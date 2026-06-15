/**
 * campController — public autocomplete endpoint for CAMP items.
 *
 * GET /api/camp/search?q=<q>&limit=<n>
 *   Public, unauthenticated. Mirrors /api/wiki/search response shape.
 *   Response: { data: [{ id, name, category, subCategory, budgetCost, plan,
 *                        imageUrl, sourceLabel, sourceType }] }
 */

import { Request, Response, NextFunction } from 'express';
import { searchCampItems, getCampItem } from '../services/campService';
import { validateSearchQuery } from '../lib/wikiValidation';

export async function searchCamp(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Empty / missing q → return empty results (not a 400 for UX reasons).
    if (!req.query.q) { res.json({ data: [] }); return; }

    // validateSearchQuery strips null bytes and enforces 1–100 chars (DoS guard
    // on this public, unauthenticated endpoint). Throws 400 if q is invalid.
    const q = validateSearchQuery(req.query.q);

    const raw = parseInt(String(req.query.limit ?? '8'), 10);
    const limit = Math.min(Math.max(Number.isNaN(raw) ? 8 : raw, 1), 20);
    const results = await searchCampItems(q, limit);
    res.json({ data: results });
  } catch (err) {
    next(err);
  }
}

/** GET /api/camp/item/:name — resolve the best single camp item by name. */
export async function getCampItemByName(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const name = validateSearchQuery(req.params.name);
    const item = await getCampItem(name);
    if (!item) { res.status(404).json({ type: 'https://httpstatuses.com/404', status: 404, title: 'Not found' }); return; }
    res.json({ data: item });
  } catch (err) {
    next(err);
  }
}
