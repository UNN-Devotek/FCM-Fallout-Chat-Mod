/**
 * HelpContent — single source of truth for the command reference.
 *
 * Rendered by:
 *   - HelpPage (dashboard /help, uses dashboard CSS-var tokens)
 *   - PublicHelpPanel in LandingPage (landing-page HELP tab, uses inline gold palette)
 *
 * The `variant` prop switches the colour palette only — the command DATA and
 * structure are identical in both cases so they can never drift.
 */

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatCommand {
  id: number;
  trigger: string;
  description: string;
  response: string;
  actionType: string;
  targetChannelId: string | null;
  cooldownSec: number;
  enabled: boolean;
  requiresArgs: boolean;
}

// ── Canonical built-in commands ───────────────────────────────────────────────

interface BuiltIn {
  trigger: string;
  description: string;
  notes?: string;
}

const BUILTIN_COMMANDS: BuiltIn[] = [
  { trigger: '/help',          description: 'List all available commands',                                        notes: 'Always enabled — cannot be disabled' },
  // ── Channel commands ──────────────────────────────────────────────────────────
  { trigger: '/g',             description: 'Send a message to the General channel'                                                                           },
  { trigger: '/t',             description: 'Send a message to the Trading channel'                                                                           },
  { trigger: '/e',             description: 'Send a message to the Events channel'                                                                            },
  { trigger: '/raid',          description: 'Send a message to the Raids channel'                                                                             },
  { trigger: '/s',             description: 'Send a message to your server channel'                                                                           },
  // ── Party commands ────────────────────────────────────────────────────────────
  { trigger: '/recent',        description: 'Send a message to your most recent party'                                                                        },
  { trigger: '/r',             description: 'Send a message to your most recent party (short for /recent)'                                                    },
  { trigger: '/p1',            description: 'Send a message to your 1st joined party (Party-tab order, left to right)'                                        },
  { trigger: '/p2',            description: 'Send a message to your 2nd joined party (Party-tab order, left to right)'                                        },
  { trigger: '/p3',            description: 'Send a message to your 3rd joined party (Party-tab order, left to right)'                                        },
  // ── Utility commands ──────────────────────────────────────────────────────────
  { trigger: '/report bug',    description: 'Submit a bug report (title, description, steps, expected vs actual)'                                             },
  { trigger: '/report player', description: 'Submit a player report (player name, reason, description)'                                                       },
  { trigger: '/apply',         description: 'Open the staff application form'                                                                                 },
  // ── Fallout 76 lookups ────────────────────────────────────────────────────────
  { trigger: '/online',        description: 'Show total users online in chat'                                                                               },
  { trigger: '/serverstatus',  description: 'Show Fallout 76 server status (up/down)'                                                                          },
  { trigger: '/nukecodes',     description: "Show this week's nuke launch codes (Alpha/Bravo/Charlie)"                                                   },
  { trigger: '/wiki',          description: 'Search the Fallout 76 wiki — type a name (weapons, armor, items, creatures, locations, quests); pick a result with ↑↓ + Enter/Tab or click' },
];

// ── Prop types ────────────────────────────────────────────────────────────────

export type HelpVariant = 'dashboard' | 'public';

interface HelpContentProps {
  /** 'dashboard' uses CSS-var tokens; 'public' uses the landing-page gold palette. */
  variant?: HelpVariant;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function HelpContent({ variant = 'dashboard' }: HelpContentProps) {
  const { data: commands, isLoading, error: queryError } = useQuery({
    queryKey: ['commands'],
    queryFn: () => api.get<ChatCommand[]>('/api/commands'),
  });

  const relayCommands = (commands ?? []).filter(c => c.actionType === 'relay' && c.enabled);
  const msgCommands   = (commands ?? []).filter(c => c.actionType === 'message' && c.enabled);
  const error = queryError ? (queryError as Error).message : null;

  // ── Style tokens — switched by variant ─────────────────────────────────────
  const isPublic = variant === 'public';

  const gold    = isPublic ? '#C8A840'                      : undefined; // public uses literal; dashboard inherits
  const dim     = isPublic ? 'rgba(200,168,64,0.65)'        : 'var(--text-secondary)';
  const muted   = isPublic ? 'rgba(200,168,64,0.4)'         : 'var(--text-muted, #666)';
  const border  = isPublic ? 'rgba(200,168,64,0.18)'        : 'rgba(212,176,64,0.12)';
  const hdrBdr  = isPublic ? 'rgba(200,168,64,0.3)'         : 'rgba(212,176,64,0.25)';
  const codeBg  = isPublic ? 'rgba(200,168,64,0.12)'        : 'rgba(212,176,64,0.12)';
  const fontFam = isPublic ? 'Courier New, monospace'        : undefined;

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
    fontSize: isPublic ? '14px' : '12px',
    color: isPublic ? 'rgba(200,168,64,0.85)' : undefined,
  };

  const codeStyle: React.CSSProperties = {
    background: codeBg, padding: '1px 6px',
    fontFamily: isPublic ? 'Courier New, monospace' : 'monospace',
    fontSize: isPublic ? '13px' : '12px',
    color: isPublic ? gold : undefined,
    borderRadius: isPublic ? undefined : '3px',
  };

  const mutedTd: React.CSSProperties = { ...tdStyle, color: muted, fontStyle: 'italic' };

  return (
    <div style={containerStyle}>
      <h1 style={h1Style}>◈ {isPublic ? 'COMMAND REFERENCE' : 'HELP & COMMAND REFERENCE'}</h1>
      <p style={subtitleStyle}>
        {isPublic
          ? 'Slash commands available in the Fallout Chat Mod overlay. Type them in the chat input.'
          : 'Reference for all available slash commands in Fallout Chat Mod. Commands are typed in the chat input and processed server-side.'}
      </p>

      {error && (
        <div style={{ color: isPublic ? '#ff4444' : 'var(--error, #ff4444)', marginBottom: '16px', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {/* ── Built-in commands ────────────────────────────────────────────────── */}
      <h2 style={sectionTitle}>BUILT-IN COMMANDS</h2>
      <div className="table-responsive">
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: isPublic ? undefined : '12px' }}>
        <thead>
          <tr>
            <th style={thStyle}>TRIGGER</th>
            <th style={thStyle}>DESCRIPTION</th>
            {!isPublic && <th style={thStyle}>NOTES</th>}
          </tr>
        </thead>
        <tbody>
          {BUILTIN_COMMANDS.map(cmd => (
            <tr key={cmd.trigger}>
              <td style={tdStyle}><code style={codeStyle}>{cmd.trigger}</code></td>
              <td style={tdStyle}>{cmd.description}</td>
              {!isPublic && <td style={{ ...tdStyle, color: muted }}>{cmd.notes ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {/* ── Channel relay commands ───────────────────────────────────────────── */}
      <h2 style={sectionTitle}>CHANNEL RELAY COMMANDS</h2>
      <p style={{ fontSize: isPublic ? '13px' : '11px', color: muted, marginBottom: '12px' }}>
        Relay commands let users send a message to another channel without leaving their current view.
        Usage: <code style={codeStyle}>/trigger &lt;message&gt;</code>
      </p>
      {isLoading ? (
        <div style={{ color: dim, fontSize: '12px' }}>Loading...</div>
      ) : (
        <div className="table-responsive">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: isPublic ? undefined : '12px' }}>
          <thead>
            <tr>
              <th style={thStyle}>TRIGGER</th>
              <th style={thStyle}>DESCRIPTION</th>
              {!isPublic && <th style={thStyle}>TARGET CHANNEL</th>}
            </tr>
          </thead>
          <tbody>
            {relayCommands.length === 0 ? (
              <tr><td colSpan={isPublic ? 2 : 3} style={mutedTd}>No relay commands configured.</td></tr>
            ) : relayCommands.map(cmd => (
              <tr key={cmd.id}>
                <td style={tdStyle}><code style={codeStyle}>{cmd.trigger} &lt;message&gt;</code></td>
                <td style={tdStyle}>{cmd.description}</td>
                {!isPublic && (
                  <td style={{ ...tdStyle, color: dim, fontSize: '11px' }}>
                    {cmd.targetChannelId ?? 'same channel'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {/* ── Message commands ─────────────────────────────────────────────────── */}
      <h2 style={sectionTitle}>MESSAGE COMMANDS</h2>
      {!isLoading && (
        <div className="table-responsive">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: isPublic ? undefined : '12px' }}>
          <thead>
            <tr>
              <th style={thStyle}>TRIGGER</th>
              <th style={thStyle}>DESCRIPTION</th>
              {!isPublic && <th style={thStyle}>REQUIRES ARGS</th>}
              <th style={thStyle}>COOLDOWN</th>
            </tr>
          </thead>
          <tbody>
            {msgCommands.length === 0 ? (
              <tr><td colSpan={isPublic ? 3 : 4} style={mutedTd}>No message commands configured.</td></tr>
            ) : msgCommands.map(cmd => (
              <tr key={cmd.id}>
                <td style={tdStyle}><code style={codeStyle}>{cmd.trigger}{cmd.requiresArgs ? ' <args>' : ''}</code></td>
                <td style={tdStyle}>{cmd.description}</td>
                {!isPublic && <td style={tdStyle}>{cmd.requiresArgs ? 'Yes' : 'No'}</td>}
                <td style={{ ...tdStyle, color: isPublic ? muted : undefined }}>
                  {cmd.cooldownSec > 0 ? `${cmd.cooldownSec}s` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {/* ── Keybinds (public variant only) ───────────────────────────────────── */}
      {isPublic && (
        <>
          <h2 style={sectionTitle}>KEYBINDS</h2>
          <div className="table-responsive">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>KEY</th>
                <th style={thStyle}>ACTION</th>
              </tr>
            </thead>
            <tbody>
              {[
                // Global overlay hotkeys (default bindings — rebindable in Settings → Keybinds)
                { key: 'Insert',                    action: 'Open chat input' },
                { key: 'Ctrl+Shift+\\',             action: 'Show / hide overlay' },
                { key: 'Ctrl+Shift+,',              action: 'Open settings' },
                { key: 'Ctrl+Shift+]',              action: 'Next channel' },
                { key: 'Ctrl+Shift+[',              action: 'Previous channel' },
                { key: 'Ctrl+Shift+X',              action: 'Toggle click-through' },
                // Navigation — channels & parties
                { key: 'Page Up / Page Down',        action: 'Cycle through channels AND joined parties' },
                { key: 'Recent party keybind',       action: 'Jump to your most recent party (configurable in Settings → Keybinds)' },
                { key: 'Fallout 76 tab keybind',     action: 'Jump back to the Fallout 76 tab (default: /, configurable in Settings → Keybinds)' },
                { key: 'Party 1 / 2 / 3 keybind',   action: 'Jump to a specific joined party slot (blank by default — set in Settings → Keybinds)' },
                // In the chat input
                { key: 'Escape',                    action: 'Close chat input' },
                { key: 'Tab / ↑ / ↓',              action: 'Navigate command autocomplete' },
                { key: 'Enter',                     action: 'Send message / select autocomplete' },
              ].map(({ key, action }) => (
                <tr key={key}>
                  <td style={tdStyle}><code style={codeStyle}>{key}</code></td>
                  <td style={tdStyle}>{action}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px', lineHeight: 1.5 }}>
            The overlay hotkeys are <strong>default bindings</strong> and can be reassigned in
            {' '}<strong>Settings → Keybinds</strong>. On macOS, <code style={codeStyle}>Ctrl</code> is <code style={codeStyle}>⌘</code>.
          </p>
        </>
      )}

    </div>
  );
}
