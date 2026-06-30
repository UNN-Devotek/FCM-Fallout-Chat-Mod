/**
 * PublicCommandsKeybindsPage — public-facing reference for all chat commands
 * and overlay keybinds. Rendered under SYSTEM → KEYBINDS on the landing page.
 *
 * Commands are hard-coded to match the built-ins in commandService.ts plus the
 * channel-shortcut set. Keybind table mirrors KeybindsPage.tsx (single source
 * of truth for the dashboard route; this page is public-only so duplication is
 * intentional — they serve different audiences and layouts).
 */

import React from 'react';

// ── Palette ───────────────────────────────────────────────────────────────────

const GOLD   = '#C8A840';
const DIM    = 'rgba(200,168,64,0.65)';
const MUTED  = 'rgba(200,168,64,0.4)';
const BORDER = 'rgba(200,168,64,0.18)';
const HDR    = 'rgba(200,168,64,0.3)';
const CODE_BG = 'rgba(200,168,64,0.08)';
const FONT   = 'Courier New, monospace';

// ── Shared style helpers ──────────────────────────────────────────────────────

const sCode: React.CSSProperties = {
  background: CODE_BG, border: `1px solid ${BORDER}`,
  borderRadius: '4px', padding: '2px 6px',
  fontFamily: FONT, fontSize: '13px', color: GOLD,
};

const sTh: React.CSSProperties = {
  padding: '7px 12px', textAlign: 'left', color: DIM,
  fontSize: '13px', borderBottom: `1px solid ${HDR}`,
  fontWeight: 'bold', letterSpacing: '1px',
};

const sTd: React.CSSProperties = {
  padding: '7px 12px', borderBottom: `1px solid ${BORDER}`,
  fontSize: '13px', verticalAlign: 'top', color: GOLD,
};

const sSection: React.CSSProperties = {
  fontSize: '15px', color: DIM,
  margin: '28px 0 10px', letterSpacing: '2px', fontWeight: 'bold',
};

const sDivider: React.CSSProperties = {
  fontSize: '11px', color: MUTED, letterSpacing: '2px',
  margin: '20px 0 8px', paddingBottom: '4px',
  borderBottom: `1px solid ${BORDER}`,
};

// ── Chat commands data ────────────────────────────────────────────────────────

interface CmdRow {
  trigger: string;
  args?: string;
  description: string;
  note?: string;
}

const CHANNEL_CMDS: CmdRow[] = [
  { trigger: '/g', args: '<message>', description: 'Send to General' },
  { trigger: '/t', args: '<message>', description: 'Send to Trading' },
  { trigger: '/e', args: '<message>', description: 'Send to Events' },
  { trigger: '/r', args: '<message>', description: 'Send to Raids' },
  { trigger: '/i', args: '<message>', description: 'Send to Infests' },
];

const FO76_CMDS: CmdRow[] = [
  { trigger: '/online', description: 'Show total users online in chat' },
  { trigger: '/serverstatus', description: 'Show Fallout 76 server status (up / down)' },
  { trigger: '/nukecodes', args: '', description: 'Show this week\'s nuke launch codes (Alpha / Bravo / Charlie)', note: 'alias: /codes' },
  { trigger: '/wiki', args: '<name>', description: 'Look up a Fallout 76 item, weapon, creature, perk, or location' },
  { trigger: '/camp', args: '<item name>', description: 'Look up a CAMP item — budget cost, required plan, category' },
];

const UTILITY_CMDS: CmdRow[] = [
  { trigger: '/help', description: 'List all available commands in a private reply' },
  { trigger: '/report bug', args: '<description>', description: 'Report a bug to the dev team' },
  { trigger: '/report player', args: '<name + reason>', description: 'Report a player to moderators' },
  { trigger: '/apply', description: 'Open the staff application form' },
];

// ── Keybind data ──────────────────────────────────────────────────────────────

interface KbRow { action: string; default: string; description: string; }

const KEYBIND_ROWS: KbRow[] = [
  { action: 'toggle',       default: 'Delete',    description: 'Show / hide the overlay' },
  { action: 'focus',        default: 'Insert',    description: 'Open the chat input and start typing' },
  { action: 'clickThrough', default: 'End',       description: 'Toggle click-through mode (overlay ignores all clicks)' },
  { action: 'nextChannel',  default: 'PageDown',  description: 'Cycle to the next channel tab (overlay focused only)' },
  { action: 'prevChannel',  default: 'PageUp',    description: 'Cycle to the previous channel tab (overlay focused)' },
  { action: 'settings',     default: 'Home',      description: 'Open the settings panel (overlay focused only)' },
  { action: 'recentParty',  default: '(unbound)', description: 'Switch to your most recently active party tab' },
  { action: 'goFo76',       default: '(unbound)', description: 'Jump to the Fallout 76 main channel tab' },
  { action: 'party1–8',     default: '(unbound)', description: 'Switch directly to party slots 1 through 8' },
];

// ── Sub-component: command table ──────────────────────────────────────────────

function CmdTable({ rows }: { rows: CmdRow[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '4px' }}>
      <thead>
        <tr>
          <th style={{ ...sTh, width: '220px' }}>Command</th>
          <th style={sTh}>Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.trigger + (row.args ?? '')}>
            <td style={sTd}>
              <code style={sCode}>{row.trigger}{row.args ? ' ' + row.args : ''}</code>
              {row.note && <div style={{ fontSize: '11px', color: MUTED, marginTop: '2px' }}>{row.note}</div>}
            </td>
            <td style={{ ...sTd, color: GOLD }}>{row.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PublicCommandsKeybindsPage() {
  return (
    <div style={{
      flex: 1, padding: '24px 36px', overflowY: 'auto',
      fontFamily: FONT, color: GOLD,
    }}>

      {/* ── COMMANDS ───────────────────────────────────────────────────────── */}

      <h1 style={{ fontSize: '22px', fontWeight: 'bold', letterSpacing: '4px', marginBottom: '6px', textShadow: '0 0 10px rgba(200,168,64,0.4)' }}>
        CHAT COMMANDS
      </h1>
      <p style={{ fontSize: '13px', color: MUTED, marginBottom: '24px' }}>
        Type any command into the chat input. Responses marked <em>private</em> are only visible to you — they never appear in the feed.
      </p>

      <p style={sSection}>CHANNEL SHORTCUTS</p>
      <p style={{ fontSize: '12px', color: MUTED, marginBottom: '10px' }}>
        Route a message to any channel without clicking the tab first.
        Everything after the command is sent as the message.
      </p>
      <CmdTable rows={CHANNEL_CMDS} />

      <p style={sSection}>FALLOUT 76 TOOLS</p>
      <p style={{ fontSize: '12px', color: MUTED, marginBottom: '10px' }}>
        Live data pulled directly from Bethesda's status endpoints and the Fallout Wiki / CAMP Database.
        Responses are private — only you see the result.
      </p>
      <CmdTable rows={FO76_CMDS} />

      <p style={sSection}>UTILITY</p>
      <CmdTable rows={UTILITY_CMDS} />

      <p style={{ fontSize: '12px', color: MUTED, marginTop: '10px', marginBottom: '0' }}>
        Custom commands (created by moderators) also appear in <code style={sCode}>/help</code>.
        Their triggers vary — use <code style={sCode}>/help</code> in the overlay for the full live list.
      </p>

      {/* ── KEYBINDS ───────────────────────────────────────────────────────── */}

      <h1 style={{ fontSize: '22px', fontWeight: 'bold', letterSpacing: '4px', marginTop: '40px', marginBottom: '6px', textShadow: '0 0 10px rgba(200,168,64,0.4)' }}>
        OVERLAY KEYBINDS
      </h1>
      <p style={{ fontSize: '13px', color: MUTED, marginBottom: '24px' }}>
        All keybinds are stored in <code style={sCode}>keybinds.cfg</code>.
        Edit it in any text editor — the overlay reloads changes live, no restart needed.
      </p>

      <p style={sSection}>FILE LOCATION</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
        {[
          { os: 'Windows', path: '%APPDATA%\\Fallout Chat Mod\\keybinds.cfg' },
          { os: 'Linux',   path: '~/.config/Fallout Chat Mod/keybinds.cfg' },
        ].map(({ os, path }) => (
          <div key={os} style={{
            background: 'rgba(200,168,64,0.07)', border: `1px solid ${BORDER}`,
            borderLeft: `3px solid ${GOLD}`, borderRadius: '4px', padding: '10px 14px',
          }}>
            <strong>{os}</strong>
            <br />
            <code style={{ ...sCode, marginTop: '4px', display: 'inline-block' }}>{path}</code>
          </div>
        ))}
      </div>

      <p style={sSection}>DEFAULT KEYBINDS</p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...sTh, width: '160px' }}>Action (cfg key)</th>
            <th style={{ ...sTh, width: '130px' }}>Default</th>
            <th style={sTh}>Description</th>
          </tr>
        </thead>
        <tbody>
          {KEYBIND_ROWS.map(row => (
            <tr key={row.action}>
              <td style={sTd}><code style={sCode}>{row.action}</code></td>
              <td style={sTd}>
                {row.default === '(unbound)'
                  ? <span style={{ color: MUTED }}>{row.default}</span>
                  : <code style={sCode}>{row.default}</code>
                }
              </td>
              <td style={{ ...sTd, color: GOLD }}>{row.description}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={sDivider}>HOW TO CHANGE A KEYBIND</p>
      <ol style={{ fontSize: '13px', lineHeight: '1.8', paddingLeft: '20px', margin: '0 0 16px' }}>
        <li>Open <code style={sCode}>keybinds.cfg</code> in any text editor.</li>
        <li>Find the action — each line is <code style={sCode}>action=KeyName</code>.</li>
        <li>Replace the key name. Leave it empty (<code style={sCode}>action=</code>) to unbind.</li>
        <li>Save. Changes are picked up immediately — no restart needed.</li>
      </ol>

      <p style={sDivider}>VALID KEY NAMES</p>
      <p style={{ fontSize: '12px', color: MUTED, marginBottom: '8px' }}>
        Combine with modifiers using <code style={sCode}>+</code>, e.g. <code style={sCode}>Shift+F1</code> or <code style={sCode}>Alt+Delete</code>.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '4px' }}>
        <thead>
          <tr>
            <th style={{ ...sTh, width: '160px' }}>Category</th>
            <th style={sTh}>Valid names</th>
          </tr>
        </thead>
        <tbody>
          {[
            { g: 'Function',   k: 'F1 – F24' },
            { g: 'Navigation', k: 'Insert, Delete, Home, End, PageUp, PageDown' },
            { g: 'Arrows',     k: 'Left, Right, Up, Down' },
            { g: 'Editing',    k: 'Tab, Backspace, Return, Space' },
            { g: 'Letters',    k: 'A – Z (case-insensitive)' },
            { g: 'Numbers',    k: '0 – 9' },
            { g: 'Symbols',    k: "/ \\ [ ] ; ' , . ` - = and others" },
            { g: 'Modifiers',  k: 'CommandOrControl, Alt, Shift' },
            { g: 'Media',      k: 'MediaPlayPause, MediaStop, MediaNextTrack, MediaPreviousTrack' },
            { g: 'Volume',     k: 'VolumeUp, VolumeDown, VolumeMute' },
          ].map(({ g, k }) => (
            <tr key={g}>
              <td style={{ ...sTd, color: DIM, fontWeight: 'bold' }}>{g}</td>
              <td style={sTd}><code style={{ ...sCode, background: 'none', border: 'none', padding: 0 }}>{k}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: '12px', color: MUTED, marginTop: '10px' }}>
        Cannot bind: Escape, CapsLock, NumLock, ScrollLock, Pause, ContextMenu, or any modifier key alone.
      </p>

    </div>
  );
}
