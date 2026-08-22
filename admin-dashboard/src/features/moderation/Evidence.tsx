import React from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';

interface EvidenceRow {
  id: string; banId: string;
  type: 'text' | 'image';
  textContent: string | null;
  mime: string | null;
  sizeBytes: number | null;
  createdAt: string;
  ban: {
    id: string; userId: string;
    reasonCategory: string; reasonText: string;
    createdAt: string; reversedAt: string | null;
    user: { username: string; discordDisplayName: string | null; discordUsername: string | null };
  };
}

function name(u: { username: string; discordDisplayName: string | null; discordUsername: string | null }): string {
  if (u.username && u.username !== 'Wanderer' && !u.username.startsWith('pending-') && !u.username.startsWith('admin-discord-')) return u.username;
  return u.discordDisplayName || u.discordUsername || u.username || '—';
}

export default function Evidence() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['evidence'],
    queryFn: () => api.get<EvidenceRow[]>('/api/moderation/evidence'),
  });

  return (
    <div>
      <h1 style={{ fontSize: '18px', marginBottom: '16px' }}>◈ EVIDENCE</h1>
      <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>
        Every piece of ban evidence ever attached. Click an image to see full size, click a card title to open the parent ban.
      </p>

      {error && <div className="error-message">{(error as Error).message}</div>}
      {isLoading ? <div className="loading">Loading...</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '12px' }}>
          {(data ?? []).map(e => (
            <div key={e.id} style={{ border: '1px solid var(--border-color)', padding: '8px', background: 'var(--bg-card)', opacity: e.ban.reversedAt ? 0.55 : 1 }}>
              <Link to={`/moderation/bans/${e.banId}`} style={{ fontSize: '12px', color: 'var(--phosphor-color)', display: 'block', marginBottom: '4px' }}>
                {name(e.ban.user)} — {e.ban.reasonCategory}
              </Link>
              {e.type === 'image' ? (
                <a href={`/api/moderation/bans/${e.banId}/evidence/${e.id}`} target="_blank" rel="noopener noreferrer">
                  <img src={`/api/moderation/bans/${e.banId}/evidence/${e.id}`} alt="evidence" style={{ width: '100%', display: 'block', cursor: 'zoom-in' }} />
                </a>
              ) : (
                <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '11px', maxHeight: '160px', overflow: 'auto', margin: 0, padding: '6px', background: 'var(--bg-panel)' }}>{e.textContent}</pre>
              )}
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', justifyContent: 'space-between' }}>
                <span>{e.type === 'image' ? `📷 ${e.mime ?? 'image'}` : '📝 TEXT'}</span>
                <span>{new Date(e.createdAt).toLocaleDateString()}</span>
              </div>
              {e.ban.reversedAt && <div style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '4px' }}>BAN REVERSED</div>}
            </div>
          ))}
          {(data ?? []).length === 0 && <div style={{ color: 'var(--text-muted)' }}>No evidence yet.</div>}
        </div>
      )}
    </div>
  );
}
