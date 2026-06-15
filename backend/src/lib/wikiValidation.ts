/**
 * wikiValidation — shared input-validation helpers for wiki + camp endpoints.
 *
 * Centralised here so the same rules apply regardless of which controller
 * handles the request (wikiController, campController, wikiAdminController…).
 */

import { createError } from '../middleware/errorHandler';

/** Strip null bytes and validate length (spec §1.5 / §1.7).
 *
 * Throws a 400 RFC7807 error when the input is not a non-empty string of
 * 1–100 characters (after null-byte stripping and trimming).
 */
export function validateSearchQuery(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw createError(400, 'q must be a string');
  }
  // Strip null bytes (security: prevent C-string truncation in downstream libs)
  const q = raw.replace(/\x00/g, '').trim();
  if (q.length < 1 || q.length > 100) {
    throw createError(400, 'q must be between 1 and 100 characters');
  }
  return q;
}

/** Minimal async sleep — exported so services can throttle ingest loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
