/**
 * wikiIngestionService — recursive category walk + upsert pipeline for the
 * local FO76 wiki catalog.
 *
 * Ingestion-only: this module MUST NOT be imported by any request controller.
 * All Fandom API calls live here (or in wikiService / wikiParser). The
 * request path serves exclusively from the local Postgres catalog.
 *
 * Security / spec compliance:
 *   - Redis distributed lock  (SET fo76:wiki:ingest:lock NX EX 10800)
 *   - Min re-trigger interval enforced via fo76:wiki:ingest:last-run key
 *   - 300ms throttle between entity fetches; exponential backoff on HTTP 429
 *   - Per-entity try/catch → wiki_ingest_errors; never aborts the whole run
 *   - Stale cleanup: is_stale=true where ingested_at < run_start
 *   - Infobox sanitization at ingestion (never trusts raw Fandom content)
 */

import crypto from 'crypto';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';
import prisma from '../config/prisma';
import { parseInfobox, parseExpandedPerkInfobox, isFo76Content, filterPageImages, filterContentImages, isMapImage, parseLocationsSection, RawPageImage, WikiLocationSegment } from './wikiParser';
import { mirrorWikiImage, deriveImageAspect, WikiImageResult } from './wikiImageService';
import { apiGet as fandomApiGet, apiGetWithBackoff as fandomApiGetWithBackoff, RateLimitError, sleep } from '../lib/fandomApiClient';

// ── Deferred-image mode ────────────────────────────────────────────────────────
// When WIKI_DEFER_IMAGES is set to any truthy string, processTitle writes
// wiki_images rows with url = Fandom source URL (no download/convert/upload).
// wikiImageController.getWikiImage falls back to the Fandom CDN for any row
// whose url does not contain 'wiki-images/', so images remain functional
// immediately. Run backend/src/scripts/backfillWikiImages.ts afterwards to
// mirror deferred rows to MinIO.
const DEFER_IMAGES = Boolean(process.env.WIKI_DEFER_IMAGES);

// ── Constants ──────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS    = 12_000;
const THROTTLE_MS         = 60;
const INGEST_CONCURRENCY  = 10;
const MAX_CATEGORY_DEPTH = 5;
const LOCK_KEY         = 'fo76:wiki:ingest:lock';
/**
 * Message of the Error thrown when a run is skipped because the Redis ingest
 * lock is already held by a concurrent run. This is an EXPECTED, non-fatal
 * skip — callers (cron wrappers) match on it so the job tracker does NOT count
 * a lock-held skip as a failure and falsely escalate to logger.error.
 */
export const WIKI_INGEST_LOCK_HELD_MESSAGE = 'Ingestion already running (Redis lock held)';
const LAST_RUN_KEY     = 'fo76:wiki:ingest:last-run';
const LOCK_TTL_SEC     = 10_800; // 3h
const MIN_INTERVAL_SEC = 3_600;  // 1h
const UPDATE_CACHE_KEY = 'fo76:wiki:updates:cache';
const UPDATE_CACHE_TTL = 300;    // 5 min

/** Max raw wikitext bytes accepted from Fandom (security: response size cap). */
const MAX_WIKITEXT_BYTES = 2 * 1024 * 1024; // 2 MB

/** Max infobox field value length stored in DB (trim, don't drop). */
const MAX_FIELD_VALUE_LEN = 500;

/** Seed categories per spec §1.2 */
const SEED_CATEGORIES = [
  'Fallout 76 weapons',
  'Fallout 76 armor and clothing',
  'Fallout 76 creatures',
  'Fallout 76 items',
  'Fallout 76 locations',
  'Fallout 76 perks',
  'Fallout 76 characters',
  'Fallout 76 events',
  'Fallout 76 quests',
  // ── Expanded coverage (audit-driven) ──────────────────────────────────────
  'Fallout 76 mutations',
  // Items collapse to kind='item' / 'plan' (existing handling):
  'Fallout 76 junk items',
  'Fallout 76 holotapes',
  'Fallout 76 notes',
  'Fallout 76 weapon mods',
  'Fallout 76 armor mods',
  'Fallout 76 consumables',
  'Fallout 76 aid items',
  'Fallout 76 headwear',
  'Fallout 76 bobbleheads',
  'Fallout 76 serums',
  'Fallout 76 perk magazines',
  'Fallout 76 crafting components',
  'Fallout 76 weapon plans',
  'Fallout 76 armor plans',
  'Fallout 76 power armor',
  // Quest-kind (the real events live here — the 'events' seed cat is a 2-page stub):
  'Fallout 76 public events',
  'Fallout 76 activities',
  // New kinds (inferKind + KIND_FIELDS handle these):
  'Fallout 76 ammunition',
  'Fallout 76 factions',
  'Fallout 76 radio stations',
  'Fallout 76 workshop objects',
  'Fallout 76 miscellaneous world objects',
  'Fallout 76 vehicles',
  // Robots/computers are enemies under gameplay, NOT under 'creatures' — a real
  // gap (~155 mechanical enemies). {{Infobox creature|type=robot}} → kind creature.
  'Fallout 76 robots and computers',
  'Fallout 76 currency items',
];

// ── HTTP helpers (delegated to shared fandomApiClient) ─────────────────────────

function apiGet(params: Record<string, string>): Promise<any | null> {
  return fandomApiGet(params, FETCH_TIMEOUT_MS) as Promise<any | null>;
}

function apiGetWithBackoff(params: Record<string, string>, attempt = 0): Promise<any | null> {
  return fandomApiGetWithBackoff(params, FETCH_TIMEOUT_MS, attempt) as Promise<any | null>;
}

// ── Category walk ──────────────────────────────────────────────────────────────

/**
 * Recursively enumerate all page titles in a Fandom category (and its
 * subcategories) to unlimited depth. Returns a de-duped Set of page titles
 * (namespace 0 only — subcat titles are never included).
 *
 * A visitedCats Set prevents revisiting the same subcategory via multiple paths
 * and breaks cycles in the category graph. Each category is fully paginated via
 * cmcontinue (cmlimit=500/page) so large categories are never truncated.
 * MAX_CATEGORY_DEPTH is a safety valve against unexpected graph cycles.
 */
async function walkCategory(
  category     : string,
  depth        = 0,
  pages        = new Set<string>(),
  visitedCats  = new Set<string>(),
): Promise<Set<string>> {
  if (depth > MAX_CATEGORY_DEPTH) return pages;
  if (visitedCats.has(category)) return pages;
  visitedCats.add(category);

  let cmcontinue: string | undefined;
  do {
    const params: Record<string, string> = {
      action:  'query',
      list:    'categorymembers',
      cmtitle: `Category:${category}`,
      cmtype:  'page|subcat',
      cmlimit: '500',
    };
    if (cmcontinue) params['cmcontinue'] = cmcontinue;

    const json = await apiGetWithBackoff(params);
    if (!json) break; // transient API failure — stop paginating this category

    const members: Array<{ title: string; ns: number }> = json?.query?.categorymembers ?? [];

    for (const member of members) {
      if (member.ns === 14) {
        // Subcat — strip 'Category:' prefix and recurse (shares visitedCats)
        const subcatName = member.title.replace(/^Category:/, '');
        await walkCategory(subcatName, depth + 1, pages, visitedCats);
      } else if (member.ns === 0) {
        // Article page (ns=0 only; skip File/Template/etc. that might sneak in)
        pages.add(member.title);
      }
    }

    cmcontinue = json?.continue?.cmcontinue;
    if (cmcontinue) await sleep(THROTTLE_MS);
  } while (cmcontinue);

  return pages;
}

// ── Alias generation ───────────────────────────────────────────────────────────

/**
 * Auto-generate alias strings from a display name.
 * Rules: strip "(Fallout 76)" suffix, trivial plural/singular.
 * Returns unique, non-empty strings (excluding the name itself).
 */
export function generateAliases(name: string): string[] {
  const aliases = new Set<string>();
  // Strip ANY trailing disambiguation suffix — "(Fallout 76)", "(Wastelanders)",
  // "(Steel Dawn)", etc. — so e.g. "Beckett (Wastelanders)" gets a clean "Beckett"
  // alias and an exact search for "beckett" matches it.
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (stripped && stripped.toLowerCase() !== name.toLowerCase()) {
    aliases.add(stripped);
  }
  // Plural: add 's' suffix if not already ending in s/es
  for (const candidate of [name, stripped]) {
    if (!candidate) continue;
    if (!candidate.endsWith('s')) aliases.add(candidate + 's');
    if (candidate.endsWith('s') && candidate.length > 2) {
      aliases.add(candidate.slice(0, -1)); // singular guess
    }
  }
  aliases.delete(name); // never alias to itself
  return [...aliases].filter(a => a.length > 0);
}

// ── Normalize display name ─────────────────────────────────────────────────────

function normalizeName(title: string): string {
  return title.replace(/\s*\(Fallout 76\)\s*/i, '').trim() || title;
}

// ── Per-entity ingest ──────────────────────────────────────────────────────────

interface PageMeta {
  pageId:   number;
  title:    string;
  fullUrl:  string;
  revId:    number | null;
  imageUrl: string | null;
  imgWidth:  number | null;
  imgHeight: number | null;
}

async function fetchPageMeta(title: string): Promise<PageMeta | null> {
  const json = await apiGetWithBackoff({
    action:      'query',
    prop:        'pageimages|info|revisions',
    inprop:      'url',
    piprop:      'original',
    rvprop:      'ids',
    rvlimit:     '1',
    redirects:   '1',
    titles:      title,
  });

  const page: any = json?.query?.pages ? Object.values(json.query.pages)[0] : null;
  if (!page || page.missing !== undefined) return null;

  const latestRev = Array.isArray(page.revisions) ? page.revisions[0] : null;

  return {
    pageId:    page.pageid,
    title:     page.title,
    fullUrl:   page.fullurl ?? `https://fallout.fandom.com/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    revId:     latestRev?.revid ?? null,
    imageUrl:  page.original?.source ?? null,
    imgWidth:  page.original?.width  ?? null,
    imgHeight: page.original?.height ?? null,
  };
}

async function fetchWikitext(title: string): Promise<string | null> {
  const json = await apiGetWithBackoff({
    action:  'parse',
    page:    title,
    prop:    'wikitext',
    section: '0',
  });
  const raw: string = json?.parse?.wikitext?.['*'] ?? '';
  if (raw.length > MAX_WIKITEXT_BYTES) {
    logger.warn({ title, bytes: raw.length }, '[wikiIngest] wikitext exceeds size cap, skipping');
    return null;
  }
  return raw;
}

// ── Additional image fetching ──────────────────────────────────────────────────

/**
 * Fetch all image File: titles listed on a page via prop=images, then resolve
 * each to its URL + dimensions via prop=imageinfo. Returns raw descriptors
 * ready for filterPageImages().
 *
 * Two API calls per entity. Returns [] on any failure (non-fatal caller).
 */
async function fetchAllPageImages(title: string): Promise<RawPageImage[]> {
  // Step 0: full page wikitext, used to keep only DIRECTLY-referenced (content)
  // images and drop template-injected currency/UI/sprite/logo assets.
  let fullWikitext = '';
  try {
    const wtJson = await apiGetWithBackoff({ action: 'parse', page: title, prop: 'wikitext', redirects: '1' });
    fullWikitext = wtJson?.parse?.wikitext?.['*'] ?? '';
  } catch { /* best-effort; empty wikitext = no content filter */ }

  // Step 1: get the list of File: titles on the page
  const listJson = await apiGetWithBackoff({
    action:   'query',
    titles:   title,
    prop:     'images',
    imlimit:  '50',
    redirects: '1',
  });
  const page: any = listJson?.query?.pages ? Object.values(listJson.query.pages)[0] : null;
  const imageTitles: string[] = (page?.images ?? []).map((img: any) => img.title as string);
  if (imageTitles.length === 0) return [];

  // Step 2: resolve each File: title to imageinfo (batch in chunks of 50)
  const results: RawPageImage[] = [];
  const CHUNK = 50;
  for (let i = 0; i < imageTitles.length; i += CHUNK) {
    const chunk = imageTitles.slice(i, i + CHUNK);
    const infoJson = await apiGetWithBackoff({
      action:  'query',
      titles:  chunk.join('|'),
      prop:    'imageinfo',
      iiprop:  'url|size|mime',
    });
    const infoPages: Record<string, any> = infoJson?.query?.pages ?? {};
    for (const p of Object.values(infoPages)) {
      const ii = p?.imageinfo?.[0];
      if (!ii?.url) continue;
      results.push({
        title:  p.title ?? '',
        url:    ii.url,
        width:  ii.width  ?? 0,
        height: ii.height ?? 0,
        mime:   ii.mime   ?? '',
      });
    }
    if (i + CHUNK < imageTitles.length) await sleep(THROTTLE_MS);
  }
  // Keep only images directly referenced in the page source (content images).
  return filterContentImages(results, fullWikitext);
}

// ── Locations section fetching ─────────────────────────────────────────────────

/**
 * Fetch the Locations section wikitext for a page and parse bullet items.
 * Two API calls: sections list + section wikitext. Returns [] if no section
 * found or on any failure.
 */
async function fetchLocations(title: string): Promise<WikiLocationSegment[][]> {
  // Step 1: get section list
  const secJson = await apiGetWithBackoff({
    action: 'parse',
    page:   title,
    prop:   'sections',
  });
  const sections: Array<{ index: string; line: string }> = secJson?.parse?.sections ?? [];
  const locSection = sections.find(s => /^locations$/i.test(s.line.trim()));
  if (!locSection) return [];

  // Step 2: fetch that section's wikitext using .index (NOT .number)
  const wtJson = await apiGetWithBackoff({
    action:  'parse',
    page:    title,
    prop:    'wikitext',
    section: locSection.index,
  });
  const wikitext: string = wtJson?.parse?.wikitext?.['*'] ?? '';
  return parseLocationsSection(wikitext);
}

function sanitizeFields(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    // cleanWikitextValue already stripped markup; just truncate long values
    out[k] = v.slice(0, MAX_FIELD_VALUE_LEN);
  }
  return out;
}

// ── Main ingestion run ─────────────────────────────────────────────────────────

export interface IngestResult {
  pagesFound:   number;
  upserted:     number;
  skipped:      number;
  errors:       number;
  markedStale:  number;
  durationMs:   number;
}

export async function runWikiIngestion(titlesOverride?: string[]): Promise<IngestResult> {
  const runStart = new Date();
  const redis    = await getRedisClient();

  // ── Redis distributed lock ──
  const runId  = crypto.randomUUID();
  const locked = await redis.set(LOCK_KEY, runId, { NX: true, EX: LOCK_TTL_SEC });
  if (!locked) {
    logger.info('[wikiIngest] another ingestion run is already active (lock held), aborting');
    throw new Error(WIKI_INGEST_LOCK_HELD_MESSAGE);
  }

  try {
    logger.info('[wikiIngest] starting ingestion run');

    // ── Enumerate pages: targeted override (fast, for testing) or full category walk ──
    const allTitles = new Set<string>();
    if (titlesOverride && titlesOverride.length > 0) {
      titlesOverride.forEach(t => allTitles.add(t));
      logger.info({ count: allTitles.size }, '[wikiIngest] using targeted title override (skipping category walk)');
    } else {
      for (const cat of SEED_CATEGORIES) {
        logger.info({ cat }, '[wikiIngest] walking category');
        const titles = await walkCategory(cat);
        titles.forEach(t => allTitles.add(t));
        logger.info({ cat, count: titles.size }, '[wikiIngest] category enumerated');
        await sleep(THROTTLE_MS);
      }
    }

    logger.info({ total: allTitles.size }, '[wikiIngest] total pages to process');

    let upserted = 0, skipped = 0, errors = 0;
    let processed = 0;
    const totalTitles = allTitles.size;

    // ── Per-title worker (extracted for concurrent pool) ──────────────────────
    async function processTitle(title: string): Promise<void> {
      await sleep(THROTTLE_MS);

      try {
        // 1) Fetch metadata + revision id (for change detection)
        const meta = await fetchPageMeta(title);
        if (!meta) { skipped++; return; }

        // 2) Look up existing row early — needed for revId fast-skip
        // Cast to any: rev_id column exists in DB after migration but the
        // Prisma client won't reflect it until `prisma generate` is re-run;
        // the cast is safe because the column is nullable integer.
        const existing = await prisma.wikiEntry.findUnique({ where: { pageId: meta.pageId } }) as any;

        // revId fast-skip: if the Fandom revision id hasn't changed AND we
        // already have an imageUrl, skip the heavy wikitext fetch entirely.
        if (
          existing?.revId != null &&
          meta.revId != null &&
          existing.revId === meta.revId &&
          existing.imageUrl
        ) {
          await prisma.wikiEntry.update({
            where: { pageId: meta.pageId },
            data:  { ingestedAt: new Date(), isStale: false },
          });
          skipped++;
          return;
        }

        // 3) Fetch wikitext
        const wikitext = await fetchWikitext(meta.title);
        if (wikitext === null) { skipped++; return; }

        // Parse infobox — reject cross-game/disambiguation pages using the
        // shared isFo76Content() predicate (pure, unit-tested in wikiParser.test.ts).
        // Accepts: FO76-specific infobox templates (e.g. "Infobox weapon FO76")
        // AND shared infoboxes whose `games` field includes the FO76 token.
        // Rejects: no-infobox pages (kind=null), pure cross-game pages.
        const parsed = parseInfobox(wikitext);
        const { kind, templateName } = parsed;
        if (!isFo76Content(parsed)) {
          logger.debug({ title: meta.title, templateName, kind }, '[wikiIngest] rejected (not FO76 content)');
          skipped++;
          return;
        }

        // ── Perk expand: {{Perks/Infobox|<Title>}} is a transclusion with no
        // inline fields — use action=expandtemplates to recover stat data.
        // Guard: page is a perk (kind==='perk' OR raw wikitext contains the
        // template) AND the parsed infobox came back empty/sparse (0 fields).
        // perkCardImageFilename: set when the expanded XML contains an <image>
        // element; consumed by the image carousel block below.
        let perkCardImageFilename: string | null = null;
        if (
          (kind === 'perk' || /\{\{Perks\/Infobox/i.test(wikitext)) &&
          Object.keys(parsed.fields).length === 0
        ) {
          try {
            await sleep(THROTTLE_MS);
            // The perk-data module is keyed by the perk's base name, NOT the page
            // title — a disambiguated title like "Mad Scientist (perk)" won't match.
            // Prefer the page's own {{Perks/Infobox|ARG}} arg; else use the title
            // with any trailing "(…)" suffix stripped.
            const perkArgMatch = wikitext.match(/\{\{Perks\/Infobox\s*\|\s*([^}|]+?)\s*\}\}/i);
            const perkArg = perkArgMatch?.[1]?.trim() || meta.title.replace(/\s*\([^)]*\)\s*$/, '').trim();
            const expandJson = await apiGetWithBackoff({
              action: 'expandtemplates',
              prop:   'wikitext',
              text:   `{{Perks/Infobox|${perkArg}}}`,
            });
            const expandedXml: string = (expandJson as any)?.expandtemplates?.wikitext ?? '';
            if (expandedXml) {
              const expandedFields = parseExpandedPerkInfobox(expandedXml);
              if (Object.keys(expandedFields).length > 0) {
                // Merge expanded fields over the empty infobox; sanitize inline.
                for (const [k, v] of Object.entries(expandedFields)) {
                  parsed.fields[k] = v.slice(0, MAX_FIELD_VALUE_LEN);
                }
                logger.debug({ title: meta.title, fieldCount: Object.keys(expandedFields).length }, '[wikiIngest] perk expand succeeded');
              }
              // Extract perk card image filename from the expanded XML.
              // The <image> element is only present in the expanded infobox —
              // it is NOT referenced in the page wikitext, so the normal image
              // pipeline misses it.  Pattern handles optional <default> wrapper.
              const imgMatch = expandedXml.match(
                /<image>\s*(?:<default>)?\s*([^<\s][^<]*?\.(?:png|jpg|jpeg|webp|gif))\s*(?:<\/default>)?\s*<\/image>/i,
              );
              if (imgMatch) {
                perkCardImageFilename = imgMatch[1].trim();
                logger.debug({ title: meta.title, perkCardImageFilename }, '[wikiIngest] perk card image filename found in expanded XML');
              }
            }
          } catch (expandErr) {
            logger.warn({ expandErr, title: meta.title }, '[wikiIngest] perk expandtemplates failed (non-fatal)');
          }
        }

        // Compute content hash
        const contentHash = crypto.createHash('sha256').update(wikitext).digest('hex');

        // existing was already fetched above for revId fast-skip; use it for hash change-detection
        const hashUnchanged = existing?.contentHash === contentHash;

        // 6) Mirror image (skip re-download if hash unchanged)
        let imageResult = {
          imageUrl:       existing?.imageUrl       ?? null,
          imageMime:      existing?.imageMime      ?? null,
          imageWidth:     existing?.imageWidth     ?? null,
          imageHeight:    existing?.imageHeight    ?? null,
          imageAspect:    (existing?.imageAspect   ?? 'unknown') as string,
          imageSourceUrl: existing?.imageSourceUrl ?? null,
        };

        if (meta.imageUrl && (!hashUnchanged || !existing?.imageUrl)) {
          if (DEFER_IMAGES) {
            // Deferred mode: store the Fandom source URL directly — no network
            // download, no MinIO upload. The image proxy falls back to the Fandom
            // CDN for rows whose url does not contain 'wiki-images/'.
            imageResult = {
              imageUrl:       meta.imageUrl,
              imageMime:      null,
              imageWidth:     meta.imgWidth  ?? null,
              imageHeight:    meta.imgHeight ?? null,
              imageAspect:    deriveImageAspect(meta.imgWidth, meta.imgHeight),
              imageSourceUrl: meta.imageUrl,
            };
          } else {
            const mirrored = await mirrorWikiImage(
              meta.pageId,
              meta.imageUrl,
              existing?.contentHash ?? null,
              meta.imgWidth,
              meta.imgHeight,
            );
            imageResult = {
              // Fall back to the source URL when MinIO mirroring is unavailable so
              // the primary image / search thumbnail still renders.
              imageUrl:       mirrored.imageUrl ?? mirrored.imageSourceUrl,
              imageMime:      mirrored.imageMime,
              imageWidth:     mirrored.imageWidth,
              imageHeight:    mirrored.imageHeight,
              imageAspect:    mirrored.imageAspect,
              imageSourceUrl: mirrored.imageSourceUrl,
            };
          }
        }

        // If hash unchanged, just touch ingestedAt (and store revId if we now have it)
        if (hashUnchanged && existing) {
          await prisma.wikiEntry.update({
            where: { pageId: meta.pageId },
            // revId not yet in generated client — cast until next prisma generate
            data:  { ingestedAt: new Date(), isStale: false, ...(meta.revId != null ? { revId: meta.revId } as any : {}) },
          });
          skipped++;
          return;
        }

        const sanitizedFields = sanitizeFields(parsed.fields);
        const displayName     = normalizeName(meta.title);

        // 8) Upsert on page_id
        // revId spread: not yet in the generated Prisma client type (pending
        // `prisma generate` after migration); cast the entire args to any to
        // keep the field without a TS error. Remove the cast after the next
        // prisma generate cycle.
        const upsertArgs: any = {
          where: { pageId: meta.pageId },
          create: {
            wikiTitle:      meta.title,
            pageId:         meta.pageId,
            name:           displayName,
            kind,
            infobox:        sanitizedFields,
            imageUrl:       imageResult.imageUrl,
            imageMime:      imageResult.imageMime,
            imageWidth:     imageResult.imageWidth,
            imageHeight:    imageResult.imageHeight,
            imageAspect:    imageResult.imageAspect,
            imageSourceUrl: imageResult.imageSourceUrl,
            contentHash,
            revId:          meta.revId,
            isStale:        false,
            ingestedAt:     new Date(),
          },
          update: {
            wikiTitle:      meta.title,
            name:           displayName,
            kind,
            infobox:        sanitizedFields,
            imageUrl:       imageResult.imageUrl,
            imageMime:      imageResult.imageMime,
            imageWidth:     imageResult.imageWidth,
            imageHeight:    imageResult.imageHeight,
            imageAspect:    imageResult.imageAspect,
            imageSourceUrl: imageResult.imageSourceUrl,
            contentHash,
            revId:          meta.revId,
            isStale:        false,
            ingestedAt:     new Date(),
          },
        };
        const upserted_entry = await prisma.wikiEntry.upsert(upsertArgs);

        // 9) Auto-generate aliases
        const aliasStrings = generateAliases(displayName);
        for (const alias of aliasStrings) {
          await prisma.wikiAlias.upsert({
            where:  { alias_wikiEntryId: { alias, wikiEntryId: upserted_entry.id } },
            create: { alias, wikiEntryId: upserted_entry.id, source: 'auto' },
            update: {},
          });
        }

        // 10) Fetch + populate multi-image carousel
        try {
          const rawImages = await fetchAllPageImages(meta.title);
          const kept = filterPageImages(rawImages);

          // Position 0 = primary (infobox / pageimages image first, if present)
          // Build ordered list: primary (from meta.imageUrl source) goes first, rest follow
          const primarySourceUrl = meta.imageUrl;
          const ordered: RawPageImage[] = [];
          if (primarySourceUrl) {
            const primaryRaw = kept.find(img => img.url === primarySourceUrl);
            if (primaryRaw) ordered.push(primaryRaw);
          }
          for (const img of kept) {
            if (!ordered.includes(img)) ordered.push(img);
          }

          // ── Perk card image injection ────────────────────────────────────────
          // When the expanded perk infobox XML contained an <image> filename and
          // the normal image pipeline found no images (perks rarely reference
          // images directly in wikitext), resolve the File: title to a CDN URL
          // via imageinfo and mirror it to MinIO at position 0.
          if (perkCardImageFilename && ordered.length === 0) {
            try {
              await sleep(THROTTLE_MS);
              // Resolve File:<filename> → CDN URL + dimensions via imageinfo.
              // MediaWiki treats underscores and spaces as equivalent in File titles.
              const fileTitle = `File:${perkCardImageFilename}`;
              const infoJson = await apiGetWithBackoff({
                action: 'query',
                titles: fileTitle,
                prop:   'imageinfo',
                iiprop: 'url|size|mime',
              });
              const infoPages: Record<string, any> = (infoJson as any)?.query?.pages ?? {};
              const infoPage = Object.values(infoPages)[0] as any;
              const ii = infoPage?.imageinfo?.[0];
              if (ii?.url) {
                const cdnUrl  = ii.url as string;
                const imgW    = (ii.width  as number) || null;
                const imgH    = (ii.height as number) || null;
                const imgMime = (ii.mime   as string) || null;

                await sleep(THROTTLE_MS);
                let perkCardRow: {
                  url: string; sourceUrl: string | null; mime: string | null;
                  width: number | null; height: number | null;
                  aspect: string; isMap: boolean; position: number;
                };
                if (DEFER_IMAGES) {
                  perkCardRow = {
                    url:       cdnUrl,
                    sourceUrl: cdnUrl,
                    mime:      imgMime,
                    width:     imgW,
                    height:    imgH,
                    aspect:    deriveImageAspect(imgW, imgH),
                    isMap:     false,
                    position:  0,
                  };
                } else {
                  const mirrored = await mirrorWikiImage(meta.pageId, cdnUrl, null, imgW, imgH);
                  perkCardRow = {
                    url:       mirrored.imageUrl ?? cdnUrl,
                    sourceUrl: mirrored.imageUrl ? cdnUrl : null,
                    mime:      mirrored.imageMime ?? imgMime,
                    width:     mirrored.imageWidth ?? imgW,
                    height:    mirrored.imageHeight ?? imgH,
                    aspect:    mirrored.imageAspect,
                    isMap:     false,
                    position:  0,
                  };
                }

                // Write the wiki_images row immediately (the ordered loop below
                // will produce no rows since ordered.length === 0).
                await prisma.wikiImage.deleteMany({ where: { wikiEntryId: upserted_entry.id } });
                await prisma.wikiImage.create({
                  data: {
                    wikiEntryId: upserted_entry.id,
                    url:         perkCardRow.url,
                    sourceUrl:   perkCardRow.sourceUrl,
                    mime:        perkCardRow.mime,
                    width:       perkCardRow.width,
                    height:      perkCardRow.height,
                    aspect:      perkCardRow.aspect,
                    isMap:       false,
                    position:    0,
                  },
                });

                // Also populate the entry-level image fields so the primary
                // image thumbnail + aspect layout work on search/detail views.
                await prisma.wikiEntry.update({
                  where: { id: upserted_entry.id },
                  data: {
                    imageUrl:       perkCardRow.url,
                    imageSourceUrl: perkCardRow.sourceUrl,
                    imageMime:      perkCardRow.mime,
                    imageWidth:     perkCardRow.width,
                    imageHeight:    perkCardRow.height,
                    imageAspect:    perkCardRow.aspect,
                  } as any,
                });

                logger.debug(
                  { title: meta.title, perkCardImageFilename, url: perkCardRow.url },
                  '[wikiIngest] perk card image mirrored',
                );
              } else {
                logger.debug({ title: meta.title, fileTitle }, '[wikiIngest] perk card image: imageinfo returned no URL (skipped)');
              }
            } catch (perkImgErr) {
              logger.warn({ perkImgErr, title: meta.title, perkCardImageFilename }, '[wikiIngest] perk card image mirror failed (non-fatal)');
            }
          }

          // Mirror each image to MinIO; never abort on individual failure.
          // In deferred mode, store the Fandom source URL as url + sourceUrl
          // so the image proxy can fall back to the Fandom CDN immediately.
          interface ImageRow {
            url: string;          // never null — falls back to sourceUrl on mirror failure
            sourceUrl: string | null;
            mime: string | null;
            width: number | null;
            height: number | null;
            aspect: string;
            isMap: boolean;
            position: number;
          }
          const imageRows: ImageRow[] = [];
          for (let pos = 0; pos < ordered.length; pos++) {
            const img = ordered[pos];
            if (DEFER_IMAGES) {
              // No download — store Fandom source URL directly.
              imageRows.push({
                url:       img.url,
                sourceUrl: img.url,
                mime:      img.mime || null,
                width:     img.width  || null,
                height:    img.height || null,
                aspect:    deriveImageAspect(img.width, img.height),
                isMap:     isMapImage(img.title),
                position:  pos,
              });
            } else {
              // mirrorWikiImage never throws — returns imageUrl=null on failure
              const mirrored = await mirrorWikiImage(meta.pageId, img.url, null, img.width, img.height);
              // On mirror failure, store sourceUrl as the url fallback so the column is always populated
              imageRows.push({
                url:       mirrored.imageUrl ?? img.url,
                sourceUrl: mirrored.imageUrl ? img.url : null,
                mime:      mirrored.imageMime,
                width:     mirrored.imageWidth,
                height:    mirrored.imageHeight,
                aspect:    mirrored.imageAspect,
                isMap:     isMapImage(img.title),
                position:  pos,
              });
              await sleep(THROTTLE_MS);
            }
          }

          // Replace wiki_images rows: delete-then-insert
          await prisma.wikiImage.deleteMany({ where: { wikiEntryId: upserted_entry.id } });
          if (imageRows.length > 0) {
            await prisma.wikiImage.createMany({
              data: imageRows.map(r => ({
                wikiEntryId: upserted_entry.id,
                url:         r.url,
                sourceUrl:   r.sourceUrl,
                mime:        r.mime,
                width:       r.width,
                height:      r.height,
                aspect:      r.aspect,
                isMap:       r.isMap,
                position:    r.position,
              })),
            });
          }

          logger.debug({ title: meta.title, imageCount: imageRows.length }, '[wikiIngest] images populated');
        } catch (imgErr) {
          logger.warn({ imgErr, title: meta.title }, '[wikiIngest] image carousel population failed (non-fatal)');
        }

        // 11) Fetch + populate locations
        try {
          const locations = await fetchLocations(meta.title);
          await prisma.wikiEntry.update({
            where: { id: upserted_entry.id },
            // Cast: named segment interface lacks the index signature Prisma's
            // InputJsonValue wants; the value is plain JSON-serializable data.
            data:  { locations: locations as unknown as object[] },
          });
          if (locations.length > 0) {
            logger.debug({ title: meta.title, locationCount: locations.length }, '[wikiIngest] locations populated');
          }
        } catch (locErr) {
          logger.warn({ locErr, title: meta.title }, '[wikiIngest] locations population failed (non-fatal)');
        }

        upserted++;
        logger.debug({ title: meta.title, pageId: meta.pageId }, '[wikiIngest] upserted');
      } catch (err) {
        errors++;
        logger.warn({ err, title }, '[wikiIngest] per-entity error (logged, continuing)');

        // Write to wiki_ingest_errors — best-effort (we already have the title but may not know pageId)
        try {
          // Try to parse a pageId from a prior meta fetch; fall back to -1 sentinel
          await prisma.wikiIngestError.create({
            data: {
              pageId:      -1,
              error:       String(err instanceof Error ? err.message : err).slice(0, 1000),
              attemptedAt: new Date(),
            },
          });
        } catch { /* non-fatal */ }
      } finally {
        processed++;
        if (processed % 500 === 0 || processed === totalTitles) {
          logger.info(
            { processed, totalTitles, upserted, skipped, errors },
            '[wikiIngest] progress',
          );
        }
      }
    }

    // ── Concurrency pool (INGEST_CONCURRENCY = 5) ────────────────────────────
    // Each worker drains from the iterator; THROTTLE_MS stagger is applied
    // inside processTitle so workers naturally spread requests in time.
    const titleIter = allTitles[Symbol.iterator]();
    async function worker(): Promise<void> {
      while (true) {
        const { value: title, done } = titleIter.next();
        if (done) return;
        await processTitle(title);
      }
    }
    await Promise.all(
      Array.from({ length: INGEST_CONCURRENCY }, () => worker()),
    );

    // ── Mark stale ── (only on a FULL run; a targeted run must not flag every
    // other entry as stale just because it wasn't in the requested set)
    const staleResult = (titlesOverride && titlesOverride.length > 0)
      ? { count: 0 }
      : await prisma.wikiEntry.updateMany({
          where: { ingestedAt: { lt: runStart } },
          data:  { isStale: true },
        });

    // ── Update last-run timestamp ──
    await redis.set(LAST_RUN_KEY, String(Date.now()), { EX: LOCK_TTL_SEC * 10 });

    const durationMs = Date.now() - runStart.getTime();
    const result: IngestResult = {
      pagesFound:  allTitles.size,
      upserted,
      skipped,
      errors,
      markedStale: staleResult.count,
      durationMs,
    };
    logger.info(result, '[wikiIngest] run complete');
    return result;
  } finally {
    // Release lock only if we still hold it (don't clobber another run)
    const current = await redis.get(LOCK_KEY);
    if (current === runId) await redis.del(LOCK_KEY);
  }
}

// ── Wiki update status ─────────────────────────────────────────────────────────

export interface WikiUpdateStatus {
  lastSyncAt:        string | null; // ISO 8601 UTC or null if never synced
  updatesAvailable:  number;        // total distinct changed+new titles
  changedPages:      number;        // edits to existing pages
  newPages:          number;        // newly created pages
  checkedAt:         string;        // ISO 8601 UTC timestamp of this check
}

// Title carries an explicit FO76 marker (covers new pages not yet in our catalog).
const FO76_TITLE_SIGNAL = /Fallout 76|FO76|\bF76\b/i;

/**
 * Fetch Fandom recentchanges since `lastRunMs` and filter to FO76-RELEVANT pages.
 * This is the SINGLE source of truth shared by getWikiUpdateStatus (the badge
 * count) and runIncrementalSync (what gets processed) — so "N updates available"
 * always equals what a "Sync now" will actually pull. Fandom's ns=0 feed spans
 * the WHOLE Fallout wiki (all games/templates), so we keep only titles already
 * in our FO76 catalog OR whose title carries an FO76 signal. Created-then-edited
 * pages in the window are counted as new.
 */
async function fetchFo76RecentChanges(lastRunMs: number): Promise<{ changedTitles: string[]; newTitles: string[] }> {
  const json = await apiGetWithBackoff({
    action:      'query',
    list:        'recentchanges',
    rcnamespace: '0',
    rctype:      'edit|new',
    rcstart:     new Date().toISOString(),
    rcend:       new Date(lastRunMs).toISOString(),
    rclimit:     '500',
    rcprop:      'title|timestamp|type',
    rcdir:       'older',  // newest→oldest so we get the most recent 500
  });
  const changes: Array<{ title: string; type: string }> = json?.query?.recentchanges ?? [];

  const editSet = new Set<string>();
  const newSet  = new Set<string>();
  for (const rc of changes) {
    if (rc.type === 'new') newSet.add(rc.title);
    else editSet.add(rc.title);
  }
  for (const t of newSet) editSet.delete(t); // created + edited in window → treat as new

  // Keep only FO76-relevant titles: already in our catalog, or FO76-signalled.
  const allTitles = [...editSet, ...newSet];
  const known = allTitles.length
    ? new Set(
        (await prisma.wikiEntry.findMany({
          where: { wikiTitle: { in: allTitles } },
          select: { wikiTitle: true },
        })).map(e => e.wikiTitle),
      )
    : new Set<string>();
  const relevant = (t: string) => known.has(t) || FO76_TITLE_SIGNAL.test(t);

  return {
    changedTitles: [...editSet].filter(relevant),
    newTitles:     [...newSet].filter(relevant),
  };
}

/**
 * Query Fandom recentchanges since the last sync and return counts of
 * FO76-relevant changed/new pages. Result cached ~5 min in Redis.
 *
 * Returns safe zero values on Fandom error or when never synced.
 */
export async function getWikiUpdateStatus(): Promise<WikiUpdateStatus> {
  const redis = await getRedisClient();
  const checkedAt = new Date().toISOString();

  // Return cached result if fresh
  const cached = await redis.get(UPDATE_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached) as WikiUpdateStatus;
    } catch { /* fall through to fresh check */ }
  }

  const lastRunStr = await redis.get(LAST_RUN_KEY);
  if (!lastRunStr) {
    const status: WikiUpdateStatus = {
      lastSyncAt: null, updatesAvailable: 0, changedPages: 0, newPages: 0, checkedAt,
    };
    await redis.set(UPDATE_CACHE_KEY, JSON.stringify(status), { EX: UPDATE_CACHE_TTL });
    return status;
  }

  const lastSyncAt = new Date(parseInt(lastRunStr, 10)).toISOString();

  try {
    const { changedTitles, newTitles } = await fetchFo76RecentChanges(parseInt(lastRunStr, 10));

    const status: WikiUpdateStatus = {
      lastSyncAt,
      updatesAvailable: changedTitles.length + newTitles.length,
      changedPages:     changedTitles.length,
      newPages:         newTitles.length,
      checkedAt,
    };
    await redis.set(UPDATE_CACHE_KEY, JSON.stringify(status), { EX: UPDATE_CACHE_TTL });
    return status;
  } catch (err) {
    logger.warn({ err }, '[wikiIngest] getWikiUpdateStatus: Fandom query failed, returning zeros');
    const status: WikiUpdateStatus = {
      lastSyncAt,
      updatesAvailable: 0,
      changedPages:     0,
      newPages:         0,
      checkedAt,
    };
    // Cache briefly so a transient Fandom error doesn't hammer the API
    await redis.set(UPDATE_CACHE_KEY, JSON.stringify(status), { EX: 60 });
    return status;
  }
}

/**
 * Collect changed+new page titles via Fandom recentchanges since last sync,
 * filter to plausible FO76 pages, then run a targeted ingestion on that set.
 * Updates LAST_RUN_KEY on completion. Safe to call while a full sync is
 * running — the Redis lock in runWikiIngestion will no-op.
 */
export async function runIncrementalSync(): Promise<IngestResult> {
  const redis = await getRedisClient();
  const lastRunStr = await redis.get(LAST_RUN_KEY);

  let titles: string[] = [];

  if (lastRunStr) {
    try {
      const { changedTitles, newTitles } = await fetchFo76RecentChanges(parseInt(lastRunStr, 10));
      titles = [...changedTitles, ...newTitles];
      logger.info(
        { changed: changedTitles.length, new: newTitles.length, total: titles.length },
        '[wikiIngest] incremental sync: FO76-relevant titles to process',
      );
    } catch (err) {
      logger.warn({ err }, '[wikiIngest] runIncrementalSync: failed to fetch recentchanges, aborting');
      throw err;
    }
  }

  if (titles.length === 0) {
    logger.info('[wikiIngest] incremental sync: no changed pages to process');
    // Still update last-run so next check window advances
    await redis.set(LAST_RUN_KEY, String(Date.now()), { EX: LOCK_TTL_SEC * 10 });
    // Invalidate update-status cache
    await redis.del(UPDATE_CACHE_KEY);
    return { pagesFound: 0, upserted: 0, skipped: 0, errors: 0, markedStale: 0, durationMs: 0 };
  }

  const result = await runWikiIngestion(titles);
  // runWikiIngestion sets LAST_RUN_KEY internally; also invalidate update cache
  await redis.del(UPDATE_CACHE_KEY);
  return result;
}

/**
 * Check whether a new ingestion may be triggered.
 * Returns null if allowed, or an error message string if not.
 */
export async function checkIngestAllowed(): Promise<string | null> {
  const redis = await getRedisClient();

  const lockHolder = await redis.get(LOCK_KEY);
  if (lockHolder) return WIKI_INGEST_LOCK_HELD_MESSAGE;

  const lastRunStr = await redis.get(LAST_RUN_KEY);
  if (lastRunStr) {
    const elapsedSec = (Date.now() - parseInt(lastRunStr, 10)) / 1000;
    if (elapsedSec < MIN_INTERVAL_SEC) {
      const waitSec = Math.ceil(MIN_INTERVAL_SEC - elapsedSec);
      return `Ingestion rate-limited — next run allowed in ${waitSec}s`;
    }
  }

  return null;
}
