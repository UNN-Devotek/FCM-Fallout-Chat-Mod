/**
 * CommandsGif — 480×540 overlay on 960×540 dark canvas.
 * Loops every LOOP_DURATION frames (18 s @ 30 fps); durationInFrames = 1080 (2 loops).
 *
 * Per-loop phases:
 *    0– 98 : /nukecodes    → EmbedCard stays in chat history
 *   98–200 : /serverstatus → EmbedCard appended
 *  200–305 : /camp [item]  → EmbedCard with real item image appended; item cycles per loop
 *  305–537 : /g · /t · /e · /r relay messages appended to feed
 *  537–540 : hold / loop seam
 *
 * Cards and relay messages never disappear — they accumulate as chat history.
 * Users and camp item rotate on each loop iteration.
 */

import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Img,
  staticFile,
} from 'remotion';
import { OverlayWindow } from './OverlayWindow';
import { SAMPLE_MESSAGES, SAMPLE_NUKE_CODES, SERVER_STATUS, CHANNEL_COLORS } from './content';
import {
  PRIMARY,
  TEXT,
  SECONDARY,
  CHROME,
  CHROME_RGBA,
  DIVIDER,
  FONT_FAMILY,
  DISPLAY_FONT_FAMILY,
  rgba,
} from './theme';

// ── Accent colours ────────────────────────────────────────────────────────────
const ACCENT_NUKE   = '#E05050';
const ACCENT_SERVER = '#4ADE80';
const ACCENT_CAMP   = '#B57AFF';
const MONO = '"Courier New", Courier, monospace';

// ── Loop timing ───────────────────────────────────────────────────────────────
export const LOOP_DURATION = 540;

// Phase 1: /nukecodes (10 chars)
const T_P1_TYPE  = 0;
const T_P1_END   = 10;
const T_P1_ENTER = 13;
const T_P1_CARD  = 15;

// Phase 2: /serverstatus (13 chars)
const T_P2_TYPE  = 98;
const T_P2_END   = 111;
const T_P2_ENTER = 114;
const T_P2_CARD  = 116;

// Phase 3: /camp [item] (~18 chars)
const T_P3_TYPE  = 200;
const T_P3_END   = 218;
const T_P3_ENTER = 221;
const T_P3_CARD  = 223;

// Phase 4: channel relay commands — 4 blocks × RELAY_BLOCK frames
const RELAY_START = 305;
const RELAY_BLOCK = 58;
const TR_TYPE  = 0;   // within-block: start typing
const TR_END   = 15;  // within-block: done typing
const TR_ENTER = 18;  // within-block: enter flash
const TR_MSG   = 21;  // within-block: message appears

// ── Rotating data ─────────────────────────────────────────────────────────────
const USERS = [
  'GhoulSlayer', 'AtomicAnnie', 'VaultHunter76',
  'NukaWitch', 'Pip-Boy99', 'SteelRanger', 'RadScorpKing',
];

interface CampItem {
  name: string; cmd: string; category: string; sub: string;
  budget: number; plan: string; source: string;
  atoms: number | null; imageAsset: string;
}
const CAMP_ITEMS: CampItem[] = [
  {
    name: 'Baseless Greenhouse Dome', cmd: 'greenhouse dome',
    category: 'Structure', sub: 'Farm', budget: 5,
    plan: '', source: 'Atomic Shop', atoms: null,
    imageAsset: 'camp-00562f94.webp',
  },
  {
    name: 'Enclave Machinegun Turret', cmd: 'enclave turret',
    category: 'Defense', sub: 'Turrets', budget: 10,
    plan: '', source: 'Atomic Shop', atoms: null,
    imageAsset: 'camp-0062977d.webp',
  },
  {
    name: 'Brahmin Couch', cmd: 'brahmin couch',
    category: 'Furniture', sub: 'Seating', budget: 1,
    plan: 'Plan: Brahmin Couch', source: 'Gold Bullion', atoms: null,
    imageAsset: 'camp-00692a20.webp',
  },
];

interface RelayRow { cmd: string; tag: string; messages: string[] }
const RELAYS: RelayRow[] = [
  { cmd: '/g', tag: 'General', messages: ['LF group for nuke launch!',   'Anyone doing daily ops?',      'Free camp near Whitespring rn'] },
  { cmd: '/t', tag: 'Trading', messages: ['WTB Enclave Plasma Rifle',     'WTS Ultracite ammo × 10k',     'Trading Fixer AA/50/25'] },
  { cmd: '/e', tag: 'Events',  messages: ['Scorched Earth now — join up!','Uranium Fever at Blackwater',  'Encryptid event 5 mins'] },
  { cmd: '/r', tag: 'Raids',   messages: ['Need squad for Vault 94',      '2 spots open — Earle raid',    'Daily ops raid LFM lv50+'] },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function tw(full: string, lf: number, start: number, end: number): string {
  if (lf <= start) return '';
  if (lf >= end) return full;
  return full.slice(0, Math.ceil(((lf - start) / (end - start)) * full.length));
}

function fadeIn(lf: number, cardIn: number): number {
  return interpolate(lf, [cardIn, cardIn + 10], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
}

// ── InputBar ──────────────────────────────────────────────────────────────────
function InputBar({ text, user, showCursor, flash }: {
  text: string; user: string; showCursor: boolean; flash: boolean;
}) {
  const charCount = text.length;
  return (
    <div style={{
      borderTop: `1px solid ${flash ? rgba(PRIMARY, 0.8) : DIVIDER}`,
      background: flash ? rgba(PRIMARY, 0.12) : rgba(CHROME, 0.6),
      padding: '0 10px', height: 32,
      display: 'flex', alignItems: 'center', gap: 6,
      flexShrink: 0,
    }}>
      <span style={{ fontFamily: 'monospace', fontSize: 11, color: rgba(PRIMARY, 0.7), letterSpacing: '0.04em' }}>&gt;</span>
      {text ? (
        <span style={{ flex: 1, fontFamily: FONT_FAMILY, fontSize: 11, color: TEXT, overflow: 'hidden', whiteSpace: 'nowrap' }}>{text}</span>
      ) : (
        <>
          <span style={{ display: 'inline-block', width: 1, height: 13, background: rgba(PRIMARY, 0.85), marginLeft: 2 }} />
          <div style={{ flex: 1 }} />
        </>
      )}
      {text && showCursor && (
        <span style={{ display: 'inline-block', width: 1, height: 13, background: rgba(PRIMARY, 0.85), flexShrink: 0 }} />
      )}
      <span style={{ fontFamily: 'monospace', fontSize: 9, color: rgba(PRIMARY, 0.4), letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <span style={{ fontSize: 10 }}>☢</span>
        <span>{charCount}/255</span>
      </span>
    </div>
  );
}

// ── EmbedCard — mirrors real ChatEmbedCard + chat-embeds.css ─────────────────
interface EmbedField { label: string; value: React.ReactNode; mono?: boolean }
function EmbedCard({ accent, icon, tag, title, fields, meta, imageAsset, opacity = 1, translateY = 0 }: {
  accent: string; icon: string; tag: string; title: string;
  fields: EmbedField[]; meta?: string; imageAsset?: string;
  opacity?: number; translateY?: number;
}) {
  const FS        = 8;
  const accentDim = rgba(accent, 0.8);
  const labelCol  = rgba(accent, 0.6);
  return (
    <div style={{
      opacity, transform: `translateY(${translateY}px)`,
      borderLeft: `3px solid ${accentDim}`,
      background: rgba(accent, 0.07),
      padding: '5px 10px', boxSizing: 'border-box', fontFamily: FONT_FAMILY,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 2 }}>
        <span style={{ fontSize: 11, lineHeight: 1, color: accentDim, flexShrink: 0 }}>{icon}</span>
        <span style={{ fontSize: FS, fontWeight: 'bold', letterSpacing: '0.06em', textTransform: 'uppercase', color: accentDim, whiteSpace: 'nowrap', flexShrink: 0 }}>{tag}</span>
        <span style={{ fontSize: FS, fontWeight: 'bold', letterSpacing: '0.06em', textTransform: 'uppercase', color: accentDim, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {meta && <span style={{ fontSize: FS, color: rgba(accent, 0.5), whiteSpace: 'nowrap', flexShrink: 0 }}>{meta}</span>}
      </div>
      {/* Body: image thumbnail + field grid side-by-side when image present */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        {imageAsset && (
          <div style={{ flexShrink: 0, border: `1px solid ${rgba(accent, 0.3)}`, overflow: 'hidden', lineHeight: 0 }}>
            <Img src={staticFile(imageAsset)} style={{ display: 'block', width: 52, height: 52, objectFit: 'contain' }} />
          </div>
        )}
        {fields.length > 0 && (
          <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', columnGap: 12, rowGap: 1 }}>
            {fields.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ minWidth: 44, fontSize: FS, fontWeight: 'bold', letterSpacing: '0.05em', textTransform: 'uppercase', color: labelCol, whiteSpace: 'nowrap', flexShrink: 0 }}>{f.label}</span>
                <span style={{ fontSize: FS, color: accentDim, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: f.mono ? MONO : FONT_FAMILY }}>{f.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── ChatRow ───────────────────────────────────────────────────────────────────
function ChatRow({ user, tag, text, showTag = false, opacity = 1 }: {
  user: string; tag: string; text: string;
  showTag?: boolean; opacity?: number;
}) {
  const tagColor = CHANNEL_COLORS[tag] ?? PRIMARY;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', fontSize: 11, padding: '2px 0',
      opacity, flexShrink: 0,
    }}>
      {showTag && (
        <span style={{ fontSize: 9, color: rgba(tagColor, 0.85), textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 5, flexShrink: 0 }}>[{tag}]</span>
      )}
      <span style={{ color: rgba(PRIMARY, 0.85), fontWeight: 'bold', marginRight: 4, flexShrink: 0 }}>{user}:</span>
      <span style={{ color: TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{text}</span>
    </div>
  );
}

// ── Main composition ──────────────────────────────────────────────────────────
export function CommandsGif() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const loopFrame = frame % LOOP_DURATION;
  const loopIndex = Math.floor(frame / LOOP_DURATION);

  const campItem = CAMP_ITEMS[loopIndex % CAMP_ITEMS.length];
  const cmdUser  = (offset: number) => USERS[(loopIndex * 4 + offset) % USERS.length];

  // ── Phase ─────────────────────────────────────────────────────────────────
  const inP1    = loopFrame < T_P2_TYPE;
  const inP2    = loopFrame >= T_P2_TYPE && loopFrame < T_P3_TYPE;
  const inP3    = loopFrame >= T_P3_TYPE && loopFrame < RELAY_START;
  const inRelay = loopFrame >= RELAY_START;
  const relayIdx = inRelay ? Math.min(3, Math.floor((loopFrame - RELAY_START) / RELAY_BLOCK)) : -1;
  const relayBF  = inRelay ? (loopFrame - RELAY_START) % RELAY_BLOCK : 0;

  // ── Input bar state ────────────────────────────────────────────────────────
  let inputText = ''; let inputUser = ''; let showCursor = false; let inputFlash = false;

  if (inP1) {
    inputUser = cmdUser(0);
    if (loopFrame < T_P1_ENTER) {
      inputText  = tw('/nukecodes', loopFrame, T_P1_TYPE, T_P1_END);
      showCursor = loopFrame >= T_P1_END;
    } else if (loopFrame < T_P1_CARD) { inputFlash = true; }
  } else if (inP2) {
    inputUser = cmdUser(1);
    if (loopFrame < T_P2_ENTER) {
      inputText  = tw('/serverstatus', loopFrame, T_P2_TYPE, T_P2_END);
      showCursor = loopFrame >= T_P2_END;
    } else if (loopFrame < T_P2_CARD) { inputFlash = true; }
  } else if (inP3) {
    inputUser = cmdUser(2);
    const campCmd = `/camp ${campItem.cmd}`;
    if (loopFrame < T_P3_ENTER) {
      inputText  = tw(campCmd, loopFrame, T_P3_TYPE, T_P3_END);
      showCursor = loopFrame >= T_P3_END;
    } else if (loopFrame < T_P3_CARD) { inputFlash = true; }
  } else if (inRelay && relayIdx >= 0) {
    const relay = RELAYS[relayIdx];
    inputUser = cmdUser(3 + relayIdx);
    const fullText = `${relay.cmd} ${relay.messages[loopIndex % relay.messages.length]}`;
    if (relayBF < TR_ENTER) {
      inputText  = tw(fullText, relayBF, TR_TYPE, TR_END);
      showCursor = relayBF >= TR_END;
    } else if (relayBF < TR_MSG) { inputFlash = true; }
  }

  // ── Card opacity (fade in; cards persist) ─────────────────────────────────
  const nukeOp = loopFrame >= T_P1_CARD ? fadeIn(loopFrame, T_P1_CARD) : 0;
  const ssOp   = loopFrame >= T_P2_CARD ? fadeIn(loopFrame, T_P2_CARD) : 0;
  const campOp = loopFrame >= T_P3_CARD ? fadeIn(loopFrame, T_P3_CARD) : 0;

  const nukeY = spring({ frame: Math.max(0, loopFrame - T_P1_CARD), fps, config: { damping: 18, stiffness: 120, mass: 0.8 }, from: 14, to: 0 });
  const ssY   = spring({ frame: Math.max(0, loopFrame - T_P2_CARD), fps, config: { damping: 18, stiffness: 120, mass: 0.8 }, from: 14, to: 0 });
  const campY = spring({ frame: Math.max(0, loopFrame - T_P3_CARD), fps, config: { damping: 18, stiffness: 120, mass: 0.8 }, from: 14, to: 0 });

  // ── Relay messages ─────────────────────────────────────────────────────────
  const relayMsgs = RELAYS.map((relay, i) => {
    const msgFrame = RELAY_START + i * RELAY_BLOCK + TR_MSG;
    if (loopFrame < msgFrame) return null;
    return {
      relay,
      user: cmdUser(3 + i),
      text: relay.messages[loopIndex % relay.messages.length],
      op: interpolate(loopFrame, [msgFrame, msgFrame + 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    };
  });

  // General-only background messages (viewer is on General sub-tab)
  const bgMsgs = SAMPLE_MESSAGES.filter(m => m.tag === 'General').slice(0, 3);

  return (
    <AbsoluteFill style={{
      background: '#000', fontFamily: FONT_FAMILY,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
    }}>
      {/* ── Title callout ── */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, textAlign: 'center' }}>
        <div style={{ fontFamily: DISPLAY_FONT_FAMILY, fontSize: 16, fontWeight: 700, color: PRIMARY, letterSpacing: '0.05em', textShadow: `0 0 18px ${rgba(PRIMARY, 0.55)}, 0 0 5px ${rgba(PRIMARY, 0.4)}`, lineHeight: 1.2 }}>
          Check Out the Other Available Commands
        </div>
        <div style={{ fontSize: 9, color: rgba(SECONDARY, 0.65), letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: DISPLAY_FONT_FAMILY }}>
          /g general · /t trading · /e events · /r raids · /i infests · /nukecodes · /camp
        </div>
        <div style={{ width: 200, height: 1, background: `linear-gradient(to right, transparent, ${rgba(PRIMARY, 0.45)}, transparent)`, marginTop: 2 }} />
      </div>
      <div style={{ width: 480, height: 420, flexShrink: 0 }}>
        <OverlayWindow width={480} height={420} activeMain="fo76" activeSub="general">
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

            {/* ── Chat feed ── */}
            <div style={{
              flex: 1, padding: '8px 10px 4px',
              display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
              gap: 3, overflow: 'hidden',
            }}>
              {bgMsgs.map((m) => (
                <ChatRow key={m.id} user={m.user} tag={m.tag} text={m.text} showTag />
              ))}

              {/* /nukecodes card */}
              {nukeOp > 0 && (
                <EmbedCard
                  accent={ACCENT_NUKE} icon="☢" tag="NUKE CODES" title="Active Silo Codes"
                  meta="via NukaCrypt" opacity={nukeOp} translateY={nukeY}
                  fields={[
                    { label: 'ALPHA',   value: SAMPLE_NUKE_CODES.alpha,   mono: true },
                    { label: 'BRAVO',   value: SAMPLE_NUKE_CODES.bravo,   mono: true },
                    { label: 'CHARLIE', value: SAMPLE_NUKE_CODES.charlie, mono: true },
                    { label: 'VALID',   value: SAMPLE_NUKE_CODES.validUntil.slice(0, 10) },
                  ]}
                />
              )}

              {/* /serverstatus card */}
              {ssOp > 0 && (
                <EmbedCard
                  accent={ACCENT_SERVER} icon="▣" tag="SERVER STATUS" title="Fallout 76 Servers"
                  meta="via Bethesda" opacity={ssOp} translateY={ssY}
                  fields={[
                    { label: 'STATUS',  value: `${SERVER_STATUS} — ${SERVER_STATUS === 'UP' ? 'Online' : 'Offline'}` },
                    { label: 'CHECKED', value: '14:41 UTC' },
                  ]}
                />
              )}

              {/* /camp card */}
              {campOp > 0 && (
                <EmbedCard
                  accent={ACCENT_CAMP} icon="⚒" tag="CAMP ITEM" title={campItem.name}
                  meta="via 76 CAMP DB" opacity={campOp} translateY={campY}
                  imageAsset={campItem.imageAsset}
                  fields={[
                    { label: 'CATEGORY', value: campItem.category },
                    { label: 'SUB',      value: campItem.sub },
                    { label: 'BUDGET',   value: String(campItem.budget) },
                    ...(campItem.plan ? [{ label: 'PLAN', value: campItem.plan }] : []),
                    { label: 'SOURCE',   value: campItem.source },
                  ]}
                />
              )}

              {/* Relay messages */}
              {relayMsgs.map((rm, i) => rm && (
                <ChatRow
                  key={`relay-${i}`}
                  user={rm.user} tag={rm.relay.tag} text={rm.text}
                  showTag opacity={rm.op}
                />
              ))}
            </div>

            {/* ── Input bar ── */}
            <InputBar text={inputText} user={inputUser} showCursor={showCursor} flash={inputFlash} />
          </div>
        </OverlayWindow>
      </div>
    </AbsoluteFill>
  );
}
