/**
 * Header composition — 1300×372 still banner for the Nexus mod page.
 *
 * Layout (two-column):
 *   LEFT  (~580px) — Large "FCM" monogram with amber glow.
 *   RIGHT (~720px) — Full OverlayWindow: tab chrome + chat feed + input bar
 *                    + keybind footer, matching the live overlay appearance.
 */

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { OverlayWindow } from './OverlayWindow';
import {
  BG,
  CHROME,
  PRIMARY,
  SECONDARY,
  TEXT,
  DIVIDER,
  FONT_FAMILY,
  DISPLAY_FONT_FAMILY,
  SCANLINE_GRADIENT,
  rgba,
} from './theme';

// ── Geometry ──────────────────────────────────────────────────────────────────

const W = 1300;
const H = 372;
const LEFT_W = 660;   // FCM hero area — wider to push chat rightward
const RIGHT_W = 590;  // narrower chat window, flush to the right edge
const GAP_W = W - LEFT_W - RIGHT_W; // 50px spacer between hero and chat

import { CHANNEL_COLORS } from './content';
const TAG_COLORS = CHANNEL_COLORS;

const MESSAGES = [
  { tag: 'General', user: 'Sole_Survivor', text: 'morning wanderers 🌅' },
  { tag: 'Discord', user: 'Paige',         text: 'saying hi from the Discord ↓' },
  { tag: 'Trade',   user: 'CapsKing',      text: 'WTS bloodied fixer — 8k caps 💊' },
  { tag: 'Events',  user: 'Overseer',      text: 'Nuke launching West Tek in 5' },
  { tag: 'Raids',   user: 'RaidLeader',    text: 'SBQ run — need 3 more' },
];

// ── Chat body (messages + input bar + keybind footer) ─────────────────────────

function ChatBody() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      boxSizing: 'border-box',
    }}>

      {/* Messages */}
      <div style={{
        flex: 1,
        padding: '8px 12px 4px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        overflowY: 'hidden',
      }}>
        {MESSAGES.map((msg, i) => {
          const c = TAG_COLORS[msg.tag] ?? PRIMARY;
          return (
            <div key={i} style={{
              fontFamily: FONT_FAMILY,
              fontSize: 11,
              lineHeight: '18px',
              display: 'flex',
              alignItems: 'baseline',
              gap: 4,
              padding: '1px 8px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}>
                <span style={{
                color: rgba(c, 0.9),
                fontWeight: 'normal',
                borderRadius: 2,
                padding: '0 1px',
                textShadow: `0 0 3px ${rgba(c, 0.45)}`,
                flexShrink: 0,
              }}>
                [{msg.tag}]
              </span>
              <span style={{
                fontWeight: 'bold',
                color: rgba(PRIMARY, 0.9),
                textShadow: `0 0 3px ${rgba(PRIMARY, 0.45)}`,
                flexShrink: 0,
              }}>
                {msg.user}:{' '}
              </span>
              <span style={{
                fontWeight: 600,
                color: rgba(TEXT, 0.85),
                textShadow: `0 0 2px ${rgba(PRIMARY, 0.25)}`,
              }}>
                {msg.text}
              </span>
            </div>
          );
        })}
      </div>

      {/* Input bar */}
      <div style={{
        borderTop: `1px solid ${DIVIDER}`,
        padding: '0 10px',
        height: 32,
        display: 'flex',
        alignItems: 'center',
        background: rgba(CHROME, 0.6),
        flexShrink: 0,
        gap: 6,
      }}>
        <span style={{
          fontFamily: 'monospace',
          fontSize: 11,
          color: rgba(PRIMARY, 0.7),
          letterSpacing: '0.04em',
        }}>
          &gt;
        </span>
          <span style={{
          display: 'inline-block',
          width: 1,
          height: 13,
          background: rgba(PRIMARY, 0.85),
          marginLeft: 2,
        }} />
        <div style={{ flex: 1 }} />
        <span style={{
          fontFamily: 'monospace',
          fontSize: 9,
          color: rgba(PRIMARY, 0.4),
          letterSpacing: '0.04em',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}>
          <span style={{ fontSize: 10 }}>☢</span>
          <span>0/255</span>
        </span>
      </div>

      {/* Keybind footer */}
      <div style={{
        borderTop: `1px solid ${rgba(PRIMARY, 0.12)}`,
        padding: '0 10px',
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: rgba(CHROME, 0.8),
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: 'monospace',
          fontSize: 8,
          letterSpacing: '0.04em',
          color: rgba(TEXT, 0.28),
        }}>
          Ins chat · Del hide · PgUp/PgDn cycle · Home settings · /help
        </span>
        <span style={{
          fontFamily: 'monospace',
          fontSize: 8,
          letterSpacing: '0.04em',
          color: rgba(PRIMARY, 0.28),
        }}>
          v1.3.66
        </span>
      </div>
    </div>
  );
}

// ── Left hero — large FCM monogram ───────────────────────────────────────────

function FCMHero() {
  return (
    <div style={{
      width: LEFT_W,
      height: H,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      paddingBottom: 70, // shifts flex centre upward
      flexShrink: 0,
    }}>
      <div style={{
        fontFamily: DISPLAY_FONT_FAMILY,
        fontSize: 118,
        fontWeight: 'bold',
        letterSpacing: '0.12em',
        color: PRIMARY,
        textShadow: [
          `0 0 16px ${rgba(PRIMARY, 0.9)}`,
          `0 0 40px ${rgba(PRIMARY, 0.5)}`,
          `0 0 80px ${rgba(PRIMARY, 0.25)}`,
        ].join(', '),
        lineHeight: 1,
        userSelect: 'none',
      }}>
        FCM
      </div>
    </div>
  );
}

// ── Root composition ──────────────────────────────────────────────────────────

export function Header() {
  useCurrentFrame();
  useVideoConfig();

  return (
    <AbsoluteFill style={{ background: BG, fontFamily: FONT_FAMILY }}>

      {/* Outer border frame */}
      <div style={{
        position: 'absolute',
        inset: 0,
        border: `1px solid ${rgba(PRIMARY, 0.28)}`,
        pointerEvents: 'none',
        zIndex: 10,
      }} />

      <div style={{ display: 'flex', width: W, height: H, overflow: 'hidden' }}>

          <FCMHero />
        <div style={{ width: GAP_W, flexShrink: 0 }} />
        {/* Overlay window */}
        <div style={{ width: RIGHT_W, flexShrink: 0 }}>
          <OverlayWindow
            width={RIGHT_W}
            height={H}
            activeMain="fo76"
            activeSub="general"
          >
            <ChatBody />
          </OverlayWindow>
        </div>
      </div>

      {/* Scanline overlay */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: SCANLINE_GRADIENT,
        pointerEvents: 'none',
        opacity: 0.35,
        zIndex: 5,
      }} />

      {/* Vignette */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: 'radial-gradient(ellipse 80% 70% at 50% 50%, transparent 40%, rgba(0,0,0,0.45) 100%)',
        pointerEvents: 'none',
        zIndex: 4,
      }} />
    </AbsoluteFill>
  );
}
