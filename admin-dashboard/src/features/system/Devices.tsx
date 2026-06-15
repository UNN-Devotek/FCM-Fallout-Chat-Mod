import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

interface DeviceRow {
  id: string;
  installToken: string;
  enrolledAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  user: { installToken: string; username: string; discordUsername: string | null; isBanned: boolean } | null;
}

function userLabel(u: DeviceRow['user']): string {
  if (!u) return '(no linked account)';
  if (u.username && u.username !== 'Wanderer' && !u.username.startsWith('pending-') && !u.username.startsWith('admin-discord-')) return u.username;
  return u.discordUsername || u.username || '(unnamed)';
}

export default function Devices() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<DeviceRow[]>('/api/devices/admin/list'),
  });

  async function revoke(installToken: string, who: string) {
    if (!confirm(`Revoke the device key for ${who}? They'll be forced to re-enroll on next launch.`)) return;
    try {
      await api.delete(`/api/devices/admin/${encodeURIComponent(installToken)}`);
      qc.invalidateQueries({ queryKey: ['devices'] });
    } catch (err: any) {
      alert(err.message);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: '18px', marginBottom: '16px' }}>◈ DEVICES</h1>
      <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>
        Per-install signing keys. Each desktop install enrolls an ECDSA key the backend uses to verify
        its requests (replaces the shared client key). Revoking forces that install to re-enroll on next launch.
      </p>

      {error && <div className="error-message">{(error as Error).message}</div>}
      {isLoading ? <div className="loading">Loading...</div> : (
        <div className="table-responsive"><table>
          <thead>
            <tr><th>User</th><th>Install</th><th>Enrolled</th><th>Last seen</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {(data ?? []).map(d => {
              const who = userLabel(d.user);
              return (
                <tr key={d.id} style={{ opacity: d.revokedAt ? 0.55 : 1 }}>
                  <td>
                    {who}
                    {d.user?.isBanned && <span style={{ marginLeft: '6px', fontSize: '10px', color: 'var(--error)', border: '1px solid var(--error)', padding: '0 4px' }}>BANNED</span>}
                  </td>
                  <td style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-muted)' }}>{d.installToken.slice(0, 8)}…</td>
                  <td style={{ fontSize: '11px' }}>{new Date(d.enrolledAt).toLocaleString()}</td>
                  <td style={{ fontSize: '11px' }}>{new Date(d.lastSeenAt).toLocaleString()}</td>
                  <td style={{ fontSize: '11px', color: d.revokedAt ? 'var(--text-muted)' : 'var(--success)' }}>
                    {d.revokedAt ? `REVOKED ${new Date(d.revokedAt).toLocaleDateString()}` : 'ACTIVE'}
                  </td>
                  <td>
                    {!d.revokedAt && (
                      <button className="danger" onClick={() => revoke(d.installToken, who)} style={{ padding: '4px 10px', fontSize: '11px' }}>REVOKE</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {(data ?? []).length === 0 && (
              <tr><td colSpan={6} style={{ color: 'var(--text-muted)' }}>No devices enrolled yet.</td></tr>
            )}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
