/**
 * blockController.ts
 *
 * REST handlers for the user-level block feature.
 *
 * All routes are authenticated via requireClientAuth (X-Auth-Token session).
 * Enforcement (filtering WS broadcasts, message history, member lists, party
 * presence) is NOT done here — that is a subsequent pass.
 *
 * Routes (mounted at /api/block):
 *   GET    /api/block              → list blocked users
 *   POST   /api/block              → add block { userId }
 *   DELETE /api/block/:userId      → remove block
 *   GET    /api/block/search?q=    → search users to block
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import { resolveDisplayName } from '../websocket/handlers';

/** Same-origin avatar URL derived from discordId (served by GET /avatars/:discordId). */
function buildAvatarUrl(discordId: string | null | undefined): string | null {
  if (!discordId) return null;
  return `/avatars/${discordId}`;
}
import { addBlock, removeBlock, listBlocked } from '../services/blockService';

export async function getBlockList(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const blockerId = req.user!.id as string;
    const blocked = await listBlocked(blockerId);
    res.json({ data: { blocked } });
  } catch (err) {
    next(err);
  }
}

export async function blockUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const blockerId = req.user!.id as string;
    const { userId: blockedId } = req.body as { userId?: string };

    if (!blockedId || typeof blockedId !== 'string') {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    await addBlock(blockerId, blockedId);
    // Live block enforcement: refresh the blocker's cached blocked-set on any
    // connected socket so the new block takes effect immediately.
    try { (global as any).refreshClientBlocks?.(blockerId); } catch { /* non-fatal */ }
    res.json({ data: { blocked: true } });
  } catch (err: any) {
    if (err?.statusCode) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    next(err);
  }
}

export async function unblockUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const blockerId = req.user!.id as string;
    const blockedId = req.params.userId as string;

    if (!blockedId) {
      res.status(400).json({ error: 'userId param required' });
      return;
    }

    await removeBlock(blockerId, blockedId);
    // Live block enforcement: refresh the blocker's cached blocked-set so the
    // unblock takes effect immediately (the sender becomes visible again).
    try { (global as any).refreshClientBlocks?.(blockerId); } catch { /* non-fatal */ }
    res.json({ data: { removed: true } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/block/search?q=
 * Returns up to 8 users matching q (username / discordUsername / discordDisplayName,
 * case-insensitive) excluding self, already-blocked users, and banned users.
 */
export async function searchUsersToBlock(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const requesterId = req.user!.id as string;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    if (!q) {
      res.json({ data: { results: [] } });
      return;
    }

    const existingBlocks = await prisma.block.findMany({
      where: { blockerId: requesterId },
      select: { blockedId: true },
    });
    const alreadyBlockedIds = existingBlocks.map(b => b.blockedId);

    const users = await prisma.user.findMany({
      where: {
        AND: [
          { id: { not: requesterId } },
          { id: { notIn: alreadyBlockedIds } },
          { isBanned: false },
          {
            OR: [
              { username: { contains: q, mode: 'insensitive' } },
              { discordUsername: { contains: q, mode: 'insensitive' } },
              { discordDisplayName: { contains: q, mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: {
        id: true,
        username: true,
        discordId: true,
        discordUsername: true,
        discordDisplayName: true,
        installToken: true,
      },
      take: 8,
    });

    const results = users.map(u => ({
      userId: u.id,
      displayName: resolveDisplayName(u),
      avatarUrl: buildAvatarUrl(u.discordId),
    }));

    res.json({ data: { results } });
  } catch (err) {
    next(err);
  }
}
