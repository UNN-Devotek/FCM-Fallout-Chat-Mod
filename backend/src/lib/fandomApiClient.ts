/**
 * fandomApiClient — shared Fandom MediaWiki API client used by wikiIngestionService,
 * atomPriceService, and wikiService.
 *
 * Consolidates: apiGet, apiGetWithBackoff, RateLimitError, sleep, and shared constants.
 * JSON responses are capped at MAX_JSON_BYTES to prevent unbounded buffering.
 */

import logger from '../config/logger';

export const FANDOM_API = 'https://fallout.fandom.com/api.php';
export const FANDOM_UA  = 'FalloutChatMod/1.x (falloutchatmod.com)';

/** Max JSON response bytes accepted from Fandom API (prevents adversarial buffering). */
const MAX_JSON_BYTES = 4 * 1024 * 1024; // 4 MB

export class RateLimitError extends Error {
  constructor() { super('HTTP 429'); }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Single Fandom API GET. Throws RateLimitError on 429; returns null on other errors.
 * JSON response is read as text and capped at MAX_JSON_BYTES before parsing.
 */
export async function apiGet(
  params: Record<string, string>,
  timeoutMs = 12_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const qs  = new URLSearchParams({ ...params, format: 'json' }).toString();
    const res = await fetch(`${FANDOM_API}?${qs}`, {
      signal:  controller.signal,
      headers: { 'User-Agent': FANDOM_UA },
    });
    if (res.status === 429) throw new RateLimitError();
    if (!res.ok) {
      logger.warn({ status: res.status, action: params['action'] }, '[fandomApi] non-OK response');
      return null;
    }
    // Size-cap: read as text first, then parse
    const text = await res.text();
    if (text.length > MAX_JSON_BYTES) {
      logger.warn({ bytes: text.length, action: params['action'] }, '[fandomApi] response exceeds size cap, skipping');
      return null;
    }
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    logger.warn({ err, action: params['action'] }, '[fandomApi] request failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * apiGet with exponential backoff on HTTP 429. Backs off up to 60 s.
 */
export async function apiGetWithBackoff(
  params: Record<string, string>,
  timeoutMs = 12_000,
  attempt   = 0,
): Promise<unknown> {
  try {
    return await apiGet(params, timeoutMs);
  } catch (err) {
    if (err instanceof RateLimitError) {
      const delay = Math.min(60_000, 2_000 * Math.pow(2, attempt));
      logger.warn({ delay, attempt }, '[fandomApi] 429 rate-limited, backing off');
      await sleep(delay);
      return apiGetWithBackoff(params, timeoutMs, attempt + 1);
    }
    throw err;
  }
}
