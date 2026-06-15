/**
 * AutocompleteStill — 480×530 still showing the wiki autocomplete dropdown
 * open with "/wiki the fix" typed (three real wiki_entries results).
 */

import React from 'react';
import { AbsoluteFill, staticFile } from 'remotion';
import { OverlayWindow } from './OverlayWindow';
import { AC_QUERY, AC_SUGGESTIONS, SAMPLE_MESSAGES, CHANNEL_COLORS } from './content';
import {
  PRIMARY,
  SECONDARY,
  TEXT,
  BG,
  CHROME,
  FONT_FAMILY,
  DISPLAY_FONT_FAMILY,
  FONT_SIZE,
  rgba,
} from './theme';

const TAG_COLORS = CHANNEL_COLORS;

// ── Kind glyph fallback ───────────────────────────────────────────────────────

function KindGlyph({ kind, color }: { kind: string; color: string }) {
  const glyphs: Record<string, string> = {
    weapon: '⚔', location: '⚑', creature: '☣', item: '◆', npc: '☻',
    plan: '📋', armor: '🛡', ammo: '⚙',
  };
  return (
    <span style={{ fontSize: 16, lineHeight: 1, color, display: 'block', textAlign: 'center' }}>
      {glyphs[kind] ?? '◈'}
    </span>
  );
}

function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    weapon: 'WEAPON', location: 'LOCATION', creature: 'CREATURE',
    item: 'ITEM', npc: 'NPC', plan: 'PLAN', armor: 'ARMOR', ammo: 'AMMO',
  };
  return labels[kind] ?? kind.toUpperCase();
}

// ── Thumbnail cell ────────────────────────────────────────────────────────────

function Thumb({ asset, kind }: { asset: string | null; kind: string }) {
  const container: React.CSSProperties = {
    width: 44, height: 36, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
  if (!asset) {
    return (
      <div style={container}>
        <KindGlyph kind={kind} color={rgba(PRIMARY, 0.7)} />
      </div>
    );
  }
  return (
    <div style={container}>
      <img
        src={staticFile(asset)}
        alt=""
        style={{ maxWidth: 44, maxHeight: 36, objectFit: 'contain', display: 'block' }}
      />
    </div>
  );
}

// ── Main composition ──────────────────────────────────────────────────────────

export function AutocompleteStill() {
  const W = 1920;
  const H = 1080;

  const WIN_W = 480;
  const WIN_H = 460;

  const primaryColor  = PRIMARY;
  const borderBright  = rgba(PRIMARY, 0.35);
  const headerColor   = rgba(PRIMARY, 0.85);
  const menuBg        = rgba(BG, 0.97);
  const chromeBg      = rgba(CHROME, 0.98);

  return (
    <AbsoluteFill style={{
      fontFamily: FONT_FAMILY,
      backgroundColor: '#070605',
      backgroundImage: 'radial-gradient(ellipse 75% 70% at 50% 55%, #1a150a 0%, #07060500 100%)',
    }}>
      {/* Callout + card — centered as a column */}
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {/* Callout above card */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
          marginBottom: 18,
        }}>
          <div style={{
            fontFamily: DISPLAY_FONT_FAMILY, fontSize: 18, fontWeight: 'bold',
            color: PRIMARY, letterSpacing: '0.05em',
            textShadow: `0 0 18px ${rgba(PRIMARY, 0.55)}, 0 0 5px ${rgba(PRIMARY, 0.4)}`,
            lineHeight: 1.2, textAlign: 'center',
          }}>Full Fallout 76 Wiki Search, In Overlay</div>
          <div style={{
            fontSize: 9, color: rgba(SECONDARY, 0.65), letterSpacing: '0.1em',
            textTransform: 'uppercase', fontFamily: DISPLAY_FONT_FAMILY, textAlign: 'center',
          }}>Type /wiki &lt;anything&gt; or /camp &lt;item&gt; — results appear instantly</div>
          <div style={{
            width: 200, height: 1,
            background: `linear-gradient(to right, transparent, ${rgba(PRIMARY, 0.45)}, transparent)`,
            marginTop: 2,
          }} />
        </div>

        {/* Overlay window */}
        <div style={{
          width: WIN_W,
          height: WIN_H,
          flexShrink: 0,
          boxShadow: `0 0 0 1px ${rgba(PRIMARY, 0.25)}, 0 0 40px ${rgba(PRIMARY, 0.08)}, 0 20px 60px rgba(0,0,0,0.7)`,
        }}>
        <OverlayWindow width={WIN_W} height={WIN_H} activeMain="fo76" activeSub="general">
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>

            {/* Faded chat feed */}
            <div style={{ flex: 1, padding: '8px 12px 4px', opacity: 0.3, overflow: 'hidden' }}>
              {SAMPLE_MESSAGES.slice(0, 5).map((m) => {
                const c = TAG_COLORS[m.tag] ?? PRIMARY;
                return (
                  <div key={m.id} style={{
                    fontSize: 11, lineHeight: '18px',
                    display: 'flex', alignItems: 'baseline',
                    gap: 4, padding: '1px 8px',
                  }}>
                    <span style={{ color: rgba(c, 0.9), fontWeight: 'normal', borderRadius: 2, padding: '0 1px', flexShrink: 0 }}>
                      [{m.tag}]
                    </span>
                    <span style={{ fontWeight: 'bold', color: rgba(PRIMARY, 0.9), flexShrink: 0 }}>
                      {m.user}:{' '}
                    </span>
                    <span style={{ fontWeight: 600, color: rgba(TEXT, 0.85) }}>{m.text}</span>
                  </div>
                );
              })}
            </div>

            {/* Input + autocomplete dropdown */}
            <div style={{ position: 'relative', flexShrink: 0 }}>

              {/* Autocomplete dropdown (above input) */}
              <div style={{
                position: 'absolute', bottom: '100%', left: 0, right: 0, zIndex: 101,
                background: menuBg, border: `1px solid ${borderBright}`, borderBottom: 'none',
                fontFamily: FONT_FAMILY,
              }}>
                {/* "Search as you type" header */}
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 10px',
                  borderBottom: `1px solid ${rgba(PRIMARY, 0.1)}`,
                  background: rgba(PRIMARY, 0.06),
                }}>
                  <span style={{
                    fontSize: 10, fontWeight: 'bold', letterSpacing: '0.08em',
                    color: headerColor, fontFamily: DISPLAY_FONT_FAMILY,
                  }}>
                    /WIKI — Wiki Search
                  </span>
                  <span style={{
                    fontSize: 9, letterSpacing: '0.04em',
                    color: rgba(SECONDARY, 0.65),
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontFamily: DISPLAY_FONT_FAMILY,
                  }}>
                    <span style={{
                      width: 4, height: 4, borderRadius: '50%',
                      background: PRIMARY, boxShadow: `0 0 4px ${rgba(PRIMARY, 0.7)}`,
                      display: 'inline-block',
                    }} />
                    Search as you type
                  </span>
                </div>

                {/* Result rows */}
                {AC_SUGGESTIONS.map((item, idx) => {
                  const isActive = idx === 0;
                  return (
                    <div key={item.name} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '4px 10px 4px 8px', height: 44,
                      background: isActive ? rgba(PRIMARY, 0.10) : 'transparent',
                      borderLeft: isActive ? `2px solid ${primaryColor}` : '2px solid transparent',
                      boxSizing: 'border-box',
                    }}>
                      <Thumb asset={item.thumbAsset} kind={item.kind} />
                      <span style={{
                        flex: 1, minWidth: 0, fontSize: 13,
                        color: isActive ? TEXT : rgba(TEXT, 0.65),
                        fontWeight: isActive ? 'bold' : 'normal',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {item.name}
                      </span>
                      <span style={{
                        flexShrink: 0, fontSize: 9, letterSpacing: '0.06em', padding: '2px 5px',
                        border: `1px solid ${isActive ? primaryColor : rgba(SECONDARY, 0.4)}`,
                        color: isActive ? primaryColor : rgba(SECONDARY, 0.55),
                      }}>
                        {kindLabel(item.kind)}
                      </span>
                    </div>
                  );
                })}

                {/* Key hint footer */}
                <div style={{
                  padding: '5px 12px', fontSize: 10, letterSpacing: '0.03em',
                  color: rgba(SECONDARY, 0.5),
                  borderTop: `1px solid ${rgba(PRIMARY, 0.08)}`,
                  background: chromeBg,
                }}>
                  ↑↓ select · Enter / Tab open · or click a result
                </div>
              </div>

              {/* Input bar */}
              <div style={{
                borderTop: `1px solid ${rgba(PRIMARY, 0.45)}`,
                padding: '0 10px',
                height: 32,
                display: 'flex',
                alignItems: 'center',
                background: rgba(CHROME, 0.6),
                flexShrink: 0,
                gap: 6,
              }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: rgba(PRIMARY, 0.7), letterSpacing: '0.04em' }}>&gt;</span>
                <span style={{ flex: 1, fontFamily: FONT_FAMILY, fontSize: 11, color: TEXT }}>{AC_QUERY}</span>
                <span style={{ display: 'inline-block', width: 1, height: 13, background: rgba(PRIMARY, 0.85) }} />
                <span style={{ fontFamily: 'monospace', fontSize: 9, color: rgba(PRIMARY, 0.4), letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 10 }}>☢</span>
                  <span>{AC_QUERY.length}/255</span>
                </span>
              </div>
            </div>
          </div>
        </OverlayWindow>
        </div>
      </div>
    </AbsoluteFill>
  );
}
