/**
 * campImageController — proxies a CAMP item image through our own origin.
 *
 * GET /api/camp/img/:id   (id = camp_items.id, text PK)
 *   1. Look up camp_items.image_key (MinIO object key).
 *   2. Stream from MinIO if present.
 *   3. Fallback: fetch from mrsblobby github Pages (upstream CDN).
 *   4. 404 if item unknown / no image available.
 *
 * In-memory byte cache (≤400 entries) avoids repeated MinIO round-trips for
 * popular items — mirrors the wiki image proxy pattern exactly.
 */

import { Request, Response } from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';
import { s3, BUCKET } from '../config/storage';
import prisma from '../config/prisma';
import logger from '../config/logger';

const IMAGES_BASE    = 'https://mrsblobby.github.io/76-CAMPDatabase/Live/Images/';
const FETCH_TIMEOUT  = 12_000;
const FETCH_RETRIES  = 2;
const MAX_CACHE      = 400;

// ── In-memory byte cache ──────────────────────────────────────────────────────

const byteCache = new Map<string, { buf: Buffer; contentType: string }>();

function cacheGet(id: string) { return byteCache.get(id); }
function cacheSet(id: string, buf: Buffer, ct: string) {
  if (byteCache.size >= MAX_CACHE) {
    const oldest = byteCache.keys().next().value;
    if (oldest) byteCache.delete(oldest);
  }
  byteCache.set(id, { buf, contentType: ct });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchWithRetry(url: string): Promise<{ buf: Buffer; contentType: string } | null> {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, {
        signal:  controller.signal,
        headers: { 'User-Agent': 'FalloutChatMod/1.x (falloutchatmod.com)' },
      });
      if (res.ok && res.body) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0) {
          return { buf, contentType: res.headers.get('content-type') || 'image/webp' };
        }
      }
      logger.warn({ url, status: res.status, attempt }, '[campImage] upstream non-OK');
    } catch (err) {
      logger.warn({ err, url, attempt }, '[campImage] upstream fetch error');
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function serveBytes(res: Response, buf: Buffer, contentType: string): void {
  res.setHeader('Content-Type',                  contentType);
  res.setHeader('Cache-Control',                 'public, max-age=604800');
  res.setHeader('Cross-Origin-Resource-Policy',  'cross-origin');
  res.setHeader('Content-Length',                String(buf.length));
  res.end(buf);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function getCampImage(req: Request, res: Response): Promise<void> {
  const id = String(req.params.id || '').trim();
  if (!id) { res.status(404).end(); return; }

  // 0) Hot path: in-memory byte cache
  const cached = cacheGet(id);
  if (cached) { serveBytes(res, cached.buf, cached.contentType); return; }

  // 1) DB lookup — get image_key + form_id (fallback)
  let imageKey: string | null = null;
  let formId:   string | null = null;
  try {
    const row = await prisma.campItem.findUnique({
      where:  { id },
      select: { imageKey: true, formId: true },
    });
    if (!row) { res.status(404).end(); return; }
    imageKey = row.imageKey ?? null;
    formId   = row.formId   ?? null;
  } catch (err) {
    logger.warn({ err, id }, '[campImage] db lookup failed');
    res.status(500).end();
    return;
  }

  // 2) Try MinIO if we have a key
  if (imageKey) {
    try {
      const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: imageKey }));
      if (out.Body) {
        const buf = await streamToBuffer(out.Body as Readable);
        const ct  = out.ContentType || 'image/webp';
        cacheSet(id, buf, ct);
        serveBytes(res, buf, ct);
        return;
      }
    } catch { /* fall through to upstream */ }
  }

  // 3) Fall back to upstream mrsblobby CDN — image_key encodes the formId: camp-images/<formid>.webp
  const fid = imageKey
    ? imageKey.replace(/^camp-images\/(.+)\.webp$/, '$1')
    : (formId ? formId.toLowerCase() : null);

  if (!fid) { res.status(404).end(); return; }

  const sourceUrl = `${IMAGES_BASE}${fid}.webp`;
  const result    = await fetchWithRetry(sourceUrl);
  if (!result) {
    logger.warn({ id, sourceUrl }, '[campImage] all fetch attempts failed → 502');
    res.status(502).end();
    return;
  }
  cacheSet(id, result.buf, result.contentType);
  serveBytes(res, result.buf, result.contentType);
}
