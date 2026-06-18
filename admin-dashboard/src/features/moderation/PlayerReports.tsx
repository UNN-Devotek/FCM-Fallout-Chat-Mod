import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import MyReports from './selfService/MyReports';

const STAFF_ROLES = ['owner', 'admin', 'moderator'];

interface PlayerReport {
  id: string;
  reportNumber: number;
  content: string;
  involvedPlayers: string | null;
  imageUrls: string | null; // JSON: string[]
  status: string;
  createdAt: string;
  user: {
    username: string;
    discordUsername: string | null;
    discordAvatar: string | null;
    discordDisplayName: string | null;
  };
}

const STATUS_COLORS: Record<string, string> = {
  open: 'var(--warning)',
  reviewed: 'var(--info)',
  closed: 'var(--phosphor-color)',
};

const phosphor = 'var(--text-primary)';
const dim = 'var(--text-secondary)';
const faint = 'rgba(212,176,64,0.08)';
const border = 'var(--border-color)';

function parseImageUrls(raw: string | null): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

// Render @mention tokens as green chips, plain text as-is
function MentionText({ text }: { text: string }) {
  const parts = text.split(/(@\w+)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('@') ? (
          <span key={i} style={{
            display: 'inline-block',
            background: 'rgba(212,176,64,0.12)',
            border: '1px solid rgba(212,176,64,0.3)',
            color: phosphor,
            borderRadius: '2px',
            padding: '0 5px',
            fontSize: '11px',
            fontWeight: 'bold',
            letterSpacing: '0.5px',
            margin: '0 2px',
          }}>{part}</span>
        ) : (
          <span key={i} style={{ color: dim, fontSize: '12px' }}>{part}</span>
        )
      )}
    </>
  );
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.88)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'zoom-out',
      }}
    >
      <img
        src={url}
        alt="Evidence screenshot"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '90vw', maxHeight: '88vh', objectFit: 'contain', border: `1px solid ${border}`, cursor: 'default' }}
      />
      <button
        onClick={onClose}
        style={{
          position: 'fixed', top: '16px', right: '20px',
          background: 'transparent', border: `1px solid ${border}`,
          color: phosphor, fontSize: '16px', cursor: 'pointer',
          fontFamily: 'Courier New, monospace', padding: '4px 10px', letterSpacing: '1px',
        }}
      >✕ CLOSE</button>
    </div>
  );
}

export default function PlayerReports() {
  const { user } = useAuth();
  const isStaff = !!user && STAFF_ROLES.includes(user.role);
  if (!isStaff) return <MyReports type="player" />;
  return <PlayerReportsAdmin />;
}

function PlayerReportsAdmin() {
  const queryClient = useQueryClient();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const { data: reports, isLoading } = useQuery({
    queryKey: ['player-reports', 'player'],
    queryFn: () => api.get<PlayerReport[]>('/api/player-reports?type=player'),
  });

  async function handleStatusChange(id: string, status: string) {
    setUpdatingId(id);
    try {
      await api.patch(`/api/player-reports/${id}`, { status });
      queryClient.invalidateQueries({ queryKey: ['player-reports', 'player'] });
    } catch {
      //
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}

      <div style={{ padding: '16px 0 12px', borderBottom: `1px solid ${border}` }}>
        <h1 style={{ fontSize: '18px', margin: 0, letterSpacing: '4px' }}>
          ◈ PLAYER REPORTS
        </h1>
        <div style={{ fontSize: '11px', color: dim, marginTop: '4px', letterSpacing: '1px' }}>
          Player conduct reports submitted via the web form
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', marginTop: '8px' }}>
        {isLoading && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: dim, letterSpacing: '2px', fontSize: '13px' }}>LOADING...</div>
        )}
        {!isLoading && (!reports || reports.length === 0) && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: dim, letterSpacing: '2px', fontSize: '13px' }}>NO REPORTS FOUND</div>
        )}

        {!isLoading && reports && reports.length > 0 && (
          <div className="table-responsive">
          <table>
            <thead>
              <tr>
                {['', '#', 'REPORTER', 'REPORT', 'INVOLVED', 'IMGS', 'STATUS', 'DATE', 'ACTION'].map(h => (
                  <th key={h} style={{ whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const isExpanded = expandedId === r.id;
                const imgs = parseImageUrls(r.imageUrls);
                const displayName = (r.user.username && r.user.username !== 'Wanderer' && !r.user.username.startsWith('discord:'))
                  ? r.user.username
                  : (r.user.discordDisplayName ?? r.user.discordUsername ?? 'Unknown');
                const statusColor = STATUS_COLORS[r.status] ?? dim;

                return (
                  <React.Fragment key={r.id}>
                    <tr
                      style={{ borderBottom: isExpanded ? 'none' : `1px solid ${border}`, cursor: 'pointer' }}
                      onClick={() => setExpandedId(isExpanded ? null : r.id)}
                      onMouseEnter={e => { if (!isExpanded) e.currentTarget.style.background = faint; }}
                      onMouseLeave={e => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <td style={{ color: dim, fontSize: '11px', width: '16px' }}>
                        {isExpanded ? '▼' : '▶'}
                      </td>

                      <td style={{ color: dim, fontWeight: 'bold', whiteSpace: 'nowrap', fontSize: '12px' }}>
                        #{r.reportNumber}
                      </td>

                      <td style={{ color: 'var(--phosphor-color)', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                        {displayName}
                      </td>

                      <td style={{ maxWidth: '280px' }}>
                        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' }}>
                          {r.content}
                        </span>
                      </td>

                      <td style={{ maxWidth: '200px' }}>
                        {r.involvedPlayers ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', overflow: 'hidden', maxHeight: '42px' }}>
                            <MentionText text={r.involvedPlayers} />
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>—</span>
                        )}
                      </td>

                      <td style={{ whiteSpace: 'nowrap' }}>
                        {imgs.length > 0 ? (
                          <span className="badge" style={{ color: 'var(--phosphor-color)' }}>
                            ◼ {imgs.length}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>—</span>
                        )}
                      </td>

                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span className="badge" style={{ color: statusColor }}>
                          {r.status}
                        </span>
                      </td>

                      <td style={{ color: dim, whiteSpace: 'nowrap', fontSize: '11px' }}>
                        {new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </td>

                      <td style={{ whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                        <select
                          value={r.status}
                          disabled={updatingId === r.id}
                          onChange={e => handleStatusChange(r.id, e.target.value)}
                          style={{ width: 'auto', padding: '4px 8px', fontSize: '11px' }}
                        >
                          <option value="open">OPEN</option>
                          <option value="reviewed">REVIEWED</option>
                          <option value="closed">CLOSED</option>
                        </select>
                      </td>
                    </tr>

                    {isExpanded && (
                      <tr>
                        <td colSpan={9} style={{ padding: '0' }}>
                          <div style={{ padding: '16px 32px 20px', background: 'var(--bg-card)', borderTop: `1px solid ${border}` }}>
                            <div style={{ marginBottom: '16px' }}>
                              <div style={{ fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '6px' }}>REPORT CONTENT</div>
                              <div style={{
                                background: 'var(--bg-panel)', border: `1px solid ${border}`,
                                padding: '10px 14px', fontSize: '13px', color: 'var(--text-primary)',
                                lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                              }}>
                                {r.content}
                              </div>
                            </div>

                            {r.involvedPlayers && (
                              <div style={{ marginBottom: '16px' }}>
                                <div style={{ fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '6px' }}>INVOLVED PLAYERS</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                                  <MentionText text={r.involvedPlayers} />
                                </div>
                              </div>
                            )}

                            {imgs.length > 0 && (
                              <div>
                                <div style={{ fontSize: '11px', color: dim, letterSpacing: '2px', marginBottom: '8px' }}>
                                  EVIDENCE SCREENSHOTS ({imgs.length})
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'row', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                                  {imgs.map((url, i) => (
                                    <div
                                      key={i}
                                      onClick={() => setLightboxUrl(url)}
                                      style={{
                                        position: 'relative', cursor: 'zoom-in',
                                        border: `1px solid ${border}`, flexShrink: 0,
                                        width: '120px', height: '90px',
                                        overflow: 'hidden',
                                      }}
                                    >
                                      <img
                                        src={url}
                                        alt={`Evidence ${i + 1}`}
                                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                                      />
                                      <div style={{
                                        position: 'absolute', bottom: 0, left: 0, right: 0,
                                        background: 'rgba(0,0,0,0.55)', color: 'var(--text-primary)',
                                        fontSize: '10px', textAlign: 'center', padding: '2px 0', letterSpacing: '1px',
                                      }}>
                                        IMG {i + 1} — CLICK TO EXPAND
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
