/**
 * atomPriceService — fetches last-known Atomic Shop prices from the Fallout wiki
 * for CAMP items, then writes atom_price / atom_bundle / atom_checked_at columns.
 *
 * Data is "community-sourced, last known" — we store exactly what the wiki says
 * and use null for anything unknown.  Never fabricated.
 *
 * Algorithm:
 *  1. Enumerate all Atomic_Shop/CAMP/* subpages via the MediaWiki allpages API.
 *  2. Fetch wikitext for each page + the Atomic_Shop/Bundles page.
 *  3. Parse {{ATX table|row ...}} blocks:
 *       |name=, |formid={{ID|XXXXXXXX}}, |atom={{atom|NNN}}[bundle wikilink]
 *  4. Build bundleName→price map from the Bundles page.
 *  5. Match each camp_items row (form_id first, then case-insensitive name).
 *  6. Batch-update matched rows.
 *  7. Cache the raw fetched data in Redis for ~24 h so re-runs are cheap.
 */

import prisma from '../config/prisma';
import logger from '../config/logger';
import { getRedisClient } from '../config/redis';
import { apiGet as fandomApiGet, sleep } from '../lib/fandomApiClient';

// ── Constants ──────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 20_000;
const THROTTLE_MS      = 400;

const REDIS_KEY        = 'fo76:atom-prices:cache';
const REDIS_TTL_SEC    = 60 * 60 * 24; // 24 h

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AtomEntry {
  /** Normalized (lowercase, no leading zeros) form ID from the wiki */
  formId:    string | null;
  /** Raw name from |name= */
  name:      string;
  /** Atom price (integer) or null when sold at unknown/non-atom price */
  atomPrice: number | null;
  /** Bundle display name from [[Atomic Shop/Bundles|...]], or null */
  atomBundle: string | null;
}

export interface AtomPriceData {
  /** All ATX table entries keyed by normalised form ID (may have duplicates — last write wins) */
  byFormId:   Map<string, AtomEntry>;
  /** All entries keyed by lowercase name */
  byName:     Map<string, AtomEntry>;
  /** Bundle display name → bundle atom price */
  bundlePrice: Map<string, number>;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Normalise a form ID: lowercase, strip exactly 2 leading zeros (wiki uses 8-char
 * FormIDs with "00" prefix; the CAMPDatabase may store the 6-char variant or vice
 * versa). We keep both the 6-char and 8-char forms when indexing so look-ups work
 * regardless of which convention the DB row was stored with.
 */
function normalizeFormId(raw: string): string {
  return raw.trim().toLowerCase().replace(/^0+/, '') || '0';
}

/** Alternate form IDs for the same raw value (with and without leading zeros). */
function formIdVariants(raw: string): string[] {
  const base = normalizeFormId(raw);
  // 8-char padded form
  const padded = raw.trim().toLowerCase().padStart(8, '0');
  const normalPadded = normalizeFormId(padded);
  return [...new Set([base, normalPadded, padded])];
}

function apiGet(params: Record<string, string>): Promise<unknown> {
  return fandomApiGet(params, FETCH_TIMEOUT_MS);
}

// ── Page enumeration ───────────────────────────────────────────────────────────

/**
 * Enumerate all wiki pages whose title starts with "Atomic Shop/CAMP" using
 * the allpages API (namespace 0, apprefix search).
 */
async function enumerateAtomicShopCampPages(): Promise<string[]> {
  const pages: string[] = [];
  let apcontinue: string | undefined;

  do {
    const params: Record<string, string> = {
      action:    'query',
      list:      'allpages',
      apprefix:  'Atomic Shop/CAMP',
      aplimit:   '100',
      apnamespace: '0',
    };
    if (apcontinue) params['apcontinue'] = apcontinue;

    const json = await apiGet(params) as any;
    const items: Array<{ title: string }> = json?.query?.allpages ?? [];
    for (const item of items) {
      pages.push(item.title);
    }
    apcontinue = json?.['continue']?.apcontinue;
  } while (apcontinue);

  return pages;
}

// ── Wikitext fetch ─────────────────────────────────────────────────────────────

async function fetchWikitext(title: string): Promise<string | null> {
  const json = await apiGet({
    action:    'query',
    prop:      'revisions',
    titles:    title,
    rvprop:    'content',
    rvslots:   'main',
  }) as any;

  const pages = json?.query?.pages;
  if (!pages) return null;
  const page = Object.values(pages as Record<string, any>)[0] as any;
  return page?.revisions?.[0]?.slots?.main?.['*'] ?? null;
}

// ── ATX table parser ───────────────────────────────────────────────────────────

/**
 * Find all {{ATX table|row ...}} top-level template blocks using brace counting.
 * Returns the body (content after "row") of each block so nested {{ }} inside
 * field values (like {{atom|1300}} or {{ID|00588222}}) don't terminate the match.
 */
function findAtxRowBodies(wikitext: string): string[] {
  const bodies: string[] = [];
  // Find each start of "{{ATX table|row" (case-insensitive)
  const startRe = /\{\{ATX\s+table\s*\|\s*row/gi;
  let sm: RegExpExecArray | null;

  while ((sm = startRe.exec(wikitext)) !== null) {
    // Walk forward counting braces to find the matching closing }}
    let depth  = 2; // we've already consumed the opening {{
    let i      = sm.index + sm[0].length;
    const bodyStart = i;

    while (i < wikitext.length && depth > 0) {
      if (wikitext[i] === '{' && wikitext[i + 1] === '{') {
        depth += 2;
        i     += 2;
      } else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
        depth -= 2;
        if (depth <= 0) break;
        i += 2;
      } else {
        i++;
      }
    }

    if (depth === 0) {
      bodies.push(wikitext.slice(bodyStart, i));
      // Advance startRe past this block so we don't re-match nested starters
      startRe.lastIndex = i + 2;
    }
  }

  return bodies;
}

/**
 * Parse all {{ATX table|row ...}} blocks in a wikitext string.
 * Returns an array of AtomEntry (may include entries with null prices).
 *
 * Template form (actual):
 *   {{ATX table|row
 *   |name   =Display Name
 *   |atom   ={{atom|1200}}<br /><small>''[[Atomic Shop/Bundles|Bundle Name]]''</small>
 *   |formid ={{ID|0012A3F4}}
 *   }}
 *
 * Parameters are separated by newline+|. We extract each parameter value up to
 * the next newline+| boundary (not just any |) to handle nested templates.
 */
function parseAtxRows(wikitext: string): AtomEntry[] {
  const results: AtomEntry[] = [];
  const bodies = findAtxRowBodies(wikitext);

  for (const body of bodies) {
    const name      = extractParamNewline(body, 'name');
    const formidRaw = extractParamNewline(body, 'formid');
    const atomRaw   = extractParamNewline(body, 'atom');

    if (!name) continue;

    // Extract hex form ID from {{ID|XXXXXXXX}}
    let formId: string | null = null;
    if (formidRaw) {
      const idMatch = /\{\{ID\s*\|\s*([0-9A-Fa-f]+)\s*\}\}/i.exec(formidRaw);
      if (idMatch) formId = normalizeFormId(idMatch[1]);
    }

    // Parse |atom= field
    const { atomPrice, atomBundle } = parseAtomField(atomRaw ?? '');

    results.push({ formId, name: name.trim(), atomPrice, atomBundle });
  }

  return results;
}

/**
 * Extract a named parameter from an ATX row body.
 * Parameters are on their own lines: \n|paramname = value\n|next
 * We capture from "=value" up to the next newline that starts a "|" parameter
 * or the end of the body.
 */
function extractParamNewline(body: string, param: string): string | null {
  // Match: (start or newline) | param = value ... up to next (newline|) or end
  const re = new RegExp(`(?:^|\\n)\\s*\\|\\s*${param}\\s*=([\\s\\S]*?)(?=\\n\\s*\\||$)`, 'i');
  const m  = re.exec(body);
  return m ? m[1].trim() : null;
}

/**
 * Parse the |atom= field:
 *   {{atom|1200}}                        → price=1200, bundle=null
 *   {{atom|1200}}...|Bundle Name]]...   → price=1200, bundle="Bundle Name"
 *   {{atom|}}                            → price=null (sold, price unknown)
 *   {{icon|score...}} / {{icon|limited}} → price=null (not Atoms)
 *   empty / missing                      → price=null
 */
function parseAtomField(raw: string): { atomPrice: number | null; atomBundle: string | null } {
  if (!raw) return { atomPrice: null, atomBundle: null };

  // Non-atom icons → null
  if (/\{\{icon\s*\|/i.test(raw)) return { atomPrice: null, atomBundle: null };

  // {{atom|NNN}}
  const atomMatch = /\{\{atom\s*\|\s*(\d*)\s*\}\}/i.exec(raw);
  if (!atomMatch) return { atomPrice: null, atomBundle: null };

  const priceStr = atomMatch[1].trim();
  const atomPrice = priceStr.length > 0 ? parseInt(priceStr, 10) : null;

  // Bundle wikilink: [[Atomic Shop/Bundles|Bundle Name]]
  let atomBundle: string | null = null;
  const bundleMatch = /\[\[Atomic Shop\/Bundles\s*\|\s*([^\]]+)\]\]/i.exec(raw);
  if (bundleMatch) {
    atomBundle = bundleMatch[1].trim();
  }

  return { atomPrice, atomBundle };
}

// ── Bundles page parser ────────────────────────────────────────────────────────

/**
 * Parse the Atomic Shop/Bundles page and return a map of bundle name → price.
 * The Bundles page uses {{atom|NNN}} next to bundle names.
 */
function parseBundlesPage(wikitext: string): Map<string, number> {
  const map = new Map<string, number>();

  // Bundle rows look like: {{ATX table|row | name = ... | atom = {{atom|NNN}} ... }}
  const rows = parseAtxRows(wikitext);
  for (const row of rows) {
    if (row.atomPrice != null && row.name) {
      map.set(row.name.toLowerCase(), row.atomPrice);
    }
  }

  // Also scan for bare {{atom|NNN}} adjacent to bundle wikilinks as a fallback
  // Pattern: ==Bundle Name==\n...{{atom|NNN}}
  const headingRe = /==\s*([^=]+?)\s*==[\s\S]{0,500}?\{\{atom\s*\|(\d+)\}\}/gi;
  let hm: RegExpExecArray | null;
  while ((hm = headingRe.exec(wikitext)) !== null) {
    const bundleName = hm[1].trim();
    const price      = parseInt(hm[2], 10);
    if (!map.has(bundleName.toLowerCase())) {
      map.set(bundleName.toLowerCase(), price);
    }
  }

  return map;
}

// ── Main fetcher ───────────────────────────────────────────────────────────────

export async function fetchAtomicShopPrices(): Promise<AtomPriceData> {
  // Check Redis cache first
  const redis = await getRedisClient();
  const cached = await redis.get(REDIS_KEY);
  if (cached) {
    try {
      const raw = JSON.parse(cached) as { entries: AtomEntry[]; bundlePrice: Record<string, number> };
      const byFormId = new Map<string, AtomEntry>();
      const byName   = new Map<string, AtomEntry>();
      for (const e of raw.entries) {
        if (e.formId) byFormId.set(e.formId, e);
        byName.set(e.name.toLowerCase(), e);
      }
      const bundlePrice = new Map(Object.entries(raw.bundlePrice));
      logger.info({ entries: raw.entries.length }, '[atomPrice] loaded from Redis cache');
      return { byFormId, byName, bundlePrice };
    } catch {
      // fall through to fresh fetch
    }
  }

  logger.info('[atomPrice] fetching Atomic Shop prices from Fandom wiki');

  // 1. Enumerate CAMP subpages
  const campPages = await enumerateAtomicShopCampPages();
  logger.info({ count: campPages.length }, '[atomPrice] found Atomic Shop/CAMP subpages');

  const allEntries: AtomEntry[] = [];

  // 2. Fetch + parse each CAMP subpage
  for (const title of campPages) {
    await sleep(THROTTLE_MS);
    const wikitext = await fetchWikitext(title);
    if (!wikitext) continue;
    const rows = parseAtxRows(wikitext);
    logger.debug({ title, rows: rows.length }, '[atomPrice] parsed ATX rows');
    allEntries.push(...rows);
  }

  // 3. Fetch + parse the Bundles page
  await sleep(THROTTLE_MS);
  const bundlesText = await fetchWikitext('Atomic Shop/Bundles');
  const bundlePrice = bundlesText ? parseBundlesPage(bundlesText) : new Map<string, number>();
  logger.info({ bundles: bundlePrice.size }, '[atomPrice] parsed bundle prices');

  // 4. Build lookup maps
  const byFormId = new Map<string, AtomEntry>();
  const byName   = new Map<string, AtomEntry>();

  for (const entry of allEntries) {
    if (entry.formId) {
      // Index under all form ID variants
      for (const variant of formIdVariants(entry.formId)) {
        byFormId.set(variant, entry);
      }
    }
    // Index by lowercase name (last write wins for duplicates)
    byName.set(entry.name.toLowerCase(), entry);
  }

  logger.info({ entries: allEntries.length, byFormId: byFormId.size, byName: byName.size }, '[atomPrice] fetch complete');

  // 5. Cache to Redis
  try {
    const payload = {
      entries:     allEntries,
      bundlePrice: Object.fromEntries(bundlePrice.entries()),
    };
    await redis.set(REDIS_KEY, JSON.stringify(payload), { EX: REDIS_TTL_SEC });
  } catch (err) {
    logger.warn({ err }, '[atomPrice] failed to cache to Redis (non-fatal)');
  }

  return { byFormId, byName, bundlePrice };
}

/** Invalidate the Redis cache (call after a forced refresh). */
export async function invalidateAtomPriceCache(): Promise<void> {
  const redis = await getRedisClient();
  await redis.del(REDIS_KEY);
}

// ── DB updater ─────────────────────────────────────────────────────────────────

export interface AtomPriceCoverage {
  total:       number;
  withPrice:   number;
  withBundle:  number;
  samples:     Array<{ name: string; atomPrice: number | null; atomBundle: string | null }>;
}

/**
 * Fetch atom prices from the wiki and update every matching camp_items row.
 * Match strategy: try form_id first (most reliable), then case-insensitive name.
 * Items in a bundle but without a direct price inherit the bundle price.
 */
export async function updateCampAtomPrices(): Promise<AtomPriceCoverage> {
  const data = await fetchAtomicShopPrices();
  const checkedAt = new Date();

  // Load all camp items in batches
  const PAGE   = 500;
  let   offset = 0;
  let   total  = 0;
  let   withPrice  = 0;
  let   withBundle = 0;
  const samples: AtomPriceCoverage['samples'] = [];

  logger.info('[atomPrice] starting DB update pass');

  while (true) {
    const rows = await prisma.$queryRaw<Array<{
      id:      string;
      name:    string;
      form_id: string | null;
    }>>`
      SELECT id, name, form_id FROM camp_items
      ORDER BY id
      LIMIT ${PAGE} OFFSET ${offset}
    `;

    if (rows.length === 0) break;
    offset += PAGE;

    for (const row of rows) {
      total++;
      let match: typeof data.byFormId extends Map<string, infer V> ? V : never | null = null as any;

      // 1. Try form_id match
      if (row.form_id) {
        const variants = formIdVariants(row.form_id);
        for (const v of variants) {
          const m = data.byFormId.get(v);
          if (m) { match = m; break; }
        }
      }

      // 2. Fall back to name match
      if (!match) {
        match = data.byName.get(row.name.toLowerCase()) ?? null as any;
      }

      if (!match) continue;

      let atomPrice  = match.atomPrice;
      let atomBundle = match.atomBundle;

      // 3. If no direct price but has a bundle, try to look up bundle price
      if (atomPrice == null && atomBundle) {
        const bp = data.bundlePrice.get(atomBundle.toLowerCase());
        if (bp != null) atomPrice = bp;
      }

      // Update the row
      await prisma.$executeRaw`
        UPDATE camp_items
        SET atom_price      = ${atomPrice},
            atom_bundle     = ${atomBundle},
            atom_checked_at = ${checkedAt}
        WHERE id = ${row.id}
      `;

      if (atomPrice != null)  withPrice++;
      if (atomBundle != null) withBundle++;

      if (samples.length < 5) {
        samples.push({ name: row.name, atomPrice, atomBundle });
      }
    }

    logger.debug({ offset, total }, '[atomPrice] DB update progress');
  }

  logger.info({ total, withPrice, withBundle }, '[atomPrice] DB update complete');
  return { total, withPrice, withBundle, samples };
}
