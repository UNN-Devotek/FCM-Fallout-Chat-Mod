import logger from '../config/logger';
import { cachedFetch } from '../lib/cachedFetch';

// Current Fallout 76 nuclear launch codes (Alpha / Bravo / Charlie silos), sourced from
// NukaCrypt's undocumented, no-auth JSON endpoint. Codes rotate weekly. Cached in Redis so
// a burst of /nukecodes commands hits NukaCrypt at most once per TTL window.
//
// Response shape (observed June 2026):
//   { "date": "2026-06-04 00:00:00Z", "since_epoch": 1780531200,
//     "ALPHA": "94661753", "BRAVO": "61618540", "CHARLIE": "89438601" }
//
// NOTE: undocumented endpoint, no published ToS. Attribute NukaCrypt in any UI and confirm
// acceptable use with the site owner before leaning on this in production. See
// docs/roadmap/fan-site-integrations.md.

const CODES_URL = 'https://api.nukacrypt.com/api/codes';
const REDIS_KEY = 'fo76:nukecodes';
const CACHE_TTL_SEC = 1800; // 30 min — codes only change on the weekly reset
const FETCH_TIMEOUT_MS = 6000;
const WEEK_SEC = 604800;

export interface NukeCodes {
  alpha: string;
  bravo: string;
  charlie: string;
  sinceEpoch: number | null; // unix seconds of the current cycle start
  validUntil: number | null; // unix seconds — sinceEpoch + 1 week
  fetchedAt: number;         // unix ms
}

async function fetchFromNukaCrypt(): Promise<NukeCodes | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CODES_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'FalloutChatMod/1.x (falloutchatmod.com)' },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'NukaCrypt codes endpoint returned non-OK');
      return null;
    }
    const json: any = await res.json();
    const alpha = String(json?.ALPHA ?? '').trim();
    const bravo = String(json?.BRAVO ?? '').trim();
    const charlie = String(json?.CHARLIE ?? '').trim();
    if (!alpha || !bravo || !charlie) {
      logger.warn({ json }, 'NukaCrypt codes response missing one or more silo codes');
      return null;
    }
    const sinceEpoch = typeof json?.since_epoch === 'number' ? json.since_epoch : null;
    return {
      alpha,
      bravo,
      charlie,
      sinceEpoch,
      validUntil: sinceEpoch != null ? sinceEpoch + WEEK_SEC : null,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch FO76 nuke codes from NukaCrypt');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get the current week's nuke codes, served from a ~30min Redis cache.
 * Returns null only if both the cache and a live fetch fail.
 */
export async function getNukeCodes(): Promise<NukeCodes | null> {
  return cachedFetch<NukeCodes>(REDIS_KEY, CACHE_TTL_SEC, fetchFromNukaCrypt);
}
