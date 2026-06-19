import express, { Request, Response } from 'express';
import * as giveawayService from '../services/giveawayService';
import { GiveawayError } from '../services/giveawayService';
import logger from '../config/logger';

const SHORT_ID_RE = /^[A-Z0-9]{6}$/;

const router = express.Router();

// GET /api/giveaways — list active giveaways (auth required, wired in server.ts)
router.get('/', async (req: Request, res: Response) => {
  try {
    const active = await giveawayService.listActive();
    res.json({ data: active });
  } catch (err) {
    logger.error({ err }, 'GET /api/giveaways failed');
    res.status(500).json({ error: 'Failed to list giveaways' });
  }
});

export default router;
export { router as giveawaysRouter };

// Admin force-cancel — wired in server.ts under requireDiscordRole(owner/admin/mod).
// :shortId must be the 6-char giveaway shortId (e.g. "A1B2C3").
export async function adminCancelGiveaway(req: Request, res: Response): Promise<void> {
  const { shortId } = req.params;

  if (!SHORT_ID_RE.test(shortId ?? '')) {
    res.status(400).json({ error: 'Invalid shortId — must be 6 uppercase alphanumeric characters' });
    return;
  }

  // discordUser is a Discord identity, not a DB user; isMod=true bypasses ownership.
  // Pass a sentinel actor ID so the audit log is readable.
  const actorLabel = (req as any).discordUser?.username ?? 'admin';

  try {
    await giveawayService.cancelGiveaway(shortId, actorLabel, true);
    res.json({ data: { cancelled: true } });
  } catch (err) {
    if (err instanceof GiveawayError) {
      res.status(err.code === 'NOT_FOUND' ? 404 : 400).json({ error: err.message });
      return;
    }
    logger.error({ err, shortId }, 'Admin cancel giveaway failed');
    res.status(500).json({ error: 'Failed to cancel giveaway' });
  }
}
