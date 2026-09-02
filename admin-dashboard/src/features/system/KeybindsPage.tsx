/**
 * KeybindsPage — overlay keybind reference and file-edit guide.
 *
 * Rendered by:
 *   - Dashboard /keybinds route (CHAT tab, visible to all users)
 *   - PublicKeybindsPanel in LandingPage (public SYSTEM tab)
 *
 * The `variant` prop switches the colour palette only — the content is
 * identical in both cases so they can never drift.
 */

import React from 'react';
import HudKeybindGuide from './HudKeybindGuide';

// ── Types ─────────────────────────────────────────────────────────────────────

interface KeybindRow {
  action: string;
  default: string;
  description: string;
}

// ── Canonical keybind reference ───────────────────────────────────────────────

const KEYBIND_ROWS: KeybindRow[] = [
  { action: 'toggle',       default: 'Delete',   description: 'Show / hide the overlay'                              },
  { action: 'focus',        default: 'Insert',   description: 'Open the chat input and start typing'                 },
  { action: 'clickThrough', default: 'End',      description: 'Toggle click-through mode (overlay ignores clicks)'   },
  { action: 'nextChannel',  default: 'PageDown', description: 'Cycle to the next channel tab (overlay focused only)' },
  { action: 'prevChannel',  default: 'PageUp',   description: 'Cycle to the previous channel tab (overlay focused)'  },
  { action: 'settings',     default: 'Home',     description: 'Open the settings panel (overlay focused only)'       },
  { action: 'recentParty',  default: '(unbound)', description: 'Switch to your most recently active party tab'       },
  { action: 'goFo76',       default: '(unbound)', description: 'Jump to the Fallout 76 main channel tab'             },
  { action: 'party1',       default: '(unbound)', description: 'Switch to party slot 1'                             },
  { action: 'party2',       default: '(unbound)', description: 'Switch to party slot 2'                             },
  { action: 'party3',       default: '(unbound)', description: 'Switch to party slot 3'                             },
  { action: 'party4',       default: '(unbound)', description: 'Switch to party slot 4'                             },
  { action: 'party5',       default: '(unbound)', description: 'Switch to party slot 5'                             },
  { action: 'party6',       default: '(unbound)', description: 'Switch to party slot 6'                             },
  { action: 'party7',       default: '(unbound)', description: 'Switch to party slot 7'                             },
  { action: 'party8',       default: '(unbound)', description: 'Switch to party slot 8'                             },
];

const VALID_KEYS = [
  { group: 'Function',    keys: 'F1 – F24' },
  { group: 'Navigation',  keys: 'Insert, Delete, Home, End, PageUp, PageDown' },
  { group: 'Arrows',      keys: 'Left, Right, Up, Down' },
  { group: 'Editing',     keys: 'Tab, Backspace, Return, Space' },
  { group: 'Letters',     keys: 'A – Z (case-insensitive)' },
  { group: 'Numbers',     keys: '0 – 9' },
  { group: 'Symbols',     keys: '/ \\ [ ] ; \' , . ` - = and others' },
  { group: 'Modifiers',   keys: 'CommandOrControl, Alt, Shift (combine with +, e.g. Shift+F1)' },
  { group: 'Media',       keys: 'MediaPlayPause, MediaStop, MediaNextTrack, MediaPreviousTrack' },
  { group: 'Volume',      keys: 'VolumeUp, VolumeDown, VolumeMute' },
];

const SAMPLE_CFG = `# Fallout Chat Mod — Overlay Keybinds
# Edit this file to customise your hotkeys. Changes are picked up live.
#
# Key names (case-sensitive):
#   Function .... F1-F24
#   Navigation .. Insert  Delete  Home  End  PageUp  PageDown
#   Arrows ...... Left  Right  Up  Down
#   Editing ..... Tab  Backspace  Return  Space
#   Letters ..... A-Z   Numbers: 0-9
#   Symbols ..... / \\ [ ] ; ' , . \` - =
#   Modifiers ... CommandOrControl  Alt  Shift  (combine: Shift+F1, Alt+Delete)
#
# Leave a value blank to unbind that action entirely.
# Blocked (cannot bind): Escape  CapsLock  NumLock  ScrollLock  Pause

toggle=Delete
focus=Insert
clickThrough=End
nextChannel=PageDown
prevChannel=PageUp
settings=Home
recentParty=
goFo76=
party1=
party2=
party3=
party4=
party5=
party6=
party7=
party8=`;

// ── Prop types ─────────────────────────────────────────────────────────────────

export type KeybindsVariant = 'dashboard' | 'public';

interface KeybindsPageProps {
  variant?: KeybindsVariant;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function KeybindsPage({ variant = 'dashboard' }: KeybindsPageProps) {
  const isPublic = variant === 'public';

  const gold    = isPublic ? '#C8A840'                : undefined;
  const dim     = isPublic ? 'rgba(200,168,64,0.65)'  : 'var(--text-secondary)';
  const muted   = isPublic ? 'rgba(200,168,64,0.4)'   : 'var(--text-muted, #666)';
  const border  = isPublic ? 'rgba(200,168,64,0.18)'  : 'rgba(212,176,64,0.12)';
  const hdrBdr  = isPublic ? 'rgba(200,168,64,0.3)'   : 'rgba(212,176,64,0.25)';
  const codeBg  = isPublic ? 'rgba(200,168,64,0.08)'  : 'rgba(212,176,64,0.08)';
  const fontFam = isPublic ? 'Courier New, monospace'  : undefined;

  const containerStyle: React.CSSProperties = isPublic
    ? { flex: 1, padding: '24px 36px', overflowY: 'auto', fontFamily: fontFam, color: gold }
    : { width: '100%' };

  const h1Style: React.CSSProperties = isPublic
    ? { fontSize: '22px', fontWeight: 'bold', letterSpacing: '4px', marginBottom: '6px', textShadow: '0 0 10px rgba(200,168,64,0.4)' }
    : { fontSize: '18px', marginBottom: '4px' };

  const subtitleStyle: React.CSSProperties = isPublic
    ? { fontSize: '13px', color: muted, marginBottom: '24px' }
    : { fontSize: '11px', color: dim, marginBottom: '28px' };

  const sectionTitle: React.CSSProperties = isPublic
    ? { fontSize: '15px', color: dim, margin: '24px 0 10px', letterSpacing: '2px', fontWeight: 'bold' }
    : { fontSize: '13px', color: dim, marginTop: '28px', marginBottom: '12px', letterSpacing: '1px' };

  const thStyle: React.CSSProperties = {
    padding: '7px 12px', textAlign: 'left', color: dim,
    fontSize: isPublic ? '13px' : '11px',
    borderBottom: `1px solid ${hdrBdr}`, fontWeight: 'bold',
    letterSpacing: isPublic ? '1px' : undefined,
  };

  const tdStyle: React.CSSProperties = {
    padding: '7px 12px', borderBottom: `1px solid ${border}`,
    fontSize: isPublic ? '13px' : '12px',
    verticalAlign: 'top',
  };

  const codeStyle: React.CSSProperties = {
    background: codeBg,
    border: `1px solid ${border}`,
    borderRadius: '4px',
    padding: '2px 6px',
    fontFamily: 'Courier New, monospace',
    fontSize: isPublic ? '13px' : '12px',
  };

  const blockStyle: React.CSSProperties = {
    background: codeBg,
    border: `1px solid ${border}`,
    borderRadius: '6px',
    padding: '16px',
    fontFamily: 'Courier New, monospace',
    fontSize: '12px',
    overflowX: 'auto',
    whiteSpace: 'pre',
    lineHeight: '1.6',
    color: isPublic ? gold : undefined,
  };

  const calloutStyle: React.CSSProperties = {
    background: isPublic ? 'rgba(200,168,64,0.07)' : 'rgba(212,176,64,0.06)',
    border: `1px solid ${border}`,
    borderLeft: `3px solid ${isPublic ? '#C8A840' : 'rgba(212,176,64,0.5)'}`,
    borderRadius: '4px',
    padding: '10px 14px',
    fontSize: isPublic ? '13px' : '12px',
    color: isPublic ? gold : undefined,
    marginBottom: '8px',
  };

  return (
    <div style={containerStyle}>
      <HudKeybindGuide variant={variant} />

      <h1 style={h1Style}>OVERLAY KEYBINDS</h1>
      <p style={subtitleStyle}>
        All keybinds are stored in <code style={codeStyle}>keybinds.cfg</code> — a plain text file
        you can open in any text editor. The overlay reloads changes live — no restart needed.
      </p>

      {/* ── File location ─────────────────────────────────────────────────── */}
      <p style={sectionTitle}>FILE LOCATION</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '4px' }}>
        <div style={calloutStyle}>
          <strong>Windows</strong>
          <br />
          <code style={{ ...codeStyle, marginTop: '4px', display: 'inline-block' }}>
            %APPDATA%\Fallout Chat Mod\keybinds.cfg
          </code>
        </div>
        <div style={calloutStyle}>
          <strong>Linux</strong>
          <br />
          <code style={{ ...codeStyle, marginTop: '4px', display: 'inline-block' }}>
            ~/.config/Fallout Chat Mod/keybinds.cfg
          </code>
        </div>
      </div>
      <p style={{ fontSize: isPublic ? '12px' : '11px', color: muted, marginTop: '8px', marginBottom: '0' }}>
        On Windows, press <code style={codeStyle}>Win+R</code>, type <code style={codeStyle}>%APPDATA%\Fallout Chat Mod</code> and press Enter, then open <code style={codeStyle}>keybinds.cfg</code> in Notepad.
        On Linux, run <code style={codeStyle}>nano ~/.config/Fallout\ Chat\ Mod/keybinds.cfg</code> in a terminal.
      </p>

      {/* ── How to edit ───────────────────────────────────────────────────── */}
      <p style={sectionTitle}>HOW TO EDIT</p>
      <ol style={{ fontSize: isPublic ? '13px' : '12px', lineHeight: '1.8', paddingLeft: '20px', margin: 0 }}>
        <li>Open <code style={codeStyle}>keybinds.cfg</code> in any text editor (Notepad, VS Code, nano, etc.).</li>
        <li>Find the action you want to change — each line is <code style={codeStyle}>action=KeyName</code>.</li>
        <li>Replace the key name with the one you want (see the valid key names below).</li>
        <li>Leave the value empty (<code style={codeStyle}>action=</code>) to unbind that action entirely.</li>
        <li>Save the file. The overlay picks up the change automatically — no restart needed.</li>
      </ol>
      <p style={{ fontSize: isPublic ? '12px' : '11px', color: muted, marginTop: '8px' }}>
        Lines starting with <code style={codeStyle}>#</code> are comments and are ignored. Bad or unknown
        action names are also safely skipped.
      </p>

      {/* ── Sample keybinds block ─────────────────────────────────────────── */}
      <p style={sectionTitle}>SAMPLE — DEFAULT keybinds.cfg</p>
      <div style={blockStyle}>{SAMPLE_CFG}</div>

      {/* ── Keybind reference table ───────────────────────────────────────── */}
      <p style={sectionTitle}>KEYBIND REFERENCE</p>
      <div className="table-responsive">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: isPublic ? '13px' : '12px' }}>
        <thead>
          <tr>
            <th style={thStyle}>Action (JSON key)</th>
            <th style={thStyle}>Default</th>
            <th style={thStyle}>Description</th>
          </tr>
        </thead>
        <tbody>
          {KEYBIND_ROWS.map(row => (
            <tr key={row.action}>
              <td style={tdStyle}><code style={codeStyle}>{row.action}</code></td>
              <td style={tdStyle}>
                {row.default === '(unbound)'
                  ? <span style={{ color: muted }}>{row.default}</span>
                  : <code style={codeStyle}>{row.default}</code>
                }
              </td>
              <td style={{ ...tdStyle, color: isPublic ? gold : undefined }}>{row.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {/* ── Valid key names ───────────────────────────────────────────────── */}
      <p style={sectionTitle}>VALID KEY NAMES</p>
      <p style={{ fontSize: isPublic ? '12px' : '11px', color: muted, marginBottom: '10px' }}>
        Key names are case-sensitive. Use the exact names listed here.
        Combine with modifiers using <code style={codeStyle}>+</code>, e.g. <code style={codeStyle}>Shift+F1</code> or <code style={codeStyle}>CommandOrControl+Delete</code>.
      </p>
      <div className="table-responsive">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: isPublic ? '13px' : '12px' }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, width: '160px' }}>Category</th>
            <th style={thStyle}>Valid names</th>
          </tr>
        </thead>
        <tbody>
          {VALID_KEYS.map(row => (
            <tr key={row.group}>
              <td style={{ ...tdStyle, color: dim, fontWeight: 'bold' }}>{row.group}</td>
              <td style={tdStyle}><code style={{ ...codeStyle, background: 'none', border: 'none', padding: 0 }}>{row.keys}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p style={{ fontSize: isPublic ? '12px' : '11px', color: muted, marginTop: '10px' }}>
        The following keys <strong>cannot</strong> be used as keybinds: Escape, CapsLock, NumLock,
        ScrollLock, Pause, ContextMenu, and any modifier key alone (Control, Shift, Alt).
      </p>
    </div>
  );
}
