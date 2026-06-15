/**
 * wikiCatalogService — serves the local FO76 wiki catalog to request controllers.
 *
 * NEVER calls Fandom. All data is read from the local Postgres catalog
 * (wiki_entries / wiki_aliases) populated by wikiIngestionService.
 *
 * Security (spec §1.7):
 *   - `q` validated: 1–100 chars, null bytes stripped, parameterized $queryRaw only.
 *   - Per-kind infobox field subsets trimmed before sending (oversized infobox guard).
 *   - Values capped at 256 chars to prevent accidental multi-KB field bleed.
 *   - No dangerouslySetInnerHTML exposure — values are plain text strings.
 */

import prisma from '../config/prisma';
import { createError } from '../middleware/errorHandler'; // used in getEntry 404
import type { WikiLocationSegment } from './wikiParser';
import { getCampMatchesForName } from './campService';
import type { CampMatch } from './campService';

// Re-export so existing callers (wikiController) keep the same import path.
export { validateSearchQuery, sleep } from '../lib/wikiValidation';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WikiSearchResult {
  id: string;
  name: string;
  wikiTitle: string;
  kind: string | null;
  thumbnailUrl: string | null;
  score: number;
}

export interface WikiEntryImage {
  url: string;
  aspect: string | null;
  isMap: boolean;
  width: number | null;
  height: number | null;
}

export interface WikiEntryResult {
  id: string;
  name: string;
  kind: string | null;
  /** Back-compat: always the proxied `/api/wiki/img/<id>` form, never a raw
   *  MinIO or Fandom CDN URL. Equals `images[0]?.url ?? null`. */
  imageUrl: string | null;
  imageAspect: string | null;
  imageMime: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  // imageSourceUrl intentionally omitted — would leak internal MinIO paths.
  /** All images ordered by position (primary/position-0 first). */
  images: WikiEntryImage[];
  /** Spawn / find locations — each row is an array of text/link segments. */
  locations: WikiLocationSegment[][];
  articleUrl: string;
  wikiTitle: string;
  fields: Record<string, string>;
  attribution: string;
  /** CAMP buildable data — empty array when the item is not in the CAMP database. */
  campData: CampMatch[];
}

// ── Per-kind field subsets (spec §3.4) ─────────────────────────────────────────

// Field allow-lists, ordered by importance. Keys are matched against the real
// FO76 infobox keys (verified against synced data); extra/legacy keys are kept
// as harmless fallbacks since empty values are skipped at render time.
const KIND_FIELDS: Record<string, string[]> = {
  weapon: [
    'type', 'class', 'level', 'base type', 'damage', 'attack time', 'fire rate',
    'range', 'accuracy', 'crit', 'ap used', 'projectiles', 'ammo', 'clip size',
    'reload time', 'draw', 'sight', 'bash', 'block', 'stagger', 'speed',
    'sound level', 'special', 'effects',
    'perk mod', 'perk dmg', 'perk repair', 'perk leg', 'perk sneak', 'perk pen', 'modifiers',
    'repair', 'craft', 'scrap', 'weight', 'value', 'plan', 'formid',
  ],
  armor: [
    'type', 'class', 'dr', 'er', 'rr', 'resist', 'physical resistance',
    'energy resistance', 'radiation resistance',
    'variants', 'slots', 'effects', 'perks', 'weight', 'value', 'plan', 'formid',
  ],
  creature: [
    'type', 'class', 'level', 'variants', 'hp', 'xp', 'drops', 'perks',
    'affiliation', 'quests', 'weakness', 'events', 'location', 'locations', 'formid',
  ],
  item: [
    'type', 'effect', 'effects', 'duration', 'hunger', 'thirst', 'rads',
    'modifies', 'mod slot', 'components', 'weight', 'value', 'food', 'component of', 'quests', 'disease', 'spoil', 'formid',
  ],
  perk: ['effects', 'equip cost', 'unlocked', 'race(s)', 'editor id', 'form id', 'type', 'requires'],
  // FO76 {{Infobox location}} actually uses these keys (not region/map ref/formid).
  location: ['type', 'part of', 'factions', 'creatures', 'robots', 'quests', 'leaders', 'owners', 'terminal', 'refid', 'cell name', 'map marker', 'edid'],
  plan: ['unlocks', 'unlock types', 'value', 'value type', 'tradeable', 'weight', 'locations', 'formid'],
  quest: ['type', 'location', 'given by', 'reward', 'related', 'leads to', 'previous', 'baddies', 'other npcs', 'formid'],
  mutation: ['effects pos', 'effects neg', 'serum', 'suppressed by', 'formid'],
  world_object: ['type', 'location', 'edid', 'formid', 'learned by', 'components', 'objecttype', 'shelter', 'workshop', 'use', 'used for', 'perk'],
  faction: ['type', 'status', 'leader', 'founded by', 'headquarters', 'members', 'divisions', 'locations', 'parent', 'related', 'formid'],
  ammo: ['item name', 'weight', 'value', 'edid', 'formid', 'item name2', 'weight2', 'value2', 'edid2', 'formid2'],
  radio_station: ['origin', 'range', 'quests', 'refid'],
  character: ['race', 'role', 'class', 'level', 'gender', 'affiliation', 'factions', 'location', 'actor', 'aggression', 'refid', 'formid'],
  currency: ['uses', 'type', 'value', 'weight', 'tradeable', 'max', 'requirements', 'edid', 'formid'],
};

const MAX_VALUE_LEN = 256;
const OTHER_MAX_PAIRS = 14;
/** pg_trgm similarity threshold used for candidate filtering (spec §3.2).
 *  Lower than the pg default (0.3) to surface near-matches for short queries. */
const TRGM_SIMILARITY_THRESHOLD = 0.1;

export function trimInfobox(
  raw: Record<string, unknown>,
  kind: string | null,
): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};

  const coerce = (v: unknown): string =>
    String(v ?? '').slice(0, MAX_VALUE_LEN).trim();

  const normalKey = (k: string) => k.toLowerCase().trim().replace(/_/g, ' ');

  const entries = Object.entries(raw)
    .map(([k, v]) => [normalKey(k), coerce(v)] as [string, string])
    .filter(([, v]) => v !== '');

  const allowed = kind ? KIND_FIELDS[kind] : null;

  if (allowed) {
    const allowedSet = new Set(allowed.map(normalKey));
    const filtered = entries.filter(([k]) => allowedSet.has(k));
    return Object.fromEntries(filtered);
  }

  // other / unknown — first OTHER_MAX_PAIRS non-empty pairs
  return Object.fromEntries(entries.slice(0, OTHER_MAX_PAIRS));
}

// ── Search ─────────────────────────────────────────────────────────────────────

/**
 * Fuzzy-search the local catalog using pg_trgm over name + aliases.
 *
 * Uses Prisma $queryRaw (parameterized) — NEVER $queryRawUnsafe.
 * Returns results ordered by similarity descending, deduplicated by page_id.
 */
export async function searchEntries(
  q: string,
  limit = 10,
): Promise<WikiSearchResult[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);

  // pg_trgm similarity search across wiki_entries.name and wiki_aliases.alias.
  //
  // Performance: the candidate filter uses the trigram `%` operator (not
  // `similarity() > x`) so the planner engages the GIN trgm indexes
  // (wiki_entries_name_trgm_idx / wiki_aliases_alias_trgm_idx) — an index scan
  // instead of a full table seq-scan. The `%` threshold is set per-transaction
  // to 0.1 (pg default is 0.3) to match the old behaviour. name_hits and
  // alias_hits are separate index-friendly scans, UNION'd then deduped by entry
  // (max score across name + aliases). similarity() is computed only on the
  // already-narrowed candidate rows for scoring.
  const rows = await prisma.$transaction(async (tx) => {
    // SET LOCAL cannot take a bind parameter — inline the numeric constant
    // (Number()-coerced, never user input, so no injection risk).
    await tx.$executeRawUnsafe(`SET LOCAL pg_trgm.similarity_threshold = ${Number(TRGM_SIMILARITY_THRESHOLD)}`);
    return tx.$queryRaw<
      Array<{
        id: string;
        name: string;
        wiki_title: string;
        kind: string | null;
        thumb_id: string | null;
        score: number;
      }>
    >`
      WITH name_hits AS (
        SELECT e.id, e.name, e.wiki_title, e.kind, similarity(e.name, ${q}) AS score
        FROM wiki_entries e
        WHERE e.is_stale = false AND e.kind IS NOT NULL AND e.name % ${q}
      ),
      alias_hits AS (
        SELECT e.id, e.name, e.wiki_title, e.kind, similarity(a.alias, ${q}) AS score
        FROM wiki_aliases a
        JOIN wiki_entries e ON e.id = a.wiki_entry_id
        WHERE e.is_stale = false AND e.kind IS NOT NULL AND a.alias % ${q}
      ),
      ranked AS (
        SELECT id, name, wiki_title, kind, MAX(score) AS score
        FROM (SELECT * FROM name_hits UNION ALL SELECT * FROM alias_hits) c
        GROUP BY id, name, wiki_title, kind
      )
      SELECT
        r.id, r.name, r.wiki_title, r.kind, r.score,
        (SELECT i.id FROM wiki_images i WHERE i.wiki_entry_id = r.id ORDER BY i.position ASC LIMIT 1) AS thumb_id
      FROM ranked r
      ORDER BY
        (lower(r.name) = lower(${q})) DESC,
        r.score DESC,
        (lower(r.name) LIKE lower(${q}) || '%') DESC,
        length(r.name) ASC
      LIMIT ${safeLimit}
    `;
  });

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    wikiTitle: r.wiki_title,
    kind: r.kind,
    // Proxied through our origin so the autocomplete thumbnail always loads.
    thumbnailUrl: r.thumb_id ? `/api/wiki/img/${r.thumb_id}` : null,
    score: typeof r.score === 'number' ? r.score : parseFloat(String(r.score)),
  }));
}

// ── Best match helper ──────────────────────────────────────────────────────────

/** Returns the top search result (first pg_trgm hit) or null. */
export async function bestMatch(q: string): Promise<WikiSearchResult | null> {
  const results = await searchEntries(q, 1);
  return results[0] ?? null;
}

// ── Entry lookup ───────────────────────────────────────────────────────────────

const ARTICLE_BASE = 'https://fallout.fandom.com/wiki/';

/**
 * Return a single wiki entry by display name (case-insensitive exact match
 * on wiki_entries.name, then wiki_aliases.alias).
 *
 * 404 if not found. 200 with empty `fields` when no infobox data is present.
 */
export async function getEntry(title: string): Promise<WikiEntryResult> {
  // Shared select shape (images ordered by position ascending)
  const entrySelect = {
    id: true,
    name: true,
    wikiTitle: true,
    kind: true,
    infobox: true,
    imageUrl: true,
    imageAspect: true,
    imageMime: true,
    imageWidth: true,
    imageHeight: true,
    locations: true,
    images: {
      select: { id: true, url: true, aspect: true, isMap: true, width: true, height: true },
      orderBy: { position: 'asc' as const },
    },
  } as const;

  // Attempt direct name match first (case-insensitive).
  // kind IS NOT NULL is the safety filter: only rows that passed the FO76
  // ingest gate have a kind set. Belt-and-suspenders against any pre-gate rows.
  let entry = await prisma.wikiEntry.findFirst({
    where: {
      name: { equals: title, mode: 'insensitive' },
      isStale: false,
      kind: { not: null },
    },
    select: entrySelect,
  });

  // Fallback: alias lookup
  if (!entry) {
    const alias = await prisma.wikiAlias.findFirst({
      where: { alias: { equals: title, mode: 'insensitive' } },
      include: {
        wikiEntry: {
          select: { ...entrySelect, isStale: true },
        },
      },
    });
    // Safety: reject stale rows AND rows with no kind (pre-gate / non-FO76).
    if (alias && !alias.wikiEntry.isStale && alias.wikiEntry.kind !== null) {
      const { isStale: _s, ...rest } = alias.wikiEntry;
      entry = rest;
    }
  }

  if (!entry) {
    throw createError(404, `No wiki entry found for "${title}"`);
  }

  const rawInfobox =
    entry.infobox && typeof entry.infobox === 'object'
      ? (entry.infobox as Record<string, unknown>)
      : {};

  const fields = trimInfobox(rawInfobox, entry.kind);

  // Serve every image through our own origin (proxy route) so the client never
  // hotlinks the Fandom CDN or depends on MinIO being publicly reachable.
  const images: WikiEntryImage[] = entry.images.map((img) => ({
    url: `/api/wiki/img/${img.id}`,
    aspect: img.aspect,
    isMap: img.isMap,
    width: img.width,
    height: img.height,
  }));

  // Normalize stored locations to segment rows. New format = segment arrays;
  // legacy rows may be plain strings → wrap as a single text segment.
  const locations: WikiLocationSegment[][] = Array.isArray(entry.locations)
    ? (entry.locations as unknown[])
        .map((loc): WikiLocationSegment[] => {
          if (typeof loc === 'string') return [{ text: loc }];
          if (Array.isArray(loc)) {
            return (loc as unknown[])
              .filter((s): s is { text: unknown; title?: unknown } => !!s && typeof s === 'object' && 'text' in (s as object))
              .map((s) => {
                const seg: WikiLocationSegment = { text: String((s as { text: unknown }).text) };
                const title = (s as { title?: unknown }).title;
                if (typeof title === 'string' && title) seg.title = title;
                return seg;
              });
          }
          return [{ text: String(loc) }];
        })
        .filter((segs) => segs.length > 0 && segs.some((s) => s.text.trim()))
    : [];

  // Attach CAMP buildable data if any rows match this entry's display name.
  const campData = await getCampMatchesForName(entry.name);

  return {
    id: entry.id,
    name: entry.name,
    wikiTitle: entry.wikiTitle,
    kind: entry.kind,
    // Always use the proxied URL — never expose the raw MinIO/CDN path.
    imageUrl: images[0]?.url ?? null,
    imageAspect: entry.imageAspect,
    imageMime: entry.imageMime,
    imageWidth: entry.imageWidth,
    imageHeight: entry.imageHeight,
    images,
    locations,
    articleUrl: `${ARTICLE_BASE}${encodeURIComponent(entry.wikiTitle.replace(/ /g, '_'))}`,
    fields,
    attribution: 'Fallout Wiki · CC-BY-SA 3.0',
    campData,
  };
}
