import { Request } from 'express';
import prisma from '../config/prisma';

/**
 * Resolve the game-client `users.id` for the caller, from either:
 *  1) X-Auth-Token header → Redis session → users.id     (desktop overlay path)
 *  2) Discord session cookie → users.discord_id match    (web dashboard path)
 *
 * Returns { userId, via } on success, or null if neither auth method
 * resolves to a game user. Callers decide whether that's 401 or a
 * best-effort no-op (e.g. listChannels just skips the virtual channel).
 */
export interface ResolvedGameUser {
  userId: string;
  via: 'x-auth-token' | 'discord-session';
}

export async function resolveGameUser(req: Request): Promise<ResolvedGameUser | null> {
  // 1) Desktop overlay — X-Auth-Token
  const authToken = req.headers['x-auth-token'] as string | undefined;
  if (authToken) {
    try {
      const { getRedisClient } = require('../config/redis');
      const redis = await getRedisClient();
      const uid: string | null = await redis.get(`session:${authToken}`);
      if (uid) return { userId: uid, via: 'x-auth-token' };
    } catch { /* fall through */ }
  }

  // 2) Web dashboard — Discord session → users.discord_id lookup
  const discordUser = (req.session as any)?.discordUser;
  if (discordUser?.id) {
    try {
      const gameUser = await prisma.user.findFirst({
        where: { discordId: discordUser.id },
        select: { id: true },
      });
      if (gameUser) return { userId: gameUser.id, via: 'discord-session' };
    } catch { /* fall through */ }
  }

  return null;
}
