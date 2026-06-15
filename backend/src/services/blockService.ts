/**
 * blockService.ts
 *
 * User-level block feature. Provides set-lookups used by broadcast/history/
 * member-list enforcement, and the CRUD operations exposed through the REST API.
 */

import prisma from '../config/prisma';
import { resolveDisplayName } from '../websocket/handlers';

/**
 * Derives a stable same-origin avatar URL from a Discord user ID.
 * Served by GET /avatars/:discordId (streams the stored MinIO object).
 * Returns null when discordId is absent.
 */
function buildAvatarUrl(discordId: string | null | undefined): string | null {
  if (!discordId) return null;
  return `/avatars/${discordId}`;
}
import logger from '../config/logger';

// ---------------------------------------------------------------------------
// In-memory cache — avoids a DB round-trip on every message broadcast check.
// Each entry is a Set<blockedId> keyed by blockerId. Invalidated on add/remove.
// TTL-based expiry (60s) as a safety net against stale data after external edits.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  ids: Set<string>;
  expiresAt: number;
}

const blockerCache = new Map<string, CacheEntry>(); // blockerId → Set<blockedId>
const blockedCache = new Map<string, CacheEntry>(); // blockedId → Set<blockerId>

function cacheSet(map: Map<string, CacheEntry>, key: string, ids: Set<string>): void {
  map.set(key, { ids, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheGet(map: Map<string, CacheEntry>, key: string): Set<string> | null {
  const entry = map.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    map.delete(key);
    return null;
  }
  return entry.ids;
}

function invalidateUser(userId: string): void {
  blockerCache.delete(userId);
  blockedCache.delete(userId);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the set of user IDs that `blockerId` has blocked.
 * Used by enforcement pass to filter outbound messages/presence.
 */
export async function getBlockedIds(blockerId: string): Promise<Set<string>> {
  const cached = cacheGet(blockerCache, blockerId);
  if (cached) return cached;

  const rows = await prisma.block.findMany({
    where: { blockerId },
    select: { blockedId: true },
  });
  const ids = new Set(rows.map(r => r.blockedId));
  cacheSet(blockerCache, blockerId, ids);
  return ids;
}

/**
 * Returns the set of user IDs that have blocked `blockedId`.
 * Used by enforcement pass to filter broadcast recipients — so the sender's
 * messages are never delivered to anyone who has blocked them.
 */
export async function getBlockerIds(blockedId: string): Promise<Set<string>> {
  const cached = cacheGet(blockedCache, blockedId);
  if (cached) return cached;

  const rows = await prisma.block.findMany({
    where: { blockedId },
    select: { blockerId: true },
  });
  const ids = new Set(rows.map(r => r.blockerId));
  cacheSet(blockedCache, blockedId, ids);
  return ids;
}

export interface BlockedUserEntry {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * Returns detailed list of users that `blockerId` has blocked,
 * with display names and avatar URLs resolved.
 */
export async function listBlocked(blockerId: string): Promise<BlockedUserEntry[]> {
  const rows = await prisma.block.findMany({
    where: { blockerId },
    orderBy: { createdAt: 'asc' },
    select: {
      blocked: {
        select: {
          id: true,
          username: true,
          discordId: true,
          discordUsername: true,
          discordDisplayName: true,
          installToken: true,
        },
      },
    },
  });

  return rows.map(r => ({
    userId: r.blocked.id,
    displayName: resolveDisplayName(r.blocked),
    avatarUrl: buildAvatarUrl(r.blocked.discordId),
  }));
}

/**
 * Adds a block. Idempotent — silently succeeds if the block already exists.
 * Throws if blockerId === blockedId (self-block) or if blockedId does not exist.
 */
export async function addBlock(blockerId: string, blockedId: string): Promise<void> {
  if (blockerId === blockedId) {
    const err = new Error('Cannot block yourself') as any;
    err.statusCode = 400;
    throw err;
  }

  // Verify target user exists
  const target = await prisma.user.findUnique({
    where: { id: blockedId },
    select: { id: true },
  });
  if (!target) {
    const err = new Error('User not found') as any;
    err.statusCode = 404;
    throw err;
  }

  try {
    await prisma.block.create({
      data: { blockerId, blockedId },
    });
    logger.info({ blockerId, blockedId }, 'block:added');
  } catch (err: any) {
    // P2002 = unique constraint violation → already blocked (idempotent)
    if (err?.code !== 'P2002') throw err;
    logger.debug({ blockerId, blockedId }, 'block:already-exists (idempotent)');
  }

  // Invalidate both sides so the next lookup is fresh
  invalidateUser(blockerId);
  invalidateUser(blockedId);
}

/**
 * Removes a block. No-op if not blocked.
 */
export async function removeBlock(blockerId: string, blockedId: string): Promise<void> {
  await prisma.block.deleteMany({
    where: { blockerId, blockedId },
  });

  invalidateUser(blockerId);
  invalidateUser(blockedId);
  logger.info({ blockerId, blockedId }, 'block:removed');
}
