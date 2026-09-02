import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate, useLocation, Link } from 'react-router';
import { devPersonaUiEnabled } from '../lib/devPersonaAccess';

// Maps each admin route to its Title-Case browser-tab name. The tab title is
// `${name}.FCM` (e.g. "Chat.FCM"). For sub-paths or unknown routes we fall back
// to the longest matching prefix, then to a bare "FCM".
const ROUTE_TITLES: Record<string, string> = {
  '/chat': 'Chat',
  '/feed': 'Feed',
  '/users': 'Users',
  '/channels': 'Channels',
  '/moderation': 'Moderation',
  '/moderation/violations': 'Violations',
  '/moderation/bans': 'Bans',
  '/moderation/evidence': 'Evidence',
  '/commands': 'Commands',
  '/player-reports': 'Player Reports',
  '/bug-reports': 'Bug Reports',
  '/applications': 'Applications',
  '/name-blacklist': 'Name Blacklist',
  '/voice': 'Voice',
  '/discord-embeds': 'Embeds',
  '/help': 'Help',
  '/audit-log': 'Audit Log',
  '/server-health': 'Server Health',
  '/devices': 'Devices',
  '/wiki-sync': 'Wiki Sync',
  '/profile': 'Profile',
};

function resolveRouteTitle(pathname: string): string {
  if (ROUTE_TITLES[pathname]) return ROUTE_TITLES[pathname];
  // Longest matching prefix (handles /moderation/bans/:id, /profile/:userId, etc.)
  let best: string | null = null;
  for (const route of Object.keys(ROUTE_TITLES)) {
    if (pathname === route || pathname.startsWith(route + '/')) {
      if (!best || route.length > best.length) best = route;
    }
  }
  return best ? ROUTE_TITLES[best] : '';
}
import type { AuthUser } from '../contexts/AuthContext';
import RoleViewSwitcher from './RoleViewSwitcher';

interface SubTab {
  path: string;
  label: string;
}

interface Tab {
  id: string;
  label: string;
  subTabs: SubTab[];
}

const TABS: Tab[] = [
  {
    id: 'CHAT',
    label: 'CHAT',
    subTabs: [
      { path: '/chat', label: 'OVERLAY' },
      { path: '/keybinds', label: 'KEYBINDS' },
      { path: '/feed', label: 'FEED' },
      { path: '/channels', label: 'CHANNELS' },
      { path: '/help', label: 'HELP' },
    ]
  },
  {
    id: 'MODERATION',
    label: 'MODERATION',
    subTabs: [
      { path: '/users', label: 'USERS' },
      { path: '/player-reports', label: 'PLAYER REPORTS' },
      { path: '/bug-reports', label: 'BUG REPORTS' },
      { path: '/applications', label: 'APPLICATIONS' },
      { path: '/moderation', label: 'AUTO-MOD' },
      { path: '/moderation/violations', label: 'VIOLATIONS' },
      { path: '/name-blacklist', label: 'NAME BLACKLIST' },
      { path: '/moderation/bans', label: 'BANS' },
      { path: '/moderation/evidence', label: 'EVIDENCE' },
    ]
  },
  {
    id: 'DISCORD',
    label: 'DISCORD',
    subTabs: [
      { path: '/voice', label: 'VOICE' },
      { path: '/discord-embeds', label: 'EMBEDS' },
    ]
  },
  {
    id: 'SYSTEM',
    label: 'SYSTEM',
    subTabs: [
      { path: '/server-health', label: 'SERVER HEALTH' },
      { path: '/devices', label: 'DEVICES' },
      { path: '/audit-log', label: 'AUDIT LOG' },
      { path: '/commands', label: 'COMMANDS' },
      { path: '/wiki-sync', label: 'WIKI SYNC' },
    ]
  }
];

// Sub-tabs a dweller (non-staff) is allowed to see, per tab. Anything not listed
// here is staff-only and stripped from the dweller's nav.
const DWELLER_CHAT_PATHS = new Set(['/chat', '/keybinds', '/help']);
const DWELLER_MODERATION_PATHS = new Set(['/player-reports', '/bug-reports', '/applications']);

// Fail-safe: only roles in this list get the admin tabs. Anyone else
// (logged out, 'user', 'supporter', or any unrecognised role) sees the chat-only
// view. This is the inverse of an "exclusion list" — it can't fail open for
// custom or unexpected role strings the backend might assign.
const ADMIN_ROLES = ['moderator', 'admin', 'owner'];

function getVisibleTabs(user: AuthUser | null): Tab[] {
  const isAdmin = !!user && ADMIN_ROLES.includes(user.role);
  if (isAdmin) return TABS;
  // Dwellers ('user'/'supporter'/logged-out): hide DISCORD + SYSTEM entirely.
  // CHAT is trimmed to OVERLAY + HELP; MODERATION is trimmed to the three
  // self-service sub-tabs (player reports, bug reports, applications).
  return TABS
    .filter(tab => tab.id !== 'DISCORD' && tab.id !== 'SYSTEM')
    .map(tab => {
      if (tab.id === 'CHAT') return { ...tab, subTabs: tab.subTabs.filter(sub => DWELLER_CHAT_PATHS.has(sub.path)) };
      if (tab.id === 'MODERATION') return { ...tab, subTabs: tab.subTabs.filter(sub => DWELLER_MODERATION_PATHS.has(sub.path)) };
      return tab;
    });
}

function PipboyNav({ user }: { user: AuthUser | null }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  const visibleTabs = getVisibleTabs(user);

  let activeTabId = 'CHAT';
  const activeSubPath = location.pathname;

  for (const tab of TABS) {
    if (tab.subTabs.some(sub => sub.path === activeSubPath)) {
      activeTabId = tab.id;
      break;
    }
  }

  const activeTab = visibleTabs.find(t => t.id === activeTabId) || visibleTabs[0];

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Close drawer on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && drawerOpen) {
        setDrawerOpen(false);
      }
    }
    if (drawerOpen) {
      document.addEventListener('keydown', handleKeyDown);
      // Trap focus inside drawer
      if (drawerRef.current) {
        const firstFocusable = drawerRef.current.querySelector<HTMLElement>('button, a, [tabindex]');
        if (firstFocusable) firstFocusable.focus();
      }
    }
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [drawerOpen]);

  const handleDrawerNavClick = useCallback((path: string) => {
    navigate(path);
    setDrawerOpen(false);
  }, [navigate]);

  async function handleLogout() {
    await fetch('/auth/logout');
    navigate('/login');
  }

  return (
    <nav role="navigation" aria-label="Main navigation" style={{ userSelect: 'none', background: 'var(--bg-dark)' }}>
      {/* ── Brand Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 20px', alignItems: 'center', borderBottom: '1px solid rgba(212,176,64,0.3)' }}>
        {/* Hamburger button — visible only at mobile breakpoint via CSS */}
        <button
          className="hamburger-btn"
          onClick={() => setDrawerOpen(!drawerOpen)}
          aria-label={drawerOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={drawerOpen}
          aria-controls="mobile-nav-drawer"
          style={{
            display: 'none', /* shown via CSS media query */
            border: 'none',
            background: 'transparent',
            color: 'var(--phosphor-color)',
            fontSize: '24px',
            padding: '8px',
            minHeight: '44px',
            minWidth: '44px',
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          {drawerOpen ? '✕' : '☰'}
        </button>

        <img
          src="/logo.svg"
          alt="Fallout Chat Mod"
          style={{ height: '40px', display: 'block' }}
        />

        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <Link
              to={`/profile/${user.id}`}
              className="user-label-desktop username-chip"
              aria-label="View your profile"
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '1px',
                cursor: 'pointer', padding: '2px 6px',
              }}
            >
              {user.avatarUrl ? (
                <img src={user.avatarUrl} style={{ width: '32px', height: '32px', borderRadius: '50%', border: '1px solid var(--border-color)', objectFit: 'cover' }} alt="" />
              ) : (
                <div style={{ width: '32px', height: '32px', borderRadius: '50%', border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--phosphor-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 'bold' }}>
                  {(user.fo76Name || user.discordDisplayName || user.username).charAt(0).toUpperCase()}
                </div>
              )}
              {user.fo76Name || user.discordDisplayName || user.username}
            </Link>
            <button
              onClick={handleLogout}
              aria-label="Log out"
              style={{ fontSize: '11px', padding: '2px 6px', letterSpacing: '1px', minHeight: 'unset', border: '1px solid rgba(212,176,64,0.4)' }}
            >
              LOGOUT
            </button>
          </div>
        )}
      </div>

      {/* ── Mobile Drawer Backdrop ── */}
      {drawerOpen && (
        <div
          className="drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Mobile Navigation Drawer ── */}
      <div
        id="mobile-nav-drawer"
        ref={drawerRef}
        className={`nav-drawer ${drawerOpen ? 'nav-drawer--open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(212,176,64,0.3)' }}>
          <div style={{ fontSize: '14px', fontWeight: 'bold', color: 'var(--phosphor-color)', letterSpacing: '2px' }}>
            NAVIGATION
          </div>
        </div>
        {visibleTabs.map((tab) => (
          <div key={tab.id} style={{ borderBottom: '1px solid rgba(212,176,64,0.18)' }}>
            <div style={{
              padding: '12px 20px 4px',
              fontSize: '13px',
              fontWeight: 'bold',
              letterSpacing: '2px',
              color: tab.id === activeTabId ? 'var(--phosphor-color)' : 'var(--text-muted)',
            }}>
              {tab.label}
            </div>
            {tab.subTabs.map((sub) => {
              const isSubActive = sub.path === activeSubPath;
              return (
                <button
                  key={sub.path}
                  onClick={() => handleDrawerNavClick(sub.path)}
                  aria-label={`Navigate to ${sub.label}`}
                  aria-current={isSubActive ? 'page' : undefined}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '12px 20px 12px 32px',
                    fontSize: '12px',
                    letterSpacing: '1px',
                    border: 'none',
                    background: isSubActive ? 'rgba(212,176,64,0.14)' : 'transparent',
                    color: isSubActive ? 'var(--phosphor-color)' : 'var(--text-secondary)',
                    fontWeight: isSubActive ? 'bold' : 'normal',
                    cursor: 'pointer',
                    minHeight: '44px',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {isSubActive ? '▸ ' : '  '}{sub.label}
                </button>
              );
            })}
          </div>
        ))}
        {user && (
          <div style={{ padding: '16px 20px', borderTop: '1px solid rgba(212,176,64,0.3)', marginTop: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '11px', marginBottom: '8px' }}>
              {user.avatarUrl ? (
                <img src={user.avatarUrl} style={{ width: '32px', height: '32px', borderRadius: '50%', border: '1px solid var(--border-color)', objectFit: 'cover' }} alt="" />
              ) : (
                <div style={{ width: '32px', height: '32px', borderRadius: '50%', border: '1px solid var(--border-color)', background: 'var(--bg-card)', color: 'var(--phosphor-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 'bold' }}>
                  {(user.fo76Name || user.discordDisplayName || user.username).charAt(0).toUpperCase()}
                </div>
              )}
              {user.fo76Name || user.discordDisplayName || user.username}
            </div>
            <button
              onClick={() => { handleLogout(); setDrawerOpen(false); }}
              aria-label="Log out"
              style={{ width: '100%', fontSize: '11px', minHeight: '44px' }}
            >
              LOGOUT
            </button>
          </div>
        )}
      </div>

      {/* ── Top Tabs + Divider (hidden on mobile via CSS) ── */}
      <div className="desktop-tabs" style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', padding: '8px 20px 0', gap: '0' }}>
        {visibleTabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div key={tab.id}
                 role="button"
                 tabIndex={0}
                 aria-label={`${tab.label} section`}
                 aria-current={isActive ? 'true' : undefined}
                 onClick={() => navigate(tab.subTabs[0].path)}
                 onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(tab.subTabs[0].path); } }}
                 style={{
              padding: '4px 18px 6px',
              fontSize: '14px',
              fontWeight: 'bold',
              letterSpacing: '2px',
              cursor: 'pointer',
              color: isActive ? 'var(--phosphor-color)' : 'rgba(212,176,64,0.55)',
              borderTop: isActive ? '1px solid rgba(212,176,64,0.45)' : '1px solid transparent',
              borderLeft: isActive ? '1px solid rgba(212,176,64,0.45)' : '1px solid transparent',
              borderRight: isActive ? '1px solid rgba(212,176,64,0.45)' : '1px solid transparent',
              borderBottom: 'none',
              marginBottom: '-1px',
              background: isActive ? 'var(--bg-dark)' : 'transparent',
              position: 'relative',
              zIndex: isActive ? 2 : 0,
              textShadow: isActive ? 'var(--glow-sm)' : 'none',
              transition: 'all 0.1s',
              minHeight: '32px',
              display: 'flex',
              alignItems: 'center',
            }}>
              {tab.label}
            </div>
          );
        })}
        <div style={{ position: 'absolute', bottom: 0, left: 20, right: 20, height: '1px', background: 'rgba(212,176,64,0.45)', zIndex: 1 }} />
      </div>

      {/* ── Sub Tabs (hidden on mobile via CSS) ── */}
      <div className="desktop-subtabs" style={{ display: 'flex', gap: '24px', padding: '4px 20px 4px 38px', background: 'transparent' }}>
        {activeTab.subTabs.map((sub) => {
          const isSubActive = sub.path === activeSubPath;
          return (
            <NavLink
              key={sub.path}
              to={sub.path}
              aria-label={`Navigate to ${sub.label}`}
              aria-current={isSubActive ? 'page' : undefined}
              style={{
                fontSize: '12px',
                letterSpacing: '2px',
                color: isSubActive ? 'var(--phosphor-color)' : 'rgba(212,176,64,0.55)',
                fontWeight: isSubActive ? 'bold' : 'normal',
                textShadow: isSubActive ? '0 0 6px rgba(212,176,64,0.8)' : 'none',
                textDecoration: 'none',
                transition: 'color 0.1s',
                padding: '4px 0',
                minHeight: '44px',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              {sub.label}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'ADMIN',
  admin: 'ADMIN',
  moderator: 'MOD',
  supporter: 'SUPPORTER',
  user: 'USER',
};

const DEV_PERSONAS = [
  { key: 'admin',     label: 'Admin'     },
  { key: 'mod',       label: 'Mod'       },
  { key: 'supporter', label: 'Supporter' },
  { key: 'user',      label: 'User'      },
];

function PipboyStatusBar({ version, user }: { version: string; user: AuthUser | null }) {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const levelLabel = user ? (ROLE_LABEL[user.role] ?? user.role.toUpperCase()) : '—';

  return (
    <div style={{
      borderTop: '1px solid var(--phosphor-color)',
      padding: '5px 20px',
      display: 'flex',
      alignItems: 'center',
      gap: '24px',
      background: 'rgba(212,176,64,0.08)',
      fontSize: '12px',
      letterSpacing: '1px',
      marginTop: 'auto'
    }}>
      <span>VER <strong>{version}</strong></span>
      <span style={{ color: 'rgba(212,176,64,0.7)', fontSize: '10px' }}>████████████████████</span>
      <span>LEVEL <strong>{levelLabel}</strong></span>
      <span style={{ marginLeft: 'auto', color: 'rgba(212,176,64,0.8)' }}>
        {time.toLocaleTimeString('en-US', { hour12: false })}
      </span>
    </div>
  );
}

function DevPersonaSwitcher({ user }: { user: AuthUser | null }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'fixed', right: 0, top: '26%', transform: 'translateY(-50%)', zIndex: 9999, display: 'flex', alignItems: 'center' }}>
      {/* Slide-out panel */}
      <div style={{
        background: '#0d1a0f',
        border: '1px solid rgba(24,255,98,0.4)',
        borderRight: 'none',
        padding: open ? '14px 12px' : '0',
        width: open ? '148px' : '0',
        overflow: 'hidden',
        transition: 'width 0.2s ease, padding 0.2s ease',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        boxShadow: open ? '-4px 0 20px rgba(24,255,98,0.08)' : 'none',
      }}>
        {open && (
          <>
            <div style={{ fontSize: '9px', letterSpacing: '2px', color: 'rgba(24,255,98,0.4)', marginBottom: '4px', whiteSpace: 'nowrap' }}>
              DEV PERSONA
            </div>
            {DEV_PERSONAS.map(p => {
              const isActive = user?.username === `System ${p.label}`;
              return (
                <a
                  key={p.key}
                  href={`/auth/dev-login/${p.key}`}
                  style={{
                    display: 'block',
                    padding: '7px 10px',
                    textAlign: 'center',
                    background: isActive ? 'rgba(24,255,98,0.15)' : 'rgba(24,255,98,0.04)',
                    border: isActive ? '1px solid rgba(24,255,98,0.5)' : '1px solid rgba(24,255,98,0.18)',
                    color: isActive ? '#18FF62' : 'rgba(24,255,98,0.6)',
                    textDecoration: 'none',
                    fontSize: '11px',
                    fontWeight: isActive ? 'bold' : 'normal',
                    letterSpacing: '1px',
                    fontFamily: 'Courier New, monospace',
                    whiteSpace: 'nowrap',
                    transition: 'background 0.1s, color 0.1s',
                    textShadow: isActive ? '0 0 8px rgba(24,255,98,0.6)' : 'none',
                  }}
                  onMouseEnter={e => {
                    if (!isActive) {
                      e.currentTarget.style.background = 'rgba(24,255,98,0.1)';
                      e.currentTarget.style.color = 'rgba(24,255,98,0.9)';
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isActive) {
                      e.currentTarget.style.background = 'rgba(24,255,98,0.04)';
                      e.currentTarget.style.color = 'rgba(24,255,98,0.6)';
                    }
                  }}
                >
                  {isActive ? '▸ ' : '  '}{p.label.toUpperCase()}
                </a>
              );
            })}
          </>
        )}
      </div>

      {/* Tab button */}
      <button
        onClick={() => setOpen(o => !o)}
        title="Dev persona switcher"
        style={{
          background: '#0d1a0f',
          border: '1px solid rgba(24,255,98,0.4)',
          borderRight: 'none',
          color: open ? '#18FF62' : 'rgba(24,255,98,0.5)',
          cursor: 'pointer',
          padding: '10px 6px',
          fontSize: '10px',
          letterSpacing: '1px',
          fontFamily: 'Courier New, monospace',
          writingMode: 'vertical-rl',
          textOrientation: 'mixed',
          userSelect: 'none',
          transition: 'color 0.1s',
          boxShadow: '-2px 0 12px rgba(24,255,98,0.06)',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = '#18FF62'; }}
        onMouseLeave={e => { e.currentTarget.style.color = open ? '#18FF62' : 'rgba(24,255,98,0.5)'; }}
      >
        DEV
      </button>
    </div>
  );
}

interface AdminLayoutProps {
  user: AuthUser | null;
  children: React.ReactNode;
}

export default function AdminLayout({ user, children }: AdminLayoutProps) {
  const [version, setVersion] = useState('—');
  const location = useLocation();

  // Central browser-tab title for every admin route: `<Name> - FCM`.
  useEffect(() => {
    const name = resolveRouteTitle(location.pathname);
    document.title = name ? `${name} - FCM` : 'FCM';
  }, [location.pathname]);

  useEffect(() => {
    fetch('/api/version').then(r => r.json()).then(j => {
      if (j?.data?.version) setVersion(j.data.version);
    }).catch(() => {});
  }, []);

  return (
    <div className="admin-layout-root" style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
    }}>
      {/* Pip-Boy terminal frame around the entire app */}
      <div className="admin-layout-frame" style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        maxWidth: '1400px',
        height: 'calc(100vh - 48px)',
        border: '1px solid var(--phosphor-color)',
        boxShadow: '0 0 40px rgba(212,176,64,0.1), inset 0 0 60px rgba(0,0,0,0.15)',
        background: 'var(--bg-dark)',
        position: 'relative',
        zIndex: 1,
      }}>
        <PipboyNav user={user} />

        <main style={{ flex: 1, overflow: 'auto', padding: '4px 12px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {children}
        </main>

        <PipboyStatusBar version={version} user={user} />
      </div>
      {devPersonaUiEnabled && <DevPersonaSwitcher user={user} />}
      {/* Prod "view as role" switcher — visible to real owners/admins only. */}
      <RoleViewSwitcher />
    </div>
  );
}
