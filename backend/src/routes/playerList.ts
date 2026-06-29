import { Router, Request, Response } from 'express';
import logger from '../config/logger';
import { requireClientAuth } from '../middleware/requireClientAuth';
import { playerListLimiter } from '../middleware/rateLimiter';
import {
  setServerPlayers,
  setServerPlayersForSession,
  setServerPlayersForUser,
  validatePlayerList,
} from '../services/playerListService';

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
  const {
    players,
    endpoint,
    sessionId,
    worldSessionId,
  } = req.body as {
    players?: unknown;
    endpoint?: unknown;
    sessionId?: unknown;
    worldSessionId?: unknown;
  };
  const userId = req.user?.id;

  if (!Array.isArray(players)) {
    res.status(400).json({ error: 'players must be an array' });
    return;
  }

  const normalizedEndpoint = typeof endpoint === 'string' && endpoint.trim().length > 0 ? endpoint.trim() : null;
  const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
    ? sessionId.trim()
    : typeof worldSessionId === 'string' && worldSessionId.trim().length > 0
      ? worldSessionId.trim()
      : null;

  const safeNames = validatePlayerList(normalizedEndpoint ?? '', players);

  if (normalizedEndpoint) {
    await setServerPlayers(normalizedEndpoint, safeNames);
  }
  if (normalizedSessionId) {
    await setServerPlayersForSession(normalizedSessionId, safeNames, normalizedEndpoint);
  }
  if (typeof userId === 'string' && userId.length > 0) {
    await setServerPlayersForUser(
      userId,
      safeNames,
      normalizedEndpoint ?? (normalizedSessionId ? `session:${normalizedSessionId}` : null),
    );
  }

  logger.info({ userId, count: safeNames.length, endpoint: normalizedEndpoint, sessionId: normalizedSessionId }, '[player-list] received');
  res.status(204).end();
});

export default router;
