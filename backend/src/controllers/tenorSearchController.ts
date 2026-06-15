import { Request, Response, NextFunction } from 'express';
import env from '../config/environment';
import logger from '../config/logger';

// ---------------------------------------------------------------------------
// LRU cache (Map + insertion-order key list, capped at 200 entries, 5 min TTL)
// ---------------------------------------------------------------------------

interface TenorResult {
  id: string;
  url: string;
  preview: string;
  width: number;
  height: number;
}

interface TenorCacheEntry {
  data: TenorResult[];
  next: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_CAP = 200;

const tenorCache = new Map<string, TenorCacheEntry>();
const cacheKeys: string[] = [];

function cachePut(key: string, entry: TenorCacheEntry): void {
  if (tenorCache.has(key)) {
    // Move to end of insertion-order list
    const idx = cacheKeys.indexOf(key);
    if (idx !== -1) cacheKeys.splice(idx, 1);
  } else if (tenorCache.size >= CACHE_CAP) {
    // Evict oldest
    const oldest = cacheKeys.shift();
    if (oldest !== undefined) tenorCache.delete(oldest);
  }
  tenorCache.set(key, entry);
  cacheKeys.push(key);
}

// ---------------------------------------------------------------------------
// Tenor API response shapes (minimal — only what we need)
// ---------------------------------------------------------------------------

interface TenorMediaFmt {
  url: string;
  dims: [number, number];
  preview?: string;
}

interface TenorMediaFormats {
  gif?: TenorMediaFmt;
  tinygif?: TenorMediaFmt;
  mediumgif?: TenorMediaFmt;
  nanogif?: TenorMediaFmt;
}

interface TenorResultItem {
  id: string;
  media_formats: TenorMediaFormats;
}

interface TenorSearchResponse {
  results: TenorResultItem[];
  next?: string;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * GET /api/tenor-search?q=<query>&pos=<cursor>
 * Server-side proxy to Tenor v2. Returns 24 GIFs per page.
 * 503 if TENOR_API_KEY is not configured.
 */
async function tenorSearch(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!env.TENOR_API_KEY) {
      res.status(503).json({
        data: [],
        error: 'tenor_not_configured',
        message: 'Tenor API key is not set on the server.',
      });
      return;
    }

    // Validate + sanitise query
    const raw = (req.query.q as string | undefined) ?? '';
    const q = raw.replace(/[&<>"']/g, '').trim().slice(0, 64);
    if (!q) {
      res.status(400).json({ error: 'bad_request', message: 'q is required (1..64 chars)' });
      return;
    }

    const pos = (req.query.pos as string | undefined) ?? '';
    const cacheKey = `${q}\x00${pos}`;

    // Check cache
    const cached = tenorCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      res.json({ data: cached.data, next: cached.next });
      return;
    }

    // Build Tenor request URL
    const params = new URLSearchParams({
      key: env.TENOR_API_KEY,
      q,
      limit: '24',
      media_filter: 'gif',
      contentfilter: 'high',
    });
    if (pos) params.set('pos', pos);

    const url = `https://tenor.googleapis.com/v2/search?${params}`;

    const tenorRes = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!tenorRes.ok) {
      logger.warn({ status: tenorRes.status }, 'Tenor API returned non-200');
      res.status(502).json({ data: [], error: 'tenor_upstream_error', message: `Tenor returned ${tenorRes.status}` });
      return;
    }

    const body = await tenorRes.json() as TenorSearchResponse;

    const data: TenorResult[] = (body.results ?? []).map((item) => {
      const gif = item.media_formats.gif;
      const preview =
        item.media_formats.tinygif ??
        item.media_formats.nanogif ??
        item.media_formats.mediumgif ??
        gif;

      return {
        id: item.id,
        url: gif?.url ?? '',
        preview: preview?.url ?? gif?.url ?? '',
        width: gif?.dims[0] ?? 0,
        height: gif?.dims[1] ?? 0,
      };
    });

    const next = body.next ?? '';

    // Store in LRU cache
    cachePut(cacheKey, { data, next, expiresAt: Date.now() + CACHE_TTL_MS });

    res.json({ data, next });
  } catch (err) {
    next(err);
  }
}

export { tenorSearch };
module.exports = { tenorSearch };
