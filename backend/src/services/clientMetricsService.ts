import prisma from '../config/prisma';
import { query as dbQuery } from '../config/database';
import logger from '../config/logger';

// Inline type (shared/src is outside tsconfig rootDir).
interface ClientMetricsIngest {
  source: 'overlay' | 'monitor';
  appVersion: string;
  workingSetMb: number;
  gcHeapMb: number;
  cpuPercent: number;
  gifCacheMb?: number | null;
  fps?: number | null;
}

// ── Ingest ────────────────────────────────────────────────────────────────────

export async function recordClientMetric(
  installToken: string,
  payload: ClientMetricsIngest,
): Promise<void> {
  await (prisma as any).clientMetric.create({
    data: {
      installToken,
      source:        payload.source,
      appVersion:    payload.appVersion,
      workingSetMb:  payload.workingSetMb,
      gcHeapMb:      payload.gcHeapMb,
      cpuPct:        payload.cpuPercent,
      gifCacheMb:    payload.gifCacheMb ?? null,
      fps:           payload.fps ?? null,
    },
  });
}

// ── Aggregate query ───────────────────────────────────────────────────────────

export type MetricsWindow = '1h' | '24h' | '7d' | '30d';
export type MetricsSource = 'overlay' | 'monitor' | 'all';

interface Percentiles {
  p50: number | null;
  p90: number | null;
  p99: number | null;
}

interface TimeBucket {
  tStart: string;         // ISO timestamp
  workingSetMb: Percentiles;
  cpuPct: Percentiles;
  gifCacheMb: Percentiles;
  fps: Percentiles;
  sampleCount: number;
}

interface Outlier {
  tokenPrefix: string;
  workingSetMb: number;
  cpuPct: number;
  gifCacheMb: number | null;
  fps: number | null;
  appVersion: string;
  sampledAt: string;
}

export interface ClientMetricsAdminView {
  timeBuckets: TimeBucket[];
  outliers: Outlier[];
}

// Bucket size per window, in SECONDS: 1h→1h, 24h→4h, 7d→1d, 30d→1d.
// We bucket by epoch-floor (not date_trunc) because Postgres date_trunc only
// accepts a single field name ('hour','day',…) — it rejects multi-unit strings
// like '4 hours'. Epoch-floor supports any bucket size uniformly.
function bucketSeconds(window: MetricsWindow): number {
  if (window === '1h')  return 3600;       // 1 hour
  if (window === '24h') return 4 * 3600;   // 4 hours
  return 24 * 3600;                        // 1 day
}

function windowInterval(window: MetricsWindow): string {
  if (window === '1h')  return '1 hour';
  if (window === '24h') return '24 hours';
  if (window === '7d')  return '7 days';
  return '30 days';
}

function percOrNull(arr: number[], p: number): number | null {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)] * 100) / 100;
}

export async function getClientMetricsAdminView(
  window: MetricsWindow,
  source: MetricsSource,
): Promise<ClientMetricsAdminView> {
  const interval  = windowInterval(window);
  const bucketSec = bucketSeconds(window);
  const sourceClause = source !== 'all' ? `AND source = '${source}'` : '';

  // ── Time-bucketed aggregates ──────────────────────────────────────────────
  // We use a raw query for array_agg-based percentile calc (Prisma lacks percentile_cont).
  // Results are sorted oldest-first for the chart.
  const bucketResult = await dbQuery(
    `SELECT
       to_timestamp(floor(extract(epoch from sampled_at) / $1) * $1) AS t_start,
       array_agg(working_set_mb ORDER BY working_set_mb) FILTER (WHERE working_set_mb IS NOT NULL) AS wset,
       array_agg(cpu_pct        ORDER BY cpu_pct)        FILTER (WHERE cpu_pct        IS NOT NULL) AS cpu,
       array_agg(gif_cache_mb   ORDER BY gif_cache_mb)   FILTER (WHERE gif_cache_mb   IS NOT NULL) AS gif,
       array_agg(fps            ORDER BY fps)             FILTER (WHERE fps            IS NOT NULL) AS fps_vals,
       count(*)::text AS cnt
     FROM client_metrics
     WHERE sampled_at >= now() - $2::interval
       ${sourceClause}
     GROUP BY 1
     ORDER BY 1 ASC`,
    [bucketSec, interval],
  );
  const bucketRows = bucketResult.rows as Array<{
    t_start: Date;
    wset: number[];
    cpu: number[];
    gif: number[];
    fps_vals: number[];
    cnt: string;
  }>;

  const timeBuckets: TimeBucket[] = (bucketRows || []).map((row) => {
    const wset = (row.wset ?? []).map(Number);
    const cpu  = (row.cpu  ?? []).map(Number);
    const gif  = (row.gif  ?? []).map(Number);
    const fps  = (row.fps_vals ?? []).map(Number);
    return {
      tStart:       (row.t_start as Date).toISOString(),
      workingSetMb: { p50: percOrNull(wset, 50), p90: percOrNull(wset, 90), p99: percOrNull(wset, 99) },
      cpuPct:       { p50: percOrNull(cpu,  50), p90: percOrNull(cpu,  90), p99: percOrNull(cpu,  99) },
      gifCacheMb:   { p50: percOrNull(gif,  50), p90: percOrNull(gif,  90), p99: percOrNull(gif,  99) },
      fps:          { p50: percOrNull(fps,  50), p90: percOrNull(fps,  90), p99: percOrNull(fps,  99) },
      sampleCount:  parseInt(row.cnt, 10),
    };
  });

  // ── Outliers: top 20 highest working-set rows in the window ──────────────
  const outlierResult = await dbQuery(
    `SELECT install_token, working_set_mb, cpu_pct, gif_cache_mb, fps, app_version, sampled_at
     FROM client_metrics
     WHERE sampled_at >= now() - $1::interval
       ${sourceClause}
     ORDER BY working_set_mb DESC
     LIMIT 20`,
    [interval],
  );
  const outlierRows = outlierResult.rows as Array<{
    install_token: string;
    working_set_mb: number;
    cpu_pct: number;
    gif_cache_mb: number | null;
    fps: number | null;
    app_version: string;
    sampled_at: Date;
  }>;

  const outliers: Outlier[] = (outlierRows || []).map((row) => ({
    tokenPrefix:  row.install_token.slice(0, 8),
    workingSetMb: Number(row.working_set_mb),
    cpuPct:       Number(row.cpu_pct),
    gifCacheMb:   row.gif_cache_mb != null ? Number(row.gif_cache_mb) : null,
    fps:          row.fps != null ? Number(row.fps) : null,
    appVersion:   row.app_version,
    sampledAt:    (row.sampled_at as Date).toISOString(),
  }));

  return { timeBuckets, outliers };
}

// ── Cron cleanup ─────────────────────────────────────────────────────────────

export async function purgeOldClientMetrics(): Promise<number> {
  try {
    const result = await (prisma as any).clientMetric.deleteMany({
      where: {
        sampledAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    });
    logger.info({ count: result.count }, '[clientMetrics] purged rows older than 30 days');
    return result.count;
  } catch (err) {
    logger.warn({ err }, '[clientMetrics] purge failed (non-fatal)');
    return 0;
  }
}
