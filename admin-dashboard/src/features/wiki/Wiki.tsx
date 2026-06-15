/**
 * Wiki — single scrolling wiki page with a TOC anchor-nav.
 *
 * Rendered by:
 *   - LandingPage SYSTEM → WIKI sub-tab (public surface, gold palette)
 *   - Auth dashboard /wiki route (dashboard surface, CSS-var tokens)
 *
 * The component is DATA-DRIVEN from WIKI_SECTIONS (hardcoded JSX). No DB,
 * no backend, no markdown. Content is identical on both surfaces — do NOT
 * fork it. The Command Reference section imports/embeds HelpContent to keep
 * the command data single-sourced.
 */

import React, { useRef } from 'react';
import HelpContent from '../system/HelpContent';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WikiVariant = 'dashboard' | 'public';

interface WikiSection {
  id: string;
  title: string;
  body: (variant: WikiVariant) => React.ReactNode;
}

// ── Style helpers (variant-switched) ─────────────────────────────────────────

function tokens(variant: WikiVariant) {
  const isPublic = variant === 'public';
  return {
    isPublic,
    gold:    isPublic ? '#C8A840'                     : 'var(--phosphor-color, #D4B040)',
    dim:     isPublic ? 'rgba(200,168,64,0.65)'       : 'var(--text-secondary)',
    muted:   isPublic ? 'rgba(200,168,64,0.4)'        : 'var(--text-muted, #666)',
    border:  isPublic ? 'rgba(200,168,64,0.18)'       : 'rgba(212,176,64,0.15)',
    codeBg:  isPublic ? 'rgba(200,168,64,0.1)'        : 'rgba(212,176,64,0.1)',
    fontFam: isPublic ? 'Courier New, monospace'      : 'var(--font-mono, monospace)',
    bg:      isPublic ? '#1e1908'                     : 'var(--bg-dark, #0d0d0d)',
  };
}

// ── Shared prose elements ─────────────────────────────────────────────────────

function P({ children, t }: { children: React.ReactNode; t: ReturnType<typeof tokens> }) {
  return (
    <p style={{ fontSize: '14px', lineHeight: 1.8, color: t.dim, marginBottom: '12px', marginTop: 0 }}>
      {children}
    </p>
  );
}

function UL({ children, t }: { children: React.ReactNode; t: ReturnType<typeof tokens> }) {
  return (
    <ul style={{ paddingLeft: '20px', margin: '0 0 12px', color: t.dim, fontSize: '14px', lineHeight: 1.8 }}>
      {children}
    </ul>
  );
}

function Code({ children, t }: { children: React.ReactNode; t: ReturnType<typeof tokens> }) {
  return (
    <code style={{
      background: t.codeBg,
      padding: '1px 6px',
      fontFamily: t.fontFam,
      fontSize: '13px',
      color: t.gold,
    }}>
      {children}
    </code>
  );
}

function H3({ children, t }: { children: React.ReactNode; t: ReturnType<typeof tokens> }) {
  return (
    <h3 style={{
      fontSize: '13px',
      letterSpacing: '2px',
      color: t.gold,
      marginTop: '20px',
      marginBottom: '8px',
      borderBottom: `1px solid ${t.border}`,
      paddingBottom: '4px',
    }}>
      {children}
    </h3>
  );
}

// ── Wiki sections (hardcoded content) ────────────────────────────────────────

const WIKI_SECTIONS: WikiSection[] = [
  // ── Getting Started ──────────────────────────────────────────────────────────
  {
    id: 'getting-started',
    title: 'Getting Started',
    body: (variant) => {
      const t = tokens(variant);
      return (
        <>
          <P t={t}>
            Fallout Chat Mod is a community chat overlay for Fallout 76. It runs as a
            transparent window on top of your game, connecting you to the community
            channels, Discord bridge, and party system without touching any game files.
          </P>
          <P t={t}>
            To get started: install the overlay, launch it, and log in with Discord.
            The overlay detects when Fallout 76 is running and automatically shows or
            hides itself.
          </P>
          <H3 t={t}>REQUIREMENTS</H3>
          <UL t={t}>
            <li>Windows 10/11 (x64) or Linux (x64, AppImage)</li>
            <li>Fallout 76 running in <strong>Windowed Borderless</strong> or <strong>Windowed</strong> mode</li>
            <li>A Discord account (for login and the community server)</li>
            <li>Internet connection (the overlay connects to falloutchatmod.com)</li>
          </UL>
          <P t={t}>
            <strong>Important:</strong> Exclusive Fullscreen prevents any overlay from
            rendering on top of the game — this is an OS/GPU restriction, not a mod
            limitation. Use Windowed Borderless for the best experience.
          </P>
        </>
      );
    },
  },

  // ── Installation ─────────────────────────────────────────────────────────────
  {
    id: 'installation',
    title: 'Installation',
    body: (variant) => {
      const t = tokens(variant);
      return (
        <>
          <H3 t={t}>WINDOWS — ONE-LINE INSTALL</H3>
          <P t={t}>
            Open PowerShell and paste:
          </P>
          <div style={{ background: t.codeBg, border: `1px solid ${t.border}`, padding: '10px 14px', marginBottom: '12px', fontFamily: t.fontFam, fontSize: '13px', color: t.gold }}>
            irm https://falloutchatmod.com/install.ps1 | iex
          </div>
          <P t={t}>
            Or download the installer ZIP from the INSTALL tab and run the
            &ldquo;Fallout Chat Mod Setup&rdquo; .exe. SmartScreen may warn
            &ldquo;unknown publisher&rdquo; (the binary is unsigned) — click
            <strong> More info</strong> then <strong>Run anyway</strong>.
          </P>

          <H3 t={t}>LINUX — ONE-LINE INSTALL</H3>
          <P t={t}>
            Open a terminal and paste:
          </P>
          <div style={{ background: t.codeBg, border: `1px solid ${t.border}`, padding: '10px 14px', marginBottom: '12px', fontFamily: t.fontFam, fontSize: '13px', color: t.gold }}>
            curl -fsSL https://falloutchatmod.com/install.sh | bash
          </div>
          <P t={t}>
            Or download the AppImage ZIP from the INSTALL tab, extract it, run{' '}
            <Code t={t}>chmod +x "Fallout Chat Mod-*.AppImage"</Code>, then launch it.
            If it won&apos;t start, try adding{' '}
            <Code t={t}>--appimage-extract-and-run</Code> (requires libfuse2).
          </P>

          <H3 t={t}>UNINSTALLING</H3>
          <UL t={t}>
            <li>Windows: use Apps &amp; Features or the installer&apos;s uninstaller.</li>
            <li>Linux: <Code t={t}>curl -fsSL https://falloutchatmod.com/uninstall.sh | bash</Code></li>
          </UL>
        </>
      );
    },
  },

  // ── Features ─────────────────────────────────────────────────────────────────
  {
    id: 'features',
    title: 'Features',
    body: (variant) => {
      const t = tokens(variant);
      return (
        <>
          <H3 t={t}>EULA-SAFE &amp; PATCH-DAY PROOF</H3>
          <P t={t}>
            No game-file modification, no Script Extender, no reading of game memory.
            The overlay only detects whether the Fallout76 process is running — nothing
            more. Bethesda can patch freely and the mod never breaks.
          </P>

          <H3 t={t}>DISCORD BRIDGE &amp; COMMUNITY INTEGRATIONS</H3>
          <P t={t}>
            In-game chat is mirrored to a Discord channel so your community stays in
            the loop even when they&apos;re not playing. The same platform powers
            temporary voice channels (Join-to-Create), reaction roles, and rich embeds.
          </P>

          <H3 t={t}>COMMUNITY GOVERNED &amp; OPEN MODERATION</H3>
          <P t={t}>
            Admins moderate via a browser-based dashboard — no client needed. Every
            message, channel, and report is visible and actionable, with audit logs,
            auto-mod filters, and role-based access (owner / admin / moderator).
          </P>

          <H3 t={t}>AUTO-UPDATING CLIENT</H3>
          <P t={t}>
            The overlay updates itself silently in the background via electron-updater.
            Every user is always on the latest version — no manual reinstall or download
            required after the first install.
          </P>

          <H3 t={t}>CUSTOMIZABLE OVERLAY</H3>
          <UL t={t}>
            <li>Theme color (default: Phosphor Green #18FF62)</li>
            <li>Opacity and window position (drag to reposition)</li>
            <li>Rebindable hotkeys — see the Keybinds section below</li>
            <li>Channel filters and blocked users persist across sessions</li>
          </UL>
        </>
      );
    },
  },

  // ── Command Reference ─────────────────────────────────────────────────────────
  {
    id: 'command-reference',
    title: 'Command Reference',
    body: (variant) => (
      <HelpContent variant={variant === 'public' ? 'public' : 'dashboard'} />
    ),
  },

  // ── Keybinds ─────────────────────────────────────────────────────────────────
  {
    id: 'keybinds',
    title: 'Keybinds',
    body: (variant) => {
      const t = tokens(variant);
      const rows: { key: string; action: string; note?: string }[] = [
        { key: 'Insert',       action: 'Focus chat input', note: 'Shows overlay if hidden, clears userHidden flag, focuses input' },
        { key: 'Delete',       action: 'Hide to tray',     note: 'App keeps running in the system tray; sets userHidden=true' },
        { key: 'End',          action: 'Toggle click-through', note: 'Switches between interactive and pass-through (mouse falls to game)' },
        { key: 'Page Down',    action: 'Next channel tab' },
        { key: 'Page Up',      action: 'Previous channel tab' },
        { key: 'Home',         action: 'Open Settings panel' },
        { key: '\\',           action: 'Jump to most recent party' },
        { key: '/',            action: 'Jump to Fallout 76 (General) tab' },
        { key: 'Escape',       action: 'Close chat input (while typing)' },
        { key: 'Tab / Up / Down', action: 'Navigate command autocomplete' },
        { key: 'Enter',        action: 'Send message / confirm autocomplete' },
      ];
      const thStyle: React.CSSProperties = {
        padding: '7px 12px', textAlign: 'left',
        color: t.dim, fontSize: '12px',
        borderBottom: `1px solid ${t.border}`,
        fontWeight: 'bold', letterSpacing: '1px',
      };
      const tdStyle: React.CSSProperties = {
        padding: '7px 12px',
        borderBottom: `1px solid ${t.border}`,
        fontSize: '13px', color: t.dim,
      };
      return (
        <>
          <P t={t}>
            All hotkeys below are the <strong>defaults</strong>. Every keybind is
            user-rebindable from <strong>Settings → Keybinds</strong> in the overlay.
            Rebinding carries the full behavior — no code changes required.
          </P>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>KEY</th>
                <th style={thStyle}>ACTION</th>
                <th style={thStyle}>NOTES</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key}>
                  <td style={tdStyle}><code style={{ background: t.codeBg, padding: '1px 6px', fontFamily: t.fontFam, fontSize: '12px', color: t.gold }}>{r.key}</code></td>
                  <td style={tdStyle}>{r.action}</td>
                  <td style={{ ...tdStyle, color: t.muted, fontStyle: 'italic' }}>{r.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <P t={t} >
            <strong>userHidden flag:</strong> set when the user explicitly hides the
            overlay (Delete key, /hide command, or tray Hide). While set,
            reevaluateVisibility will NOT auto-restore even if the game is running.
            Cleared by: Insert, tray Show, or the not-running to running game-launch transition.
          </P>
        </>
      );
    },
  },

  // ── Moderation ────────────────────────────────────────────────────────────────
  {
    id: 'moderation',
    title: 'Moderation',
    body: (variant) => {
      const t = tokens(variant);
      return (
        <>
          <P t={t}>
            The moderation dashboard is available at{' '}
            <a href="https://falloutchatmod.com" style={{ color: t.gold }}>falloutchatmod.com</a>{' '}
            for staff. Log in with a Discord account that holds the Admin or Moderator
            role in the community server.
          </P>
          <H3 t={t}>ROLES</H3>
          <UL t={t}>
            <li><strong>Owner</strong> — full access, including server config and role management.</li>
            <li><strong>Admin</strong> — full moderation access: bans, auto-mod, channel config, embeds.</li>
            <li><strong>Moderator</strong> — can act on reports, issue bans, view audit logs.</li>
            <li><strong>User / Supporter</strong> — community member; can submit reports and bug reports.</li>
          </UL>
          <H3 t={t}>AUTO-MOD</H3>
          <P t={t}>
            Configurable from the MODERATION tab. Rules can filter by keyword, regex,
            or message rate. Violations are logged to the Violations sub-tab and can
            trigger warnings, mutes, or automatic bans.
          </P>
          <H3 t={t}>BANS</H3>
          <P t={t}>
            Permanent or timed bans by Discord user or overlay install token. Banned
            users see a splash screen and cannot reconnect until the ban expires or is
            lifted. All bans are logged to the Audit Log.
          </P>
          <H3 t={t}>AUDIT LOG</H3>
          <P t={t}>
            Every moderation action (ban, unban, mute, message delete, role change,
            config change) is written to the audit log with timestamp, actor, and
            target. Logs are retained for 90 days.
          </P>
        </>
      );
    },
  },

  // ── FAQ ───────────────────────────────────────────────────────────────────────
  {
    id: 'faq',
    title: 'FAQ',
    body: (variant) => {
      const t = tokens(variant);
      const qa: { q: string; a: React.ReactNode }[] = [
        {
          q: 'Is this EULA-compliant?',
          a: 'Yes. The overlay performs no game-file modification, no Script Extender injection, no game-memory reading, and no network/port scanning. It only detects whether the Fallout76 process is running to show or hide the overlay window.',
        },
        {
          q: 'Why does SmartScreen block the installer?',
          a: 'The binary is unsigned ("unknown publisher"). Click More info then Run anyway. You can verify the file hash against the VirusTotal permalink on the INSTALL tab before running.',
        },
        {
          q: 'Will it work in Exclusive Fullscreen?',
          a: 'No — Exclusive Fullscreen gives the game exclusive GPU output. No overlay can render above it. Use Windowed Borderless instead.',
        },
        {
          q: 'Does the overlay read or modify my game?',
          a: 'No. It only checks whether Fallout76.exe is running. All chat is routed through the FCM backend over WebSocket — the game is never touched.',
        },
        {
          q: 'What happens on a Bethesda patch day?',
          a: 'Nothing breaks. The overlay is fully external — it does not depend on any game file, offset, or memory layout.',
        },
        {
          q: 'How do I update the overlay?',
          a: 'Automatically. electron-updater downloads and installs the latest version in the background. You get a notification on next launch.',
        },
        {
          q: 'Can I use this on Linux?',
          a: 'Yes. A native Linux AppImage is published with every release. KDE Plasma (Wayland) users: run FO76 in Windowed mode and set the taskbar to Auto-Hide for the best experience.',
        },
      ];
      return (
        <>
          {qa.map(({ q, a }) => (
            <div key={q} style={{ marginBottom: '20px' }}>
              <div style={{ fontWeight: 'bold', color: t.gold, fontSize: '14px', marginBottom: '6px' }}>
                Q: {q}
              </div>
              <div style={{ fontSize: '14px', color: t.dim, lineHeight: 1.7, paddingLeft: '16px' }}>
                {a}
              </div>
            </div>
          ))}
        </>
      );
    },
  },

  // ── Troubleshooting ───────────────────────────────────────────────────────────
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    body: (variant) => {
      const t = tokens(variant);
      return (
        <>
          <H3 t={t}>OVERLAY NOT VISIBLE IN-GAME</H3>
          <UL t={t}>
            <li>Switch Fallout 76 to <strong>Windowed Borderless</strong> or <strong>Windowed</strong> mode. Exclusive Fullscreen is not supported.</li>
            <li>Check that the overlay is running (look for the tray icon).</li>
            <li>Press <Code t={t}>Insert</Code> (or your configured Focus key) to show and focus the overlay.</li>
            <li>If you&apos;re on KDE Plasma / Wayland, make sure your taskbar is set to Auto-Hide.</li>
          </UL>

          <H3 t={t}>CANNOT CONNECT / CHAT NOT LOADING</H3>
          <UL t={t}>
            <li>Check your internet connection.</li>
            <li>Verify the server is up at{' '}<a href="https://falloutchatmod.com" style={{ color: t.gold }}>falloutchatmod.com</a>.</li>
            <li>Corporate or VPN networks may block WebSocket connections — try on a direct connection.</li>
            <li>Restart the overlay; it will reconnect with exponential backoff.</li>
          </UL>

          <H3 t={t}>LINUX APPIMAGE WON&apos;T LAUNCH</H3>
          <P t={t}>
            If the AppImage fails silently, try:
          </P>
          <div style={{ background: t.codeBg, border: `1px solid ${t.border}`, padding: '8px 14px', marginBottom: '12px', fontFamily: t.fontFam, fontSize: '12px', color: t.gold }}>
            ./&quot;Fallout Chat Mod-*.AppImage&quot; --appimage-extract-and-run
          </div>
          <P t={t}>
            This bypasses the FUSE requirement. If it still fails, install{' '}
            <Code t={t}>libfuse2</Code> via your package manager.
          </P>

          <H3 t={t}>KDE PLASMA / WAYLAND SETUP</H3>
          <UL t={t}>
            <li>Run FO76 in <strong>Windowed</strong> (not Borderless) mode.</li>
            <li>Set the KDE panel to <strong>Auto-Hide</strong>: right-click panel, Enter Edit Mode, Visibility, Auto Hide.</li>
            <li>Do NOT add a KWin window rule forcing Fullscreen=No — it breaks the game UI.</li>
            <li>Do NOT run inside gamescope — its nested compositor isolates the game from the overlay.</li>
          </UL>

          <H3 t={t}>STILL STUCK?</H3>
          <P t={t}>
            Join the Discord server (link in the SYSTEM tab) and post in the support channel.
            Include your OS, overlay version (shown in Settings), and a brief description
            of the issue.
          </P>
        </>
      );
    },
  },

  // ── EULA & Compliance ─────────────────────────────────────────────────────────
  {
    id: 'eula',
    title: 'EULA & Compliance',
    body: (variant) => {
      const t = tokens(variant);
      return (
        <>
          <P t={t}>
            Fallout Chat Mod is designed to comply with the Fallout 76 EULA, specifically
            Section 4(F) which prohibits game-memory reading, game-file modification,
            code injection, and network/port scanning.
          </P>
          <H3 t={t}>WHAT WE DO</H3>
          <UL t={t}>
            <li>Detect whether the <Code t={t}>Fallout76</Code> process is running (to show/hide the overlay window).</li>
            <li>Render a transparent window on top of the game using the OS window stack.</li>
            <li>Connect to the FCM backend over WebSocket (falloutchatmod.com, port 443).</li>
          </UL>
          <H3 t={t}>WHAT WE DO NOT DO</H3>
          <UL t={t}>
            <li>Read game memory or process memory (removed in v1.3.0).</li>
            <li>Modify any game file or asset.</li>
            <li>Inject code into the game process.</li>
            <li>Scan network connections or local ports.</li>
            <li>Use a Script Extender or any game mod loader.</li>
          </UL>
          <P t={t} >
            <em>Unofficial fan project — not affiliated with, endorsed, or sponsored
            by Bethesda Softworks or ZeniMax Media. Fallout is a registered trademark
            of ZeniMax Media, Inc.</em>
          </P>
        </>
      );
    },
  },
];

// ── Wiki component ────────────────────────────────────────────────────────────

interface WikiProps {
  variant?: WikiVariant;
}

export default function Wiki({ variant = 'dashboard' }: WikiProps) {
  const t = tokens(variant);
  const contentRef = useRef<HTMLDivElement>(null);

  function scrollTo(id: string) {
    const el = document.getElementById(`wiki-section-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  const containerStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    overflowY: 'auto',
    fontFamily: t.fontFam,
    color: t.gold,
    background: t.isPublic ? t.bg : undefined,
  };

  const innerStyle: React.CSSProperties = {
    maxWidth: '860px',
    margin: '0 auto',
    padding: t.isPublic ? '28px 36px 48px' : '20px 24px 48px',
  };

  return (
    <div style={containerStyle} ref={contentRef}>
      <div style={innerStyle}>

        {/* Header */}
        <div style={{ marginBottom: '28px' }}>
          <h1 style={{
            fontSize: t.isPublic ? '22px' : '18px',
            fontWeight: 'bold',
            letterSpacing: '4px',
            color: t.gold,
            textShadow: `0 0 10px rgba(200,168,64,0.4)`,
            marginBottom: '6px',
            marginTop: 0,
          }}>
            FALLOUT CHAT MOD — WIKI
          </h1>
          <p style={{ fontSize: '12px', color: t.muted, margin: 0, letterSpacing: '1px' }}>
            Reference documentation for players, community members, and staff.
          </p>
        </div>

        {/* Table of Contents */}
        <div style={{
          border: `1px solid ${t.border}`,
          background: t.isPublic ? 'rgba(200,168,64,0.04)' : 'rgba(212,176,64,0.04)',
          padding: '16px 20px',
          marginBottom: '36px',
        }}>
          <div style={{ fontSize: '11px', letterSpacing: '3px', color: t.muted, marginBottom: '12px' }}>
            CONTENTS
          </div>
          <ol style={{ margin: 0, padding: '0 0 0 18px', listStyle: 'decimal' }}>
            {WIKI_SECTIONS.map((s, i) => (
              <li key={s.id} style={{ marginBottom: '6px' }}>
                <button
                  type="button"
                  onClick={() => scrollTo(s.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: '0',
                    cursor: 'pointer',
                    fontFamily: t.fontFam,
                    fontSize: '14px',
                    color: t.gold,
                    textDecoration: 'underline',
                    textDecorationColor: `rgba(200,168,64,0.35)`,
                    letterSpacing: '0.5px',
                    textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.textDecorationColor = t.gold; }}
                  onMouseLeave={(e) => { e.currentTarget.style.textDecorationColor = 'rgba(200,168,64,0.35)'; }}
                >
                  {i + 1}. {s.title}
                </button>
              </li>
            ))}
          </ol>
        </div>

        {/* Sections */}
        {WIKI_SECTIONS.map((s, i) => (
          <div
            key={s.id}
            id={`wiki-section-${s.id}`}
            style={{
              marginBottom: '48px',
              paddingTop: '8px',
              borderTop: i === 0 ? 'none' : `1px solid ${t.border}`,
            }}
          >
            <h2 style={{
              fontSize: t.isPublic ? '17px' : '15px',
              fontWeight: 'bold',
              letterSpacing: '3px',
              color: t.gold,
              textShadow: `0 0 8px rgba(200,168,64,0.3)`,
              marginTop: i === 0 ? 0 : '12px',
              marginBottom: '16px',
            }}>
              ◈ {s.title.toUpperCase()}
            </h2>
            {s.body(variant)}
          </div>
        ))}

      </div>
    </div>
  );
}
