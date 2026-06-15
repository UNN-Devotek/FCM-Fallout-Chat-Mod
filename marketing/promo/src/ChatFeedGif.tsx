/**
 * ChatFeedGif — 960×420, 9 s at 30 fps (270 frames).
 *
 * Shows the multi-channel chat feed live: messages from General, Trading,
 * Events, Raids, and Discord arrive progressively, demonstrating the
 * real-time cross-channel nature of the overlay.
 *
 * Timeline:
 *   0–0    : 3 seed messages already visible (General conversation in progress)
 *   30–45  : [Trading] NukaColaCapper arrives
 *   70–85  : [Events]  GhoulSlayer arrives
 *   110–125: [Raids]   RadScorpQueen arrives
 *   150–165: [Discord] Devotek bridge message arrives
 *   165–270: All 7 messages visible — idle input, cursor blinks
 */

import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
} from 'remotion';
import { OverlayWindow } from './OverlayWindow';
import { SAMPLE_MESSAGES, CHANNEL_COLORS } from './content';
import {
  PRIMARY,
  TEXT,
  SECONDARY,
  DIVIDER,
  CHROME,
  FONT_FAMILY,
  DISPLAY_FONT_FAMILY,
  FONT_SIZE,
  rgba,
} from './theme';

// ── Dimensions ────────────────────────────────────────────────────────────────

const W = 480;
const H = 420;

// Fade-in frame for each message; msgs 0–2 are seed (always visible).
const ARRIVE: Record<number, number> = {
  3: 30,
  4: 70,
  5: 110,
  6: 150,
};
const FADE_DUR = 12; // frames for opacity + slide-up

// ── Message row ───────────────────────────────────────────────────────────────

function MsgRow({
  tag, user, text, opacity = 1, slideY = 0,
}: {
  tag: string; user: string; text: string; opacity?: number; slideY?: number;
}) {
  const color = CHANNEL_COLORS[tag] ?? PRIMARY;
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline',
      fontSize: FONT_SIZE, padding: '2px 8px', gap: 4, flexShrink: 0,
      opacity,
      transform: `translateY(${slideY}px)`,
    }}>
      <span style={{ flex: 1 }}>
        <span style={{ color: rgba(SECONDARY, 0.45), fontSize: 9, marginRight: 4 }} />
        <span style={{ color: rgba(color, 0.9), fontSize: Math.max(7, FONT_SIZE - 2), marginRight: 4 }}>
          [{tag}]
        </span>
        <span style={{ fontWeight: 'bold', color: rgba(PRIMARY, 0.9), marginRight: 3 }}>{user}:{' '}</span>
        <span style={{ color: TEXT }}>{text}</span>
      </span>
    </div>
  );
}

// ── Composition ───────────────────────────────────────────────────────────────

export function ChatFeedGif() {
  const frame = useCurrentFrame();

  const cursorOn = Math.floor(frame / 15) % 2 === 0; // 15-frame blink cycle

  // Per-message visibility
  const msgOpacity = SAMPLE_MESSAGES.map((_, i) => {
    if (i <= 2) return 1; // seed messages always visible
    const t = ARRIVE[i];
    if (t === undefined) return 1;
    return interpolate(frame, [t, t + FADE_DUR], [0, 1], {
      extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    });
  });

  const msgSlide = SAMPLE_MESSAGES.map((_, i) => {
    if (i <= 2) return 0;
    const t = ARRIVE[i];
    if (t === undefined) return 0;
    return interpolate(frame, [t, t + FADE_DUR], [8, 0], {
      extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    });
  });

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
          Live Cross-Channel Chat, In Overlay
        </div>
        <div style={{ fontSize: 9, color: rgba(SECONDARY, 0.65), letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: DISPLAY_FONT_FAMILY }}>
          General · Trading · Events · Raids · Discord — all in one feed
        </div>
        <div style={{ width: 180, height: 1, background: `linear-gradient(to right, transparent, ${rgba(PRIMARY, 0.45)}, transparent)`, marginTop: 2 }} />
      </div>
      <div style={{ width: W, height: H }}>
        <OverlayWindow width={W} height={H} activeSub="general">
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

            {/* ── Message feed ── */}
            <div style={{
              flex: 1,
              display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
              padding: '6px 0 4px',
              overflow: 'hidden',
              gap: 1,
            }}>
              {SAMPLE_MESSAGES.map((m, i) => (
                msgOpacity[i] > 0 ? (
                  <MsgRow
                    key={m.id}
                    tag={m.tag}
                    user={m.user}
                    text={m.text}
                    opacity={msgOpacity[i]}
                    slideY={msgSlide[i]}
                  />
                ) : null
              ))}
            </div>

            {/* ── Input bar ── */}
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
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: rgba(PRIMARY, 0.7), letterSpacing: '0.04em' }}>&gt;</span>
              {cursorOn && (
                <span style={{ display: 'inline-block', width: 1, height: 13, background: rgba(PRIMARY, 0.85), marginLeft: 2 }} />
              )}
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: 'monospace', fontSize: 9, color: rgba(PRIMARY, 0.4), letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 10 }}>☢</span>
                <span>0/255</span>
              </span>
            </div>

          </div>
        </OverlayWindow>
      </div>
    </AbsoluteFill>
  );
}
