import logger from '../config/logger';
import { cachedFetch } from '../lib/cachedFetch';

// Fallout 76 server up/down status, sourced from Bethesda's semi-official (undocumented,
// no-auth) status endpoint. Widely used by community tools. Read-only. Cached in Redis so
// a burst of /serverstatus commands hits Bethesda at most once per TTL window.
//
// Response shape (observed June 2026):
//   { "platform": { "code": 2000, "message": "success",
//                   "response": { "fallout76": "UP" } } }

const STATUS_URL = 'https://api.bethesda.net/status/ext-server-status?product_id=8';
const REDIS_KEY = 'fo76:serverstatus';
const CACHE_TTL_SEC = 60;
const FETCH_TIMEOUT_MS = 6000;

export interface ServerStatus {
  status: string;       // e.g. "UP", "DOWN", "MAINTENANCE", or "UNKNOWN"
  checkedAt: number;    // unix ms
}

async function fetchFromBethesda(): Promise<ServerStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(STATUS_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'FalloutChatMod/1.x (falloutchatmod.com)' },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Bethesda status endpoint returned non-OK');
      return null;
    }
    const json: any = await res.json();
    const raw = json?.platform?.response?.fallout76 ?? json?.response?.fallout76;
    const status = typeof raw === 'string' && raw.length > 0 ? raw.toUpperCase() : 'UNKNOWN';
    return { status, checkedAt: Date.now() };
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch FO76 server status from Bethesda');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get the current FO76 server status, served from a ~60s Redis cache.
 * Returns null only if both the cache and a live fetch fail.
 */
export async function getServerStatus(): Promise<ServerStatus | null> {
  return cachedFetch<ServerStatus>(REDIS_KEY, CACHE_TTL_SEC, fetchFromBethesda);
}
