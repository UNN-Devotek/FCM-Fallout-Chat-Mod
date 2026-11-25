import React, { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext, Link } from 'react-router';
import { api } from '../../services/api';
import { accountHudMutePath, GLOBAL_HUD_MUTE_PATH } from '../../services/hudAutoEventMute';
import type { AuthUser } from '../../contexts/AuthContext';

const ADMIN_ROLES = ['owner', 'admin'];
const GLOBAL_HUD_MUTE_QUERY = [GLOBAL_HUD_MUTE_PATH] as const;

interface User {
  id: string;
  username: string;
  displayName: string;
  fo76Name: string | null;
  steamId: string | null;
  discordId: string | null;
  discordUsername: string | null;
  discordAvatar: string | null;
  isBanned: boolean;
  isMuted: boolean;
  hudAutoEventsMuted: boolean;
  muteExpiresAt: string | null;
  banReason: string | null;
  createdAt: string;
}

type UserAction = 'kick' | 'unban' | 'wipe' | { hudAutoEventsMuted: boolean };

const MUTE_DURATIONS = [
  { label: '1 hour', value: 60 },
  { label: '6 hours', value: 360 },
  { label: '24 hours', value: 1440 },
  { label: '7 days', value: 10080 },
  { label: 'Permanent', value: 525600 },
];

export default function Users() {
  const outletCtx = useOutletContext<{ user?: AuthUser }>() || {};
  const isAdmin = ADMIN_ROLES.includes(outletCtx.user?.role || '');
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [muteModal, setMuteModal] = useState<User | null>(null);
  const [banModal, setBanModal] = useState<User | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [muteReason, setMuteReason] = useState('');
  const [muteDuration, setMuteDuration] = useState(60);
  const [banReason, setBanReason] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  const searchParam = debouncedSearch ? `&search=${encodeURIComponent(debouncedSearch)}` : '';

  const { data: users, isLoading: loading, error: queryError } = useQuery({
    queryKey: ['users', debouncedSearch],
    queryFn: () => api.get<User[]>(`/api/users?limit=100${searchParam}`),
  });
  const { data: globalHudMute, isError: globalHudMuteError } = useQuery({
    queryKey: GLOBAL_HUD_MUTE_QUERY,
    queryFn: () => api.get<{ muted: boolean }>(GLOBAL_HUD_MUTE_PATH),
  });
  const updateGlobalHudMute = useMutation({
    mutationFn: (muted: boolean) => api.put(GLOBAL_HUD_MUTE_PATH, { muted }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: GLOBAL_HUD_MUTE_QUERY }),
  });

  const error = queryError ? (queryError as Error).message : null;
  const filtered = users || [];

  function refresh() {
    return queryClient.invalidateQueries({ queryKey: ['users'] });
  }

  async function doAction(userId: string, action: UserAction) {
    setActionLoading(true);
    setActionError(null);
    try {
      if (action === 'kick') {
        await api.post(`/api/users/${userId}/kick`);
      } else if (action === 'unban') {
        await api.delete(`/api/users/${userId}/ban`);
      } else if (action === 'wipe') {
        if (!confirm('This will permanently anonymize this user. Continue?')) return;
        await api.post(`/api/users/${userId}/wipe`);
      } else {
        await api.put(accountHudMutePath(userId), { muted: action.hudAutoEventsMuted });
      }
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'User action failed.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleDelete(id: string, username: string) {
    if (!confirm(`PERMANENTLY delete user "${username}"? This cannot be undone. All messages, reports, and sessions will be removed.`)) return;
    if (!confirm(`Are you absolutely sure? Type the action again to confirm.`)) return;
    try {
      await api.delete(`/api/users/${id}`);
      refresh();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleMuteSubmit() {
    if (!muteModal || !muteReason.trim()) return;
    setModalLoading(true);
    setModalError(null);
    try {
      await api.post(`/api/users/${muteModal.id}/mute`, { duration: muteDuration, reason: muteReason.trim() });
      setMuteModal(null);
      setMuteReason('');
      setMuteDuration(60);
      refresh();
    } catch (err: any) {
      setModalError(err.message);
    } finally {
      setModalLoading(false);
    }
  }

  async function handleBanSubmit() {
    if (!banModal || !banReason.trim()) return;
    setModalLoading(true);
    setModalError(null);
    try {
      await api.post(`/api/users/${banModal.id}/ban`, { reason: banReason.trim() });
      setBanModal(null);
      setBanReason('');
      refresh();
    } catch (err: any) {
      setModalError(err.message);
    } finally {
      setModalLoading(false);
    }
  }

  const modalBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
  const modalBox: React.CSSProperties = { background: 'var(--bg-dark)', border: '1px solid var(--phosphor-color)', padding: '24px', minWidth: '400px' };
  const inputStyle: React.CSSProperties = { width: '100%', marginTop: '8px' };
  const btnRow: React.CSSProperties = { display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' };

  return (
    <div>
      <h1 style={{ fontSize: '18px', marginBottom: '16px' }}>◈ USER MANAGEMENT</h1>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '16px' }}>
        <span role="status">
          {globalHudMuteError ? 'Could not load the server-wide HUD auto-event mute.'
            : globalHudMute?.muted ? 'HUD auto-events are muted for everyone.'
            : globalHudMute ? 'Server-wide HUD auto-event mute is off.'
            : 'Loading server-wide HUD auto-event mute...'}
        </span>
        {isAdmin && globalHudMute && !globalHudMuteError && (
          <button
            type="button"
            className={globalHudMute.muted ? undefined : 'warning'}
            disabled={updateGlobalHudMute.isPending}
            onClick={() => updateGlobalHudMute.mutate(!globalHudMute.muted)}
          >
            {globalHudMute.muted ? 'Unmute HUD auto-events for everyone' : 'Mute HUD auto-events for everyone'}
          </button>
        )}
      </div>
      {updateGlobalHudMute.error && <div role="alert" className="error-message">{updateGlobalHudMute.error.message}</div>}

      <input
        data-testid="user-search"
        aria-label="Search by player name or UUID"
        placeholder="Search by player name or UUID"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: '16px', maxWidth: '320px' }}
      />

      {error && <div className="error-message">{error}</div>}
      {actionError && <div className="error-message" role="alert" style={{ marginBottom: '8px' }}>{actionError}</div>}

      {loading ? (
        <div className="loading">Loading users...</div>
      ) : (
        <div className="table-responsive">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>FO76 Name</th>
              <th>Status</th>
              <th>Joined</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((user) => (
              <tr key={user.id} data-testid="user-row">
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {user.discordAvatar && user.discordId ? (
                      <img
                        src={user.discordAvatar.startsWith('http')
                          ? user.discordAvatar
                          : `https://cdn.discordapp.com/avatars/${user.discordId}/${user.discordAvatar}.png?size=32`}
                        style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0 }}
                        alt=""
                      />
                    ) : (
                      <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-card)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: 'var(--text-muted)', flexShrink: 0 }}>?</div>
                    )}
                    <div>
                      <Link
                        to={`/profile/${user.id}`}
                        className="username-chip"
                        style={{ color: 'var(--text-primary)', padding: '1px 4px', margin: '-1px -4px' }}
                      >
                        {user.displayName ?? user.username}
                      </Link>
                      {user.discordUsername && (
                        <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>@{user.discordUsername}</div>
                      )}
                    </div>
                  </div>
                </td>
                <td>
                  {user.fo76Name ? (
                    <span style={{ color: 'var(--phosphor-color)', fontSize: '12px' }}>{user.fo76Name}</span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>—</span>
                  )}
                </td>
                <td>
                  {user.isBanned && <span className="badge banned">BANNED</span>}
                  {user.isMuted && !user.isBanned && <span className="badge muted">MUTED</span>}
                  {user.hudAutoEventsMuted && <span className="badge muted">HUD AUTO-EVENTS MUTED</span>}
                  {!user.isBanned && !user.isMuted && !user.hudAutoEventsMuted && <span className="badge resolved">OK</span>}
                </td>
                <td style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button
                      data-testid="mute-btn"
                      className="warning"
                      disabled={actionLoading || user.isBanned}
                      onClick={() => { setMuteModal(user); setMuteReason(''); setMuteDuration(60); setModalError(null); }}
                      aria-label={`Mute user ${user.username}`}
                      style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px' }}
                    >
                      MUTE
                    </button>
                    <button
                      type="button"
                      className={user.hudAutoEventsMuted ? undefined : 'warning'}
                      disabled={actionLoading}
                      onClick={() => doAction(user.id, { hudAutoEventsMuted: !user.hudAutoEventsMuted })}
                      aria-label={`${user.hudAutoEventsMuted ? 'Unmute' : 'Mute'} HUD auto-events for ${user.displayName ?? user.username}`}
                      title="Controls automatic HUD event announcements. Players can still chat and run event commands."
                      style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px' }}
                    >
                      {user.hudAutoEventsMuted ? 'UNMUTE HUD AUTO-EVENTS' : 'MUTE HUD AUTO-EVENTS'}
                    </button>
                    <button
                      data-testid="kick-btn"
                      disabled={actionLoading || user.isBanned}
                      onClick={() => doAction(user.id, 'kick')}
                      aria-label={`Kick user ${user.username}`}
                      style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px' }}
                    >
                      KICK
                    </button>
                    {isAdmin && (user.isBanned ? (
                      <button
                        data-testid="unban-btn"
                        disabled={actionLoading}
                        onClick={() => doAction(user.id, 'unban')}
                        aria-label={`Unban user ${user.username}`}
                        style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px' }}
                      >
                        UNBAN
                      </button>
                    ) : (
                      <button
                        data-testid="ban-btn"
                        className="danger"
                        disabled={actionLoading}
                        onClick={() => { setBanModal(user); setBanReason(''); setModalError(null); }}
                        aria-label={`Ban user ${user.username}`}
                        style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px' }}
                      >
                        BAN
                      </button>
                    ))}
                    {isAdmin && (
                      <button
                        data-testid="wipe-btn"
                        className="danger"
                        disabled={actionLoading}
                        onClick={() => doAction(user.id, 'wipe')}
                        aria-label={`Wipe data for user ${user.username}`}
                        style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px', opacity: 0.7 }}
                      >
                        WIPE
                      </button>
                    )}
                    {isAdmin && (
                      <button
                        data-testid="delete-btn"
                        className="danger"
                        disabled={actionLoading}
                        onClick={() => handleDelete(user.id, user.username)}
                        aria-label={`Permanently delete account for ${user.username}`}
                        style={{ padding: '4px 10px', fontSize: '11px', minHeight: '32px' }}
                        title="Permanently delete account"
                      >
                        DELETE
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} style={{ color: 'var(--text-muted)' }}>No users found.</td></tr>
            )}
          </tbody>
        </table>
        </div>
      )}

      {muteModal && (
        <div style={modalBackdrop} onClick={() => setMuteModal(null)}>
          <div style={modalBox} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: '16px' }}>Mute {muteModal.username}</h3>
            <label>Duration</label>
            <select value={muteDuration} onChange={(e) => setMuteDuration(Number(e.target.value))} style={inputStyle}>
              {MUTE_DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
            <label style={{ marginTop: '12px', display: 'block' }}>Reason (required)</label>
            <input value={muteReason} onChange={(e) => setMuteReason(e.target.value)} style={inputStyle} placeholder="Enter reason..." />
            {modalError && <div className="error-message" style={{ marginTop: '8px' }}>{modalError}</div>}
            <div style={btnRow}>
              <button onClick={() => setMuteModal(null)}>Cancel</button>
              <button className="warning" disabled={modalLoading || !muteReason.trim()} onClick={handleMuteSubmit}>
                {modalLoading ? 'Muting...' : 'Confirm Mute'}
              </button>
            </div>
          </div>
        </div>
      )}

      {banModal && (
        <div style={modalBackdrop} onClick={() => setBanModal(null)}>
          <div style={modalBox} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: '16px' }}>Ban {banModal.username}</h3>
            <label>Reason (required)</label>
            <input value={banReason} onChange={(e) => setBanReason(e.target.value)} style={inputStyle} placeholder="Enter ban reason..." />
            {modalError && <div className="error-message" style={{ marginTop: '8px' }}>{modalError}</div>}
            <div style={btnRow}>
              <button onClick={() => setBanModal(null)}>Cancel</button>
              <button className="danger" disabled={modalLoading || !banReason.trim()} onClick={handleBanSubmit}>
                {modalLoading ? 'Banning...' : 'Confirm Ban'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
