import { query as dbQuery } from '../config/database';
import prisma from '../config/prisma';

// ── Types ─────────────────────────────────────────────────────────────────────

export type StatsRange = 'all' | '90d' | '60d' | '30d' | '7d' | '1d';

export interface DailyCount {
  bucket: string;   // ISO timestamp (bucket start)
  count: number;
}

export interface ChannelMessageCount {
  channelId: string;
  channelName: string;
  count: number;
}

export interface SourceSplit {
  game: number;
  discord: number;
}

export interface VersionCount {
  version: string;
  count: number;
}

export interface DownloadCount {
  version: string;
  count: number;
}

export interface ModerationActivity {
  bucket: string;
  bans: number;
  reports: number;
  auditActions: number;
}

export interface ActivityPoint {
  bucket: string;
  messages: number;
  activeUsers: number;
}

export interface CommunityStats {
  range: StatsRange;
  /** Bucket size used for time-series data ('hour' | 'day') */
  bucketSize: 'hour' | 'day';
  /** Signups per bucket */
  signupsPerBucket: DailyCount[];
  /** Active users per bucket */
  dauPerBucket: DailyCount[];
  /** Messages per bucket */
  messagesPerBucket: DailyCount[];
  /** Combined activity line chart (messages + active users) */
  activityOverTime: ActivityPoint[];
  /** Per-channel message totals */
  messagesPerChannel: ChannelMessageCount[];
  /** Game vs Discord message totals */
  messageSplit: SourceSplit;
  /** Overlay app_version distribution */
  versionDistribution: VersionCount[];
  /** Download counts per version (only versions with count > 2) */
  downloadsPerVersion: DownloadCount[];
  /** Moderation activity per bucket */
  moderationPerBucket: ModerationActivity[];
}

// ── Range config ──────────────────────────────────────────────────────────────

interface RangeConfig {
  interval: string | null;  // null = all time
  bucketSize: 'hour' | 'day';
  truncUnit: string;         // date_trunc argument
}

function rangeConfig(range: StatsRange): RangeConfig {
  switch (range) {
    case '1d':  return { interval: '1 day',    bucketSize: 'hour', truncUnit: 'hour' };
    case '7d':  return { interval: '7 days',   bucketSize: 'hour', truncUnit: 'hour' };
    case '30d': return { interval: '30 days',  bucketSize: 'day',  truncUnit: 'day' };
    case '60d': return { interval: '60 days',  bucketSize: 'day',  truncUnit: 'day' };
    case '90d': return { interval: '90 days',  bucketSize: 'day',  truncUnit: 'day' };
    case 'all': return { interval: null,        bucketSize: 'day',  truncUnit: 'day' };
  }
}

function whereClause(cfg: RangeConfig, col: string): string {
  if (cfg.interval === null) return '';
  return `WHERE ${col} >= now() - '${cfg.interval}'::interval`;
}

function andClause(cfg: RangeConfig, col: string): string {
  if (cfg.interval === null) return '';
  return `AND ${col} >= now() - '${cfg.interval}'::interval`;
}

// ── Queries ───────────────────────────────────────────────────────────────────

async function getSignupsPerBucket(cfg: RangeConfig): Promise<DailyCount[]> {
  const result = await dbQuery(
    `SELECT date_trunc($1, created_at AT TIME ZONE 'UTC') AS bucket,
            count(*)::int AS count
     FROM users
     ${whereClause(cfg, 'created_at')}
     GROUP BY 1
     ORDER BY 1 ASC`,
    [cfg.truncUnit],
  );
  return (result.rows as Array<{ bucket: Date; count: number }>).map(r => ({
    bucket: r.bucket.toISOString(),
    count: Number(r.count),
  }));
}

async function getDauPerBucket(cfg: RangeConfig): Promise<DailyCount[]> {
  const result = await dbQuery(
    `SELECT date_trunc($1, created_at AT TIME ZONE 'UTC') AS bucket,
            count(DISTINCT user_id)::int AS count
     FROM sessions
     ${whereClause(cfg, 'created_at')}
     GROUP BY 1
     ORDER BY 1 ASC`,
    [cfg.truncUnit],
  );
  return (result.rows as Array<{ bucket: Date; count: number }>).map(r => ({
    bucket: r.bucket.toISOString(),
    count: Number(r.count),
  }));
}

async function getMessagesPerBucket(cfg: RangeConfig): Promise<DailyCount[]> {
  const result = await dbQuery(
    `SELECT date_trunc($1, created_at AT TIME ZONE 'UTC') AS bucket,
            count(*)::int AS count
     FROM messages
     ${whereClause(cfg, 'created_at')}
     ${cfg.interval ? 'AND' : 'WHERE'} is_deleted = false
     GROUP BY 1
     ORDER BY 1 ASC`,
    [cfg.truncUnit],
  );
  return (result.rows as Array<{ bucket: Date; count: number }>).map(r => ({
    bucket: r.bucket.toISOString(),
    count: Number(r.count),
  }));
}

async function getActivityOverTime(cfg: RangeConfig): Promise<ActivityPoint[]> {
  // Join messages + sessions bucketed together for the combined activity chart.
  const result = await dbQuery(
    `WITH msg_buckets AS (
       SELECT date_trunc($1, created_at AT TIME ZONE 'UTC') AS bucket,
              count(*)::int AS messages
       FROM messages
       ${whereClause(cfg, 'created_at')}
       ${cfg.interval ? 'AND' : 'WHERE'} is_deleted = false
       GROUP BY 1
     ),
     dau_buckets AS (
       SELECT date_trunc($1, created_at AT TIME ZONE 'UTC') AS bucket,
              count(DISTINCT user_id)::int AS active_users
       FROM sessions
       ${whereClause(cfg, 'created_at')}
       GROUP BY 1
     )
     SELECT coalesce(m.bucket, d.bucket) AS bucket,
            coalesce(m.messages, 0) AS messages,
            coalesce(d.active_users, 0) AS active_users
     FROM msg_buckets m
     FULL OUTER JOIN dau_buckets d ON d.bucket = m.bucket
     ORDER BY 1 ASC`,
    [cfg.truncUnit],
  );
  return (result.rows as Array<{ bucket: Date; messages: number; active_users: number }>).map(r => ({
    bucket: r.bucket.toISOString(),
    messages: Number(r.messages),
    activeUsers: Number(r.active_users),
  }));
}

async function getMessagesPerChannel(cfg: RangeConfig): Promise<ChannelMessageCount[]> {
  const result = await dbQuery(
    `SELECT m.channel_id,
            coalesce(c.name, m.channel_id::text) AS channel_name,
            count(*)::int AS count
     FROM messages m
     LEFT JOIN channels c ON c.id = m.channel_id
     ${whereClause(cfg, 'm.created_at')}
     ${cfg.interval ? 'AND' : 'WHERE'} m.is_deleted = false
     GROUP BY m.channel_id, c.name
     ORDER BY count DESC
     LIMIT 20`,
    [],
  );
  return (result.rows as Array<{ channel_id: string; channel_name: string; count: number }>).map(r => ({
    channelId: r.channel_id,
    channelName: r.channel_name,
    count: Number(r.count),
  }));
}

async function getMessageSplit(cfg: RangeConfig): Promise<SourceSplit> {
  const result = await dbQuery(
    `SELECT source, count(*)::int AS count
     FROM messages
     ${whereClause(cfg, 'created_at')}
     ${cfg.interval ? 'AND' : 'WHERE'} is_deleted = false
     GROUP BY source`,
    [],
  );
  let game = 0;
  let discord = 0;
  for (const row of result.rows as Array<{ source: string; count: number }>) {
    if (row.source === 'discord') discord = Number(row.count);
    else game += Number(row.count);
  }
  return { game, discord };
}

async function getVersionDistribution(cfg: RangeConfig): Promise<VersionCount[]> {
  const result = await dbQuery(
    `SELECT app_version AS version, count(DISTINCT install_token)::int AS count
     FROM client_metrics
     ${whereClause(cfg, 'sampled_at')}
     ${cfg.interval ? 'AND' : 'WHERE'} app_version IS NOT NULL
     GROUP BY app_version
     ORDER BY count DESC
     LIMIT 20`,
    [],
  );
  return (result.rows as Array<{ version: string; count: number }>).map(r => ({
    version: r.version,
    count: Number(r.count),
  }));
}

async function getDownloadsPerVersion(): Promise<DownloadCount[]> {
  // Downloads are an all-time counter — range filter doesn't apply
  const rows = await prisma.release.findMany({
    where: { downloadCount: { gt: 2 } },
    orderBy: { publishedAt: 'desc' },
    select: { version: true, downloadCount: true },
  });
  return rows.map(r => ({ version: r.version, count: r.downloadCount }));
}

async function getModerationPerBucket(cfg: RangeConfig): Promise<ModerationActivity[]> {
  const bansResult = await dbQuery(
    `SELECT date_trunc($1, created_at AT TIME ZONE 'UTC') AS bucket,
            count(*)::int AS count
     FROM bans
     ${whereClause(cfg, 'created_at')}
     GROUP BY 1
     ORDER BY 1 ASC`,
    [cfg.truncUnit],
  );

  const reportsResult = await dbQuery(
    `SELECT date_trunc($1, created_at AT TIME ZONE 'UTC') AS bucket,
            count(*)::int AS count
     FROM reports
     ${whereClause(cfg, 'created_at')}
     GROUP BY 1
     ORDER BY 1 ASC`,
    [cfg.truncUnit],
  );

  const auditResult = await dbQuery(
    `SELECT date_trunc($1, created_at AT TIME ZONE 'UTC') AS bucket,
            count(*)::int AS count
     FROM audit_logs
     ${whereClause(cfg, 'created_at')}
     GROUP BY 1
     ORDER BY 1 ASC`,
    [cfg.truncUnit],
  );

  const map = new Map<string, ModerationActivity>();
  const ensure = (isoKey: string) => {
    if (!map.has(isoKey)) map.set(isoKey, { bucket: isoKey, bans: 0, reports: 0, auditActions: 0 });
    return map.get(isoKey)!;
  };

  for (const r of bansResult.rows as Array<{ bucket: Date; count: number }>) {
    ensure(r.bucket.toISOString()).bans = Number(r.count);
  }
  for (const r of reportsResult.rows as Array<{ bucket: Date; count: number }>) {
    ensure(r.bucket.toISOString()).reports = Number(r.count);
  }
  for (const r of auditResult.rows as Array<{ bucket: Date; count: number }>) {
    ensure(r.bucket.toISOString()).auditActions = Number(r.count);
  }

  return Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

// ── Public aggregate ──────────────────────────────────────────────────────────

export async function getCommunityStats(range: StatsRange = '90d'): Promise<CommunityStats> {
  const cfg = rangeConfig(range);

  const [
    signupsPerBucket,
    dauPerBucket,
    messagesPerBucket,
    activityOverTime,
    messagesPerChannel,
    messageSplit,
    versionDistribution,
    downloadsPerVersion,
    moderationPerBucket,
  ] = await Promise.all([
    getSignupsPerBucket(cfg),
    getDauPerBucket(cfg),
    getMessagesPerBucket(cfg),
    getActivityOverTime(cfg),
    getMessagesPerChannel(cfg),
    getMessageSplit(cfg),
    getVersionDistribution(cfg),
    getDownloadsPerVersion(),
    getModerationPerBucket(cfg),
  ]);

  return {
    range,
    bucketSize: cfg.bucketSize,
    signupsPerBucket,
    dauPerBucket,
    messagesPerBucket,
    activityOverTime,
    messagesPerChannel,
    messageSplit,
    versionDistribution,
    downloadsPerVersion,
    moderationPerBucket,
  };
}
