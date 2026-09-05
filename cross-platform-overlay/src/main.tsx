// 1) Install the network bridge BEFORE anything imports the dashboard code,
//    so the real component's fetch/WebSocket are already shimmed.
import './bridge';

// 2) Match the website's chrome: Tailwind v4 preflight + the dashboard theme
//    vars/fonts. This is the SAME stylesheet the dashboard's main.tsx loads.
import '@dashboard/index.css';

import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router';

// Desktop-overlay parity shell: settings panel, idle auto-collapse, channel-nav
// commands, click-through hover reporting. (cross-platform-overlay-only.)
import { initShell, openSettings } from './shell';
// First-run onboarding overlay.
import { showOnboarding } from './onboarding';
import { focusChatInput } from './focus-chat';
import { shouldExitTextEntryOnEscape, shellToWebSettings } from './shell-core';
import { shouldShowDevPersonaLogins } from './bridge-core';

// 3) THE REAL COMPONENT — unmodified, imported straight from the dashboard source.
import ChatOverlay from '@dashboard/features/chat/ChatOverlay';
import type { AuthUser } from '@dashboard/contexts/AuthContext';

// Seed the component's localStorage settings from the persisted shell settings
// BEFORE the ChatOverlay module reads them on mount. DEFAULT theme is the
// Fallout 76 (amber/wasteland) palette — the product default. The shell owns the
// full superset; here we just mirror the subset the component reads natively.
import { loadShellSettings, DEFAULT_SHELL_SETTINGS, applyShellChromeTheme } from './shell';

// Apply the chosen theme's chrome colors (--shell-primary / --shell-text /
// --shell-primary-dim) to :root BEFORE first paint, so the pre-auth / loading /
// error screens + the shell-bar window buttons follow the theme from the very
// first frame (not hardcoded green). Re-applied on theme change via shell.ts.
try { applyShellChromeTheme(loadShellSettings().themeId); } catch { /* ignore */ }
// DEV-ONLY: ?fontsize=N seeds the persisted shell scale BEFORE loadShellSettings,
// so the CSS-zoom path is exercised in tests (reproduces the user's fontSize 16
// case where the picker landed centered). Behind a query param → never in prod.
try {
  const fsParam = new URLSearchParams(location.search).get('fontsize');
  if (fsParam) {
    const raw = localStorage.getItem('fcm_shell_settings');
    const cur = raw ? JSON.parse(raw) : {};
    cur.fontSize = parseInt(fsParam, 10);
    localStorage.setItem('fcm_shell_settings', JSON.stringify(cur));
  }
} catch { /* ignore */ }
try {
  const s = loadShellSettings();
  // Keep every component-facing setting in the mirror, including the
  // moderator party-feed mute preference. A hand-maintained subset here would
  // silently reset new settings on every Electron boot.
  localStorage.setItem('fcm_web_overlay_settings', JSON.stringify(shellToWebSettings(s)));
} catch { /* ignore */ }

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

// Seed defaults for the signed-in user. The real `role` (owner/admin/moderator)
// and `avatarUrl` are filled in reactively from each relay:status update — see
// the onStatus handler in <Shell>. role 'user' = no mod controls.
const stubUser: AuthUser = {
  id: '00000000-0000-0000-0000-0000000000ff',
  username: 'Overseer',
  role: 'user',
};

// Resolve a possibly-relative avatar path against the relay HTTP base (same
// resolution bridge.ts uses for chat avatars). Absolute URLs pass through.
function resolveAvatarUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
  const base = window.__FCM_OVERLAY_SHELL__?.relayBase || '';
  if (!base) return url; // best-effort; component falls back to letter avatar
  return base.replace(/\/$/, '') + (url.startsWith('/') ? url : `/${url}`);
}

const DEV_PERSONAS = ['user', 'developer', 'moderator', 'admin', 'owner'] as const;

function DevPersonaLoginButtons({ themePrimary }: { themePrimary: string }) {
  const [pendingPersona, setPendingPersona] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);

  return (
    <div style={{ marginTop: 12, borderTop: `1px solid ${themePrimary}22`, paddingTop: 12 }}>
      <div style={{ opacity: 0.5, fontSize: 10, letterSpacing: '0.12em', marginBottom: 8 }}>DEV ACCOUNTS</div>
      <div style={{ opacity: 0.5, fontSize: 10, marginBottom: 8 }}>
        DEV accounts grant synthetic test access immediately. These controls are unavailable in production.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {DEV_PERSONAS.map((persona) => (
          <button key={persona}
            disabled={pendingPersona !== null}
            onClick={async () => {
              setPendingPersona(persona);
              setLoginError(null);
              try {
                const { applyOnboardingSettings } = await import('./shell');
                const result = await window.relayBridge.devLoginAs!(persona);
                if (result?.ok) {
                  applyOnboardingSettings({ onboarded: true, discordLinked: true });
                } else {
                  setLoginError(result?.error || 'Dev login was rejected by the hosted Dev relay.');
                }
              } catch (err) {
                setLoginError(err instanceof Error ? err.message : 'Dev login failed unexpectedly.');
              } finally {
                setPendingPersona(null);
              }
            }}
            style={{
              background: 'rgba(20,32,20,0.9)', border: `1px solid ${themePrimary}55`,
              color: themePrimary, fontFamily: '"Courier New", monospace', cursor: pendingPersona ? 'wait' : 'pointer',
              fontSize: 10, padding: '4px 10px', opacity: 0.7, fontWeight: 'normal',
            }}
          >
            {pendingPersona === persona ? '…' : persona.toUpperCase()}
          </button>
        ))}
      </div>
      {loginError && (
        <div role="alert" style={{ color: '#FF6644', opacity: 0.9, fontSize: 10, lineHeight: '1.5', marginTop: 8 }}>
          Dev login failed: {loginError.slice(0, 240)}
        </div>
      )}
    </div>
  );
}

// ── Shell control strip ──────────────────────────────────────────────────────
// The web ChatOverlay renders NO window chrome (no close / minimize). For the
// frameless Electron window we provide a slim draggable strip with a − (minimize)
// and ✕ (close-to-tray / quit) the user can click WITHOUT any global hotkey —
// this is the primary way to hide/close the window under WSLg.
function mountShellBar() {
  // Idempotent: remove any prior shell chrome (defensive against a hot re-run).
  document.getElementById('shell-bar')?.remove();
  for (const id of ['shell-bg-dim', 'shell-scanline']) document.getElementById(id)?.remove();
  const bar = document.createElement('div');
  bar.id = 'shell-bar';

  // A slim draggable handle to MOVE the frameless window. The window controls
  // (refresh / settings / minimize / close) and the FALLOUT 76 title live INSIDE
  // the overlay header (rendered by ChatOverlay when overlayShell is set), so the
  // strip stays minimal. It only carries fallback min/close that matter on the
  // pre-auth screen (before the component — and its header — has mounted).
  const drag = document.createElement('div');
  drag.className = 'shell-drag';
  bar.appendChild(drag);

  const gear = document.createElement('div');
  gear.className = 'shell-btn';
  gear.title = 'Settings';
  gear.textContent = '⚙';
  gear.addEventListener('click', () => openSettings());

  const min = document.createElement('div');
  min.className = 'shell-btn';
  min.title = 'Minimize';
  min.textContent = '−'; // −
  min.addEventListener('click', () => window.relayBridge.minimizeWindow());

  const close = document.createElement('div');
  close.className = 'shell-btn close';
  close.title = 'Close (quit)';
  close.textContent = '✕'; // ✕
  close.addEventListener('click', () => window.relayBridge.closeWindow());

  bar.appendChild(gear);
  bar.appendChild(min);
  bar.appendChild(close);
  document.getElementById('root')!.prepend(bar);

  // Prototype-managed visual layers (background dim + scanline) the React
  // component doesn't expose as settings. They sit above the overlay paint.
  for (const id of ['shell-bg-dim', 'shell-scanline']) {
    const layer = document.createElement('div');
    layer.id = id;
    document.body.appendChild(layer);
  }
}

// ── `/hide` slash behaviour + focus-to-chat wiring ───────────────────────────
// The component owns its own <textarea>; we don't fork it. Instead we watch at
// the document level: if the user types `/hide` and presses Enter, hide the
// window before the component would try to send it as a message.
function wireShellInputBehaviour() {
  const focusRetrySteps = [
    { label: 'immediate', kind: 'immediate' as const },
    { label: 'requestAnimationFrame', kind: 'raf' as const },
    { label: '50ms', kind: 'timeout' as const, delayMs: 50 },
    { label: '150ms', kind: 'timeout' as const, delayMs: 150 },
    { label: '300ms', kind: 'timeout' as const, delayMs: 300 },
    { label: '600ms', kind: 'timeout' as const, delayMs: 600 },
  ];
  let focusRequestSeq = 0;
  const focusTimeouts = new Set<number>();
  const focusRafs = new Set<number>();

  const clearPendingFocusRetries = () => {
    for (const id of focusTimeouts) clearTimeout(id);
    focusTimeouts.clear();
    for (const id of focusRafs) cancelAnimationFrame(id);
    focusRafs.clear();
  };

  const logFocusAttempt = (msg: string) => window.relayBridge.logDiag?.(msg);

  const runFocusAttempt = (requestId: number, attemptIndex: number): boolean => {
    if (requestId !== focusRequestSeq) return true;
    const step = focusRetrySteps[attemptIndex];
    const result = focusChatInput(document);
    const prefix = `[focus-chat] attempt ${attemptIndex + 1}/${focusRetrySteps.length} ${step.label}`;

    if (result.state === 'focused') {
      logFocusAttempt(`${prefix} success target=${result.targetLabel ?? result.targetKind ?? 'unknown'}`);
      window.relayBridge.notifyInputFocusState?.(true);
      clearPendingFocusRetries();
      return true;
    }

    if (result.state === 'blocked') {
      logFocusAttempt(`${prefix} blocked: ${result.reason}`);
      window.relayBridge.notifyInputFocusState?.(false);
      clearPendingFocusRetries();
      return true;
    }

    if (attemptIndex === focusRetrySteps.length - 1) {
      logFocusAttempt(`${prefix} failed: ${result.reason}`);
      window.relayBridge.notifyInputFocusState?.(false);
      clearPendingFocusRetries();
      return true;
    }

    logFocusAttempt(`${prefix} pending: ${result.reason}`);
    return false;
  };

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      const el = e.target as HTMLElement | null;
      if (!el) return;
      const isEditable = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.contentEditable === 'true';
      if (!isEditable) return;
      const val = (
        el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
          ? (el as HTMLTextAreaElement).value
          : el.textContent ?? ''
      ).trim().toLowerCase();
      if (val === '/hide') {
        e.preventDefault();
        e.stopPropagation();
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') (el as HTMLTextAreaElement).value = '';
        else el.innerHTML = '';
        window.relayBridge.hideViaSlash();
      }
    },
    true, // capture: run before the component's own Enter handler
  );

  // Escape exits text-entry mode only after the overlay already has DOM focus.
  // This is intentionally not an Electron globalShortcut, so Escape remains
  // untouched while the game or any other app is focused.
  document.addEventListener('keydown', (e) => {
    if (!shouldExitTextEntryOnEscape(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    else if (e.target instanceof HTMLElement) e.target.blur();
    window.relayBridge.notifyInputFocusState?.(false);
    window.relayBridge.returnToGame?.();
  });

  // Focus-to-chat (Insert / tray): focus the component's input textarea or
  // rich contentEditable div (overlay-only, when custom emoji input is active).
  window.relayBridge.onFocusInput(() => {
    const requestId = ++focusRequestSeq;
    clearPendingFocusRetries();
    logFocusAttempt('[focus-chat] request received');

    for (const [attemptIndex, step] of focusRetrySteps.entries()) {
      if (step.kind === 'immediate') {
        if (runFocusAttempt(requestId, attemptIndex)) break;
        continue;
      }

      if (step.kind === 'raf') {
        const rafId = requestAnimationFrame(() => {
          focusRafs.delete(rafId);
          runFocusAttempt(requestId, attemptIndex);
        });
        focusRafs.add(rafId);
        continue;
      }

      const timeoutId = window.setTimeout(() => {
        focusTimeouts.delete(timeoutId);
        runFocusAttempt(requestId, attemptIndex);
      }, step.delayMs);
      focusTimeouts.add(timeoutId);
    }
  });
}

// ── Provider shell: replicate the dashboard's <Outlet context={{ user }} /> ──
function Shell() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When the backend provider gate fires (install has no verified Discord/Steam
  // link yet), show a blocking login wall. Cleared only on authentication.
  const [discordRequired, setDiscordRequired] = useState(false);
  // Watchdog: true when we've been stuck on the "Authenticating…" screen with no
  // terminal state (authenticated / error / discord_required) for too long. The
  // main process retries register on its own, but if it never emits ANY terminal
  // state (e.g. an unforeseen hang) the user would otherwise be stuck with no
  // escape — this surfaces a RETRY affordance on the loading screen as a backstop.
  const [authStuck, setAuthStuck] = useState(false);
  // Whether this is an unpackaged dev build (populated from getInfo once on mount).
  // Stored as a ref so the onStatus callback closure always reads the current value.
  const isDevRef = useRef(false);
  // Synthetic persona login is limited to unpackaged builds on a known DEV relay.
  const [showDevPersonaLogins, setShowDevPersonaLogins] = useState(false);
  // Bumping this key remounts the ChatOverlay so it re-reads its settings from
  // localStorage (the component only loads them on mount). Driven by the shell
  // settings panel and the header refresh button.
  const [mountKey, setMountKey] = useState(0);
  // Tracks whether we've already authenticated once. A SECOND authenticated
  // status (after a Discord link or a rename re-register) must remount the chat
  // so it re-opens the WS under the new identity + reloads history — otherwise
  // the log stays blank/stale after linking.
  const hasAuthedRef = useRef(false);
  // Identity fingerprint of the last authenticated status. Used to remount the
  // chat ONLY when the identity actually changes (Discord link / rename / new
  // account) — never on a plain focus-triggered refreshDiscordStatus, which was
  // remounting and snapping the user back to General, losing their party tab.
  const lastIdentityRef = useRef('');
  // Reactive signed-in user passed into the ChatOverlay Outlet context. Seeded
  // from stubUser defaults; role/avatarUrl/displayName are filled in from each
  // relay:status so mod controls (mute/kick/ban) appear without a restart once a
  // Discord link or rename re-register returns an admin/mod role.
  const [user, setUser] = useState<AuthUser>(stubUser);

  // Watchdog timer: while we're in the pre-auth loading state (no terminal status
  // yet), arm a 25s timer that flips authStuck → shows RETRY on the loading screen.
  // Any terminal state (ready / error / discordRequired) disarms it.
  useEffect(() => {
    if (ready || error || discordRequired) { setAuthStuck(false); return; }
    const t = setTimeout(() => setAuthStuck(true), 25_000);
    return () => clearTimeout(t);
  }, [ready, error, discordRequired]);

  useEffect(() => {
    // Wait until the main process has registered + has a session token before
    // mounting the component (so its first /api/channels + WS calls succeed).
    window.relayBridge.onStatus((s: { state: string; message?: string; displayName?: string; discordLinked?: boolean; discordName?: string; steamLinked?: boolean; role?: string | null; avatarUrl?: string | null; username?: string | null; userId?: string | null }) => {
      if (s.state === 'authenticated') {
        // Reactively update the signed-in user so ChatOverlay's mod-control gating
        // (user.role ∈ {owner, admin, moderator}) reflects the real backend role.
        setUser((prev) => ({
          ...prev,
          role: s.role || 'user',
          avatarUrl: resolveAvatarUrl(s.avatarUrl) ?? prev.avatarUrl,
          ...(s.username ? { username: s.username } : {}),
          ...(s.displayName ? { fo76Name: s.displayName } : {}),
          ...(s.userId ? { id: s.userId } : {}),
        }));
        // Pre-populate fo76Name in settings from the register response displayName
        // if the user hasn't set one yet (i.e. it's still the default empty string).
        // Also seed real provider link state from the register response so the
        // settings panel/onboarding show the correct status on launch.
        if (s.displayName || s.discordLinked != null || s.steamLinked != null) {
          try {
            const SHELL_KEY = 'fcm_shell_settings';
            const raw = localStorage.getItem(SHELL_KEY);
            const current = raw ? { ...DEFAULT_SHELL_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SHELL_SETTINGS };
            const patch: Record<string, unknown> = {};
            // Only set fo76Name if blank — don't overwrite a user-set name.
            if (s.displayName && !current.fo76Name) patch.fo76Name = s.displayName;
            // Always overwrite provider state from the authoritative backend
            // response — this corrects the "Not linked on first launch" bug.
            if (s.discordLinked != null) {
              patch.discordLinked = !!s.discordLinked;
              patch.discordName = s.discordName || '';
            }
            if (s.steamLinked != null) patch.steamLinked = !!s.steamLinked;
            if (Object.keys(patch).length > 0) {
              localStorage.setItem(SHELL_KEY, JSON.stringify({ ...current, ...patch }));
            }
          } catch { /* best-effort */ }
        }
        // Remount ONLY when the identity actually changed (Discord link / rename /
        // new account) — NOT on every authenticated status. A window-focus
        // refreshDiscordStatus re-fires 'authenticated' with the SAME identity;
        // remounting there reset the chat to General and lost the active party tab.
        //
        // Stability rule: if the incoming value for role or displayName is empty/null
        // BUT lastIdentityRef already has a real value for that field (user was already
        // authenticated), treat the incoming empty as "unchanged" by preserving the
        // previous field value in the key. A transient null role from a focus-triggered
        // re-register must not count as an identity change — that was the flash source.
        const prevParts = lastIdentityRef.current.split('|');
        const prevRole = prevParts[3] ?? '';
        const prevDisplayName = prevParts[1] ?? '';
        const stableRole = (s.role || !prevRole) ? (s.role || '') : prevRole;
        const stableDisplayName = (s.displayName || !prevDisplayName) ? (s.displayName || '') : prevDisplayName;
        const idKey = `${s.userId || ''}|${stableDisplayName}|${!!s.discordLinked}|${stableRole}|${!!s.steamLinked}`;
        if (hasAuthedRef.current && idKey !== lastIdentityRef.current) {
          // This remounts <ChatOverlay> (WS teardown + chat:history reload) — i.e. a
          // visible "chat reloaded". Log WHY so we can confirm/deny it from main.log
          // when users report the reload-on-Insert bug.
          window.relayBridge.logDiag?.(`mountKey bump (chat reload): "${lastIdentityRef.current}" -> "${idKey}"`);
          setMountKey(k => k + 1);
        }
        lastIdentityRef.current = idKey;
        hasAuthedRef.current = true;
        setReady(true);
        // Successful auth clears both the error screen and the provider-required wall.
        setDiscordRequired(false);
        // A successful (re)connection must clear any latched error screen.
        // The relay can emit a transient 'error' (e.g. a register 429 during
        // startup churn) and then recover on retry; without this, the sticky
        // `error` state keeps rendering the error card forever (the `if (error)`
        // guard below short-circuits the ready UI), so the overlay shows
        // "Rate limited" despite being connected. RETRY was the only way out.
        setError(null);
        // Show the first-run onboarding overlay if the user hasn't completed it yet.
        // DEV-ONLY: ?onboarding=1 forces it to show regardless of the flag.
        const forceOnboarding = new URLSearchParams(location.search).get('onboarding') === '1';
        // Skip onboarding only when the user has explicitly completed it.
        // The `onboarded` flag is persisted in both localStorage and
        // overlay-state.json (via __FCM_SAVED_SETTINGS__), so it survives
        // localStorage wipes. discordLinked is NOT used here — a new user who
        // just completed OAuth for the first time would incorrectly skip onboarding.
        const alreadySetUp = loadShellSettings().onboarded === true;
        if (forceOnboarding || !alreadySetUp) {
          // Small delay so the component has mounted before the overlay appears.
          // Pass the Discord display name so the identity step can pre-populate the FO76 name field.
          const sExt = s as typeof s & { discordDisplayName?: string };
          const discordDisplayNameForOnboarding = sExt.discordDisplayName || s.discordName || '';
          setTimeout(() => showOnboarding(isDevRef.current, discordDisplayNameForOnboarding), 600);
          // User still needs onboarding — game gate must NOT be enforced yet.
          // notifyChatActive(false) keeps canShowOverlay() returning true so the
          // onboarding wizard is never hidden. notifyChatActive(true) is sent by
          // the onboarding finish path (see onboarding.ts) once the user completes.
          try { window.relayBridge.notifyChatActive?.(false); } catch { /* optional */ }
        } else {
          // Already set up — engage the game gate from this point on.
          try { window.relayBridge.notifyChatActive?.(true); } catch { /* optional */ }
        }
        // DEV-ONLY: ?settings=<section> auto-opens the settings panel + section.
        const params = new URLSearchParams(location.search);
        const sp = params.get('settings');
        if (sp) setTimeout(() => {
          openSettings();
          const idx = { identity: 0, keybinds: 1, appearance: 2 }[sp];
          if (idx != null) (document.querySelectorAll<HTMLElement>('.ss-navbtn')[idx])?.click();
          const scroll = params.get('scroll');
          if (scroll) { const b = document.querySelector<HTMLElement>('.ss-body'); if (b) b.scrollTop = parseInt(scroll, 10); }
        }, 900);
        // DEV-ONLY: ?noidle=1 disables auto-hide (so tests don't collapse mid-run).
        const tw = window as unknown as { __ovTest?: { noIdle: () => void; collapse: () => void } };
        if (new URLSearchParams(location.search).get('noidle') === '1') {
          setTimeout(() => tw.__ovTest?.noIdle(), 700);
        }
        // DEV-ONLY: ?picker=emoji|gif auto-opens the picker (for screenshots).
        // Disables idle first so the overlay stays expanded + the trigger exists.
        // Uses the REAL React state setters via window.__ovChatTest (set inside
        // ChatOverlay when overlayShell is active) because a synthetic
        // dispatchEvent(MouseEvent('mousedown')) does NOT reliably trigger React's
        // onMouseDown in this renderer (confirmed: trigger found but picker absent).
        const pickerParam = new URLSearchParams(location.search).get('picker');
        if (pickerParam === 'emoji' || pickerParam === 'gif') setTimeout(() => {
          tw.__ovTest?.noIdle();
          const chatTest = (window as unknown as {
            __ovChatTest?: { openEmoji: () => void; openGif: () => void };
          }).__ovChatTest;
          if (pickerParam === 'gif') chatTest?.openGif(); else chatTest?.openEmoji();
        }, 1400);
        // DEV-ONLY: ?collapse=1 forces the idle-collapse repeatedly so the
        // collapsed state can be captured despite live chat resetting the timer.
        if (new URLSearchParams(location.search).get('collapse') === '1') {
          const t = window as unknown as { __ovTest?: { collapse: () => void } };
          setInterval(() => t.__ovTest?.collapse(), 400);
        }
        // The overlay's in-header controls (FALLOUT 76 title + refresh/settings/
        // min/close) are now visible, so fold the top strip to a thin invisible
        // drag handle to avoid doubling the window controls.
        document.getElementById('shell-bar')?.classList.add('mounted');
      } else if (s.state === 'discord_required' || s.state === 'auth_required' || s.state === 'provider_required') {
        // Backend provider gate: this install has no linked Discord or Steam account.
        // Show the blocking login wall and suppress the normal chat UI.
        setDiscordRequired(true);
        setError(null);
        setReady(false);
        // Keep the game-gate disabled so the login wall is always reachable.
        try { window.relayBridge.notifyChatActive?.(false); } catch { /* optional */ }
      } else if (s.state === 'error') setError(s.message || 'relay error');
    });

    // Reflect click-through mode for visibility (purely cosmetic banner).
    window.relayBridge.onClickThrough(() => { /* could surface a badge */ });

    // Populate the isDev flag from the main-process info (set once per session).
    window.relayBridge.getInfo().then((info) => {
      if (info?.isDev) isDevRef.current = true;
      setShowDevPersonaLogins(shouldShowDevPersonaLogins(!!info?.isDev, info?.relayHost || ''));
    }).catch(() => { /* non-fatal */ });

    // Init the desktop-parity shell once. When settings change, remount the
    // component so theme/opacity/font/hints take effect immediately.
    initShell({ onSettingsChange: () => setMountKey(k => k + 1) });

    // Auto-refresh provider link/supporter-role status when the window regains focus (the user
    // may have just returned from the OAuth browser flow). Throttled to once
    // per minute so a focus-heavy workflow doesn't spam the backend.
    let lastProviderCheck = 0;
    const onWindowFocus = () => {
      const now = Date.now();
      if (now - lastProviderCheck > 60_000) {
        lastProviderCheck = now;
        window.relayBridge.refreshDiscordStatus?.();
        window.relayBridge.refreshSteamStatus?.();
      }
    };
    window.addEventListener('focus', onWindowFocus);

    // Header refresh button → refresh provider/supporter state, then remount
    // (re-fetches channels + history).
    const onRefresh = () => setMountKey(k => k + 1);
    window.addEventListener('fcm-shell-refresh', onRefresh);
    // Header gear → open the full desktop-parity settings panel.
    const onSettings = () => openSettings();
    window.addEventListener('fcm-shell-settings', onSettings);
    return () => {
      window.removeEventListener('fcm-shell-refresh', onRefresh);
      window.removeEventListener('fcm-shell-settings', onSettings);
      window.removeEventListener('focus', onWindowFocus);
    };
  }, []);

  // ── Provider login wall ──────────────────────────────────────────────────────
  // Shown when the backend requires a verified provider before issuing a session token.
  // This is a HARD block: no chat, no settings, no dismiss. The only action is
  // "Log in with Discord" which opens the OAuth flow. When the link completes,
  // main.js fires refreshDiscordStatus → re-registers → emits 'authenticated' →
  // setDiscordRequired(false) + setReady(true) above, unlocking the UI.
  if (discordRequired) {
    const themeText = 'var(--shell-text, #18FF62)';
    const themePrimary = 'var(--shell-primary, #18FF62)';
    const btnBase: React.CSSProperties = {
      background: 'rgba(20,32,20,0.9)', border: `1px solid ${themePrimary}`,
      color: themePrimary, fontFamily: '"Courier New", monospace',
      cursor: 'pointer', letterSpacing: '0.08em', fontWeight: 'bold',
    };
    return (
      <div id="shell-discord-login-wall" style={{ fontFamily: '"Courier New", monospace', padding: 20, fontSize: 13, color: themeText, display: 'flex', flexDirection: 'column', gap: 12, background: 'rgba(8,18,8,0.96)', minHeight: '100vh', boxSizing: 'border-box' }}>
        <div style={{ color: themePrimary, fontWeight: 'bold', letterSpacing: '0.1em', fontSize: 14 }}>
          FALLOUT CHAT MOD
        </div>
        <div style={{ opacity: 0.8, lineHeight: '1.6' }}>
          Sign in with Steam or Discord to use the overlay.
        </div>
        <div style={{ opacity: 0.6, fontSize: 11, lineHeight: '1.5' }}>
          Steam sign-in verifies your Steam account directly. Discord sign-in also
          requires membership in the Fallout Chat Mod Discord server.
        </div>
        <button onClick={() => window.relayBridge.openExternal?.('https://discord.gg/NJBJqyvRJC')}
          style={{ ...btnBase, fontSize: 12, padding: '8px 18px', background: 'rgba(88,101,242,0.18)', borderColor: '#5865F2', color: '#c2cbff' }}>
          JOIN THE DISCORD SERVER
        </button>
        <button onClick={() => window.relayBridge.linkDiscord?.()}
          style={{ ...btnBase, fontSize: 12, padding: '8px 18px' }}>
          LOG IN WITH DISCORD
        </button>
        <button onClick={() => window.relayBridge.linkSteam?.()}
          style={{ ...btnBase, fontSize: 12, padding: '8px 18px', background: 'rgba(27,40,56,0.55)', borderColor: '#66C0F4', color: '#C7D5E0' }}>
          LOG IN WITH STEAM
        </button>
        <div style={{ opacity: 0.4, fontSize: 10, lineHeight: '1.5' }}>
          After authorizing in your browser, the overlay will unlock automatically.
        </div>
        {showDevPersonaLogins && typeof window.relayBridge?.devLoginAs === 'function' && (
          <DevPersonaLoginButtons themePrimary={themePrimary} />
        )}
      </div>
    );
  }

  if (error) {
    const is429 = error.includes('429');
    // Themed chrome via the :root CSS vars applyShellChromeTheme sets (primary /
    // text follow the chosen theme). A danger RED stays for the warning line only.
    const themeText = 'var(--shell-text, #18FF62)';
    const themePrimary = 'var(--shell-primary, #18FF62)';
    return (
      <div style={{ fontFamily: '"Courier New", monospace', padding: 16, fontSize: 13, color: themeText }}>
        <div style={{ color: '#FF6644', marginBottom: 10 }}>
          {is429 ? '⚠ Rate limited (HTTP 429)' : `Relay error: ${error}`}
        </div>
        {is429 && (
          <div style={{ color: themeText, opacity: 0.85, fontSize: 11, marginBottom: 12, lineHeight: '1.5' }}>
            Too many registrations — the server is cooling down.
            Wait a few minutes then retry.
          </div>
        )}
        <button
          onClick={() => {
            setError(null);
            setReady(false);
            // Re-trigger relay bootstrap by re-sending the status listener.
            // The main process will re-run startRelay on the next did-finish-load
            // equivalent — reload the page to re-attempt cleanly.
            location.reload();
          }}
          style={{
            background: 'rgba(20,32,20,0.9)', border: `1px solid ${themePrimary}`,
            color: themePrimary, fontFamily: '"Courier New", monospace',
            fontSize: 11, padding: '6px 14px', cursor: 'pointer', letterSpacing: '0.06em',
          }}
        >
          RETRY
        </button>
        <div style={{ color: themeText, opacity: 0.5, fontSize: 10, marginTop: 10 }}>
          (Or quit and relaunch after a minute)
        </div>
        {showDevPersonaLogins && typeof window.relayBridge?.devLoginAs === 'function' && (
          <DevPersonaLoginButtons themePrimary={themePrimary} />
        )}
      </div>
    );
  }
  if (!ready) {
    const themePrimary = 'var(--shell-primary, #18FF62)';
    return (
      <div style={{ color: 'var(--shell-text, #18FF62)', fontFamily: '"Courier New", monospace', padding: 16, fontSize: 13 }}>
        Authenticating with relay…
        {authStuck && (
          <div style={{ marginTop: 12 }}>
            <div style={{ opacity: 0.8, fontSize: 11, marginBottom: 10, lineHeight: '1.5' }}>
              This is taking longer than usual — the relay may be unreachable.
              It will keep retrying in the background, or you can retry now.
            </div>
            <button
              onClick={() => { setAuthStuck(false); location.reload(); }}
              style={{
                background: 'rgba(20,32,20,0.9)', border: `1px solid ${themePrimary}`,
                color: themePrimary, fontFamily: '"Courier New", monospace',
                fontSize: 11, padding: '6px 14px', cursor: 'pointer', letterSpacing: '0.06em',
              }}
            >
              RETRY
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <MemoryRouter key={mountKey} initialEntries={['/chat']}>
      <Routes>
        {/* Mirror App.tsx: ChatOverlay lives under an Outlet that supplies { user }. */}
        <Route element={<Outlet context={{ user }} />}>
          <Route path="/chat" element={<ChatOverlay />} />
          {/* The overlay renders usernames as <Link to="/profile/:userId">. The
              prototype has no profile route, so a left-click would navigate to a
              dead route and blank the window. Catch-all → keep rendering the
              overlay for ANY path (incl. /profile/:userId), so clicking a name
              never blanks the app. The right-click context menu is unaffected. */}
          <Route path="*" element={<ChatOverlay />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

// Inject the shell chrome (control strip) + input behaviour before mounting
// React. The strip lives OUTSIDE the React root so it isn't unmounted by the
// component's own re-renders.
mountShellBar();
wireShellInputBehaviour();

// React mounts into a flex-1 host below the control strip, so the overlay (whose
// own root is `flex: 1`) gets real height and its channel-tab bar stays on-screen.
// Idempotent: drop any prior host (defensive against a hot re-run).
document.getElementById('shell-overlay-host')?.remove();
const host = document.createElement('div');
host.id = 'shell-overlay-host';
document.getElementById('root')!.appendChild(host);

ReactDOM.createRoot(host).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  </React.StrictMode>
);

// This entry module has top-level side effects (mounts the shell chrome + a React
// root). It CANNOT be hot-swapped in place — re-running it would stack duplicate
// shell bars + React roots (the "many Authenticating…" bug). Force a clean full
// reload on any hot update to this module instead. (Edits to ChatOverlay.tsx
// still Fast-Refresh normally — this only governs the entry module's own graph.)
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
