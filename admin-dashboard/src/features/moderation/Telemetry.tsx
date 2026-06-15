import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../services/api';
import type { AuthUser } from '../../contexts/AuthContext';

const ADMIN_ROLES = ['owner', 'admin'];

interface TelemetryGlobal {
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface TelemetryUser {
  userId: string;
  username: string | null;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

interface TelemetryView {
  global: TelemetryGlobal;
  perUser: TelemetryUser[];
}

export default function Telemetry() {
  const outletCtx = useOutletContext<{ user?: AuthUser }>() || {};
  const isAdmin = ADMIN_ROLES.includes(outletCtx.user?.role || '');
  const queryClient = useQueryClient();

  const [userSearch, setUserSearch] = useState('');
  const [newUserId, setNewUserId] = useState('');
  const [newUserEnabled, setNewUserEnabled] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ['telemetry-settings'],
    queryFn: () => api.get<TelemetryView>('/api/admin/telemetry'),
  });

  const error = queryError ? (queryError as Error).message : null;

  async function toggleGlobal(enabled: boolean) {
    if (!isAdmin) return;
    setActionError(null);
    setActionLoading(true);
    try {
      await api.post('/api/admin/telemetry', { scope: 'global', enabled });
      queryClient.invalidateQueries({ queryKey: ['telemetry-settings'] });
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  async function toggleUser(userId: string, enabled: boolean) {
    if (!isAdmin) return;
    setActionError(null);
    setActionLoading(true);
    try {
      await api.post('/api/admin/telemetry', { scope: 'user', userId, enabled });
      queryClient.invalidateQueries({ queryKey: ['telemetry-settings'] });
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  async function addUserOverride() {
    if (!newUserId.trim()) return;
    await toggleUser(newUserId.trim(), newUserEnabled);
    setNewUserId('');
  }

  const filteredUsers = (data?.perUser ?? []).filter(u =>
    !userSearch || (u.username ?? u.userId).toLowerCase().includes(userSearch.toLowerCase()) ||
    u.userId.toLowerCase().includes(userSearch.toLowerCase())
  );

  const containerStyle: React.CSSProperties = {
    padding: '24px',
    color: 'var(--phosphor-color)',
    fontFamily: 'monospace',
    maxWidth: '900px',
  };

  const sectionStyle: React.CSSProperties = {
    marginBottom: '32px',
  };

  const headingStyle: React.CSSProperties = {
    fontSize: '12px',
    letterSpacing: '2px',
    marginBottom: '16px',
    color: 'rgba(255,255,255,0.5)',
    textTransform: 'uppercase' as const,
  };

  const cardStyle: React.CSSProperties = {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '4px',
    padding: '16px',
    marginBottom: '8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
  };

  const badgeStyle = (enabled: boolean): React.CSSProperties => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '3px',
    fontSize: '11px',
    letterSpacing: '1px',
    background: enabled ? 'rgba(24,255,98,0.15)' : 'rgba(255,68,68,0.15)',
    color: enabled ? '#18FF62' : '#ff4444',
    border: `1px solid ${enabled ? 'rgba(24,255,98,0.3)' : 'rgba(255,68,68,0.3)'}`,
  });

  const btnStyle = (variant: 'on' | 'off'): React.CSSProperties => ({
    padding: '4px 12px',
    borderRadius: '3px',
    fontSize: '11px',
    letterSpacing: '1px',
    cursor: actionLoading || !isAdmin ? 'not-allowed' : 'pointer',
    border: '1px solid',
    background: 'transparent',
    borderColor: variant === 'on' ? 'rgba(24,255,98,0.4)' : 'rgba(255,68,68,0.4)',
    color:        variant === 'on' ? '#18FF62'             : '#ff4444',
    opacity: actionLoading || !isAdmin ? 0.5 : 1,
  });

  if (isLoading) return <div style={containerStyle}>Loading telemetry settings...</div>;
  if (error) return <div style={containerStyle}>Error: {error}</div>;

  return (
    <div style={containerStyle}>
      <h2 style={{ fontSize: '14px', letterSpacing: '3px', marginBottom: '24px', textTransform: 'uppercase' as const }}>
        World-Trace Telemetry Control
      </h2>

      {actionError && (
        <div style={{ marginBottom: '16px', color: '#ff4444', fontSize: '12px' }}>
          Error: {actionError}
        </div>
      )}

      {/* Global toggle */}
      <div style={sectionStyle}>
        <div style={headingStyle}>Global Default</div>
        <div style={cardStyle}>
          <div>
            <div style={{ fontSize: '13px', marginBottom: '4px' }}>All users</div>
            {data?.global.updatedAt && (
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
                Last updated {new Date(data.global.updatedAt).toLocaleString()}
                {data.global.updatedBy ? ` by ${data.global.updatedBy}` : ''}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={badgeStyle(data?.global.enabled ?? true)}>
              {data?.global.enabled ? 'ON' : 'OFF'}
            </span>
            {isAdmin && (
              <>
                <button
                  style={btnStyle('on')}
                  disabled={actionLoading || data?.global.enabled === true}
                  onClick={() => toggleGlobal(true)}
                >
                  Enable
                </button>
                <button
                  style={btnStyle('off')}
                  disabled={actionLoading || data?.global.enabled === false}
                  onClick={() => toggleGlobal(false)}
                >
                  Disable
                </button>
              </>
            )}
          </div>
        </div>
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginTop: '8px' }}>
          Dev-mode default: ON. Flip to OFF before shipping to broad user base.
          Per-user overrides below take precedence over this setting.
        </div>
      </div>

      {/* Per-user overrides */}
      <div style={sectionStyle}>
        <div style={headingStyle}>Per-User Overrides ({data?.perUser.length ?? 0})</div>

        {isAdmin && (
          <div style={{ ...cardStyle, marginBottom: '16px', flexWrap: 'wrap' as const }}>
            <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.5)' }}>Add override</div>
            <input
              type="text"
              placeholder="User UUID"
              value={newUserId}
              onChange={e => setNewUserId(e.target.value)}
              style={{
                flex: 1,
                minWidth: '220px',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '3px',
                padding: '4px 8px',
                color: 'var(--phosphor-color)',
                fontFamily: 'monospace',
                fontSize: '12px',
              }}
            />
            <select
              value={newUserEnabled ? 'on' : 'off'}
              onChange={e => setNewUserEnabled(e.target.value === 'on')}
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '3px',
                padding: '4px 8px',
                color: 'var(--phosphor-color)',
                fontFamily: 'monospace',
                fontSize: '12px',
              }}
            >
              <option value="on">Enabled</option>
              <option value="off">Disabled</option>
            </select>
            <button
              style={btnStyle('on')}
              disabled={actionLoading || !newUserId.trim()}
              onClick={addUserOverride}
            >
              Add
            </button>
          </div>
        )}

        {filteredUsers.length > 0 && (
          <input
            type="text"
            placeholder="Search by username or UUID..."
            value={userSearch}
            onChange={e => setUserSearch(e.target.value)}
            style={{
              width: '100%',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '3px',
              padding: '6px 10px',
              color: 'var(--phosphor-color)',
              fontFamily: 'monospace',
              fontSize: '12px',
              marginBottom: '12px',
              boxSizing: 'border-box' as const,
            }}
          />
        )}

        {filteredUsers.length === 0 && (
          <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)', padding: '8px 0' }}>
            No per-user overrides configured.
          </div>
        )}

        {filteredUsers.map(u => (
          <div key={u.userId} style={cardStyle}>
            <div>
              <div style={{ fontSize: '13px', marginBottom: '2px' }}>
                {u.username ?? <span style={{ color: 'rgba(255,255,255,0.4)' }}>Unknown</span>}
              </div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)' }}>{u.userId}</div>
              <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginTop: '2px' }}>
                Updated {new Date(u.updatedAt).toLocaleString()}
                {u.updatedBy ? ` by ${u.updatedBy}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={badgeStyle(u.enabled)}>{u.enabled ? 'ON' : 'OFF'}</span>
              {isAdmin && (
                <>
                  <button
                    style={btnStyle('on')}
                    disabled={actionLoading || u.enabled}
                    onClick={() => toggleUser(u.userId, true)}
                  >
                    Enable
                  </button>
                  <button
                    style={btnStyle('off')}
                    disabled={actionLoading || !u.enabled}
                    onClick={() => toggleUser(u.userId, false)}
                  >
                    Disable
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
