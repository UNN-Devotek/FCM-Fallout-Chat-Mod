/**
 * wikiImageController — proxies a wiki entity image through our own origin.
 *
 * Why a proxy: in dev MinIO is often unreachable, and the Fandom CDN refuses
 * hotlinked originals / is subject to the overlay CSP. Serving the bytes from
 * our backend removes all of those variables — the client only ever talks to us.
 *
 * GET /api/wiki/img/:id   (id = wiki_images.id, uuid)
 *   1. MinIO: if the stored url is a mirrored object, stream it from the bucket.
 *   2. Fallback: fetch the whitelisted Fandom CDN source and stream it.
 *   3. 404 otherwise.
 */

import { Request, Response } from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import { s3, BUCKET } from '../config/storage';
import prisma from '../config/prisma';
import logger from '../config/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FANDOM_HOST = 'static.wikia.nocookie.net';
const FETCH_TIMEOUT_MS = 12_000;
const FETCH_RETRIES = 2;

// Small in-memory byte cache so a successfully fetched image is served instantly
// and reliably on every subsequent request (the dev env has no reachable MinIO,
// so without this the proxy re-hits the Fandom CDN every time — slow + flaky).
const MAX_CACHE_ENTRIES = 400;
const byteCache = new Map<string, { buf: Buffer; contentType: string }>();
function cacheGet(id: string) { return byteCache.get(id); }
function cacheSet(id: string, buf: Buffer, contentType: string) {
  if (byteCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = byteCache.keys().next().value;
    if (oldest) byteCache.delete(oldest);
  }
  byteCache.set(id, { buf, contentType });
}

/** Fetch the source bytes with a few retries (handles transient CDN failures). */
async function fetchWithRetry(source: string): Promise<{ buf: Buffer; contentType: string } | null> {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const upstream = await fetch(source, {
        signal: controller.signal,
        headers: { 'User-Agent': 'FalloutChatMod/1.x (falloutchatmod.com)' },
      });
      if (upstream.ok && upstream.body) {
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length > 0) {
          return { buf, contentType: upstream.headers.get('content-type') || 'image/webp' };
        }
      }
      logger.warn({ source, status: upstream.status, attempt }, '[wikiImage] upstream non-OK');
    } catch (err) {
      logger.warn({ err, source, attempt }, '[wikiImage] upstream fetch error');
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function isFandomCdn(url: string | null | undefined): url is string {
  if (!url) return false;
  try { return new URL(url).hostname === FANDOM_HOST; } catch { return false; }
}

/** Extract a `wiki-images/...` MinIO key from a stored url, if present. */
function minioKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const i = url.indexOf('wiki-images/');
  return i >= 0 ? url.slice(i) : null;
}

function serveBytes(res: Response, buf: Buffer, contentType: string): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=604800');
  // The Electron overlay renderer is a DIFFERENT origin (localhost:5290) than the
  // backend, so helmet's default `Cross-Origin-Resource-Policy: same-origin` makes
  // Chromium block the <img> with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin. Allow
  // cross-origin embedding of these (public, non-sensitive) wiki images.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}

export async function getWikiImage(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || '');
  if (!UUID_RE.test(id)) { res.status(404).end(); return; }

  // 0) Hot path: serve from the in-memory byte cache.
  const cached = cacheGet(id);
  if (cached) { serveBytes(res, cached.buf, cached.contentType); return; }

  let row: { url: string; sourceUrl: string | null; mime: string | null } | null = null;
  try {
    // Only serve images whose parent entry is still valid (not stale, has a
    // recognised kind). This prevents guessing UUIDs to fetch images from
    // stale / non-FO76 entries that should not be publicly accessible.
    const img = await prisma.wikiImage.findUnique({
      where: { id },
      select: {
        url:       true,
        sourceUrl: true,
        mime:      true,
        wikiEntry: { select: { isStale: true, kind: true } },
      },
    });
    if (img && !img.wikiEntry.isStale && img.wikiEntry.kind !== null) {
      row = { url: img.url, sourceUrl: img.sourceUrl, mime: img.mime };
    }
  } catch (err) {
    logger.warn({ err, id }, '[wikiImage] db lookup failed');
  }
  if (!row) { res.status(404).end(); return; }

  // 1) Try MinIO if the url points at a mirrored object.
  const key = minioKey(row.url);
  if (key) {
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      if (out.Body) {
        const buf = await streamToBuffer(out.Body as Readable);
        const ct = out.ContentType || row.mime || 'image/webp';
        cacheSet(id, buf, ct);
        serveBytes(res, buf, ct);
        return;
      }
    } catch { /* fall through to source fetch */ }
  }

  // 2) Fall back to fetching the whitelisted Fandom CDN source (with retries).
  const source = [row.sourceUrl, row.url].find(isFandomCdn);
  if (!source) { res.status(404).end(); return; }

  const result = await fetchWithRetry(source);
  if (!result) {
    logger.warn({ id, source }, '[wikiImage] all fetch attempts failed → 502');
    res.status(502).end();
    return;
  }
  cacheSet(id, result.buf, result.contentType);
  serveBytes(res, result.buf, result.contentType);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
