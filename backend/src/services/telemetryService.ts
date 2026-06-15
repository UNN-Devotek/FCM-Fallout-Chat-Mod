/**
 * telemetryService.ts
 *
 * Resolves the effective telemetry-enabled state for a given user, with a 60s
 * Redis cache per user.
 *
 * Resolution order (mirrors the desktop effective-state rule in CLAUDE.md):
 *   1. If a user-scoped row (`scope = 'user:<userId>'`) exists → use its `enabled`.
 *   2. Otherwise fall back to the `scope = 'global'` row (default true = dev ON).
 *
 * Admin-side writes call `setTelemetry()` which upserts the DB row and invalidates
 * the affected Redis key(s).
 */

import prisma from '../config/prisma';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';

const CACHE_TTL_SECONDS = 60;
const CACHE_KEY = (userId: string) => `telemetry:effective:${userId}`;
const GLOBAL_CACHE_KEY = 'telemetry:effective:global';

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Returns the effective telemetry-enabled flag for `userId`.
 * Caches in Redis for 60 s.
 */
export async function getEffectiveTelemetryFor(userId: string): Promise<boolean> {
  const cacheKey = CACHE_KEY(userId);
  try {
    const redis = await getRedisClient();
    const cached = await redis.get(cacheKey);
    if (cached !== null) return cached === '1';
  } catch (err) {
    logger.warn({ err }, '[telemetry] Redis read failed — falling back to DB');
  }

  const effective = await resolveFromDb(userId);

  try {
    const redis = await getRedisClient();
    await redis.setEx(cacheKey, CACHE_TTL_SECONDS, effective ? '1' : '0');
  } catch (err) {
    logger.warn({ err }, '[telemetry] Redis write failed — continuing without cache');
  }

  return effective;
}

async function resolveFromDb(userId: string): Promise<boolean> {
  const db = prisma as any;
  const [userRow, globalRow] = await Promise.all([
    db.telemetrySetting.findUnique({ where: { scope: `user:${userId}` } }),
    db.telemetrySetting.findUnique({ where: { scope: 'global' } }),
  ]);

  if (userRow !== null) return userRow.enabled;
  return globalRow?.enabled ?? true; // default ON if no global row
}

// ── Write ─────────────────────────────────────────────────────────────────────

export type TelemetryScope = { kind: 'global' } | { kind: 'user'; userId: string };

export interface TelemetrySetResult {
  scope: string;
  enabled: boolean;
  updatedAt: Date;
  updatedBy: string | null;
}

/**
 * Upserts a telemetry_settings row and invalidates the Redis cache.
 * Returns the updated row.
 */
export async function setTelemetry(
  scope: TelemetryScope,
  enabled: boolean,
  updatedBy: string | null,
): Promise<TelemetrySetResult> {
  const scopeStr = scope.kind === 'global' ? 'global' : `user:${scope.userId}`;

  const db = prisma as any;
  const row = await db.telemetrySetting.upsert({
    where:  { scope: scopeStr },
    update: { enabled, updatedAt: new Date(), updatedBy },
    create: { scope: scopeStr, enabled, updatedBy },
  });

  // Invalidate Redis cache for affected user(s).
  try {
    const redis = await getRedisClient();
    if (scope.kind === 'global') {
      // Purge all per-user cached entries so they re-resolve against the new global.
      // We use SCAN to avoid blocking on large keyspaces.
      await scanAndDelete(redis, 'telemetry:effective:*');
    } else {
      await redis.del(CACHE_KEY(scope.userId));
    }
  } catch (err) {
    logger.warn({ err }, '[telemetry] Redis invalidation failed — stale cache may persist up to 60 s');
  }

  return { scope: row.scope, enabled: row.enabled, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
}

async function scanAndDelete(redis: any, pattern: string): Promise<void> {
  let cursor = 0;
  do {
    const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = typeof result === 'object' && 'cursor' in result ? result.cursor : 0;
    const keys: string[] = typeof result === 'object' && 'keys' in result ? result.keys : [];
    if (keys.length > 0) {
      await redis.del(keys);
    }
  } while (cursor !== 0);
}

// ── List (admin GET) ──────────────────────────────────────────────────────────

export interface TelemetryAdminView {
  global: {
    enabled: boolean;
    updatedAt: Date | null;
    updatedBy: string | null;
  };
  perUser: Array<{
    userId: string;
    username: string | null;
    enabled: boolean;
    updatedAt: Date;
    updatedBy: string | null;
  }>;
}

export async function getTelemetryAdminView(): Promise<TelemetryAdminView> {
  const db = prisma as any;
  const rows = await db.telemetrySetting.findMany({ orderBy: { updatedAt: 'desc' } }) as Array<{ scope: string; enabled: boolean; updatedAt: Date; updatedBy: string | null }>;

  const globalRow = rows.find(r => r.scope === 'global');
  const userRows  = rows.filter(r => r.scope.startsWith('user:'));

  // Resolve usernames for user-scoped rows in a single query.
  const userIds = userRows.map(r => r.scope.slice('user:'.length));
  const users = userIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true },
      })
    : [];
  const usernameMap = new Map(users.map(u => [u.id, u.username]));

  return {
    global: {
      enabled:   globalRow?.enabled ?? true,
      updatedAt: globalRow?.updatedAt ?? null,
      updatedBy: globalRow?.updatedBy ?? null,
    },
    perUser: userRows.map(r => {
      const uid = r.scope.slice('user:'.length);
      return {
        userId:    uid,
        username:  usernameMap.get(uid) ?? null,
        enabled:   r.enabled,
        updatedAt: r.updatedAt,
        updatedBy: r.updatedBy,
      };
    }),
  };
}
