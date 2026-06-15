import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

// The "main roles" an owner/admin can preview the site as. Order = highest to
// lowest privilege. `null` reset entry is rendered separately.
const VIEW_ROLES: { role: string; label: string; hint: string }[] = [
  { role: 'owner',     label: 'OWNER',     hint: 'Full access' },
  { role: 'admin',     label: 'ADMIN',     hint: 'Full access' },
  { role: 'moderator', label: 'MODERATOR', hint: 'Mod tools, no admin-only actions' },
  { role: 'supporter', label: 'SUPPORTER', hint: 'Chat only' },
  { role: 'user',      label: 'DWELLER',   hint: 'Chat only' },
];

const PHOSPHOR = '#18FF62';

/**
 * Right-edge slide-out panel that lets a real owner/admin hot-swap the role the
 * UI is gated against. Purely a client-side preview — the override lives in
 * AuthContext (sessionStorage-backed) and only re-skins the app; the backend
 * still authorizes every request by the real Discord role, so impersonating a
 * lower role can't break anything and impersonating can't escalate privilege.
 */
export default function RoleViewSwitcher() {
  const { canImpersonate, realRole, viewAsRole, setViewAsRole } = useAuth();
  const [open, setOpen] = useState(false);

  if (!canImpersonate) return null;

  const effectiveRole = viewAsRole ?? realRole;
  const impersonating = !!viewAsRole;

  const itemStyle = (active: boolean): React.CSSProperties => ({
    display: 'block',
    width: '100%',
    padding: '7px 10px',
    textAlign: 'left',
    background: active ? 'rgba(24,255,98,0.15)' : 'rgba(24,255,98,0.04)',
    border: active ? `1px solid ${PHOSPHOR}80` : '1px solid rgba(24,255,98,0.18)',
    color: active ? PHOSPHOR : 'rgba(24,255,98,0.6)',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: active ? 'bold' : 'normal',
    letterSpacing: '1px',
    fontFamily: 'Courier New, monospace',
    whiteSpace: 'nowrap',
    transition: 'background 0.1s, color 0.1s',
    textShadow: active ? `0 0 8px ${PHOSPHOR}99` : 'none',
  });

  return (
    <div style={{ position: 'fixed', right: 0, top: '50%', transform: 'translateY(-50%)', zIndex: 9999, display: 'flex', alignItems: 'center' }}>
      {/* Slide-out panel */}
      <div style={{
        background: '#0d1a0f',
        border: `1px solid ${PHOSPHOR}66`,
        borderRight: 'none',
        padding: open ? '14px 12px' : '0',
        width: open ? '184px' : '0',
        overflow: 'hidden',
        transition: 'width 0.2s ease, padding 0.2s ease',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        boxShadow: open ? `-4px 0 20px ${PHOSPHOR}14` : 'none',
      }}>
        {open && (
          <>
            <div style={{ fontSize: '9px', letterSpacing: '2px', color: 'rgba(24,255,98,0.4)', whiteSpace: 'nowrap' }}>
              VIEW AS ROLE
            </div>
            <div style={{ fontSize: '9px', color: 'rgba(24,255,98,0.55)', marginBottom: '4px', whiteSpace: 'nowrap' }}>
              YOUR ROLE: <strong style={{ color: PHOSPHOR }}>{(realRole ?? '—').toUpperCase()}</strong>
            </div>

            {VIEW_ROLES.map(r => {
              const active = effectiveRole === r.role;
              return (
                <button
                  key={r.role}
                  type="button"
                  title={r.hint}
                  onClick={() => setViewAsRole(r.role === realRole ? null : r.role)}
                  style={itemStyle(active)}
                  onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'rgba(24,255,98,0.1)'; e.currentTarget.style.color = 'rgba(24,255,98,0.9)'; } }}
                  onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'rgba(24,255,98,0.04)'; e.currentTarget.style.color = 'rgba(24,255,98,0.6)'; } }}
                >
                  {active ? '▸ ' : '  '}{r.label}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => setViewAsRole(null)}
              disabled={!impersonating}
              style={{
                ...itemStyle(false),
                marginTop: '6px',
                textAlign: 'center',
                opacity: impersonating ? 1 : 0.35,
                cursor: impersonating ? 'pointer' : 'default',
                borderColor: impersonating ? 'rgba(255,180,64,0.5)' : 'rgba(24,255,98,0.18)',
                color: impersonating ? '#ffb440' : 'rgba(24,255,98,0.4)',
              }}
            >
              ⟲ RESET TO MY ROLE
            </button>
          </>
        )}
      </div>

      {/* Tab button — shows a warning tint while impersonating */}
      <button
        onClick={() => setOpen(o => !o)}
        title={impersonating ? `Viewing as ${viewAsRole?.toUpperCase()} — click to change` : 'View site as another role'}
        style={{
          background: impersonating ? '#1a1405' : '#0d1a0f',
          border: `1px solid ${impersonating ? 'rgba(255,180,64,0.6)' : `${PHOSPHOR}66`}`,
          borderRight: 'none',
          color: impersonating ? '#ffb440' : (open ? PHOSPHOR : 'rgba(24,255,98,0.5)'),
          cursor: 'pointer',
          padding: '12px 6px',
          fontSize: '10px',
          letterSpacing: '1px',
          fontFamily: 'Courier New, monospace',
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          userSelect: 'none',
          transition: 'color 0.1s',
          boxShadow: impersonating ? '-2px 0 12px rgba(255,180,64,0.15)' : `-2px 0 12px ${PHOSPHOR}10`,
        }}
      >
        {impersonating ? `AS ${(viewAsRole ?? '').toUpperCase()}` : 'VIEW AS'}
      </button>
    </div>
  );
}
