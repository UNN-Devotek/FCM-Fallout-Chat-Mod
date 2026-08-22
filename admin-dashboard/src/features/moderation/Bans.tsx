import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

interface Ban {
  id: string;
  reasonCategory: string;
  reasonText: string;
  bannedUntil: string | null;
  createdAt: string;
  reversedAt: string | null;
  reverseReason: string | null;
  user: { id: string; username: string; discordId: string | null; discordDisplayName: string | null; discordUsername: string | null; discordAvatar: string | null; isBanned: boolean };
  bannedBy: { id: string; username: string; discordDisplayName: string | null; discordUsername: string | null } | null;
  reversedBy: { id: string; username: string; discordDisplayName: string | null; discordUsername: string | null } | null;
  evidence: Array<{ id: string; type: 'text' | 'image'; mime: string | null }>;
}

function displayName(u: { username: string; discordDisplayName: string | null; discordUsername: string | null } | null): string {
  if (!u) return '—';
  if (u.username && u.username !== 'Wanderer' && !u.username.startsWith('pending-') && !u.username.startsWith('admin-discord-')) return u.username;
  return u.discordDisplayName || u.discordUsername || u.username || '—';
}

// discordAvatar is the raw Discord avatar HASH — build the CDN URL from it + discordId.
function avatarUrl(u: { discordId: string | null; discordAvatar: string | null }, size = 32): string | null {
  if (!u.discordAvatar) return null;
  if (u.discordAvatar.startsWith('http')) return u.discordAvatar;
  if (!u.discordId) return null;
  return `https://cdn.discordapp.com/avatars/${u.discordId}/${u.discordAvatar}.png?size=${size}`;
}

function statusLabel(b: Ban): { text: string; color: string } {
  if (b.reversedAt) return { text: 'REVERSED', color: 'var(--text-muted)' };
  if (b.bannedUntil && new Date(b.bannedUntil) < new Date()) return { text: 'EXPIRED', color: 'var(--text-muted)' };
  if (b.bannedUntil) return { text: `UNTIL ${new Date(b.bannedUntil).toLocaleDateString()}`, color: 'var(--warning)' };
  return { text: 'PERMANENT', color: 'var(--error)' };
}

export default function Bans() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['bans'],
    queryFn: () => api.get<Ban[]>('/api/moderation/bans'),
  });
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleReverse(id: string) {
    if (!reverseReason.trim()) return;
    setBusy(true);
    try {
      await api.post(`/api/moderation/bans/${id}/reverse`, { reason: reverseReason });
      setReversingId(null);
      setReverseReason('');
      qc.invalidateQueries({ queryKey: ['bans'] });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h1 style={{ fontSize: '18px', margin: 0 }}>◈ BANS</h1>
        <button onClick={() => navigate('/moderation/bans/new')} style={{ fontSize: '12px', letterSpacing: '0.08em' }}>+ NEW BAN</button>
      </div>

      {error && <div className="error-message" style={{ marginBottom: '12px' }}>{(error as Error).message}</div>}
      {isLoading ? <div className="loading">Loading...</div> : (
        <div className="table-responsive"><table>
          <thead>
            <tr><th>User</th><th>Category</th><th>Reason</th><th>Status</th><th>By</th><th>When</th><th>Evidence</th><th></th></tr>
          </thead>
          <tbody>
            {(data ?? []).map(b => {
              const s = statusLabel(b);
              const imgCount = b.evidence.filter(e => e.type === 'image').length;
              const txtCount = b.evidence.filter(e => e.type === 'text').length;
              return (
                <tr key={b.id} style={{ opacity: b.reversedAt ? 0.55 : 1 }}>
                  <td style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {avatarUrl(b.user, 32) && <img src={avatarUrl(b.user, 32)!} alt="" style={{ width: '24px', height: '24px', borderRadius: '50%' }} />}
                    <Link to={`/profile/${b.user.id}`} style={{ color: 'var(--phosphor-color)' }}>{displayName(b.user)}</Link>
                  </td>
                  <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{b.reasonCategory}</td>
                  <td style={{ maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.reasonText}</td>
                  <td style={{ fontSize: '11px', color: s.color, fontWeight: 'bold' }}>{s.text}</td>
                  <td style={{ fontSize: '11px' }}>{displayName(b.bannedBy)}</td>
                  <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{new Date(b.createdAt).toLocaleString()}</td>
                  <td style={{ fontSize: '11px' }}>{imgCount > 0 && `📷 ${imgCount}`} {txtCount > 0 && `📝 ${txtCount}`}</td>
                  <td style={{ display: 'flex', gap: '6px' }}>
                    <Link to={`/moderation/bans/${b.id}`} style={{ padding: '4px 10px', fontSize: '11px', border: '1px solid var(--border-color)', textDecoration: 'none', color: 'var(--text-primary)' }}>VIEW</Link>
                    {!b.reversedAt && (
                      <button onClick={() => { setReversingId(b.id); setReverseReason(''); }} style={{ padding: '4px 10px', fontSize: '11px' }}>UNBAN</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {(data ?? []).length === 0 && (
              <tr><td colSpan={8} style={{ color: 'var(--text-muted)' }}>No bans recorded.</td></tr>
            )}
          </tbody>
        </table></div>
      )}

      {reversingId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }} onClick={() => !busy && setReversingId(null)}>
          <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-color)', padding: '20px', minWidth: '400px', maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
            <h2 style={{ marginTop: 0, fontSize: '14px' }}>Reverse this ban</h2>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>REASON (required, will be audited)</label>
            <textarea value={reverseReason} onChange={e => setReverseReason(e.target.value)} rows={3} style={{ width: '100%', resize: 'vertical' }} maxLength={500} autoFocus />
            <div style={{ display: 'flex', gap: '10px', marginTop: '12px', justifyContent: 'flex-end' }}>
              <button onClick={() => setReversingId(null)} disabled={busy}>CANCEL</button>
              <button onClick={() => handleReverse(reversingId)} disabled={busy || !reverseReason.trim()} className="danger">{busy ? 'REVERSING...' : 'CONFIRM UNBAN'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
