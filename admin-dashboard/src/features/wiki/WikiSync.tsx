import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

interface WikiUpdatesData {
  lastSyncAt: string | null;
  updatesAvailable: number;
  changedPages: number;
  newPages: number;
  checkedAt: string;
}

interface IngestResult {
  upserted: number;
  skipped: number;
  errors: number;
  [key: string]: unknown;
}

interface CampUpdatesData {
  lastSyncAt: string | null;
  updatesAvailable: boolean;
  checkedAt: string;
}

interface CampIngestResult {
  upserted: number;
  skipped: number;
  errors: number;
  [key: string]: unknown;
}

const sectionStyle: React.CSSProperties = {
  background: 'var(--bg-panel)',
  border: '1px solid var(--border-color)',
  padding: '20px',
  marginBottom: '24px',
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: '11px',
  letterSpacing: '3px',
  color: 'var(--text-muted)',
  textTransform: 'uppercase' as const,
  fontFamily: 'var(--font-mono)',
  marginBottom: '16px',
};

const statCardStyle: React.CSSProperties = {
  background: 'var(--bg-dark)',
  border: '1px solid var(--border-color)',
  padding: '12px',
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffS = Math.floor(diffMs / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

export default function WikiSync() {
  const queryClient = useQueryClient();
  const [lastResult, setLastResult] = useState<{ mode: string; result: IngestResult } | null>(null);
  const [confirmFull, setConfirmFull] = useState(false);

  // ── CAMP sync state ──
  const [campLastResult, setCampLastResult] = useState<CampIngestResult | null>(null);

  const { data: updates, error: updatesError } = useQuery<WikiUpdatesData>({
    queryKey: ['wiki-updates'],
    queryFn: () => api.get<WikiUpdatesData>('/api/admin/wiki/updates'),
    refetchInterval: 60_000,
  });

  const ingestMutation = useMutation<IngestResult, Error, 'incremental' | 'full'>({
    mutationFn: (mode) => api.post<IngestResult>('/api/admin/wiki/ingest', { mode }),
    onSuccess: (result, mode) => {
      setLastResult({ mode, result });
      setConfirmFull(false);
      queryClient.invalidateQueries({ queryKey: ['wiki-updates'] });
    },
    onError: () => {
      setConfirmFull(false);
    },
  });

  const isRunning = ingestMutation.isPending;

  const hasUpdates = updates && updates.updatesAvailable > 0;

  // ── CAMP queries / mutation ──
  const { data: campUpdates, error: campUpdatesError } = useQuery<CampUpdatesData>({
    queryKey: ['camp-updates'],
    queryFn: () => api.get<CampUpdatesData>('/api/admin/camp/updates'),
    refetchInterval: 60_000,
  });

  const campIngestMutation = useMutation<CampIngestResult, Error, void>({
    mutationFn: () => api.post<CampIngestResult>('/api/admin/camp/ingest', {}),
    onSuccess: (result) => {
      setCampLastResult(result);
      queryClient.invalidateQueries({ queryKey: ['camp-updates'] });
    },
  });

  const isCampRunning = campIngestMutation.isPending;
  const campHasUpdates = campUpdates?.updatesAvailable === true;

  return (
    <div>
      {/* ── Page header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: '18px' }}>◈ WIKI SYNC</h1>
      </div>

      {updatesError && (
        <div className="error-message" role="alert" style={{ marginBottom: '16px' }}>
          {(updatesError as Error).message}
        </div>
      )}

      {ingestMutation.isError && (
        <div className="error-message" role="alert" style={{ marginBottom: '16px' }}>
          Sync failed: {ingestMutation.error.message}
        </div>
      )}

      {/* ── STATUS ── */}
      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>◈ SYNC STATUS</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          {/* Last sync */}
          <div style={statCardStyle} role="status" aria-label={`Last sync: ${updates?.lastSyncAt ? relativeTime(updates.lastSyncAt) : 'Never'}`}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>LAST SYNC</div>
            <div style={{ fontSize: '18px', color: 'var(--text-primary)', fontWeight: 'bold' }}>
              {updates?.lastSyncAt ? relativeTime(updates.lastSyncAt) : '—'}
            </div>
            {updates?.lastSyncAt && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {new Date(updates.lastSyncAt).toLocaleString()}
              </div>
            )}
          </div>

          {/* Updates available */}
          <div
            style={{
              ...statCardStyle,
              border: `1px solid ${hasUpdates ? 'var(--warning)' : 'var(--border-color)'}`,
            }}
            role="status"
            aria-label={`Updates available: ${updates?.updatesAvailable ?? '—'}`}
          >
            <div style={{ fontSize: '10px', color: hasUpdates ? 'var(--warning)' : 'var(--text-muted)', marginBottom: '6px' }}>
              UPDATES AVAILABLE
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {hasUpdates && (
                <span style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  background: 'var(--warning)',
                  boxShadow: '0 0 6px var(--warning)',
                  flexShrink: 0,
                  display: 'inline-block',
                }} />
              )}
              <span style={{ fontSize: '18px', color: hasUpdates ? 'var(--warning)' : 'var(--phosphor-color)', fontWeight: 'bold' }}>
                {updates ? updates.updatesAvailable : '—'}
              </span>
            </div>
            {updates && updates.updatesAvailable > 0 && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {updates.changedPages} changed · {updates.newPages} new
              </div>
            )}
            {updates && updates.updatesAvailable === 0 && (
              <div style={{ fontSize: '10px', color: 'var(--phosphor-color)', marginTop: '4px' }}>Up to date</div>
            )}
          </div>

          {/* Checked at */}
          <div style={statCardStyle} role="status" aria-label={`Last checked: ${updates?.checkedAt ? relativeTime(updates.checkedAt) : 'Never'}`}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>LAST CHECKED</div>
            <div style={{ fontSize: '18px', color: 'var(--text-primary)', fontWeight: 'bold' }}>
              {updates?.checkedAt ? relativeTime(updates.checkedAt) : '—'}
            </div>
            {updates?.checkedAt && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {new Date(updates.checkedAt).toLocaleString()}
              </div>
            )}
          </div>
        </div>

        {/* Schedule info */}
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', letterSpacing: '1px', borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
          Auto-sync: configured via <code style={{ color: 'var(--phosphor-color)', fontSize: '11px' }}>WIKI_SYNC_INTERVAL_HOURS</code> (server)
        </div>
      </div>

      {/* ── SYNC ACTIONS ── */}
      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>◈ SYNC ACTIONS</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Incremental sync */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <button
              onClick={() => ingestMutation.mutate('incremental')}
              disabled={isRunning}
              aria-label="Run incremental wiki sync"
              style={{
                padding: '8px 20px',
                fontSize: '12px',
                letterSpacing: '2px',
                minHeight: '44px',
                opacity: isRunning ? 0.6 : 1,
                cursor: isRunning ? 'not-allowed' : 'pointer',
              }}
            >
              {isRunning && ingestMutation.variables === 'incremental' ? '◌ SYNCING…' : '↻ SYNC NOW'}
            </button>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Fetches only changed and new pages since last sync.
            </span>
          </div>

          {/* Full re-sync */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            {!confirmFull ? (
              <button
                onClick={() => setConfirmFull(true)}
                disabled={isRunning}
                aria-label="Request full wiki re-sync"
                style={{
                  padding: '6px 16px',
                  fontSize: '11px',
                  letterSpacing: '1px',
                  minHeight: '44px',
                  border: '1px solid rgba(212,176,64,0.35)',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  opacity: isRunning ? 0.5 : 1,
                  cursor: isRunning ? 'not-allowed' : 'pointer',
                }}
              >
                FULL RE-SYNC
              </button>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', color: 'var(--warning)', letterSpacing: '1px' }}>
                  This re-ingests all wiki pages. Confirm?
                </span>
                <button
                  onClick={() => ingestMutation.mutate('full')}
                  disabled={isRunning}
                  aria-label="Confirm full wiki re-sync"
                  style={{
                    padding: '6px 14px',
                    fontSize: '11px',
                    letterSpacing: '1px',
                    minHeight: '44px',
                    border: '1px solid var(--warning)',
                    color: 'var(--warning)',
                    background: 'transparent',
                    cursor: isRunning ? 'not-allowed' : 'pointer',
                  }}
                >
                  {isRunning && ingestMutation.variables === 'full' ? '◌ RUNNING…' : 'CONFIRM'}
                </button>
                <button
                  onClick={() => setConfirmFull(false)}
                  aria-label="Cancel full re-sync"
                  style={{
                    padding: '6px 12px',
                    fontSize: '11px',
                    letterSpacing: '1px',
                    minHeight: '44px',
                    border: '1px solid rgba(212,176,64,0.25)',
                    background: 'transparent',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  CANCEL
                </button>
              </div>
            )}
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Re-ingests all wiki pages from scratch. Slow — use sparingly.
            </span>
          </div>
        </div>
      </div>

      {/* ── CAMP DATABASE ── */}
      <div style={{ ...sectionStyle, borderColor: 'var(--border-color)' }}>
        <div style={sectionHeaderStyle}>◈ CAMP DATABASE</div>

        {campUpdatesError && (
          <div className="error-message" role="alert" style={{ marginBottom: '12px' }}>
            {(campUpdatesError as Error).message}
          </div>
        )}
        {campIngestMutation.isError && (
          <div className="error-message" role="alert" style={{ marginBottom: '12px' }}>
            CAMP sync failed: {campIngestMutation.error.message}
          </div>
        )}

        {/* Stat cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          <div style={statCardStyle} role="status" aria-label={`CAMP last sync: ${campUpdates?.lastSyncAt ? relativeTime(campUpdates.lastSyncAt) : 'Never'}`}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>LAST SYNC</div>
            <div style={{ fontSize: '18px', color: 'var(--text-primary)', fontWeight: 'bold' }}>
              {campUpdates?.lastSyncAt ? relativeTime(campUpdates.lastSyncAt) : '—'}
            </div>
            {campUpdates?.lastSyncAt && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {new Date(campUpdates.lastSyncAt).toLocaleString()}
              </div>
            )}
          </div>

          <div
            style={{
              ...statCardStyle,
              border: `1px solid ${campHasUpdates ? 'var(--warning)' : 'var(--border-color)'}`,
            }}
            role="status"
            aria-label={`CAMP updates available: ${campHasUpdates ? 'Yes' : 'No'}`}
          >
            <div style={{ fontSize: '10px', color: campHasUpdates ? 'var(--warning)' : 'var(--text-muted)', marginBottom: '6px' }}>
              UPDATES AVAILABLE
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {campHasUpdates && (
                <span style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  background: 'var(--warning)',
                  boxShadow: '0 0 6px var(--warning)',
                  flexShrink: 0,
                  display: 'inline-block',
                }} />
              )}
              <span style={{ fontSize: '18px', color: campHasUpdates ? 'var(--warning)' : 'var(--phosphor-color)', fontWeight: 'bold' }}>
                {campUpdates ? (campHasUpdates ? 'Yes' : 'No') : '—'}
              </span>
            </div>
            {campUpdates && !campHasUpdates && (
              <div style={{ fontSize: '10px', color: 'var(--phosphor-color)', marginTop: '4px' }}>Up to date</div>
            )}
          </div>

          <div style={statCardStyle} role="status" aria-label={`CAMP last checked: ${campUpdates?.checkedAt ? relativeTime(campUpdates.checkedAt) : 'Never'}`}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>LAST CHECKED</div>
            <div style={{ fontSize: '18px', color: 'var(--text-primary)', fontWeight: 'bold' }}>
              {campUpdates?.checkedAt ? relativeTime(campUpdates.checkedAt) : '—'}
            </div>
            {campUpdates?.checkedAt && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {new Date(campUpdates.checkedAt).toLocaleString()}
              </div>
            )}
          </div>
        </div>

        {/* Sync button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
          <button
            onClick={() => campIngestMutation.mutate()}
            disabled={isCampRunning}
            aria-label="Sync CAMP database now"
            style={{
              padding: '8px 20px',
              fontSize: '12px',
              letterSpacing: '2px',
              minHeight: '44px',
              opacity: isCampRunning ? 0.6 : 1,
              cursor: isCampRunning ? 'not-allowed' : 'pointer',
            }}
          >
            {isCampRunning ? '◌ SYNCING…' : '↻ SYNC CAMP NOW'}
          </button>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Ingests CAMP item data and images from the 76 CAMP Database.
          </span>
        </div>

        {/* Last CAMP result */}
        {campLastResult && (
          <div style={{ marginTop: '16px', borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
            <div style={{ ...sectionHeaderStyle, marginBottom: '10px' }}>LAST RUN RESULT</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '12px' }}>
              {[
                { label: 'UPSERTED', value: campLastResult.upserted, color: 'var(--phosphor-color)' },
                { label: 'SKIPPED', value: campLastResult.skipped, color: 'var(--text-secondary)' },
                { label: 'ERRORS', value: campLastResult.errors, color: campLastResult.errors > 0 ? 'var(--danger)' : 'var(--text-muted)' },
              ].map(({ label, value, color }) => (
                <div key={label} style={statCardStyle} role="status" aria-label={`${label}: ${value}`}>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>{label}</div>
                  <div style={{ fontSize: '22px', color, fontWeight: 'bold' }}>{value}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── LAST RESULT ── */}
      {lastResult && (
        <div style={{ ...sectionStyle, border: '1px solid var(--phosphor-color)' }}>
          <div style={sectionHeaderStyle}>◈ LAST RUN RESULT — {lastResult.mode.toUpperCase()}</div>
          {typeof lastResult.result.upserted !== 'number' ? (
            // Full re-sync runs in the background (no synchronous counts) — the
            // "updates available" badge above drops to 0 when it finishes.
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              Full re-sync started in the background — this can take a while; the “updates available” badge will refresh when it completes.
            </div>
          ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '12px' }}>
            {[
              { label: 'UPSERTED', value: lastResult.result.upserted, color: 'var(--phosphor-color)' },
              { label: 'SKIPPED', value: lastResult.result.skipped, color: 'var(--text-secondary)' },
              { label: 'ERRORS', value: lastResult.result.errors, color: lastResult.result.errors > 0 ? 'var(--danger)' : 'var(--text-muted)' },
            ].map(({ label, value, color }) => (
              <div key={label} style={statCardStyle} role="status" aria-label={`${label}: ${value}`}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>{label}</div>
                <div style={{ fontSize: '22px', color, fontWeight: 'bold' }}>{value}</div>
              </div>
            ))}
          </div>
          )}
        </div>
      )}
    </div>
  );
}
