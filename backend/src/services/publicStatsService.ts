/**
 * publicStatsService — aggregates for GET /api/public/stats.
 *
 * All data returned is world-readable (no PII, no per-user rows).
 * Results are cached in memory for 30 seconds to prevent DB hammering
 * from a public, unauthenticated endpoint.
 */

import { query as dbQuery } from '../config/database';
import { getClientCount } from '../websocket/handlers';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OnlinePoint {
  bucket: string;   // ISO timestamp (UTC-midnight day bucket start)
  online: number;   // peak (max) online count observed that day; 0 if no snapshot
}

export interface UsersOverTimePoint {
  bucket: string;   // ISO timestamp (UTC-midnight day bucket start)
  total: number;    // cumulative registered users as of end of that day
}

export interface PublicStats {
  onlineNow: number;
  totalUsers: number;
  totalMessages: number;
  usersOverTime: UsersOverTimePoint[];
  onlineOverTime: OnlinePoint[];
}

// ── In-memory cache (30s TTL) ─────────────────────────────────────────────────

let cachedStats: PublicStats | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 30_000;

// ── Queries ───────────────────────────────────────────────────────────────────

async function getTotalUsers(): Promise<number> {
  // Exclude synthetic / placeholder accounts:
  //   • 'pending-%'  — install-token stubs created before Discord auth
  //   • 'discord:%'  — legacy bot-bridge accounts
  const result = await dbQuery(
    `SELECT count(*)::int AS total
     FROM users
     WHERE username NOT LIKE 'pending-%'
       AND username NOT LIKE 'discord:%'`,
    [],
  );
  return Number((result.rows[0] as { total: number }).total);
}

async function getTotalMessages(): Promise<number> {
  // pg_class reltuples gives an approximate count that is fast even on a
  // TimescaleDB hypertable with millions of rows. Falls back to exact count
  // if the estimate is 0 (fresh table / never ANALYZEd).
  const approxResult = await dbQuery(
    `SELECT reltuples::bigint AS estimate
     FROM pg_class
     WHERE relname = 'messages'`,
    [],
  );
  const estimate = Number((approxResult.rows[0] as { estimate: number } | undefined)?.estimate ?? 0);
  if (estimate > 0) return estimate;

  // Exact fallback for small/fresh tables
  const exactResult = await dbQuery(
    'SELECT count(*)::int AS total FROM messages WHERE is_deleted = false',
    [],
  );
  return Number((exactResult.rows[0] as { total: number }).total);
}

// Shared 7-day daily spine. Each bucket is a `timestamptz` instant pinned to
// UTC midnight: `date_trunc('day', now() AT TIME ZONE 'UTC')` yields a naive
// timestamp at UTC midnight, and the trailing `AT TIME ZONE 'UTC'` converts it
// back to a true timestamptz at that UTC instant — so node-postgres reads it as
// a Date whose `.toISOString()` is exactly `…T00:00:00.000Z` regardless of the
// DB session timezone. Used by BOTH series so their buckets align bucket-for-
// bucket (same 7 UTC-midnight boundaries, same order/length).
const DAY_SPINE_CTE = `
  days AS (
    SELECT generate_series(
             (date_trunc('day', now() AT TIME ZONE 'UTC') - interval '6 days') AT TIME ZONE 'UTC',
             (date_trunc('day', now() AT TIME ZONE 'UTC'))                      AT TIME ZONE 'UTC',
             interval '1 day'
           ) AS bucket
  )`;

/**
 * Cumulative registered users per day for the LAST 7 DAYS (daily buckets).
 *
 * Shares DAY_SPINE_CTE with getOnlineOverTime so both arrays have aligned
 * UTC-midnight buckets (same 7 boundaries, same order/length).
 *
 * The value for each day is the CUMULATIVE total of all users created before
 * the END of that day (i.e. running total of registrations), so the line only
 * ever rises. Computed as a correlated count over the users table keyed off the
 * day's exclusive upper bound (start of the next day).
 */
async function getUsersOverTime(): Promise<UsersOverTimePoint[]> {
  const result = await dbQuery(
    `WITH ${DAY_SPINE_CTE}
     SELECT d.bucket,
            (SELECT count(*)::int
               FROM users u
              WHERE u.created_at < d.bucket + interval '1 day'
                AND u.username NOT LIKE 'pending-%'
                AND u.username NOT LIKE 'discord:%') AS total
     FROM days d
     ORDER BY d.bucket ASC`,
    [],
  );
  return (result.rows as Array<{ bucket: Date; total: number }>).map(r => ({
    bucket: r.bucket.toISOString(),
    total: Number(r.total),
  }));
}

/**
 * Peak (max) online count per day for the LAST 7 DAYS (daily buckets).
 *
 * Shares DAY_SPINE_CTE with getUsersOverTime so the two arrays align
 * bucket-for-bucket. Days with no snapshot yet return 0 (LEFT JOIN + coalesce)
 * rather than being omitted, keeping both arrays the same length. The
 * daily_peak buckets are computed with the same UTC-midnight timestamptz
 * convention so the LEFT JOIN matches the spine exactly. Works within the
 * existing 7-day snapshot retention window.
 */
async function getOnlineOverTime(): Promise<OnlinePoint[]> {
  const result = await dbQuery(
    `WITH ${DAY_SPINE_CTE},
     daily_peak AS (
       SELECT date_trunc('day', captured_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
              max(online_count)::int AS online
       FROM online_snapshots
       WHERE captured_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') - interval '6 days') AT TIME ZONE 'UTC'
       GROUP BY 1
     )
     SELECT d.bucket,
            coalesce(p.online, 0)::int AS online
     FROM days d
     LEFT JOIN daily_peak p ON p.bucket = d.bucket
     ORDER BY d.bucket ASC`,
    [],
  );
  return (result.rows as Array<{ bucket: Date; online: number }>).map(r => ({
    bucket: r.bucket.toISOString(),
    online: Number(r.online),
  }));
}

// ── Public aggregate ──────────────────────────────────────────────────────────

export async function getPublicStats(): Promise<PublicStats> {
  const now = Date.now();
  if (cachedStats && now < cacheExpiresAt) {
    return cachedStats;
  }

  const [totalUsers, totalMessages, usersOverTime, onlineOverTime] = await Promise.all([
    getTotalUsers(),
    getTotalMessages(),
    getUsersOverTime(),
    getOnlineOverTime(),
  ]);

  const stats: PublicStats = {
    onlineNow: getClientCount(),
    totalUsers,
    totalMessages,
    usersOverTime,
    onlineOverTime,
  };

  cachedStats = stats;
  cacheExpiresAt = now + CACHE_TTL_MS;

  return stats;
}

/** Invalidate the cache (e.g. after a snapshot is inserted). Not strictly needed
 *  given the 30s TTL but provided for testability. */
export function invalidatePublicStatsCache(): void {
  cachedStats = null;
  cacheExpiresAt = 0;
}
