/**
 * imageStorage — shared image fetch + MinIO upload pipeline used by
 * wikiImageService and campImageService.
 *
 * Security invariants applied here (single enforcement point):
 *   1. SSRF allowlist: only static.wikia.nocookie.net, *.fandom.com, mrsblobby.github.io
 *   2. redirect: 'error' — open redirects cannot chain to internal hosts
 *   3. MIME allowlist: image/webp | image/png | image/jpeg | image/gif only
 *      (prevents storing HTML error pages masquerading as images)
 */

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET, ensureBucket } from '../config/storage';
import logger from '../config/logger';

// ── SSRF allowlist ─────────────────────────────────────────────────────────────

const ALLOWED_HOSTS = new Set([
  'static.wikia.nocookie.net',
  'mrsblobby.github.io',
]);

const ALLOWED_FANDOM_SUFFIX = '.fandom.com';

/**
 * Returns true if the URL's host is in the SSRF allowlist.
 * Exported so callers can do a pre-flight check without fetching.
 */
export function isAllowedImageHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (ALLOWED_HOSTS.has(hostname)) return true;
    if (hostname === 'fallout.fandom.com' || hostname.endsWith(ALLOWED_FANDOM_SUFFIX)) return true;
    return false;
  } catch {
    return false; // malformed URL
  }
}

// ── MIME allowlist ─────────────────────────────────────────────────────────────

const ALLOWED_MIME_PREFIXES = ['image/webp', 'image/png', 'image/jpeg', 'image/gif'];

function isAllowedMime(contentType: string): boolean {
  const ct = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_MIME_PREFIXES.some(m => ct === m);
}

// ── Bucket singleton ───────────────────────────────────────────────────────────

let _bucketReady = false;

export async function ensureBucketOnce(): Promise<void> {
  if (_bucketReady) return;
  await ensureBucket();
  _bucketReady = true;
}

// ── Core helpers ───────────────────────────────────────────────────────────────

export interface FetchImageResult {
  buf:         Buffer;
  contentType: string;
}

/**
 * Fetch a remote image with:
 *   - SSRF host allowlist check
 *   - redirect: 'error' (no open redirect chaining)
 *   - size cap (maxBytes)
 *   - MIME allowlist check
 *
 * Returns null and logs a warning on any violation.
 */
export async function fetchRemoteImage(
  url:      string,
  maxBytes: number,
  timeoutMs = 15_000,
): Promise<FetchImageResult | null> {
  // 1. SSRF allowlist
  if (!isAllowedImageHost(url)) {
    logger.warn({ url }, '[imageStorage] rejected: host not in SSRF allowlist');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      signal:   controller.signal,
      redirect: 'error',   // 2. block open redirects
      headers:  { 'User-Agent': 'FalloutChatMod/1.x (falloutchatmod.com)' },
    });
  } catch (err) {
    logger.warn({ err, url }, '[imageStorage] fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    logger.warn({ status: res.status, url }, '[imageStorage] download non-OK, skipping');
    return null;
  }

  // 3. MIME allowlist
  const contentType = res.headers.get('content-type') ?? '';
  if (!isAllowedMime(contentType)) {
    logger.warn({ contentType, url }, '[imageStorage] rejected: MIME type not allowed');
    return null;
  }

  const arrayBuf = await res.arrayBuffer();
  const buf      = Buffer.from(arrayBuf);

  if (buf.length > maxBytes) {
    logger.warn({ bytes: buf.length, url }, '[imageStorage] image exceeds size cap, skipping');
    return null;
  }

  return { buf, contentType };
}

/**
 * Upload a buffer to MinIO. Returns the key on success, null on failure (non-fatal).
 */
export async function putToMinio(
  key:         string,
  buf:         Buffer,
  contentType: string,
): Promise<string | null> {
  try {
    await ensureBucketOnce();
    await s3.send(new PutObjectCommand({
      Bucket:       BUCKET,
      Key:          key,
      Body:         buf,
      ContentType:  contentType,
      CacheControl: 'public, max-age=31536000',
    }));
    return key;
  } catch (err) {
    logger.warn({ err, key }, '[imageStorage] MinIO upload failed (non-fatal)');
    return null;
  }
}
