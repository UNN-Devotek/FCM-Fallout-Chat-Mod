import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../config/redis';
import { createError } from './errorHandler';
import { verifyToken } from '../services/mcpTokenService';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { clientIp } from '../utils/clientIp';

declare global {
  namespace Express {
    interface Request {
      mcpUser?: { tokenId: string; ownerId: string; env: string };
    }
  }
}

/**
 * Rate limiter for MCP endpoints — 120 requests per minute per IP.
 */
export const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req) ?? 'unknown',
  store: new RedisStore({
    sendCommand: async (...args: string[]) => {
      const redis = await getRedisClient();
      return (redis as any).sendCommand(args);
    },
    prefix: 'rl:mcp:',
  }),
  handler: (_req, res) => {
    res.status(429).json({
      type: 'https://fo76chat.app/errors/429',
      title: 'Too Many Requests',
      status: 429,
      detail: 'MCP rate limit exceeded. Max 120 requests per minute.',
    });
  },
});

/**
 * Factory that returns middleware verifying a Bearer MCP token for the given env.
 * On success: attaches req.mcpUser (token metadata) and req.user (game user row).
 */
export function requireMcpToken(env: 'dev' | 'prod') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(createError(401, 'Missing or invalid Authorization header'));
    }
    const raw = authHeader.slice(7).trim();

    try {
      const tokenRow = await verifyToken(raw, env);
      if (!tokenRow) {
        return next(createError(401, 'Invalid, expired, or revoked MCP token'));
      }

      const user = await prisma.user.findUnique({
        where: { id: tokenRow.ownerId },
        select: { id: true, username: true, isBanned: true, isMuted: true, bannedUntil: true },
      });

      if (!user) {
        return next(createError(401, 'Token owner not found'));
      }
      if (user.isBanned) {
        return next(createError(403, 'Account is banned'));
      }

      req.mcpUser = { tokenId: tokenRow.id, ownerId: tokenRow.ownerId, env: tokenRow.env };
      req.user = user;

      next();
    } catch (err) {
      logger.warn({ err }, 'MCP token verification error');
      next(err);
    }
  };
}

module.exports = { requireMcpToken, mcpLimiter };
