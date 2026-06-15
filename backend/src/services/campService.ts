/**
 * campService — CAMP item lookup backed by the 76-CAMPDatabase.
 *
 * Data source: https://mrsblobby.github.io/76-CAMPDatabase/Live/final_workshop_db.json
 * A JSON array of ~7,382 records. Each record has at minimum:
 *   Name, Category, SubCategory, BudgetCost, BOOK_FULL (plan name or null), COBJ_FormID
 *
 * ingestCampDatabase() — fetch + upsert all rows (idempotent), mirror images, resolve sources.
 * searchCampItems()   — case-insensitive prefix/contains search on name.
 * getCampItem()       — resolve best single match for a name string.
 * getCampUpdateStatus() — Redis-cached check: has the upstream JSON changed?
 * runCampSync()       — full re-ingest + Redis hash update.
 */

import prisma from '../config/prisma';
import logger from '../config/logger';
import { getRedisClient } from '../config/redis';
import { campImageFormId, deriveCampSource, mirrorCampImage } from './campImageService';
import { updateCampAtomPrices } from './atomPriceService';
import { validateSearchQuery } from '../lib/wikiValidation';

const CAMP_DB_URL       = 'https://mrsblobby.github.io/76-CAMPDatabase/Live/final_workshop_db.json';
const FETCH_TIMEOUT_MS  = 30_000;
const UPSERT_BATCH      = 200;
const IMAGE_CONCURRENCY = 10; // max parallel image downloads

// Redis keys
const CAMP_HASH_KEY     = 'fo76:camp:last-sync-hash';
const CAMP_SYNC_AT_KEY  = 'fo76:camp:last-sync-at';
const CAMP_UPDATE_CACHE = 'fo76:camp:update-status-cache';
const UPDATE_CACHE_TTL  = 5 * 60; // 5 min

// ── Raw record shape from the upstream JSON ───────────────────────────────────

interface RawCampRecord {
  Name:              string;
  Category:          string;
  SubCategory:       string;
  BudgetCost?:       number | null;
  BOOK_FULL?:        string | null;
  COBJ_FormID?:      string | null;
  CNAM_FormID?:      string | null;
  ARTO_FormID?:      string | null;
  ENTM_FULL?:        string | null;
  ENTM_EDID?:        string | null;
  ENTM_ImagePath?:   string | null;
  BOOK_SOURCE_TAG?:  string | null;
  [key: string]: unknown;
}

// ── Public result types ───────────────────────────────────────────────────────

export interface CampItemResult {
  id:          string;
  name:        string;
  category:    string;
  subCategory: string;
  budgetCost:  number | null;
  plan:        string | null;
  imageUrl:    string | null;
  sourceLabel: string | null;
  sourceType:  string | null;
  atomPrice:   number | null;
  atomBundle:  string | null;
}

export interface CampItemFull extends CampItemResult {
  formId: string | null;
}

export interface CampUpdateStatus {
  lastSyncAt:       string | null;
  updatesAvailable: number;        // 0 or 1 (hash changed)
  checkedAt:        string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildImageUrl(id: string, imageKey: string | null): string | null {
  return imageKey ? `/api/camp/img/${id}` : null;
}

/** Hash the first 200 bytes + length of a string (cheap content fingerprint). */
function quickHash(text: string): string {
  const sample = text.slice(0, 200) + '|' + text.length;
  let h = 0;
  for (let i = 0; i < sample.length; i++) {
    h = Math.imul(31, h) + sample.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(16) + '_' + text.length;
}

// ── Shared row mapper ─────────────────────────────────────────────────────────

/**
 * Raw shape returned by every camp_items $queryRaw that includes the full
 * column set. The `form_id` column is only present in queries that request it
 * (getCampItem fallback path); callers that don't need it use a partial pick.
 */
interface CampRawRow {
  id:           string;
  name:         string;
  category:     string;
  sub_category: string;
  /** nullable — treat as nullable on the frontend too */
  budget_cost:  number | null;
  plan:         string | null;
  form_id?:     string | null;
  image_key:    string | null;
  source_label: string | null;
  source_type?: string | null;
  atom_price:   number | null;
  atom_bundle:  string | null;
}

/** Map a raw DB row to the public `CampItemResult` shape. */
function mapCampRow(r: CampRawRow): CampItemResult {
  return {
    id:          r.id,
    name:        r.name,
    category:    r.category,
    subCategory: r.sub_category,
    // budgetCost is number | null — frontend MUST treat it as nullable.
    budgetCost:  r.budget_cost,
    plan:        r.plan,
    imageUrl:    buildImageUrl(r.id, r.image_key),
    sourceLabel: r.source_label,
    sourceType:  r.source_type ?? null,
    atomPrice:   r.atom_price  ?? null,
    atomBundle:  r.atom_bundle ?? null,
  };
}

// ── Ingest ────────────────────────────────────────────────────────────────────

/**
 * Fetch the 76-CAMPDatabase JSON and upsert every row into camp_items.
 * Also mirrors images to MinIO and resolves source labels.
 * Safe to call multiple times — upsert key is (name, form_id).
 * Returns { fetched, upserted, imagesAdded } counts.
 *
 * @param preloadedText – when provided by runCampSync (already fetched), skip
 *   the network request and parse this text directly.
 */
export async function ingestCampDatabase(preloadedText?: string): Promise<{ fetched: number; upserted: number; imagesAdded: number }> {
  logger.info('[campService] starting CAMP database ingest');

  let raw: RawCampRecord[];
  if (preloadedText) {
    raw = JSON.parse(preloadedText) as RawCampRecord[];
  } else {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(CAMP_DB_URL, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} from CAMP DB`);
      raw = (await res.json()) as RawCampRecord[];
    } finally {
      clearTimeout(timeout);
    }
  }

  logger.info({ count: raw.length }, '[campService] fetched CAMP records');

  let upserted    = 0;
  let imagesAdded = 0;

  // Process in batches: upsert metadata first, then image concurrency limited
  for (let i = 0; i < raw.length; i += UPSERT_BATCH) {
    const batch = raw.slice(i, i + UPSERT_BATCH);

    // Phase 1: upsert metadata (no images yet — images need existing DB rows for ids)
    const upsertedRows = await Promise.all(
      batch.map(async rec => {
        const name     = String(rec.Name ?? '').trim();
        const category = String(rec.Category ?? '').trim();
        const subCat   = String(rec.SubCategory ?? '').trim();
        const budget   = typeof rec.BudgetCost === 'number' ? rec.BudgetCost : null;
        const plan     = rec.BOOK_FULL ? String(rec.BOOK_FULL).trim() || null : null;
        const formId   = rec.COBJ_FormID ? String(rec.COBJ_FormID).trim() || null : null;

        if (!name) return null;

        const { sourceType, sourceLabel } = deriveCampSource(rec as Record<string, unknown>);

        const row = await prisma.campItem.upsert({
          where:  { name_formId: { name, formId: formId ?? '' } },
          create: { name, category, subCategory: subCat, budgetCost: budget, plan, formId, sourceType, sourceLabel, updatedAt: new Date() },
          update: { category, subCategory: subCat, budgetCost: budget, plan, sourceType, sourceLabel, updatedAt: new Date() },
        });
        upserted++;
        return { row, rec };
      }),
    );

    // Phase 2: mirror images (concurrency capped)
    const withRows = upsertedRows.filter((r): r is { row: typeof r extends null ? never : NonNullable<typeof r>['row']; rec: RawCampRecord } => r !== null);

    // Process IMAGE_CONCURRENCY at a time
    for (let j = 0; j < withRows.length; j += IMAGE_CONCURRENCY) {
      const chunk = withRows.slice(j, j + IMAGE_CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ row, rec }) => {
          const formId = campImageFormId(rec as Record<string, unknown>);
          if (!formId) return;

          const existingKey = (row as { imageKey?: string | null }).imageKey ?? null;
          const key = await mirrorCampImage(formId, existingKey);
          if (key && key !== existingKey) {
            await prisma.campItem.update({
              where: { id: row.id },
              data:  { imageKey: key },
            });
            imagesAdded++;
          }
        }),
      );
    }
  }

  logger.info({ fetched: raw.length, upserted, imagesAdded }, '[campService] CAMP ingest complete');

  // Enrich with Atomic Shop prices from the Fandom wiki (best-effort, non-fatal)
  try {
    const atomCoverage = await updateCampAtomPrices();
    logger.info(atomCoverage, '[campService] atom price update complete');
  } catch (err) {
    logger.warn({ err }, '[campService] atom price update failed (non-fatal)');
  }

  return { fetched: raw.length, upserted, imagesAdded };
}

// ── Sync service ──────────────────────────────────────────────────────────────

/**
 * Fetch the upstream JSON, compute a quick content hash, compare to Redis.
 * Returns whether an update is available (hash changed since last sync).
 * Result cached ~5 min in Redis.
 */
export async function getCampUpdateStatus(): Promise<CampUpdateStatus> {
  const redis     = await getRedisClient();
  const checkedAt = new Date().toISOString();

  // Return cached result if fresh
  const cached = await redis.get(CAMP_UPDATE_CACHE);
  if (cached) {
    try { return JSON.parse(cached) as CampUpdateStatus; } catch { /* fall through */ }
  }

  const lastSyncAt  = await redis.get(CAMP_SYNC_AT_KEY) ?? null;
  const storedHash  = await redis.get(CAMP_HASH_KEY)    ?? null;

  let updatesAvailable = 0;
  try {
    // Fetch with a HEAD first to respect ETag / conditional GET approach; if
    // the server does not honour conditional GETs we fall back to full fetch.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let res: Response;
    try {
      res = await fetch(CAMP_DB_URL, {
        signal:  controller.signal,
        headers: { 'User-Agent': 'FalloutChatMod/1.x (falloutchatmod.com)' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      const text  = await res.text();
      const hash  = quickHash(text);
      updatesAvailable = (!storedHash || storedHash !== hash) ? 1 : 0;
    }
  } catch (err) {
    logger.warn({ err }, '[campService] getCampUpdateStatus: fetch failed, returning 0');
  }

  const status: CampUpdateStatus = { lastSyncAt, updatesAvailable, checkedAt };
  await redis.set(CAMP_UPDATE_CACHE, JSON.stringify(status), { EX: UPDATE_CACHE_TTL });
  return status;
}

/**
 * Full re-ingest + Redis hash update.  Called by POST /api/admin/camp/ingest
 * and the scheduled job.
 *
 * Fetches the upstream JSON once, passing the raw text into ingestCampDatabase
 * directly to avoid a second network round-trip for hashing.
 */
export async function runCampSync(): Promise<{ fetched: number; upserted: number; imagesAdded: number }> {
  // Fetch the upstream JSON once — reuse the text for both ingest and hashing.
  let rawText: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let fetchRes: globalThis.Response;
    try {
      fetchRes = await fetch(CAMP_DB_URL, {
        signal:  controller.signal,
        headers: { 'User-Agent': 'FalloutChatMod/1.x (falloutchatmod.com)' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (fetchRes.ok) rawText = await fetchRes.text();
  } catch (err) {
    logger.warn({ err }, '[campService] runCampSync: pre-fetch failed, falling back to ingest fetch');
  }

  const result = await ingestCampDatabase(rawText ?? undefined);

  // Store hash from the same text we already downloaded.
  if (rawText) {
    try {
      const hash  = quickHash(rawText);
      const redis = await getRedisClient();
      const now   = new Date().toISOString();
      await redis.set(CAMP_HASH_KEY,     hash, { EX: 60 * 60 * 24 * 30 }); // 30 days
      await redis.set(CAMP_SYNC_AT_KEY,  now,  { EX: 60 * 60 * 24 * 30 });
      await redis.del(CAMP_UPDATE_CACHE);
    } catch (err) {
      logger.warn({ err }, '[campService] runCampSync: could not store hash (non-fatal)');
    }
  }

  return result;
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Case-insensitive fuzzy prefix/contains search on name.
 * Returns up to `limit` results ordered by match quality (exact → prefix → contains).
 */
export async function searchCampItems(query: string, limit = 8): Promise<CampItemResult[]> {
  if (!query || query.trim().length === 0) return [];

  // Validate and sanitise: null bytes stripped, length cap 1–100 (DoS guard).
  const q = validateSearchQuery(query);

  const rows = await prisma.$queryRaw<CampRawRow[]>`
    SELECT id, name, category, sub_category, budget_cost, plan, image_key, source_label, source_type, atom_price, atom_bundle
    FROM camp_items
    WHERE lower(name) LIKE ${'%' + q.toLowerCase() + '%'}
    ORDER BY
      CASE
        WHEN lower(name) = ${q.toLowerCase()}           THEN 0
        WHEN lower(name) LIKE ${q.toLowerCase() + '%'}  THEN 1
        ELSE 2
      END,
      name
    LIMIT ${limit}
  `;

  return rows.map(mapCampRow);
}

// ── Single-item resolver ──────────────────────────────────────────────────────

/**
 * Resolve the best single match for a name string.
 * Priority: exact case-insensitive → closest contains match.
 * Returns null when no match is found.
 */
export async function getCampItem(name: string): Promise<CampItemFull | null> {
  if (!name || name.trim().length === 0) return null;

  // Validate and sanitise: null bytes stripped, length cap (DoS guard).
  const q = validateSearchQuery(name);

  // Exact match first (hits the btree index on lower(name))
  const exact = await prisma.campItem.findFirst({
    where: { name: { equals: q, mode: 'insensitive' } },
  });

  if (exact) {
    return {
      ...mapCampRow({
        id:           exact.id,
        name:         exact.name,
        category:     exact.category,
        sub_category: exact.subCategory,
        budget_cost:  exact.budgetCost,
        plan:         exact.plan,
        image_key:    exact.imageKey,
        source_label: exact.sourceLabel,
        source_type:  exact.sourceType,
        atom_price:   (exact as Record<string, unknown>).atomPrice as number | null ?? null,
        atom_bundle:  (exact as Record<string, unknown>).atomBundle as string | null ?? null,
      }),
      formId: exact.formId,
    };
  }

  // Closest contains match
  const rows = await prisma.$queryRaw<Array<CampRawRow & { form_id: string | null }>>`
    SELECT id, name, category, sub_category, budget_cost, plan, form_id, image_key, source_label, source_type, atom_price, atom_bundle
    FROM camp_items
    WHERE lower(name) LIKE ${'%' + q.toLowerCase() + '%'}
    ORDER BY
      CASE WHEN lower(name) LIKE ${q.toLowerCase() + '%'} THEN 0 ELSE 1 END,
      length(name)
    LIMIT 1
  `;

  if (rows.length === 0) return null;

  const r = rows[0];
  return {
    ...mapCampRow(r),
    formId: r.form_id ?? null,
  };
}

// ── Wiki cross-reference ──────────────────────────────────────────────────────

/**
 * Return ALL camp_items rows whose name exactly matches (case-insensitive) the
 * given wiki entry display name.  Used by wikiCatalogService.getEntry() to
 * attach CAMP buildable data to a wiki entry.
 *
 * Returns an empty array when there is no match — never throws.
 * Single indexed query (camp_items has a btree index on lower(name) via the
 * unique key used by upsert; the ILIKE '=' path hits it).
 */
export interface CampMatch {
  id:          string;
  name:        string;
  category:    string;
  subCategory: string;
  budgetCost:  number | null;
  plan:        string | null;
  sourceLabel: string | null;
  imageUrl:    string | null;
  atomPrice:   number | null;
  atomBundle:  string | null;
}

export async function getCampMatchesForName(name: string): Promise<CampMatch[]> {
  if (!name || !name.trim()) return [];

  const rows = await prisma.$queryRaw<CampRawRow[]>`
    SELECT id, name, category, sub_category, budget_cost, plan, source_label, image_key, atom_price, atom_bundle
    FROM camp_items
    WHERE lower(name) = ${name.trim().toLowerCase()}
    ORDER BY category, sub_category
  `;

  return rows.map((r) => {
    const base = mapCampRow(r);
    return {
      id:          base.id,
      name:        base.name,
      category:    base.category,
      subCategory: base.subCategory,
      budgetCost:  base.budgetCost,
      plan:        base.plan,
      sourceLabel: base.sourceLabel,
      imageUrl:    base.imageUrl,
      atomPrice:   base.atomPrice,
      atomBundle:  base.atomBundle,
    };
  });
}

// ── Table-empty guard (for boot-time auto-ingest) ─────────────────────────────

export async function isCampTableEmpty(): Promise<boolean> {
  const count = await prisma.campItem.count();
  return count === 0;
}
