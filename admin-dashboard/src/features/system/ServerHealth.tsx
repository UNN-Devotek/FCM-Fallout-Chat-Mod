import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import CrtLineChart from './components/CrtLineChart';
import CrtBarChart from './components/CrtBarChart';
import CrtRangeSelector from './components/CrtRangeSelector';
import { useCommunityStats } from './hooks/useCommunityStats';
import type { StatsRange } from './components/CrtRangeSelector';

interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

interface HealthData {
  status: string;
  database: string;
  redis: string;
  discord: string;
  websocket_clients: number;
  messagesPerSecond: number | null;
  uptime: number;
  timestamp: string;
  fullscreenClients?: number;
  poolStats?: PoolStats;
  process?: {
    memoryMB?: { rss: number };
    cpuPercent?: number;
  };
}

// ── Shared layout constants ────────────────────────────────────────────────

const SECTION_GAP = 32;

const sectionStyle: React.CSSProperties = {
  background: 'var(--bg-panel)',
  border: '1px solid var(--border-color)',
  padding: '20px',
  marginTop: `${SECTION_GAP}px`,
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: '11px',
  letterSpacing: '3px',
  color: 'var(--text-muted)',
  textTransform: 'uppercase' as const,
  fontFamily: 'var(--font-mono)',
  marginBottom: '16px',
  display: 'flex',
  alignItems: 'center',
  gap: '16px',
  flexWrap: 'wrap' as const,
};

const chartGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
  gap: '16px',
};

// Chart wrapper: gives each chart a consistent height so grid rows align
const chartWrapStyle: React.CSSProperties = {
  minHeight: '200px',
  display: 'flex',
  flexDirection: 'column',
};

export default function ServerHealth() {
  const [statsRange, setStatsRange] = useState<StatsRange>('90d');

  const { data: health, error: queryError, refetch } = useQuery({
    queryKey: ['server-health'],
    queryFn: () => api.get<HealthData>('/api/health'),
    refetchInterval: 15000,
  });
  const error = queryError ? (queryError as Error).message : null;

  const { data: communityStats, isLoading: statsLoading, error: statsError } = useCommunityStats(statsRange);

  function statusColor(status: string) {
    return status === 'connected' || status === 'ok' ? 'var(--phosphor-color)' : 'var(--danger)';
  }

  function poolBar(poolStats: PoolStats) {
    const { total, idle, waiting } = poolStats;
    const active = total - idle;
    const pct = total > 0 ? Math.round((active / total) * 100) : 0;
    const color = pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warning)' : 'var(--phosphor-color)';
    return (
      <div style={{ marginTop: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
          <span>{active} active / {total} total</span>
          {waiting > 0 && <span style={{ color: 'var(--warning)' }}>{waiting} waiting</span>}
        </div>
        <div style={{ height: '6px', background: 'var(--bg-dark)', border: '1px solid var(--border-color)' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: color, transition: 'width 0.3s' }} />
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* ── Page header ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '18px' }}>◈ SERVER HEALTH</h1>
        <button onClick={() => refetch()} aria-label="Refresh server health data" style={{ padding: '4px 12px', fontSize: '11px', minHeight: '44px' }}>↻ REFRESH</button>
      </div>

      {error && <div className="error-message" role="alert">{error}</div>}

      {/* ── SYSTEM HEALTH ────────────────────────────────────────────────────── */}
      {health && (
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <span>◈ SYSTEM HEALTH</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px' }}>
            {[
              { label: 'STATUS', value: health.status?.toUpperCase(), color: statusColor(health.status) },
              { label: 'DATABASE', value: health.database?.toUpperCase(), color: statusColor(health.database) },
              { label: 'REDIS', value: health.redis?.toUpperCase(), color: statusColor(health.redis) },
              { label: 'DISCORD', value: health.discord?.toUpperCase(), color: statusColor(health.discord) },
              { label: 'WS CLIENTS', value: String(health.websocket_clients), color: 'var(--text-primary)' },
              { label: 'MESSAGES/SEC', value: health.messagesPerSecond != null ? health.messagesPerSecond.toFixed(1) : '—', color: 'var(--text-primary)' },
              { label: 'UPTIME', value: `${Math.floor(health.uptime / 60)}m ${Math.floor(health.uptime % 60)}s`, color: 'var(--text-primary)' },
              { label: 'RSS MEMORY', value: health.process?.memoryMB?.rss != null ? `${health.process.memoryMB.rss} MB` : '—', color: 'var(--text-primary)' },
              { label: 'CPU %', value: health.process?.cpuPercent != null ? `${health.process.cpuPercent}%` : '—', color: 'var(--text-primary)' },
            ].map(({ label, value, color }) => (
              <div
                key={label}
                data-testid="health-card"
                role="status"
                aria-label={`${label}: ${value}`}
                style={{
                  background: 'var(--bg-dark)',
                  border: '1px solid var(--border-color)',
                  padding: '12px',
                }}
              >
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>{label}</div>
                <div style={{ fontSize: '18px', color, fontWeight: 'bold' }}>{value}</div>
              </div>
            ))}

            {/* DB Pool Utilization card */}
            <div
              data-testid="health-card"
              role="status"
              aria-label={`DB Pool: ${health.poolStats ? `${health.poolStats.total - health.poolStats.idle} active of ${health.poolStats.total}` : 'unavailable'}`}
              style={{
                background: 'var(--bg-dark)',
                border: '1px solid var(--border-color)',
                padding: '12px',
              }}
            >
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>DB POOL</div>
              <div style={{ fontSize: '18px', color: 'var(--text-primary)', fontWeight: 'bold' }}>
                {health.poolStats ? `${Math.round(((health.poolStats.total - health.poolStats.idle) / health.poolStats.total) * 100)}%` : '—'}
              </div>
              {health.poolStats && poolBar(health.poolStats)}
            </div>

            {/* Fullscreen clients card */}
            {health.fullscreenClients != null && (
              <div
                data-testid="health-card"
                role="status"
                aria-label={`Fullscreen clients: ${health.fullscreenClients}`}
                style={{
                  background: 'var(--bg-dark)',
                  border: `1px solid ${health.fullscreenClients > 0 ? 'var(--warning)' : 'var(--border-color)'}`,
                  padding: '12px',
                }}
              >
                <div style={{ fontSize: '10px', color: health.fullscreenClients > 0 ? 'var(--warning)' : 'var(--text-muted)', marginBottom: '6px' }}>FULLSCREEN CLIENTS</div>
                <div style={{ fontSize: '18px', color: health.fullscreenClients > 0 ? 'var(--warning)' : 'var(--text-primary)', fontWeight: 'bold' }}>{health.fullscreenClients}</div>
              </div>
            )}
          </div>

          <div style={{ marginTop: '12px', fontSize: '11px', color: 'var(--text-muted)' }}>
            Last updated: {new Date(health.timestamp).toLocaleString()}
          </div>
        </div>
      )}

      {/* ── COMMUNITY ────────────────────────────────────────────────────────── */}
      <div style={{ ...sectionStyle, marginTop: `${SECTION_GAP}px` }}>
        <div style={sectionHeaderStyle}>
          <span>◈ COMMUNITY</span>
          <CrtRangeSelector value={statsRange} onChange={setStatsRange} />
          {statsLoading && (
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '1px' }}>LOADING…</span>
          )}
          {statsError && (
            <span style={{ fontSize: '10px', color: 'var(--danger)', letterSpacing: '1px' }}>
              {(statsError as Error).message}
            </span>
          )}
        </div>

        {communityStats && (
          <>
            {/* ── ACTIVITY ─────────────────────────────────────────────────── */}
            <div style={{ marginBottom: `${SECTION_GAP}px` }}>
              <div style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: '12px', textTransform: 'uppercase' }}>
                Activity
              </div>
              <div style={chartGridStyle}>
                <div style={chartWrapStyle}>
                  <CrtLineChart
                    title="Activity Over Time"
                    buckets={communityStats.activityOverTime.map(p => p.bucket)}
                    bucketSize={communityStats.bucketSize}
                    series={[
                      {
                        key: 'messages',
                        label: 'Messages',
                        color: 'var(--phosphor-color)',
                        values: communityStats.activityOverTime.map(p => p.messages),
                      },
                      {
                        key: 'users',
                        label: 'Active Users',
                        color: '#70b0ff',
                        values: communityStats.activityOverTime.map(p => p.activeUsers),
                      },
                    ]}
                  />
                </div>
                <div style={chartWrapStyle}>
                  <CrtLineChart
                    title="New Signups"
                    unit="users"
                    buckets={communityStats.signupsPerBucket.map(p => p.bucket)}
                    bucketSize={communityStats.bucketSize}
                    series={[{
                      key: 'signups',
                      label: 'Signups',
                      color: 'var(--phosphor-color)',
                      values: communityStats.signupsPerBucket.map(p => p.count),
                    }]}
                  />
                </div>
                <div style={chartWrapStyle}>
                  <CrtLineChart
                    title="Daily Active Users"
                    unit="users"
                    buckets={communityStats.dauPerBucket.map(p => p.bucket)}
                    bucketSize={communityStats.bucketSize}
                    series={[{
                      key: 'dau',
                      label: 'Active Users',
                      color: '#70b0ff',
                      values: communityStats.dauPerBucket.map(p => p.count),
                    }]}
                  />
                </div>
              </div>
            </div>

            {/* ── MESSAGES ─────────────────────────────────────────────────── */}
            <div style={{ marginBottom: `${SECTION_GAP}px` }}>
              <div style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: '12px', textTransform: 'uppercase' }}>
                Messages
              </div>
              <div style={chartGridStyle}>
                <div style={chartWrapStyle}>
                  <CrtLineChart
                    title="Messages Per Bucket"
                    unit="msgs"
                    buckets={communityStats.messagesPerBucket.map(p => p.bucket)}
                    bucketSize={communityStats.bucketSize}
                    series={[{
                      key: 'msgs',
                      label: 'Messages',
                      color: 'var(--phosphor-color)',
                      values: communityStats.messagesPerBucket.map(p => p.count),
                    }]}
                  />
                </div>

                {/* Message Sources */}
                <div style={{ ...chartWrapStyle, background: 'var(--bg-dark)', border: '1px solid var(--border-color)', padding: '12px', gap: '12px' }}>
                  <div style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--text-muted)', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', marginBottom: '12px' }}>
                    Message Sources
                  </div>
                  {(() => {
                    const total = communityStats.messageSplit.game + communityStats.messageSplit.discord || 1;
                    const gamePct = Math.round((communityStats.messageSplit.game / total) * 100);
                    const discordPct = 100 - gamePct;
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {[
                          { label: 'IN-GAME', value: communityStats.messageSplit.game, pct: gamePct, color: 'var(--phosphor-color)' },
                          { label: 'DISCORD', value: communityStats.messageSplit.discord, pct: discordPct, color: '#70b0ff' },
                        ].map(({ label, value, pct, color }) => (
                          <div key={label}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px', fontFamily: 'var(--font-mono)' }}>
                              <span>{label}</span>
                              <span>{value.toLocaleString()} ({pct}%)</span>
                            </div>
                            <div style={{ height: '6px', background: 'var(--bg-dark)', border: '1px solid var(--border-color)' }}>
                              <div style={{ height: '100%', width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                <div style={chartWrapStyle}>
                  <CrtBarChart
                    title="Messages per Channel"
                    horizontal
                    data={communityStats.messagesPerChannel.map(ch => ({
                      label: ch.channelName,
                      value: ch.count,
                    }))}
                  />
                </div>
              </div>
            </div>

            {/* ── VERSIONS & DOWNLOADS ─────────────────────────────────────── */}
            <div style={{ marginBottom: `${SECTION_GAP}px` }}>
              <div style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: '12px', textTransform: 'uppercase' }}>
                Versions &amp; Downloads
              </div>
              <div style={chartGridStyle}>
                <div style={chartWrapStyle}>
                  <CrtBarChart
                    title="Client Version Distribution"
                    horizontal
                    data={communityStats.versionDistribution.map(v => ({
                      label: v.version,
                      value: v.count,
                    }))}
                  />
                </div>
                <div style={chartWrapStyle}>
                  <CrtBarChart
                    title="Downloads per Version"
                    unit="count &gt; 2"
                    horizontal
                    data={communityStats.downloadsPerVersion.map(d => ({
                      label: `v${d.version}`,
                      value: d.count,
                      color: 'var(--phosphor-color)',
                    }))}
                  />
                </div>
              </div>
            </div>

            {/* ── MODERATION ───────────────────────────────────────────────── */}
            <div>
              <div style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginBottom: '12px', textTransform: 'uppercase' }}>
                Moderation
              </div>
              <div style={chartWrapStyle}>
                <CrtLineChart
                  title="Moderation Activity"
                  buckets={communityStats.moderationPerBucket.map(p => p.bucket)}
                  bucketSize={communityStats.bucketSize}
                  series={[
                    {
                      key: 'bans',
                      label: 'Bans',
                      color: 'var(--danger)',
                      values: communityStats.moderationPerBucket.map(p => p.bans),
                    },
                    {
                      key: 'reports',
                      label: 'Reports',
                      color: 'var(--warning)',
                      values: communityStats.moderationPerBucket.map(p => p.reports),
                    },
                    {
                      key: 'audit',
                      label: 'Audit Actions',
                      color: 'var(--text-secondary)',
                      values: communityStats.moderationPerBucket.map(p => p.auditActions),
                    },
                  ]}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
