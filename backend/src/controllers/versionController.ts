import { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';

/**
 * GET /api/version -- Returns the latest published release metadata.
 * Reads from the `releases` table so the value survives container redeploys.
 */
async function getVersion(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const latest = await prisma.release.findFirst({ orderBy: { publishedAt: 'desc' } });
    if (!latest) {
      res.json({ data: {
        version: '—',
        releaseNotes: '',
        downloadUrl: '',
        hudModVersion: null,
        hudModUrl: null,
        publishedAt: null,
      } });
      return;
    }
    res.json({
      data: {
        version: latest.version,
        downloadUrl: latest.downloadUrl,
        releaseNotes: latest.releaseNotes,
        hudModVersion: latest.hudModVersion ?? null,
        hudModUrl: latest.hudModUrl ?? null,
        publishedAt: latest.publishedAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

export { getVersion };
module.exports = { getVersion };
