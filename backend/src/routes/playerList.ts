import { Router, Request, Response } from 'express';
import logger from '../config/logger';
import { requireClientAuth } from '../middleware/requireClientAuth';
import { playerListLimiter } from '../middleware/rateLimiter';
import { validatePlayerList } from '../services/playerListService';

const router = Router();

/**
 * POST /api/player-list
 * Called by GameMonitor whenever the FO76 companion mod writes a new player list.
 * Body: { endpoint?: string, players: string[], alternateEndpoints?: string[] }
 * Auth: X-Auth-Token (requireClientAuth middleware).
 *
 * World-session and same-server detection have been removed. This route accepts
 * POSTs for backwards compatibility with older companion mod versions and returns
 * 204 after basic validation.
 */
router.post('/', playerListLimiter, requireClientAuth, async (req: Request, res: Response) => {
  const { players } = req.body as { players?: unknown };
  const userId = req.user?.id;

  if (!Array.isArray(players)) {
    res.status(400).json({ error: 'players must be an array' });
    return;
  }

  const safeNames = validatePlayerList('', players);
  logger.info({ userId, count: safeNames.length }, '[player-list] received');
  res.status(204).end();
});

export default router;
