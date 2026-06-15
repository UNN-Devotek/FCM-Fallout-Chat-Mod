import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';

interface AutoModRule {
  id: string;
  name: string;
  triggerType: string;
}

interface ViolationActionResult {
  type: string;
  success: boolean;
  detail?: string;
}

interface AutoModViolation {
  id: string;
  ruleId: string;
  userId: string;
  channelId: string | null;
  messageContent: string;
  matchedKeyword: string | null;
  matchedSubstr: string | null;
  actionsTaken: ViolationActionResult[];
  createdAt: string;
  rule: { name: string; triggerType: string };
}

interface ViolationsResponse {
  data: AutoModViolation[];
  total: number;
}

const PAGE_SIZE = 50;

function truncate(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function actionsBadges(actions: ViolationActionResult[]) {
  return actions.map((a, i) => (
    <span
      key={i}
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        fontSize: '10px',
        borderRadius: '3px',
        marginRight: '4px',
        background: a.success ? 'rgba(24,255,98,0.1)' : 'rgba(255,68,68,0.1)',
        color: a.success ? 'var(--success)' : 'var(--error)',
        border: `1px solid ${a.success ? 'rgba(24,255,98,0.25)' : 'rgba(255,68,68,0.25)'}`,
      }}
    >
      {a.type}
    </span>
  ));
}

export default function AutoModViolations() {
  const [filters, setFilters] = useState({ ruleId: '', userId: '', from: '', to: '' });
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);

  const { data: rules } = useQuery({
    queryKey: ['automod-rules'],
    queryFn: () => api.get<AutoModRule[]>('/api/moderation/automod-rules'),
  });

  const queryString = new URLSearchParams({
    ...Object.fromEntries(Object.entries(applied).filter(([, v]) => v)),
    limit: String(PAGE_SIZE),
    offset: String(offset),
  }).toString();

  const { data: result, isLoading, error: queryError } = useQuery({
    queryKey: ['automod-violations', queryString],
    queryFn: () =>
      fetch(`/api/moderation/automod-violations${queryString ? '?' + queryString : ''}`, { credentials: 'include' })
        .then(async r => {
          if (!r.ok) {
            const err = await r.json().catch(() => ({ detail: r.statusText }));
            throw new Error(err.detail || `HTTP ${r.status}`);
          }
          const json = await r.json();
          return json as ViolationsResponse;
        }),
  });

  const violations: AutoModViolation[] = result?.data ?? [];
  const total: number = result?.total ?? 0;
  const error = queryError ? (queryError as Error).message : null;

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    setApplied({ ...filters });
    setOffset(0);
  }

  function clearFilters() {
    setFilters({ ruleId: '', userId: '', from: '', to: '' });
    setApplied({});
    setOffset(0);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div>
      <h1 style={{ fontSize: '18px', marginBottom: '16px' }}>◈ AUTOMOD VIOLATIONS</h1>

      <form onSubmit={applyFilters} style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px', alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>RULE</label>
          <select
            value={filters.ruleId}
            onChange={e => setFilters(f => ({ ...f, ruleId: e.target.value }))}
            style={{ width: '180px' }}
          >
            <option value="">All rules</option>
            {(rules || []).map(r => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>USER ID</label>
          <input
            placeholder="UUID or partial..."
            value={filters.userId}
            onChange={e => setFilters(f => ({ ...f, userId: e.target.value }))}
            style={{ width: '200px' }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>FROM</label>
          <input type="date" value={filters.from} onChange={e => setFilters(f => ({ ...f, from: e.target.value }))} style={{ width: '160px' }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>TO</label>
          <input type="date" value={filters.to} onChange={e => setFilters(f => ({ ...f, to: e.target.value }))} style={{ width: '160px' }} />
        </div>
        <button type="submit">APPLY</button>
        <button type="button" onClick={clearFilters} style={{ color: 'var(--text-muted)', borderColor: 'var(--text-muted)' }}>CLEAR</button>
      </form>

      {error && <div className="error-message">{error}</div>}

      {!isLoading && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
          {total} violation{total !== 1 ? 's' : ''} found
          {total > PAGE_SIZE && ` — page ${currentPage} of ${totalPages}`}
        </div>
      )}

      {isLoading ? (
        <div className="loading">Loading violations...</div>
      ) : (
        <div className="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>User</th>
                <th>Rule</th>
                <th>Trigger</th>
                <th>Matched</th>
                <th>Content</th>
                <th>Actions Taken</th>
              </tr>
            </thead>
            <tbody>
              {violations.map(v => (
                <tr key={v.id} data-testid="violation-row">
                  <td style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {new Date(v.createdAt).toLocaleString()}
                  </td>
                  <td style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                    {v.userId.slice(0, 8)}…
                  </td>
                  <td style={{ fontWeight: 'bold', fontSize: '12px' }}>{v.rule.name}</td>
                  <td style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{v.rule.triggerType}</td>
                  <td style={{ fontSize: '11px', fontFamily: 'monospace', color: '#f59e0b' }}>
                    {v.matchedKeyword ?? v.matchedSubstr ?? '—'}
                  </td>
                  <td style={{ fontSize: '11px', color: 'var(--text-muted)', maxWidth: '260px' }}>
                    <span title={v.messageContent}>{truncate(v.messageContent)}</span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{actionsBadges(v.actionsTaken)}</td>
                </tr>
              ))}
              {violations.length === 0 && (
                <tr><td colSpan={7} style={{ color: 'var(--text-muted)' }}>No violations found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '16px', fontSize: '12px' }}>
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
            style={{ padding: '4px 12px' }}
          >
            ← PREV
          </button>
          <span style={{ color: 'var(--text-muted)' }}>
            Page {currentPage} of {totalPages}
          </span>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= total}
            style={{ padding: '4px 12px' }}
          >
            NEXT →
          </button>
        </div>
      )}
    </div>
  );
}
