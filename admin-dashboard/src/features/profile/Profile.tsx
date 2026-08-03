import React, { useMemo } from 'react';
import ApiTokensPanel from './ApiTokensPanel';
import { useParams, useOutletContext, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import type { AuthUser } from '../../contexts/AuthContext';

interface ProfileData {
  id: string;
  username: string;
  createdAt: string;
  discordId: string | null;
  discordUsername: string | null;
  discordDisplayName: string | null;
  discordAvatar: string | null;
  isBanned: boolean;
  isMuted: boolean;
  muteExpiresAt: string | null;
  role: string;
}

interface MessageRecord {
  id: string;
  content: string;
  channelId: string;
  source: string;
  createdAt: string;
}

interface ChannelInfo { id: string; name: string; children?: ChannelInfo[]; }

const MOD_ROLES  = ['owner', 'admin', 'moderator'];
const ADMIN_ROLES = ['owner', 'admin'];

const ROLE_COLORS: Record<string, string> = {
  owner:     '#FFB000',
  admin:     '#d4b040',
  moderator: '#50C878',
  supporter: '#5865F2',
  user:      'var(--text-muted)',
};

function flattenChannels(list: ChannelInfo[]): ChannelInfo[] {
  const out: ChannelInfo[] = [];
  for (const c of list) {
    out.push(c);
    if (c.children) out.push(...flattenChannels(c.children));
  }
  return out;
}

function formatAvatarUrl(p: ProfileData): string | null {
  if (!p.discordAvatar || !p.discordId) return null;
  if (p.discordAvatar.startsWith('http')) return p.discordAvatar;
  return `https://cdn.discordapp.com/avatars/${p.discordId}/${p.discordAvatar}.png?size=128`;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)',
  padding: '16px 18px',
};

const badge = (color: string, background = 'transparent'): React.CSSProperties => ({
  display: 'inline-block', padding: '2px 8px', fontSize: '10px', fontWeight: 'bold',
  color, border: `1px solid ${color}`, background, letterSpacing: '0.8px',
});

const kvLabel: React.CSSProperties = {
  fontSize: '10px', letterSpacing: '0.8px', color: 'var(--text-secondary)',
  textTransform: 'uppercase', marginBottom: '2px',
};

const kvValue: React.CSSProperties = {
  fontSize: '13px', color: 'var(--text-primary)', wordBreak: 'break-word',
};

// ── Message history card (moderator+ only) ──────────────────────────────────

function MessageHistoryCard({ userId, channelMap }: { userId: string; channelMap: Map<string, string> }) {
  const { data: messages, isLoading, error } = useQuery({
    queryKey: ['user-messages', userId],
    queryFn: () => api.get<MessageRecord[]>(`/api/users/${userId}/messages?limit=100`),
  });

  return (
    <section style={{ ...card, marginTop: '16px' }}>
      <header style={{
        display: 'flex', alignItems: 'baseline', gap: '10px',
        paddingBottom: '10px', marginBottom: '10px', borderBottom: '1px solid var(--border-color)',
      }}>
        <h2 style={{ margin: 0, fontSize: '13px', color: 'var(--phosphor-color)', letterSpacing: '1px' }}>
          ◈ MESSAGE HISTORY
        </h2>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>(moderator view · last {messages?.length ?? 0})</span>
      </header>

      {isLoading ? (
        <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Loading messages…</div>
      ) : error ? (
        <div style={{ color: 'var(--danger)', fontSize: '12px' }}>{(error as Error).message}</div>
      ) : !messages || messages.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '12px', fontStyle: 'italic' }}>
          No messages from this user.
        </div>
      ) : (
        <div style={{
          maxHeight: '480px', overflowY: 'auto',
          background: 'var(--bg-dark)', border: '1px solid var(--border-color)',
          padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: '12px',
        }}>
          {messages.map(m => {
            const channelName = channelMap.get(m.channelId) ?? m.channelId.slice(0, 8);
            const stamp = new Date(m.createdAt).toLocaleString(undefined, {
              month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
            });
            return (
              <div key={m.id} style={{
                display: 'grid', gridTemplateColumns: '110px 80px 1fr', gap: '10px',
                padding: '3px 0', borderBottom: '1px dotted var(--border-color)',
              }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{stamp}</span>
                <span style={{
                  color: m.source === 'discord' ? 'var(--info)' : 'var(--text-secondary)',
                  fontSize: '10px',
                }}>
                  #{channelName}
                </span>
                <span style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{m.content}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function Profile() {
  const { userId } = useParams<{ userId: string }>();
  const ctx = useOutletContext<{ user?: AuthUser }>() || {};
  const me = ctx.user;

  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['profile', userId],
    queryFn: () => api.get<ProfileData>(`/api/users/${userId}/profile`),
    enabled: !!userId,
  });

  const { data: channels } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get<ChannelInfo[]>('/api/channels'),
  });

  const channelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of flattenChannels(channels ?? [])) m.set(c.id, c.name);
    return m;
  }, [channels]);

  const isMod = MOD_ROLES.includes(me?.role ?? '');
  const isAdmin = ADMIN_ROLES.includes(me?.role ?? '');
  const isSelf = me?.id === userId;

  if (isLoading) {
    return <div style={{ color: 'var(--text-secondary)', padding: '20px' }}>Loading profile…</div>;
  }

  if (error || !profile) {
    return (
      <div style={{ ...card, color: 'var(--danger)', maxWidth: '640px' }}>
        <h1 style={{ margin: 0, fontSize: '15px' }}>Profile unavailable</h1>
        <p style={{ margin: '10px 0 0', fontSize: '12px' }}>
          {error ? (error as Error).message : 'User not found.'}
        </p>
      </div>
    );
  }

  const avatarUrl = formatAvatarUrl(profile);
  const displayName = (profile.username && profile.username !== 'Wanderer' && !profile.username.startsWith('pending-'))
    ? profile.username
    : (profile.discordDisplayName || profile.discordUsername || profile.username);

  const roleColor = ROLE_COLORS[profile.role] ?? ROLE_COLORS.user;
  const statusTxt = profile.isBanned
    ? { text: 'BANNED', color: 'var(--danger)' }
    : profile.isMuted
      ? { text: 'MUTED', color: 'var(--warning)' }
      : { text: 'ACTIVE', color: 'var(--phosphor-color)' };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', marginBottom: '16px', gap: '12px' }}>
        <h1 style={{ fontSize: '18px', margin: 0 }}>◈ PROFILE</h1>
        {isSelf && <span style={badge('var(--phosphor-color)')}>YOU</span>}
        {isMod && !isSelf && (
          <Link to="/users" style={{ fontSize: '11px', color: 'var(--text-secondary)', textDecoration: 'underline' }}>
            ← back to users
          </Link>
        )}
      </div>

      {/* Identity card */}
      <section style={{ ...card, display: 'grid', gridTemplateColumns: '96px 1fr', gap: '18px', maxWidth: '720px' }}>
        {/* Avatar */}
        <div>
          {avatarUrl ? (
            <img src={avatarUrl} alt=""
              style={{
                width: '96px', height: '96px', borderRadius: '4px',
                border: '1px solid var(--phosphor-color)',
                boxShadow: '0 0 12px rgba(212, 176, 64, 0.3)',
              }} />
          ) : (
            <div style={{
              width: '96px', height: '96px', borderRadius: '4px',
              background: 'var(--bg-dark)', border: '1px solid var(--border-color)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '40px', color: 'var(--text-muted)',
            }}>?</div>
          )}
        </div>

        {/* Name + badges + meta grid */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' }}>
            <h2 style={{ margin: 0, fontSize: '20px', color: 'var(--phosphor-color)' }}>{displayName}</h2>
            <span style={badge(roleColor, 'rgba(212, 176, 64, 0.08)')}>{profile.role.toUpperCase()}</span>
            <span style={badge(statusTxt.color)}>{statusTxt.text}</span>
          </div>
          {profile.discordUsername && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
              @{profile.discordUsername}
              {profile.discordDisplayName && profile.discordDisplayName !== displayName && (
                <> · <span style={{ color: 'var(--text-muted)' }}>{profile.discordDisplayName}</span></>
              )}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px' }}>
            <div>
              <div style={kvLabel}>FO76 name</div>
              <div style={kvValue}>
                {profile.username && profile.username !== 'Wanderer' && !profile.username.startsWith('pending-')
                  ? profile.username
                  : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>not detected</span>}
              </div>
            </div>
            <div>
              <div style={kvLabel}>Joined</div>
              <div style={kvValue}>{new Date(profile.createdAt).toLocaleDateString()}</div>
            </div>
            {profile.isMuted && profile.muteExpiresAt && (
              <div>
                <div style={kvLabel}>Mute expires</div>
                <div style={{ ...kvValue, color: 'var(--warning)' }}>
                  {new Date(profile.muteExpiresAt).toLocaleString()}
                </div>
              </div>
            )}
          </div>

          {/* Admin link to full user admin view */}
          {isAdmin && !isSelf && (
            <div style={{ marginTop: '14px', fontSize: '11px' }}>
              <Link to="/users" style={{ color: 'var(--text-secondary)', textDecoration: 'underline' }}>
                open in Users admin →
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* Message history — moderator+ only */}
      {isMod && <MessageHistoryCard userId={profile.id} channelMap={channelMap} />}

      {/* API Tokens — self-service panel shown only to the signed-in user */}
      {isSelf && <ApiTokensPanel />}
    </div>
  );
}
