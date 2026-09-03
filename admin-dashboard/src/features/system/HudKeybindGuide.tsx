/**
 * Shared quick-start guide for the optional in-game HUD widget.
 *
 * This is rendered by both the dashboard and public website keybind pages so
 * the native HUD controls and HUDModLoader menu instructions cannot drift.
 */

import React from 'react';

export type HudKeybindGuideVariant = 'dashboard' | 'public';

export interface HudKeybindRow {
  key: string;
  config: string;
  description: string;
}

export const HUD_KEYBIND_ROWS: HudKeybindRow[] = [
  {
    key: 'Insert',
    config: 'openKey=INSERT + OpenChatKey=INSERT',
    description: 'Open the HUD chat input and start typing. These two settings must match.',
  },
  { key: 'Enter', config: 'native game input', description: 'Send the message.' },
  { key: 'Escape', config: 'native game input', description: 'Cancel typing and close the input.' },
  { key: 'Arrow Up / Down', config: 'Insert-open session', description: 'Scroll the HUD feed up or down. Ignored until Insert opens a typing session.' },
  { key: 'Home / End', config: 'Insert-open session', description: 'Jump to the newest HUD messages. Ignored until Insert opens a typing session.' },
  { key: 'Page Down', config: 'channelNextKey=NextPage', description: 'Switch to the next channel.' },
  { key: 'Page Up', config: 'channelPrevKey=PrevPage', description: 'Switch to the previous channel.' },
  { key: '/hide', config: 'slash command', description: 'Hide the HUD feed. Press Insert to restore it.' },
  { key: 'F11', config: 'HUDModLoader menu', description: 'Open or close the HUDModLoader menu.' },
];

export const HUD_CHANNEL_COMMANDS = ['/g', '/t', '/e', '/i', '/r', '/s'] as const;

interface HudKeybindGuideProps {
  variant?: HudKeybindGuideVariant;
}

export default function HudKeybindGuide({ variant = 'dashboard' }: HudKeybindGuideProps) {
  const isPublic = variant === 'public';
  const gold = isPublic ? '#C8A840' : undefined;
  const dim = isPublic ? 'rgba(200,168,64,0.65)' : 'var(--text-secondary)';
  const muted = isPublic ? 'rgba(200,168,64,0.4)' : 'var(--text-muted, #666)';
  const border = isPublic ? 'rgba(200,168,64,0.18)' : 'rgba(212,176,64,0.12)';
  const headerBorder = isPublic ? 'rgba(200,168,64,0.3)' : 'rgba(212,176,64,0.25)';
  const codeBackground = isPublic ? 'rgba(200,168,64,0.08)' : 'rgba(212,176,64,0.08)';
  const codeStyle: React.CSSProperties = {
    background: codeBackground,
    border: `1px solid ${border}`,
    borderRadius: '4px',
    padding: '2px 6px',
    fontFamily: 'Courier New, monospace',
    fontSize: isPublic ? '13px' : '12px',
  };
  const sectionStyle: React.CSSProperties = isPublic
    ? { fontSize: '15px', color: dim, margin: '24px 0 10px', letterSpacing: '2px', fontWeight: 'bold' }
    : { fontSize: '13px', color: dim, marginTop: '28px', marginBottom: '12px', letterSpacing: '1px' };
  const cellStyle: React.CSSProperties = {
    padding: '7px 12px',
    borderBottom: `1px solid ${border}`,
    fontSize: isPublic ? '13px' : '12px',
    verticalAlign: 'top',
  };

  return (
    <section data-testid="hud-keybind-guide">
      <h1 style={isPublic
        ? { fontSize: '22px', fontWeight: 'bold', letterSpacing: '4px', marginBottom: '6px', textShadow: '0 0 10px rgba(200,168,64,0.4)' }
        : { fontSize: '18px', marginBottom: '4px' }}>
        IN-GAME HUD MOD
      </h1>
      <p style={{ fontSize: isPublic ? '13px' : '11px', color: muted, marginBottom: '12px' }}>
        This is the separate, optional Fallout 76 HUD-mod track. It is not an Electron overlay
        keybind and requires ZFE or xScal plus HUDModLoader (or the documented standalone HUDMenu path).
      </p>

      <div style={{
        background: isPublic ? 'rgba(200,168,64,0.07)' : 'rgba(212,176,64,0.06)',
        border: `1px solid ${border}`,
        borderLeft: `3px solid ${isPublic ? '#C8A840' : 'rgba(212,176,64,0.5)'}`,
        borderRadius: '4px',
        padding: '10px 14px',
        fontSize: isPublic ? '13px' : '12px',
        color: gold,
      }}>
        <strong>Start typing:</strong> while Fallout 76 is focused, press <code style={codeStyle}>Insert</code>.
        The HUD input opens and you can type immediately; press <code style={codeStyle}>Enter</code> to send
        or <code style={codeStyle}>Escape</code> to cancel.
      </div>

      <p style={sectionStyle}>HUD INPUT AND CHANNEL CONTROLS</p>
      <div className="table-responsive">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: isPublic ? '13px' : '12px' }}>
          <thead>
            <tr>
              <th style={{ ...cellStyle, color: dim, borderBottom: `1px solid ${headerBorder}`, textAlign: 'left', fontWeight: 'bold' }}>Control</th>
              <th style={{ ...cellStyle, color: dim, borderBottom: `1px solid ${headerBorder}`, textAlign: 'left', fontWeight: 'bold' }}>Config / source</th>
              <th style={{ ...cellStyle, color: dim, borderBottom: `1px solid ${headerBorder}`, textAlign: 'left', fontWeight: 'bold' }}>Behavior</th>
            </tr>
          </thead>
          <tbody>
            {HUD_KEYBIND_ROWS.map(row => (
              <tr key={row.key}>
                <td style={cellStyle}><code style={codeStyle}>{row.key}</code></td>
                <td style={cellStyle}><code style={codeStyle}>{row.config}</code></td>
                <td style={{ ...cellStyle, color: gold }}>{row.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={sectionStyle}>HUD CHAT COMMANDS</p>
      <p style={{ fontSize: isPublic ? '12px' : '11px', color: muted, margin: '0 0 8px' }}>
        After pressing <code style={codeStyle}>Insert</code>, type one of these at the start of a
        message to switch its destination: {HUD_CHANNEL_COMMANDS.map((command, index) => (
          <React.Fragment key={command}>
            {index > 0 ? ', ' : ''}<code style={codeStyle}>{command}</code>
          </React.Fragment>
        ))}. Add the message after the command, for example <code style={codeStyle}>/t looking for plans</code>.
        <code style={codeStyle}>/s</code> (or <code style={codeStyle}>/server</code>) is available after
        the relay confirms the current server/world session. Type <code style={codeStyle}>/hide</code>
        by itself to hide the feed.
      </p>

      <p style={sectionStyle}>HUDMODLOADER MENU</p>
      <ol style={{ fontSize: isPublic ? '12px' : '11px', lineHeight: '1.7', paddingLeft: '20px', margin: 0, color: gold }}>
        <li>Start Fallout 76 with ZFE or xScal and HUDModLoader enabled.</li>
        <li>Press <code style={codeStyle}>F11</code> to open the HUDModLoader menu.</li>
        <li>Choose <code style={codeStyle}>FCM</code> → <code style={codeStyle}>Customize...</code> to resize, move, change opacity/theme, or reset settings.</li>
        <li>After pressing <code style={codeStyle}>Insert</code>, use <code style={codeStyle}>Arrow Up</code> / <code style={codeStyle}>Arrow Down</code> to review history and <code style={codeStyle}>Home</code> / <code style={codeStyle}>End</code> to return to the newest message; channel entries are also available in this menu.</li>
        <li>Select <code style={codeStyle}>FCM</code> → <code style={codeStyle}>Customize...</code> → <code style={codeStyle}>Reset all settings</code> only when you want the packaged defaults restored.</li>
      </ol>
      <p style={{ fontSize: isPublic ? '12px' : '11px', color: muted, marginTop: '8px', marginBottom: '0' }}>
        If Insert does not open chat, verify that <code style={codeStyle}>openKey</code> in
        <code style={codeStyle}>Data/FCMChat.ini</code> matches <code style={codeStyle}>OpenChatKey</code> in
        <code style={codeStyle}>Data/ZFE/TextChat/fragments/FCMChatWidget.ini</code>. If
        <code style={codeStyle}>Data/configuration/zfe.ini</code> has a <code style={codeStyle}>[TextChat]</code>
        <code style={codeStyle}>OpenChatKey</code> override, that value must match too. The known
        fallback is <code style={codeStyle}>PAGE_DOWN</code> / <code style={codeStyle}>Page Down</code>.
        Use the loader reload control for live widget changes; replacing the BA2 or ZFE fragment
        requires exiting and restarting Fallout 76 so native configuration is reloaded.
      </p>
    </section>
  );
}
