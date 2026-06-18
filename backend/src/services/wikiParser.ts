// Pure wikitext/infobox parsing for the FO76 wiki lookup feature.
//
// Deliberately free of any I/O, Redis, logging, or env imports so it can be
// unit-tested in isolation and reused by both the request path and the
// ingestion job. See docs/roadmap/fan-site-integrations.md.

// ── Image filtering helpers ────────────────────────────────────────────────────

/** Raw image descriptor returned by the MediaWiki imageinfo API. */
export interface RawPageImage {
  /** File title, e.g. "File:SomeWeapon.png" */
  title: string;
  url: string;
  width: number;
  height: number;
  mime: string;
}

/**
 * Returns true when the image is a map / location image.
 * Pure — no I/O.
 *
 * Detection rules (any match → true):
 *   1. Filename/title contains the word "map" as a standalone token
 *      (word-boundary or delimited by spaces / underscores / hyphens / dots).
 *      This catches "Helvetia_map.png", "FO76_map_of_Helvetia.png", etc.
 *      while avoiding false positives like "damage_minimap_hud.png" (no match)
 *      or "campfire.png" (no match).
 *   2. Optional caption (if provided) contains "map" or "map of" (case-insensitive).
 *   3. Legacy loc[_-] prefix heuristic retained for backward compat.
 *
 * Signature extended with optional caption parameter; all existing call-sites
 * (title-only) continue to work unchanged.
 */
export function isMapImage(title: string, caption?: string): boolean {
  // "map" as a standalone token: preceded/followed by start/end, space, _, -, or .
  // Catches "Helvetia_map.png", "Map_of_X.png", "FO76 map overview.png", etc.
  // Does NOT match "minimap", "campmap", "damage_map_icon" (the word is embedded mid-token).
  const MAP_BOUNDARY = /(?:^|[_\-.\s])map(?:[_\-.\s]|$)/i;
  if (MAP_BOUNDARY.test(title.replace(/^File:/i, ''))) return true;
  if (caption && MAP_BOUNDARY.test(caption)) return true;
  // Legacy: loc[_-] prefix (keep for backward compat)
  if (/loc[_\-]/i.test(title)) return true;
  return false;
}

/** Normalize a File title / filename for comparison (drop File:, lowercase, spaces). */
export function normalizeImageName(s: string): string {
  return s.replace(/^File:/i, '').replace(/[_\s]+/g, ' ').trim().toLowerCase();
}

/**
 * Keep only images whose filename is DIRECTLY referenced in the page wikitext
 * (the infobox `image=` field, `[[File:…]]` links, and `<gallery>` entries).
 *
 * This drops currency/UI/sprite/logo images (e.g. Caps.png, FO76_scoresprite_*)
 * that the MediaWiki `prop=images` list includes because they're injected by
 * TEMPLATES — those never appear in the page's own source. Pure / unit-testable.
 */
export function filterContentImages(images: RawPageImage[], wikitext: string): RawPageImage[] {
  if (!wikitext) return images;
  const wt = wikitext.replace(/[_\s]+/g, ' ').toLowerCase();
  return images.filter(img => wt.includes(normalizeImageName(img.title)));
}

/**
 * Filter junk out of a raw page-image list:
 *  - drops .svg files
 *  - drops images with width < 100 or height < 100
 *  - drops names matching icon|vault.?boy|button|marker|emote|logo
 *
 * Pure — no I/O, unit-testable.
 */
export function filterPageImages(images: RawPageImage[]): RawPageImage[] {
  return images.filter(img => {
    if (!img.url || !img.mime) return false;
    if (img.mime === 'image/svg+xml' || img.url.endsWith('.svg')) return false;
    if ((img.width ?? 0) < 100 || (img.height ?? 0) < 100) return false;
    const name = img.title.replace(/^File:/i, '');
    if (/icon|vault.?boy|button|marker|emote|logo/i.test(name)) return false;
    return true;
  });
}

// ── Locations section parser ───────────────────────────────────────────────────

/**
 * Extract location bullet/list items from the raw wikitext of a Locations
 * section. Accepts lines starting with *, ;, or # and cleans wiki markup.
 *
 * Pure — no I/O, unit-testable.
 */
/**
 * One piece of a location line: plain `text`, or a link when `title` is set
 * (the wiki page title the location name points to). Lets the UI hyperlink ONLY
 * the actual in-game location name(s) rather than the whole sentence.
 */
export interface WikiLocationSegment {
  text: string;
  title?: string;
}

/** Clean a non-link wikitext fragment while PRESERVING boundary whitespace. */
function cleanLocationFragment(raw: string): string {
  const core = cleanWikitextValue(raw);
  if (!core) return '';
  return (/^\s/.test(raw) ? ' ' : '') + core + (/\s$/.test(raw) ? ' ' : '');
}

/** Split one list-item line into text + `[[link]]` segments. Pure. */
export function parseLocationLine(content: string): WikiLocationSegment[] {
  const segments: WikiLocationSegment[] = [];
  const linkRe = /\[\[([^[\]]+)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(content)) !== null) {
    const before = cleanLocationFragment(content.slice(last, m.index));
    if (before) segments.push({ text: before });
    const inner = m[1];
    const pipe = inner.indexOf('|');
    const title = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    const label = cleanWikitextValue(pipe >= 0 ? inner.slice(pipe + 1) : inner) || title;
    // Keep real page links; skip file/category/anchor links.
    if (label && title && !/^(file|image|category):/i.test(title) && !title.startsWith('#')) {
      segments.push({ text: label, title });
    } else if (label) {
      segments.push({ text: label });
    }
    last = linkRe.lastIndex;
  }
  const tail = cleanLocationFragment(content.slice(last));
  if (tail) segments.push({ text: tail });
  return segments;
}

/**
 * Parse a "Locations" section into structured rows. Each row is an array of
 * segments; only `[[wikilink]]` targets become links (`title` set), so the UI
 * can hyperlink just the location name(s), not the whole line.
 */
export function parseLocationsSection(wikitext: string): WikiLocationSegment[][] {
  const lines = wikitext.split('\n');
  const results: WikiLocationSegment[][] = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (/^[*;#]/.test(trimmed)) {
      // Strip the list marker characters from the start
      const content = trimmed.replace(/^[*;#]+\s*/, '');
      const segs = parseLocationLine(content);
      if (segs.length > 0 && segs.some(s => s.text.trim())) results.push(segs);
    }
  }
  return results;
}

/**
 * Parse the expanded XML blob returned by `action=expandtemplates` for a
 * {{Perks/Infobox|<PerkName>}} transclusion. The blob contains multiple
 * <section> elements (one per rank ★★★/★★/★), each with repeated
 * <data><label>…</label><default>…</default></data> pairs.
 *
 * Strategy: take only the FIRST non-empty value per label (top rank wins).
 * Both label and value are cleaned with cleanWikitextValue so wikilinks and
 * templates are stripped. Labels like "[[Form ID]]" become "form id".
 *
 * Pure — no I/O, unit-testable.
 */
export function parseExpandedPerkInfobox(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pairRe = /<data>\s*<label>([\s\S]*?)<\/label>\s*<default>([\s\S]*?)<\/default>\s*<\/data>/gi;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(xml)) !== null) {
    const rawLabel = m[1];
    const rawValue = m[2];
    const key   = cleanWikitextValue(rawLabel).toLowerCase().trim();
    const value = cleanWikitextValue(rawValue).trim();
    if (key && value && !(key in result)) {
      result[key] = value;
    }
  }
  return result;
}

/** Clean a raw infobox value of wiki markup → display text. */
export function cleanWikitextValue(raw: string): string {
  let s = raw;
  s = s.replace(/<!--[\s\S]*?-->/g, '');                    // comments
  s = s.replace(/<ref[\s\S]*?<\/ref>/gi, '');               // references
  s = s.replace(/<br\s*\/?>/gi, ' ');                        // line breaks
  s = s.replace(/<small>|<\/small>/gi, '');                 // small tags
  // Strip any remaining HTML tags. Loop until stable so OVERLAPPING/NESTED angle
  // brackets (e.g. "<scr<x>ipt>") can't leave a residual usable "<…>" tag after a
  // single pass — each pass removes one inner "<…>" and re-scans the collapsed
  // result. Iteration cap (50) guards against adversarial input (ReDoS).
  let prevTag: string;
  let tagIter = 0;
  do { prevTag = s; s = s.replace(/<[^>]+>/g, ''); } while (s !== prevTag && ++tagIter < 50);
  // Any leftover lone angle brackets (unbalanced "<" or ">") are dropped so no
  // partial markup can survive to the rendered output.
  s = s.replace(/[<>]/g, '');
  s = s.replace(/\{\{dot\}\}/gi, ' · ');                     // {{dot}} separator
  s = s.replace(/\{\{icon\|[^}]*\}\}/gi, '');                // {{icon|…}} → drop
  s = s.replace(/\{\{ID\|([^}]*)\}\}/gi, '$1');              // {{ID|0046D2A1}} → 0046D2A1
  // Strip any remaining templates innermost-first so NESTED templates
  // ({{Damage|{{IF|x|50|45}}}}) collapse cleanly — a single flat regex would
  // stop at the first '}}' and leave garbage braces behind.
  // Iteration cap (50) guards against adversarial deeply-nested input (ReDoS).
  let prevTpl: string;
  let tplIter = 0;
  do { prevTpl = s; s = s.replace(/\{\{[^{}]*\}\}/g, ''); } while (s !== prevTpl && ++tplIter < 50);
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1');         // [[target|label]] → label
  s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');                  // [[target]] → target
  s = s.replace(/\[(?:https?:\/\/\S+)\s+([^\]]*)\]/g, '$1'); // [url label] → label
  s = s.replace(/'''?/g, '');                                // bold/italic markup
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Map an infobox template name to a coarse entity kind for display + filtering. */
export function inferKind(templateName: string): string | null {
  const m = templateName.toLowerCase();
  // Power armor uses {{Infobox armor FO76}} (no distinct template) so it maps to
  // 'armor' along with regular armor — there is no separate 'power_armor' kind.
  if (m.includes('weapon')) return 'weapon';
  // {{Infobox apparel FO76}} (backpacks, outfits, headwear) → armor.
  if (m.includes('armor') || m.includes('armour') || m.includes('apparel')) return 'armor';
  if (m.includes('creature')) return 'creature';
  if (m.includes('character') || m.includes('npc')) return 'character';
  if (m.includes('consumable') || m.includes('item') || m.includes('food') || m.includes('chem')) return 'item';
  if (m.includes('location')) return 'location';
  if (m.includes('perk')) return 'perk';
  if (m.includes('plan')) return 'plan';
  // Quests AND public events both use {{Infobox quest}} on the FO76 wiki —
  // there is no separate event infobox — so both map to 'quest'.
  if (m.includes('quest')) return 'quest';
  if (m.includes('mutation')) return 'mutation';
  if (m.includes('faction')) return 'faction';
  if (m.includes('ammo')) return 'ammo';
  if (m.includes('world object')) return 'world_object';
  if (m.includes('radio')) return 'radio_station';
  if (m.includes('currency')) return 'currency';
  if (m.includes('infobox')) return 'other';
  return null;
}

/**
 * Whether an infobox template is the Fallout 76 variant (e.g. "Infobox weapon
 * FO76"). Used by the ingestion job to reject cross-game shared pages.
 */
export function isFo76Infobox(templateName: string): boolean {
  return /\bfo76\b/i.test(templateName);
}

/**
 * Determine whether a parsed page should be ingested into the FO76 catalog.
 *
 * Accepts:
 *   1. Pages with an FO76-specific infobox template (e.g. "Infobox weapon FO76").
 *   2. Shared/generic infobox pages whose `games` field includes the FO76 token
 *      (e.g. {{Infobox item|games=FO76|…}}). This covers shared-universe items
 *      like "Toilet paper" that appear in multiple games including FO76.
 *
 * Rejects:
 *   - Pages with no infobox (kind === null → no entity type to classify).
 *   - Cross-game pages whose infobox carries no FO76 signal in the template
 *     name OR the `games` field.
 *   - Disambiguation / hatnote-only pages (no infobox found → kind === null).
 *
 * Pure — no I/O, fully unit-testable.
 */
export function isFo76Content(parsed: {
  kind: string | null;
  isFo76: boolean;
  fields: Record<string, string>;
}): boolean {
  if (parsed.kind === null) return false;
  if (parsed.isFo76) return true;
  // Shared-page check: `games` field must contain the FO76 token.
  return /\bFO76\b/i.test(parsed.fields.games ?? '');
}

/**
 * Maintenance/banner template names that should be skipped when locating the
 * real content infobox. These appear at the top of many FO76 pages but carry
 * no entity data. The regex is tested against the template NAME only (the text
 * between `{{` and the first `|` or `}}`).
 */
const MAINTENANCE_INFOBOX_RE = /^infobox\s+(incomplete|needed|stub)\b/i;

/**
 * Fandom wiki sub-template patterns that act as perk/armor infoboxes but do
 * NOT follow the `{{Infobox <kind>}}` naming convention. When one of these is
 * present we can still classify the page, even though we cannot extract
 * structured fields from the transcluded template.
 *
 * Each entry: { re — matches template name, kind, isFo76 }.
 */
const PSEUDO_INFOBOX_TEMPLATES: Array<{ re: RegExp; kind: string; isFo76: boolean }> = [
  // {{Perks/Infobox|…}} — all FO76 perk card pages
  { re: /^Perks\/Infobox\b/i, kind: 'perk', isFo76: true },
  // {{ArmorPage/Infobox}} — FO76 armor set overview pages
  { re: /^ArmorPage\/Infobox\b/i, kind: 'armor', isFo76: true },
];

/**
 * Extract the first real-content {{Infobox …}} block from section-0 wikitext
 * and parse its top-level `|key = value` fields. Respects nested {{ }} and
 * [[ ]] so values containing pipes (links, templates) aren't split incorrectly.
 *
 * Banner/maintenance infoboxes (e.g. `{{infobox incomplete|FO76|…}}`) that
 * frequently precede the real infobox on FO76 pages are skipped — the parser
 * finds the first Infobox template whose name does NOT match
 * `MAINTENANCE_INFOBOX_RE`.
 *
 * Also recognises Fandom sub-template patterns (Perks/Infobox, ArmorPage/Infobox)
 * that stand in for a standard Infobox on perk and armor-set pages.
 */
export function parseInfobox(wikitext: string): {
  kind: string | null;
  templateName: string | null;
  isFo76: boolean;
  fields: Record<string, string>;
} {
  const empty = { kind: null, templateName: null, isFo76: false, fields: {} };

  // ── 1. Check for pseudo-infobox sub-templates (Perks/Infobox, etc.) ──────────
  // Scan ALL `{{…}}` openings and return the first pseudo-infobox match so that
  // pages that use these patterns (perk cards, armor-set overviews) are recognised
  // even though they have no `{{Infobox …}}` block at all.
  const anyTemplateRe = /\{\{([^|}\n]+)/g;
  let pseudoMatch: RegExpExecArray | null;
  while ((pseudoMatch = anyTemplateRe.exec(wikitext)) !== null) {
    const name = pseudoMatch[1].trim();
    for (const entry of PSEUDO_INFOBOX_TEMPLATES) {
      if (entry.re.test(name)) {
        return { kind: entry.kind, templateName: name, isFo76: entry.isFo76, fields: {} };
      }
    }
  }

  // ── 2. Find the first non-maintenance {{Infobox …}} ──────────────────────────
  const infoboxSearchRe = /\{\{\s*Infobox/gi;
  let start = -1;
  let searchMatch: RegExpExecArray | null;
  while ((searchMatch = infoboxSearchRe.exec(wikitext)) !== null) {
    const candidateStart = searchMatch.index;
    // Extract the template name: text between '{{' and the first '|' or '}}'.
    const nameStart = candidateStart + 2;
    // Walk forward from nameStart to find the actual first pipe or }}.
    let ne = nameStart;
    while (ne < wikitext.length && wikitext[ne] !== '|' && !(wikitext[ne] === '}' && wikitext[ne + 1] === '}')) ne++;
    const candidateName = wikitext.slice(nameStart, ne).trim();
    if (MAINTENANCE_INFOBOX_RE.test(candidateName)) continue; // skip banner
    start = candidateStart;
    break;
  }
  if (start === -1) return empty;

  // Walk braces to find the matching close of the infobox template.
  let depth = 0;
  let end = -1;
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++; }
    else if (wikitext[i] === '}' && wikitext[i + 1] === '}') { depth--; i++; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return empty;

  const body = wikitext.slice(start + 2, end - 2); // strip outer {{ }}

  // Split top-level fields on `|`, tracking nesting depth.
  const parts: string[] = [];
  let buf = '';
  let braces = 0, brackets = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i], c2 = body[i + 1];
    if (c === '{' && c2 === '{') { braces++; buf += '{{'; i++; continue; }
    if (c === '}' && c2 === '}') { braces--; buf += '}}'; i++; continue; }
    if (c === '[' && c2 === '[') { brackets++; buf += '[['; i++; continue; }
    if (c === ']' && c2 === ']') { brackets--; buf += ']]'; i++; continue; }
    if (c === '|' && braces === 0 && brackets === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);

  // First part is the template name (e.g. "Infobox weapon FO76").
  const templateName = parts.shift()?.trim() ?? '';
  const kind = inferKind(templateName);

  const fields: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const val = cleanWikitextValue(part.slice(eq + 1));
    if (key && val) fields[key] = val;
  }
  return { kind, templateName: templateName || null, isFo76: isFo76Infobox(templateName), fields };
}
