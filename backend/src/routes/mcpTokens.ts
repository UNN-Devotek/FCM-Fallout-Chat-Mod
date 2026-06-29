import express, { Request, Response, NextFunction } from 'express';
import { requireDashboardAuth } from '../middleware/auth';
import { mintToken, listTokensForUser, revokeToken } from '../services/mcpTokenService';
import { createError } from '../middleware/errorHandler';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { paramStr } from '../utils/reqParams';

const router = express.Router();

/**
 * GET /api/me/mcp-tokens
 * List caller's MCP tokens (no plaintext exposed — only metadata).
 */
router.get('/', requireDashboardAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dashUser = (req as any).dashboardUser;
    // Resolve the game user row from Discord ID to get our internal user UUID
    const user = await prisma.user.findFirst({
      where: { discordId: dashUser.discordId },
      select: { id: true },
    });
    if (!user) return next(createError(404, 'User not found'));
    const tokens = await listTokensForUser(user.id);
    res.json({ data: tokens });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/me/mcp-tokens
 * Mint a new MCP token. Token is shown ONCE in the response.
 * Body: { label?: string, env?: 'dev'|'prod' }
 */
router.post('/', requireDashboardAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dashUser = (req as any).dashboardUser;
    const user = await prisma.user.findFirst({
      where: { discordId: dashUser.discordId },
      select: { id: true },
    });
    if (!user) return next(createError(404, 'User not found'));
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 128) : undefined;
    // Self-service always mints dev tokens — prod tokens are CLI-only.
    const env: 'dev' = 'dev';
    const result = await mintToken(user.id, env, label);
    logger.info({ userId: user.id, env, label }, 'MCP token minted');
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/me/mcp-tokens/:id
 * Revoke caller's own token by ID.
 */
router.delete('/:id', requireDashboardAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dashUser = (req as any).dashboardUser;
    const user = await prisma.user.findFirst({
      where: { discordId: dashUser.discordId },
      select: { id: true },
    });
    if (!user) return next(createError(404, 'User not found'));
    await revokeToken(user.id, paramStr(req, 'id'));
    res.json({ data: { revoked: true } });
  } catch (err: any) {
    if (err.status) return next(createError(err.status, err.message));
    next(err);
  }
});

export default router;
module.exports = router;
