import { Request, Response, NextFunction } from 'express';
import { validateSearchQuery, searchEntries, getEntry } from '../services/wikiCatalogService';
import { createError } from '../middleware/errorHandler';

/**
 * GET /api/wiki/search?q=&limit=
 * Public — served from local catalog only. Never calls Fandom.
 */
export async function searchWiki(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const q = validateSearchQuery(req.query.q);
    const rawLimit = parseInt(String(req.query.limit ?? '10'), 10);
    const limit = Number.isNaN(rawLimit) ? 10 : rawLimit;

    const results = await searchEntries(q, limit);
    res.json({ data: results });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/wiki/entry/:title
 * Public — served from local catalog only. 404 if absent.
 */
export async function getWikiEntry(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const title = String(req.params.title ?? '').replace(/\+/g, ' ').replace(/\x00/g, '').trim().slice(0, 200);
    if (!title) {
      next(createError(400, 'title is required'));
      return;
    }
    const entry = await getEntry(title);
    res.json({ data: entry });
  } catch (err) {
    next(err);
  }
}
