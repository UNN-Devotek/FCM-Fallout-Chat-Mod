import type { Request } from 'express';

/**
 * Express 5 (`@types/express-serve-static-core` v5) types `req.params` values
 * as `string | string[]` because path-to-regexp v8 supports repeating params.
 * This app has NO repeating/array route params, so a given param is ALWAYS a
 * single string at runtime. These helpers coerce back to `string` safely.
 */
export function paramStr(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * Returns `req.params` typed as a plain `Record<string, string>` for ergonomic
 * destructuring at call sites that read several single-string params at once.
 */
export function paramsOf(req: Request): Record<string, string> {
  return req.params as Record<string, string>;
}
