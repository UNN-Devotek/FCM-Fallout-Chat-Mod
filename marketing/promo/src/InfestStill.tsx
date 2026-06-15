/**
 * InfestStill — 480×540 overlay in a 960×540 canvas.
 *
 * Snapshot of an active infestation-hunt session on the Infests sub-channel.
 * Shows the full lifecycle: location callout → coordination → chase → kill → recap.
 * Includes a Discord-bridged message to show the bidirectional relay.
 */

import React from 'react';
import { AbsoluteFill } from 'remotion';
import { OverlayWindow } from './OverlayWindow';
import { INFEST_MESSAGES, CHANNEL_COLORS } from './content';
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

const W = 480;
const H = 360;

const INFEST_COLOR  = CHANNEL_COLORS.Infests;
const DISCORD_COLOR = CHANNEL_COLORS.Discord;

// ── Message row ───────────────────────────────────────────────────────────────

function MsgRow({
  user, text, time, source,
}: {
  user: string; text: string; time: string; source: 'game' | 'discord';
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline',
      fontSize: FONT_SIZE, padding: '2px 8px', gap: 4, flexShrink: 0,
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

export function InfestStill() {
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
              {INFEST_MESSAGES.map(m => (
                <MsgRow key={m.id} user={m.user} text={m.text} time={m.timestamp} source={m.source} />
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
              <span style={{ color: rgba(INFEST_COLOR, 0.9), fontSize: Math.max(7, FONT_SIZE - 2), flexShrink: 0 }}>[Infests]</span>
              <span style={{ flex: 1, fontFamily: FONT_FAMILY, fontSize: 11, color: rgba(TEXT, 0.35), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: 'italic' }}>
                /i [location] — report an infestation to the channel
              </span>
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
