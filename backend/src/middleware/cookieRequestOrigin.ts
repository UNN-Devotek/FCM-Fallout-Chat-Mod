import type { RequestHandler } from 'express';
import { createError } from './errorHandler';

function originOf(value: unknown, originHeader = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    if (originHeader && value !== url.origin) return undefined;
    return url.origin;
  } catch { return undefined; }
}

/** Cookie-bearing writes must come from a configured browser origin. CORS alone
 * does not reject simple form submissions. Do not derive trust from Host or
 * forwarded headers; cookie-free native/Bearer clients keep their existing auth.
 */
export function requireCookieRequestOrigin(origins: readonly string[]): RequestHandler {
  const trusted = new Set(origins.map(value => originOf(value)).filter(value => value !== undefined));
  return (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.cookie) return next();
    // An invalid/present Origin never falls back to a potentially unrelated Referer.
    const source = req.headers.origin !== undefined
      ? originOf(req.headers.origin, true) : originOf(req.headers.referer);
    if (source && trusted.has(source)) return next();
    next(createError(403, 'Cookie-authenticated writes require a trusted browser origin.'));
  };
}
