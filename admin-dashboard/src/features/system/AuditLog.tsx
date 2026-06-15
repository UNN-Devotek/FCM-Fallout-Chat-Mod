import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';

interface AuditEntry {
  id: string;
  created_at: string;
  actor: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
}

export default function AuditLog() {
  const [filters, setFilters] = useState({ action: '', from: '', to: '' });
  const [appliedFilters, setAppliedFilters] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);

  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(appliedFilters).filter(([, v]) => v))
  ).toString();

  const { data: logs, isLoading: loading, error: queryError } = useQuery({
    queryKey: ['audit-log', query],
    queryFn: () => api.get<AuditEntry[]>(`/api/audit-log${query ? '?' + query : ''}`),
  });
  const error = queryError ? (queryError as Error).message : null;

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    setAppliedFilters({ ...filters });
  }

  async function handleExport() {
    setExporting(true);
    try {
      const exportParams = new URLSearchParams(
        Object.fromEntries(Object.entries(appliedFilters).filter(([, v]) => v))
      );
      exportParams.set('format', 'csv');
      const res = await fetch(`/api/audit-log/export?${exportParams.toString()}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Export failed: ${res.statusText}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'audit-log-export.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h1 style={{ fontSize: '18px', margin: 0 }}>◈ AUDIT LOG</h1>
        <button data-testid="export-audit-btn" onClick={handleExport} disabled={exporting}>
          {exporting ? 'EXPORTING...' : 'EXPORT CSV'}
        </button>
      </div>

      <form onSubmit={applyFilters} style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px', alignItems: 'flex-end' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>ACTION</label>
          <input
            data-testid="audit-action-filter"
            placeholder="e.g. ban, mute"
            value={filters.action}
            onChange={(e) => setFilters({ ...filters, action: e.target.value })}
            style={{ width: '160px' }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>FROM</label>
          <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} style={{ width: '160px' }} />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>TO</label>
          <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} style={{ width: '160px' }} />
        </div>
        <button type="submit" data-testid="apply-filters-btn">APPLY</button>
        <button type="button" onClick={() => { setFilters({ action: '', from: '', to: '' }); setAppliedFilters({}); }} style={{ color: 'var(--text-muted)', borderColor: 'var(--text-muted)' }}>CLEAR</button>
      </form>

      {error && <div className="error-message">{error}</div>}
      {loading ? (
        <div className="loading">Loading audit log...</div>
      ) : (
        <div className="table-responsive">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {(logs || []).map((log) => (
              <tr key={log.id} data-testid="audit-row">
                <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {new Date(log.created_at).toLocaleString()}
                </td>
                <td>{log.actor || '[system]'}</td>
                <td style={{ color: 'var(--warning)', textTransform: 'uppercase', fontSize: '11px' }}>{log.action}</td>
                <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {log.target_type && `${log.target_type}: `}{log.target_id?.slice(0, 8)}...
                </td>
                <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{log.reason || '–'}</td>
              </tr>
            ))}
            {(logs || []).length === 0 && (
              <tr><td colSpan={5} style={{ color: 'var(--text-muted)' }}>No audit log entries found.</td></tr>
            )}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
