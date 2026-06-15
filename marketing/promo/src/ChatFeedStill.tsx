/**
 * ChatFeedStill — 480×530 still of the General chat feed showcasing inline
 * embed types: wiki share, nuke-codes card, server-status card, party invite.
 */

import React from 'react';
import { AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { OverlayWindow } from './OverlayWindow';
import { SAMPLE_NUKE_CODES, SERVER_STATUS, CHANNEL_COLORS } from './content';
import {
  PRIMARY, SECONDARY, TEXT, DIVIDER, BG, CHROME, CHROME_RGBA, FONT_FAMILY, DISPLAY_FONT_FAMILY,
  rgba,
} from './theme';

// ── Colour palette ────────────────────────────────────────────────────────────

const ACCENT_WIKI    = PRIMARY;      // amber  — wiki share
const ACCENT_NUKE    = '#FF6B4A';    // matches ChatOverlay nukeAccent exactly
const ACCENT_SERVER  = '#55EFC4';    // matches ChatOverlay ssAccent (UP state)
const ACCENT_PARTY   = PRIMARY;      // amber  — party invite
const ACCENT_CAMP    = '#B57BFF';    // matches ChatOverlay campAccent exactly

const DIM = rgba(SECONDARY, 0.55);

// ── EmbedCard ─────────────────────────────────────────────────────────────────

interface EmbedCardProps {
  accent: string;
  icon: string;
  tag: string;
  title: string;
  meta?: React.ReactNode;
  fields: { label: string; value: string; mono?: boolean }[];
  footer?: React.ReactNode;
}

function EmbedCard({ accent, icon, tag, title, meta, fields, footer }: EmbedCardProps) {
  const a80 = rgba(accent, 0.8);
  const a60 = rgba(accent, 0.6);
  const a07 = rgba(accent, 0.07);
  const fs  = 9;

  return (
    <div style={{
      borderLeft: `3px solid ${accent}`,
      background: a07,
      padding: '5px 10px',
      fontFamily: FONT_FAMILY,
      boxSizing: 'border-box',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px 7px' }}>
        <span style={{ fontSize: fs * 1.4, lineHeight: 1, color: a80, flexShrink: 0 }}>{icon}</span>
        <span style={{ fontSize: fs, fontWeight: 'bold', letterSpacing: '0.06em', textTransform: 'uppercase', color: a80, whiteSpace: 'nowrap', flexShrink: 0 }}>{tag}</span>
        <span style={{ fontSize: fs, fontWeight: 'bold', letterSpacing: '0.06em', textTransform: 'uppercase', color: a80, flexShrink: 0 }}>{title}</span>
        {meta && <span style={{ marginLeft: 'auto', fontSize: fs, color: rgba(accent, 0.55), flexShrink: 0 }}>{meta}</span>}
      </div>
      {/* Field grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        columnGap: 16,
        rowGap: 1,
        marginTop: 3,
      }}>
        {fields.map(f => (
          <div key={f.label} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: fs, fontWeight: 'bold', letterSpacing: '0.05em', color: a60, flexShrink: 0, minWidth: 54 }}>{f.label}</span>
            <span style={{ fontSize: fs, color: accent, fontFamily: f.mono ? '"Courier New", monospace' : undefined }}>{f.value}</span>
          </div>
        ))}
      </div>
      {footer}
    </div>
  );
}

// ── Helper — small badge pill ─────────────────────────────────────────────────

function Badge({ accent, children }: { accent: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 8,
      color: accent,
      border: `1px solid ${rgba(accent, 0.55)}`,
      padding: '0px 4px',
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      flexShrink: 0,
    }}>{children}</span>
  );
}

// ── Helper — channel tag ──────────────────────────────────────────────────────

const TAG_COLORS = CHANNEL_COLORS;

function ChannelTag({ tag }: { tag: string }) {
  return (
    <span style={{
      fontSize: 9,
      color: TAG_COLORS[tag] ?? rgba(PRIMARY, 0.5),
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      marginRight: 5,
      flexShrink: 0,
    }}>[{tag}]</span>
  );
}

// ── Helper — sender name ──────────────────────────────────────────────────────

function Sender({ name }: { name: string }) {
  return (
    <span style={{
      color: rgba(PRIMARY, 0.88),
      fontWeight: 'bold',
      marginRight: 4,
      flexShrink: 0,
    }}>{name}:</span>
  );
}

// ── Helper — @mention span ────────────────────────────────────────────────────

function Mention({ name }: { name: string }) {
  return (
    <span style={{
      color: TEXT,
      fontWeight: 'bold',
      textShadow: `0 0 4px ${rgba(PRIMARY, 0.5)}`,
    }}>@{name}</span>
  );
}

// ── Helper — plain message row ────────────────────────────────────────────────

interface MsgRowProps {
  tag: string;
  sender: string;
  text: React.ReactNode;
}

function MsgRow({ tag, sender, text }: MsgRowProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      fontSize: 11,
      lineHeight: 1.45,
    }}>
      <ChannelTag tag={tag} />
      <Sender name={sender} />
      <span style={{ color: TEXT }}>{text}</span>
    </div>
  );
}

// ── 1. Wiki-share inline embed row ────────────────────────────────────────────

function WikiShareRow() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      fontSize: 11,
      lineHeight: 1.45,
      gap: 0,
    }}>
      <ChannelTag tag="General" />
      <Sender name="Devotek-" />
      {/* inline embed: ◈ icon · title · badge · sep · meta */}
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' }}>
        <span style={{ color: ACCENT_WIKI, flexShrink: 0 }}>◈</span>
        <span style={{
          color: ACCENT_WIKI,
          fontWeight: 'bold',
          cursor: 'pointer',
          textDecoration: 'underline',
          textDecorationColor: rgba(ACCENT_WIKI, 0.45),
          textUnderlineOffset: 2,
        }}>The Fixer</span>
        <Badge accent={ACCENT_WIKI}>WEAPON</Badge>
        <span style={{ color: DIM, fontSize: 9, margin: '0 1px' }}>·</span>
        <span style={{
          color: DIM,
          fontSize: 9,
          cursor: 'pointer',
          letterSpacing: '0.03em',
        }}>Fallout Wiki ↗</span>
      </span>
    </div>
  );
}

// ── 2. Nuke-codes inline share row ───────────────────────────────────────────

function NukeShareRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', fontSize: 11, lineHeight: 1.45, gap: 0 }}>
      <ChannelTag tag="General" />
      <Sender name="Devotek-" />
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' }}>
        <span style={{ color: ACCENT_NUKE, flexShrink: 0 }}>☢</span>
        <span style={{ color: ACCENT_NUKE, fontWeight: 'bold', textDecoration: 'underline', textDecorationColor: rgba(ACCENT_NUKE, 0.45), textUnderlineOffset: 2 }}>
          Nuke Codes
        </span>
        <span style={{ color: DIM, fontSize: 9, margin: '0 1px' }}>·</span>
        <span style={{ color: rgba(ACCENT_NUKE, 0.65), fontSize: 9, cursor: 'pointer' }}>NukaCrypt ↗</span>
      </span>
    </div>
  );
}

// ── 3. Server-status inline share row ────────────────────────────────────────

function ServerShareRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', fontSize: 11, lineHeight: 1.45, gap: 0 }}>
      <ChannelTag tag="General" />
      <Sender name="Devotek-" />
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' }}>
        <span style={{ color: ACCENT_SERVER, flexShrink: 0 }}>▣</span>
        <span style={{ color: ACCENT_SERVER, fontWeight: 'bold', textDecoration: 'underline', textDecorationColor: rgba(ACCENT_SERVER, 0.45), textUnderlineOffset: 2 }}>
          Server Status
        </span>
        <span style={{ color: DIM, fontSize: 9, margin: '0 1px' }}>·</span>
        <span style={{ color: rgba(ACCENT_SERVER, 0.65), fontSize: 9, cursor: 'pointer' }}>Bethesda ↗</span>
      </span>
    </div>
  );
}

// ── CAMP share inline row ─────────────────────────────────────────────────────

function CampShareRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', fontSize: 11, lineHeight: 1.45, gap: 0 }}>
      <ChannelTag tag="General" />
      <Sender name="Devotek-" />
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' }}>
        <span style={{ color: ACCENT_CAMP, flexShrink: 0 }}>⚒</span>
        <span style={{ color: ACCENT_CAMP, fontWeight: 'bold', textDecoration: 'underline', textDecorationColor: rgba(ACCENT_CAMP, 0.45), textUnderlineOffset: 2 }}>
          Wavy Willard&apos;s Bubble Machine
        </span>
        <span style={{ color: DIM, fontSize: 9, margin: '0 1px' }}>·</span>
        <span style={{ color: rgba(ACCENT_CAMP, 0.65), fontSize: 9, cursor: 'pointer' }}>76 CAMP Database ↗</span>
      </span>
    </div>
  );
}

// ── CAMP item card ────────────────────────────────────────────────────────────

function CampItemCard() {
  return (
    <EmbedCard
      accent={ACCENT_CAMP}
      icon="⚒"
      tag="CAMP ITEM"
      title="Wavy Willard's Bubble Machine"
      meta={<span style={{ textDecoration: 'underline', cursor: 'pointer' }}>via 76 CAMP Database ↗</span>}
      fields={[
        { label: 'CATEGORY',     value: 'Furniture' },
        { label: 'SUB-CATEGORY', value: 'Electronics' },
        { label: 'BUDGET',       value: '1' },
        { label: 'PLAN',         value: 'No plan required' },
        { label: 'SOURCE',       value: 'S.C.O.R.E. Reward' },
      ]}
      footer={
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 6 }}>
          <img
            src={staticFile('camp-bubble-machine.webp')}
            alt="Wavy Willard's Bubble Machine"
            style={{ maxWidth: '100%', maxHeight: 80, objectFit: 'contain', display: 'block' }}
          />
        </div>
      }
    />
  );
}

// ── 4. Nuke-codes card ────────────────────────────────────────────────────────

function NukeCodesCard() {
  const { alpha, bravo, charlie, validUntil } = SAMPLE_NUKE_CODES;
  const validStr = new Date(validUntil).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <EmbedCard
      accent={ACCENT_NUKE}
      icon="☢"
      tag="NUKE CODES"
      title="Active Silo Codes"
      meta={<span style={{ textDecoration: 'underline', cursor: 'pointer' }}>via NukaCrypt ↗</span>}
      fields={[
        { label: 'ALPHA',       value: alpha,    mono: true },
        { label: 'BRAVO',       value: bravo,    mono: true },
        { label: 'CHARLIE',     value: charlie,  mono: true },
        { label: 'VALID UNTIL', value: validStr },
      ]}
    />
  );
}

// ── 3. Server-status card ─────────────────────────────────────────────────────

function ServerStatusCard() {
  const up = SERVER_STATUS === 'UP';
  const accent = up ? ACCENT_SERVER : ACCENT_NUKE;
  return (
    <EmbedCard
      accent={accent}
      icon="▣"
      tag="SERVER STATUS"
      title="Fallout 76 Servers"
      meta={<span style={{ textDecoration: 'underline', cursor: 'pointer' }}>via Bethesda ↗</span>}
      fields={[
        { label: 'STATUS',  value: up ? 'Online' : 'Offline' },
        { label: 'CHECKED', value: 'Jun 8, 02:00 PM' },
      ]}
    />
  );
}

// ── 4. Party-invite inline row ────────────────────────────────────────────────

function PartyInviteRow() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      fontSize: 11,
      lineHeight: 1.45,
      borderLeft: '2px solid transparent',
      paddingLeft: 0,
    }}>
      <ChannelTag tag="General" />
      <Sender name="GhoulSlayer" />
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, flexWrap: 'wrap' }}>
        <span style={{ color: ACCENT_PARTY, flexShrink: 0 }}>✦</span>
        <span style={{ color: TEXT }}>invited everyone to</span>
        <span style={{
          color: ACCENT_PARTY,
          fontWeight: 'bold',
          cursor: 'pointer',
          textDecoration: 'underline',
          textDecorationColor: rgba(ACCENT_PARTY, 0.45),
          textUnderlineOffset: 2,
        }}>Uranium Fever Squad</span>
        <Badge accent={ACCENT_PARTY}>PARTY</Badge>
        {/* JOIN action */}
        <span style={{
          minHeight: 0,
          boxSizing: 'border-box',
          height: '18px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 9px',
          fontSize: 9,
          fontWeight: 'bold',
          letterSpacing: '0.04em',
          lineHeight: 1,
          color: ACCENT_PARTY,
          background: rgba(ACCENT_PARTY, 0.18),
          border: `1px solid ${rgba(ACCENT_PARTY, 0.6)}`,
          cursor: 'pointer',
          flexShrink: 0,
        }}>JOIN</span>
      </span>
    </div>
  );
}

// ── Callout bar ───────────────────────────────────────────────────────────────

function CalloutBar() {
  return (
    <div style={{
      position: 'absolute',
      bottom: 60,
      left: 0,
      right: 0,
      display: 'flex',
      justifyContent: 'center',
      pointerEvents: 'none',
      zIndex: 10,
    }}>
      <div style={{
        background: rgba('#000', 0.72),
        border: `1px solid ${rgba(PRIMARY, 0.45)}`,
        borderRadius: 3,
        padding: '8px 22px',
        fontFamily: DISPLAY_FONT_FAMILY,
        fontSize: 14,
        fontWeight: 'bold',
        letterSpacing: '0.05em',
        color: PRIMARY,
        textShadow: `0 0 12px ${rgba(PRIMARY, 0.55)}`,
        whiteSpace: 'nowrap',
      }}>
        Share wiki pages, codes &amp; invites right in chat
      </div>
    </div>
  );
}

// ── Input bar ─────────────────────────────────────────────────────────────────

function InputBar() {
  return (
    <>
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
        <span style={{ display: 'inline-block', width: 1, height: 13, background: rgba(PRIMARY, 0.85), marginLeft: 2 }} />
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: 'monospace', fontSize: 9, color: rgba(PRIMARY, 0.4), letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 4 }}>
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
        background: rgba(CHROME_RGBA, 0.8),
        flexShrink: 0,
      }}>
        <span style={{ fontFamily: 'monospace', fontSize: 8, letterSpacing: '0.04em', color: rgba(TEXT, 0.28) }}>
          Ins chat · Del hide · PgUp/PgDn cycle · Home settings · /help
        </span>
        <span style={{ fontFamily: 'monospace', fontSize: 8, letterSpacing: '0.04em', color: rgba(PRIMARY, 0.28) }}>
          v1.3.66
        </span>
      </div>
    </>
  );
}

// ── Main composition ──────────────────────────────────────────────────────────

export function ChatFeedStill() {
  void useCurrentFrame();
  void useVideoConfig();

  const WIN_W = 480;
  const WIN_H = 460;

  return (
    <AbsoluteFill style={{
      fontFamily: FONT_FAMILY,
      backgroundColor: '#070605',
      backgroundImage: 'radial-gradient(ellipse 75% 70% at 50% 55%, #1a150a 0%, #07060500 100%)',
    }}>
      {/* Centered card layout — callout above, card below */}
      <div style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {/* Callout above card */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          marginBottom: 18,
        }}>
          <div style={{
            fontFamily: DISPLAY_FONT_FAMILY,
            fontSize: 18,
            fontWeight: 'bold',
            color: PRIMARY,
            letterSpacing: '0.05em',
            textShadow: `0 0 18px ${rgba(PRIMARY, 0.55)}, 0 0 5px ${rgba(PRIMARY, 0.4)}`,
            lineHeight: 1.2,
            textAlign: 'center',
          }}>
            Share Wiki Pages, Codes &amp; Invites Right in Chat
          </div>
          <div style={{
            fontSize: 9,
            color: rgba(SECONDARY, 0.65),
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            fontFamily: DISPLAY_FONT_FAMILY,
            textAlign: 'center',
          }}>Wiki · Nuke Codes · Server Status · CAMP Items · Party Invites · @Mentions</div>
          <div style={{
            width: 180, height: 1,
            background: `linear-gradient(to right, transparent, ${rgba(PRIMARY, 0.45)}, transparent)`,
            marginTop: 2,
          }} />
        </div>

        {/* Card */}
        <div style={{
          width: WIN_W,
          height: WIN_H,
          flexShrink: 0,
          boxShadow: [
            `0 0 0 1px ${rgba(PRIMARY, 0.25)}`,
            `0 0 40px ${rgba(PRIMARY, 0.08)}`,
            `0 20px 60px rgba(0,0,0,0.7)`,
          ].join(', '),
        }}>
          <OverlayWindow
            width={WIN_W}
            height={WIN_H}
            activeMain="fo76"
            activeSub="general"
          >
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
              <div style={{
                flex: 1,
                padding: '8px 10px 4px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                overflow: 'hidden',
              }}>
                <MsgRow tag="General" sender="VaultHunter76" text="Anyone know where to find a Fixer plan?" />
                <MsgRow tag="General" sender="AtomicAnnie" text="/wiki The Fixer" />
                <WikiShareRow />
                <MsgRow tag="General" sender="WastelandWarden" text={<><Mention name="VaultHunter76" /> Encryptid drops it — good luck 👍</>} />
                <MsgRow tag="Trade" sender="NukaColaCapper" text="WTS Fixer (AA/50vhc/25) 5k caps" />
                <NukeShareRow />
                <ServerShareRow />
                <div style={{ height: 1, background: rgba(PRIMARY, 0.08), margin: '2px 0' }} />
                <NukeCodesCard />
                <ServerStatusCard />
                <MsgRow tag="Events" sender="GhoulSlayer" text="Uranium Fever in 10 mins — need 2!" />
                <PartyInviteRow />
                <MsgRow tag="Discord" sender="Paige" text="omw, hopping over from Discord" />
                <CampShareRow />
                <CampItemCard />
              </div>
              <InputBar />
            </div>
          </OverlayWindow>
        </div>
      </div>
    </AbsoluteFill>
  );
}
