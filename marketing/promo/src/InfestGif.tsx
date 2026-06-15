/**
 * InfestGif — 960×540, 9 s at 30 fps (270 frames).
 *
 * Shows the infestation-hunt workflow from the player's perspective:
 *
 * Timeline:
 *   0–45   : Infests tab active, 3 "already there" messages visible (session in progress).
 *   45–165 : 6 coordination messages appear progressively (~20 frames each).
 *   165–220: User types "/i helvetia — move fast" in the input bar.
 *   220–232: Send — message appears in feed.
 *   232–255: Discord bridge reply fades in.
 *   255–270: Hold on final state.
 *
 * Message types demonstrated:
 *   - Location callout    : "new inf in toxic valley"
 *   - Multi-zone report   : "two zones up, which first?"
 *   - Coordination        : "weak one first lol", "hurry, boss at defiance is up"
 *   - Discord bridge      : bridged from Discord with [Discord] tag
 *   - Own message via /i  : user reports a new location
 *   - Kill recap          : "got it! that was close", "4 star drop 🎉"
 */

import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
} from 'remotion';
import { OverlayWindow } from './OverlayWindow';
import { CHANNEL_COLORS } from './content';
import {
  PRIMARY,
  TEXT,
  SECONDARY,
  DIVIDER,
  BG,
  CHROME,
  FONT_FAMILY,
  DISPLAY_FONT_FAMILY,
  FONT_SIZE,
  rgba,
} from './theme';

// ── Constants ─────────────────────────────────────────────────────────────────

const W = 480;
const H = 360;

const INFEST_COLOR  = CHANNEL_COLORS.Infests;
const DISCORD_COLOR = CHANNEL_COLORS.Discord;

// When each message fades in (frame number)
const MSG_TIMES = [
  45,   // msg 0 — "two zones up, which first?"
  65,   // msg 1 — "weak one first lol"
  85,   // msg 2 — "on my way to toxic"
  105,  // msg 3 — "hurry, boss at defiance is up"
  125,  // msg 4 — "toxic one down — 4 star drop 🎉"
  145,  // msg 5 — "antique store one died somehow lol"
];

const T_TYPE_START  = 165;  // user starts typing /i command
const T_SEND        = 222;  // message sent
const T_MY_MSG      = 225;  // own message appears in feed
const T_DISCORD_IN  = 238;  // Discord bridge reply
const T_FINAL_MSG   = 252;  // one last response

// ── Data ──────────────────────────────────────────────────────────────────────

// Visible when the GIF starts (session already in progress)
const SEED_MSGS = [
  { user: 'RadScorpQueen',  text: 'new inf in toxic valley — near station', time: '20:14', source: 'game' as const },
  { user: 'AtomicAnnie',    text: 'Inf at grafton station too',             time: '20:14', source: 'game' as const },
  { user: 'GhoulSlayer',    text: 'on my way to grafton',                   time: '20:15', source: 'game' as const },
];

const LIVE_MSGS = [
  { user: 'VaultHunter76',   text: 'two zones up, which first?',                 time: '20:15', source: 'game' as const },
  { user: 'WastelandWarden', text: 'weak one first lol',                          time: '20:15', source: 'game' as const },
  { user: 'AtomicAnnie',     text: 'on my way to toxic',                          time: '20:16', source: 'game' as const },
  { user: 'NukaColaCapper',  text: 'hurry, boss at defiance is up',               time: '20:17', source: 'game' as const },
  { user: 'RadScorpQueen',   text: 'toxic one down — 4 star drop 🎉',             time: '20:18', source: 'game' as const },
  { user: 'GhoulSlayer',     text: 'antique store one died somehow lol',           time: '20:19', source: 'game' as const },
];

const MY_MSG = {
  user: 'VaultHunter76', text: 'helvetia — move fast', time: '20:21', source: 'game' as const, isOwn: true,
};

const DISCORD_MSG = {
  user: 'Devotek', text: 'routing to helvetia now', time: '20:21', source: 'discord' as const,
};

const FINAL_MSG = {
  user: 'WastelandWarden', text: 'on my way, 30 secs out', time: '20:22', source: 'game' as const,
};

const FULL_INPUT = '/i helvetia — move fast';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fadeIn(frame: number, start: number, dur = 10): number {
  return interpolate(frame, [start, start + dur], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
}

// ── Message row ───────────────────────────────────────────────────────────────

function MsgRow({
  user, text, time, source, opacity = 1, highlight = false,
}: {
  user: string; text: string; time: string;
  source: 'game' | 'discord'; opacity?: number; highlight?: boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline',
      fontSize: FONT_SIZE, padding: '2px 8px', gap: 4, flexShrink: 0,
      opacity,
      background: highlight ? rgba(PRIMARY, 0.05) : 'transparent',
      borderLeft: highlight ? `2px solid ${rgba(PRIMARY, 0.45)}` : '2px solid transparent',
    }}>
      <span style={{ flex: 1 }}>
        <span style={{ color: rgba(SECONDARY, 0.45), fontSize: 9, marginRight: 4 }}>{time}</span>
        {source === 'discord' ? (
          <span style={{ color: rgba(DISCORD_COLOR, 0.9), fontSize: Math.max(7, FONT_SIZE - 2), marginRight: 4 }}>
            [Discord]
          </span>
        ) : (
          <span style={{ color: rgba(INFEST_COLOR, 0.9), fontSize: Math.max(7, FONT_SIZE - 2), marginRight: 4 }}>
            [Infests]
          </span>
        )}
        <span style={{ fontWeight: 'bold', color: rgba(PRIMARY, 0.9), marginRight: 3 }}>{user}:{' '}</span>
        <span style={{ color: TEXT }}>{text}</span>
      </span>
    </div>
  );
}

// ── Composition ───────────────────────────────────────────────────────────────

export function InfestGif() {
  const frame = useCurrentFrame();

  const liveMsgOpacities = MSG_TIMES.map(t => fadeIn(frame, t));

  const typeProgress = interpolate(frame, [T_TYPE_START, T_SEND - 3], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const charCount = Math.round(typeProgress * FULL_INPUT.length);
  const inputText  = frame >= T_MY_MSG ? '' : FULL_INPUT.slice(0, charCount);
  const showPlaceholder = charCount === 0;

  const cursorBlink = frame >= T_TYPE_START && frame < T_MY_MSG
    ? (Math.floor(frame / 15) % 2 === 0 ? 1 : 0)
    : 0;

  // Message visibilities
  const myMsgOpacity      = fadeIn(frame, T_MY_MSG);
  const discordMsgOpacity = fadeIn(frame, T_DISCORD_IN);
  const finalMsgOpacity   = fadeIn(frame, T_FINAL_MSG);

  return (
    <AbsoluteFill style={{
      background: '#000',
      fontFamily: FONT_FAMILY,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 14,
    }}>
      {/* ── Title callout ── */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, textAlign: 'center' }}>
        <div style={{ fontFamily: DISPLAY_FONT_FAMILY, fontSize: 16, fontWeight: 700, color: PRIMARY, letterSpacing: '0.05em', textShadow: `0 0 18px ${rgba(PRIMARY, 0.55)}, 0 0 5px ${rgba(PRIMARY, 0.4)}`, lineHeight: 1.2 }}>
          Hunt Infestations as a Community
        </div>
        <div style={{ fontSize: 9, color: rgba(SECONDARY, 0.65), letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: DISPLAY_FONT_FAMILY }}>
          Report spawns with /i and coordinate infestation hunts in real time
        </div>
        <div style={{ width: 180, height: 1, background: `linear-gradient(to right, transparent, ${rgba(PRIMARY, 0.45)}, transparent)`, marginTop: 2 }} />
      </div>
      <div style={{ width: W, height: H }}>
        <OverlayWindow width={W} height={H} activeSub="infests">
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

            {/* ── Message feed ── */}
            <div style={{
              flex: 1,
              display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
              padding: '6px 0 4px',
              overflow: 'hidden',
              gap: 1,
            }}>
              {/* Seed messages */}
              {SEED_MSGS.map((m, i) => (
                <MsgRow key={`seed-${i}`} {...m} />
              ))}

              {/* Live messages */}
              {LIVE_MSGS.map((m, i) => (
                liveMsgOpacities[i] > 0 ? (
                  <MsgRow key={`live-${i}`} {...m} opacity={liveMsgOpacities[i]} />
                ) : null
              ))}

              {/* Own message (sent via /i) */}
              {myMsgOpacity > 0 && (
                <MsgRow {...MY_MSG} opacity={myMsgOpacity} highlight />
              )}

              {/* Discord bridge */}
              {discordMsgOpacity > 0 && (
                <MsgRow {...DISCORD_MSG} opacity={discordMsgOpacity} />
              )}

              {/* Final reply */}
              {finalMsgOpacity > 0 && (
                <MsgRow {...FINAL_MSG} opacity={finalMsgOpacity} />
              )}
            </div>

            {/* ── Input bar ── */}
            <div style={{ borderTop: `1px solid ${DIVIDER}`, padding: '0 10px', height: 32, display: 'flex', alignItems: 'center', background: rgba(CHROME, 0.6), flexShrink: 0, gap: 6 }}>
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: rgba(PRIMARY, 0.7), letterSpacing: '0.04em' }}>&gt;</span>
              <span style={{ color: rgba(INFEST_COLOR, 0.9), fontSize: Math.max(7, FONT_SIZE - 2), flexShrink: 0 }}>[Infests]</span>
              {showPlaceholder ? (
                <>
                  <span style={{ display: 'inline-block', width: 1, height: 13, background: rgba(PRIMARY, 0.85), marginLeft: 2 }} />
                  <span style={{ flex: 1, fontFamily: FONT_FAMILY, fontSize: 11, color: rgba(TEXT, 0.35), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: 'italic', marginLeft: 4 }}>
                    /i [location] — report an infestation
                  </span>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, fontFamily: FONT_FAMILY, fontSize: 11, color: rgba(INFEST_COLOR, 0.9), overflow: 'hidden', whiteSpace: 'nowrap' }}>{inputText}</span>
                  {cursorBlink === 1 && (
                    <span style={{ display: 'inline-block', width: 1, height: 13, background: rgba(PRIMARY, 0.85), flexShrink: 0 }} />
                  )}
                </>
              )}
              <span style={{ fontFamily: 'monospace', fontSize: 9, color: rgba(PRIMARY, 0.4), letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <span style={{ fontSize: 10 }}>☢</span>
                <span>{inputText.length}/255</span>
              </span>
            </div>

          </div>
        </OverlayWindow>
      </div>
    </AbsoluteFill>
  );
}
