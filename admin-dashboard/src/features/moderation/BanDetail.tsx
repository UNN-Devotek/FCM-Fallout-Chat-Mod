import React, { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';

interface Evidence { id: string; type: 'text' | 'image'; textContent: string | null; mime: string | null; sizeBytes: number | null; createdAt: string }
interface BanDetail {
  id: string; userId: string;
  reasonCategory: string; reasonText: string;
  bannedUntil: string | null; createdAt: string;
  reversedAt: string | null; reverseReason: string | null;
  user: { id: string; username: string; discordId: string | null; discordDisplayName: string | null; discordUsername: string | null; discordAvatar: string | null; isBanned: boolean };
  bannedBy: { id: string; username: string; discordDisplayName: string | null; discordUsername: string | null } | null;
  reversedBy: { id: string; username: string; discordDisplayName: string | null; discordUsername: string | null } | null;
  evidence: Evidence[];
}

function name(u: { username: string; discordDisplayName: string | null; discordUsername: string | null } | null): string {
  if (!u) return '—';
  if (u.username && u.username !== 'Wanderer' && !u.username.startsWith('pending-') && !u.username.startsWith('admin-discord-')) return u.username;
  return u.discordDisplayName || u.discordUsername || u.username || '—';
}

// discordAvatar is the raw Discord avatar HASH — build the CDN URL from it + discordId.
function avatarUrl(u: { discordId: string | null; discordAvatar: string | null }, size = 64): string | null {
  if (!u.discordAvatar) return null;
  if (u.discordAvatar.startsWith('http')) return u.discordAvatar;
  if (!u.discordId) return null;
  return `https://cdn.discordapp.com/avatars/${u.discordId}/${u.discordAvatar}.png?size=${size}`;
}

export default function BanDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['ban', id],
    queryFn: () => api.get<BanDetail>(`/api/moderation/bans/${id}`),
    enabled: !!id,
  });
  const [reverseReason, setReverseReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleReverse() {
    if (!reverseReason.trim() || !id) return;
    setBusy(true);
    try {
      await api.post(`/api/moderation/bans/${id}/reverse`, { reason: reverseReason });
      qc.invalidateQueries({ queryKey: ['ban', id] });
      qc.invalidateQueries({ queryKey: ['bans'] });
      setReverseReason('');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error-message">{(error as Error).message}</div>;
  if (!data) return null;

  const labelStyle: React.CSSProperties = { display: 'block', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '2px', letterSpacing: '0.08em' };
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h1 style={{ fontSize: '18px', margin: 0 }}>◈ BAN DETAIL</h1>
        <button onClick={() => navigate('/moderation/bans')} style={{ fontSize: '12px' }}>← BACK TO BANS</button>
      </div>

      <section style={{ border: '1px solid var(--border-color)', padding: '14px', background: 'var(--bg-panel)', marginBottom: '14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <div>
          <label style={labelStyle}>USER</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {avatarUrl(data.user, 64) && <img src={avatarUrl(data.user, 64)!} alt="" style={{ width: '32px', height: '32px', borderRadius: '50%' }} />}
            <Link to={`/profile/${data.user.id}`} style={{ color: 'var(--phosphor-color)', fontSize: '14px' }}>{name(data.user)}</Link>
            {data.user.isBanned && <span style={{ fontSize: '10px', color: 'var(--error)', border: '1px solid var(--error)', padding: '1px 5px' }}>ACTIVE BAN</span>}
          </div>
        </div>
        <div>
          <label style={labelStyle}>STATUS</label>
          <div style={{ fontSize: '13px' }}>
            {data.reversedAt
              ? <span style={{ color: 'var(--text-muted)' }}>REVERSED by {name(data.reversedBy)} on {new Date(data.reversedAt).toLocaleString()}</span>
              : data.bannedUntil
                ? <span style={{ color: 'var(--warning)' }}>Until {new Date(data.bannedUntil).toLocaleString()}</span>
                : <span style={{ color: 'var(--error)' }}>PERMANENT</span>
            }
          </div>
        </div>
        <div>
          <label style={labelStyle}>CATEGORY</label>
          <div>{data.reasonCategory}</div>
        </div>
        <div>
          <label style={labelStyle}>ISSUED</label>
          <div>{new Date(data.createdAt).toLocaleString()} by {name(data.bannedBy)}</div>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={labelStyle}>REASON</label>
          <div style={{ whiteSpace: 'pre-wrap' }}>{data.reasonText}</div>
        </div>
        {data.reversedAt && data.reverseReason && (
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>REVERSE REASON</label>
            <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>{data.reverseReason}</div>
          </div>
        )}
      </section>

      <h2 style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>EVIDENCE ({data.evidence.length})</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', marginBottom: '20px' }}>
        {data.evidence.map(e => (
          <div key={e.id} style={{ border: '1px solid var(--border-color)', padding: '8px', background: 'var(--bg-card)', maxWidth: e.type === 'image' ? '320px' : '480px', flex: '1 1 240px' }}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
              <span>{e.type === 'image' ? `📷 ${e.mime ?? 'image'}` : '📝 TEXT'}</span>
              <span>{new Date(e.createdAt).toLocaleString()}</span>
            </div>
            {e.type === 'image' ? (
              <a href={`/api/moderation/bans/${data.id}/evidence/${e.id}`} target="_blank" rel="noopener noreferrer">
                <img src={`/api/moderation/bans/${data.id}/evidence/${e.id}`} alt="evidence" style={{ width: '100%', display: 'block', cursor: 'zoom-in' }} />
              </a>
            ) : (
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px', margin: 0 }}>{e.textContent}</pre>
            )}
          </div>
        ))}
        {data.evidence.length === 0 && <div style={{ color: 'var(--text-muted)' }}>No evidence attached.</div>}
      </div>

      {!data.reversedAt && (
        <section style={{ border: '1px solid var(--border-color)', padding: '14px', background: 'var(--bg-panel)' }}>
          <h2 style={{ fontSize: '14px', marginTop: 0, color: 'var(--text-secondary)' }}>REVERSE THIS BAN</h2>
          <textarea value={reverseReason} onChange={e => setReverseReason(e.target.value)} placeholder="Reason for reversing (audited)" rows={3} style={{ width: '100%', resize: 'vertical', marginBottom: '8px' }} maxLength={500} />
          <button onClick={handleReverse} disabled={busy || !reverseReason.trim()} className="danger">{busy ? 'REVERSING...' : 'UNBAN'}</button>
        </section>
      )}
    </div>
  );
}
