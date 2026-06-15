/**
 * backfillWikiImages — mirror deferred wiki_images rows to MinIO.
 *
 * Selects all wiki_images rows whose url does NOT contain 'wiki-images/'
 * (i.e. they hold a Fandom source URL written during a WIKI_DEFER_IMAGES
 * ingest run), then calls mirrorWikiImage for each and updates the row
 * with the MinIO url/mime/width/height/aspect.
 *
 * Usage:
 *   npx tsx src/scripts/backfillWikiImages.ts
 *
 * The script is fully RESUMABLE: re-running only processes rows that are
 * still un-mirrored (still pointing at a Fandom URL). Per-image failures
 * are logged and skipped — the Fandom CDN fallback keeps the image
 * functional until the next backfill run.
 *
 * Environment:
 *   Same .env / .env.local as the main server (MinIO credentials etc.)
 */

import '../../src/config/environment'; // load .env / .env.local
import prisma from '../config/prisma';
import logger from '../config/logger';
import { mirrorWikiImage } from '../services/wikiImageService';

// ── Config ─────────────────────────────────────────────────────────────────────

/** Number of images to mirror in parallel. */
const CONCURRENCY = 6;

/** Milliseconds between individual mirror calls (per worker). */
const THROTTLE_MS = 80;

/** Log a progress line every N images processed. */
const LOG_EVERY = 200;

// ── Un-mirrored detection ──────────────────────────────────────────────────────

/**
 * Returns true when the stored url is NOT a mirrored MinIO object.
 * Mirrors the logic in wikiImageController.minioKey():
 *   minioKey(url) is non-null iff url contains 'wiki-images/'
 */
function isUnmirrored(url: string | null | undefined): boolean {
  if (!url) return false;          // null / empty — nothing to backfill
  return url.indexOf('wiki-images/') < 0;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Fetch all un-mirrored rows in one query (IDs + fields needed for mirrorWikiImage).
  // In very large catalogs this could be batched, but even 50k rows × ~200 bytes
  // is ~10 MB — well within Node's working set.
  const rows = await prisma.wikiImage.findMany({
    select: {
      id:         true,
      url:        true,
      sourceUrl:  true,
      width:      true,
      height:     true,
      wikiEntry:  { select: { pageId: true } },
    },
  });

  const pending = rows.filter(r => isUnmirrored(r.url));
  const total   = pending.length;

  if (total === 0) {
    console.log('[backfill] No un-mirrored rows found — nothing to do.');
    await prisma.$disconnect();
    return;
  }

  console.log(`[backfill] ${total} un-mirrored wiki_images rows to process (concurrency=${CONCURRENCY})`);

  let mirrored  = 0;
  let failed    = 0;
  let processed = 0;

  // ── Concurrency pool ─────────────────────────────────────────────────────────
  const iter = pending[Symbol.iterator]();

  async function worker(): Promise<void> {
    while (true) {
      const { value: row, done } = iter.next();
      if (done) return;

      await sleep(THROTTLE_MS);

      const sourceUrl = row.url; // deferred ingest stores Fandom URL in url column
      const pageId    = row.wikiEntry.pageId;

      try {
        const result = await mirrorWikiImage(pageId, sourceUrl, null, row.width, row.height);

        if (result.imageUrl) {
          await prisma.wikiImage.update({
            where: { id: row.id },
            data: {
              url:    result.imageUrl,
              // sourceUrl stays as the Fandom CDN URL (fallback / audit trail)
              sourceUrl: sourceUrl,
              mime:   result.imageMime,
              width:  result.imageWidth,
              height: result.imageHeight,
              aspect: result.imageAspect,
            },
          });
          mirrored++;
        } else {
          // mirrorWikiImage returned no MinIO url (download/upload failed).
          // Leave the row as-is so the Fandom CDN fallback keeps serving it.
          logger.warn({ id: row.id, sourceUrl, pageId }, '[backfill] mirror returned no url — skipping row');
          failed++;
        }
      } catch (err) {
        logger.warn({ err, id: row.id, sourceUrl, pageId }, '[backfill] per-image error — skipping');
        failed++;
      }

      processed++;
      if (processed % LOG_EVERY === 0 || processed === total) {
        console.log(`[backfill] progress: ${processed}/${total} processed, ${mirrored} mirrored, ${failed} failed`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`[backfill] DONE — mirrored=${mirrored} failed=${failed} total=${total}`);
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('[backfill] fatal error:', err);
  process.exit(1);
});
