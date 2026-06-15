/**
 * CoverImage — 1920×1080 Nexus mod page cover art.
 *
 * Layout:
 *   • Black background
 *   • Large OverlayWindow (1280×680) centered horizontally, anchored near top
 *   • "VAULT-TEC COMMUNITY NETWORK ■" typed-text watermark overlaid on the window
 *   • Giant "FCM" monogram (Georgia Bold) centered over the window, semi-transparent
 *   • "Community chat for Fallout 76" + "falloutchatmod.com" below the window
 */

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { OverlayWindow } from './OverlayWindow';
import { SAMPLE_MESSAGES, CHANNEL_COLORS } from './content';
import {
  PRIMARY,
  SECONDARY,
  TEXT,
  FONT_FAMILY,
  DISPLAY_FONT_FAMILY,
  rgba,
} from './theme';

// ── Geometry ──────────────────────────────────────────────────────────────────

const WIN_W = 540;
const WIN_H = 620;
const WIN_LEFT = (1920 - WIN_W) / 2; // 690
const WIN_TOP  = 110;

// ── Chat row ──────────────────────────────────────────────────────────────────

function ChatRow({ tag, user, text }: { tag: string; user: string; text: string }) {
  const c = CHANNEL_COLORS[tag] ?? PRIMARY;
  return (
    <div style={{
      fontSize: 11,
      lineHeight: '18px',
      display: 'flex',
      alignItems: 'baseline',
      gap: 5,
      padding: '1px 8px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
    }}>
      <span style={{
        color: rgba(c, 0.9),
        fontWeight: 'normal',
        flexShrink: 0,
      }}>[{tag}]</span>
      <span style={{
        fontWeight: 'bold',
        color: rgba(PRIMARY, 0.9),
        flexShrink: 0,
      }}>{user}:</span>
      <span style={{
        fontWeight: 600,
        color: rgba(TEXT, 0.85),
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>{text}</span>
    </div>
  );
}

// ── Composition ───────────────────────────────────────────────────────────────

export function CoverImage() {
  void useCurrentFrame();
  void useVideoConfig();

  const messages = [
    { tag: 'General', user: 'VaultDweller77',  text: 'anyone up for Scorched Earth? 🔥' },
    { tag: 'Trade',   user: 'CapsKing',         text: 'WTS bloodied fixer AA/50vhc/25 — 6k caps' },
    { tag: 'Discord', user: 'Paige',             text: 'omw, hopping over from Discord 👋' },
    { tag: 'Events',  user: 'Overseer',          text: 'Nuke launching at West Tek — open event!' },
    { tag: 'Raids',   user: 'RaidLeader',        text: 'SBQ run forming — need 3 more level 50+' },
    { tag: 'General', user: 'VaultDweller77',   text: 'got the plan from Encryptid — finally!' },
  ];

  return (
    <AbsoluteFill style={{ background: '#000', fontFamily: FONT_FAMILY }}>

      {/* ── Overlay window ── */}
      <div style={{
        position: 'absolute',
        left: WIN_LEFT,
        top: WIN_TOP,
        width: WIN_W,
        height: WIN_H,
        boxShadow: `0 0 0 1px ${rgba(PRIMARY, 0.2)}, 0 0 80px ${rgba(PRIMARY, 0.06)}`,
      }}>
        <OverlayWindow
          width={WIN_W}
          height={WIN_H}
          activeMain="fo76"
          activeSub="general"
          showParty
        >
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            paddingTop: 14,
            gap: 0,
            overflow: 'hidden',
          }}>
            {messages.map((m, i) => (
              <ChatRow key={i} tag={m.tag} user={m.user} text={m.text} />
            ))}
          </div>
        </OverlayWindow>
      </div>

      {/* ── Giant "FCM" overlay — semi-transparent, Georgia Bold ── */}
      <div style={{
        position: 'absolute',
        left: WIN_LEFT,
        top: WIN_TOP + 130,
        width: WIN_W,
        height: WIN_H - 130,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 10,
        opacity: 0.88,
      }}>
        <div style={{
          fontFamily: DISPLAY_FONT_FAMILY,
          fontSize: 200,
          fontWeight: 'bold',
          letterSpacing: '0.06em',
          color: PRIMARY,
          lineHeight: 1,
          userSelect: 'none',
          textShadow: [
            `0 0 40px ${rgba(PRIMARY, 0.9)}`,
            `0 0 100px ${rgba(PRIMARY, 0.5)}`,
            `0 0 200px ${rgba(PRIMARY, 0.2)}`,
          ].join(', '),
        }}>
          FCM
        </div>
      </div>

      {/* ── Text beneath the window ── */}
      <div style={{
        position: 'absolute',
        left: WIN_LEFT,
        width: WIN_W,
        top: 605,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        zIndex: 11,
        pointerEvents: 'none',
      }}>
        <div style={{
          fontFamily: DISPLAY_FONT_FAMILY,
          fontSize: 22,
          fontWeight: 'bold',
          color: '#ffffff',
          letterSpacing: '0.02em',
          textAlign: 'center',
        }}>
          Community chat for Fallout 76
        </div>
        <div style={{
          fontFamily: DISPLAY_FONT_FAMILY,
          fontSize: 18,
          fontWeight: 'bold',
          color: PRIMARY,
          letterSpacing: '0.02em',
          textShadow: `0 0 12px ${rgba(PRIMARY, 0.5)}`,
          textAlign: 'center',
        }}>
          falloutchatmod.com
        </div>
      </div>

    </AbsoluteFill>
  );
}
