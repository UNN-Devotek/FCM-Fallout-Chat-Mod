/**
 * PartyGif — 960×480, 8 s at 30 fps (240 frames).
 *
 * Timeline:
 *   0–18   : FO76 tab (General sub-tab), 4 messages in feed. No emoji in input.
 *   18–36  : Inline party invite fades in.
 *   36–55  : Cursor tracks to [JOIN] and clicks.
 *   55–70  : [JOIN] → JOINED.
 *   70–88  : Main tab switches to PARTY; sub-tabs = PARTIES · URANIUM FEVER.
 *   88–118 : Party view — chat on left + member panel on right (initials avatars).
 *   118–148: Right-click on member → context menu appears.
 *   148–168: Cursor moves to PARTY main tab and clicks → navigate to party browser.
 *   168–240: Party browser landing page (multiple party types).
 */

import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';
import { SAMPLE_MESSAGES, CHANNEL_COLORS } from './content';
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
import { OverlayWindow } from './OverlayWindow';

// ── Dimensions & timing ───────────────────────────────────────────────────────

const W = 480;
const H = 420;

const T_INVITE_IN    = 18;
const T_CLICK        = 55;
const T_JOINED       = 63;
const T_SWITCH       = 74;   // tab flips to PARTY
const T_PARTY_IN     = 88;   // party view fades in
const T_RCLICK       = 118;  // right-click on member
const T_CTX_IN       = 121;  // context menu appears
const T_CTX_DISMISS  = 148;  // context menu dismissed
const T_NAV_CLICK    = 165;  // cursor clicks PARTY main tab
const T_BROWSER_IN   = 173;  // party browser fades in

// Approximate positions for the faux cursor targets.
// JOIN button: inline in the invite row near the right edge.
// The invite row is the last item in the flex-end message list.
// Layout: H=420 → content area = 420-23-22-36=339px; 5 rows × ~18px + padding ≈ 102px;
//   bottom of content = 23+22+339=384px; invite row top = 384-18=366.
// JOIN x: prefix (~155px) + ✦+text+badge+margin ≈ 155+248=403, center at 403+19=422.
const JOIN_BTN         = { x: 422, y: 366 };

// AtomicAnnie in the member panel (2nd member, panel starts at x=340).
// Panel header ~22px; first member ~30px; second member center ≈ 45+22+30+15=112.
const MEMBER_RCLICK    = { x: 400, y: 112 };
const CTX_MENU_POS     = { x: 338, y: 112 };  // context menu top-left

// PARTY main tab center: row left-pad=8, FO76 tab≈86px, margin=4 → PARTY starts at 98.
// PARTY text "PARTY"≈33px + pad 8+9=17 → PARTY center x≈98+26=124, y≈12.
const PARTY_MAIN_TAB   = { x: 124, y: 12 };

// ── Helpers ───────────────────────────────────────────────────────────────────

const TAG_COLORS: Record<string, string> = { ...CHANNEL_COLORS, Party: rgba(PRIMARY, 0.7) };

// ── Faux cursor ───────────────────────────────────────────────────────────────

function FauxCursor({ x, y, clicking }: { x: number; y: number; clicking: boolean }) {
  return (
    <div style={{
      position: 'absolute', left: x - 6, top: y - 6,
      width: 12, height: 12, zIndex: 100, pointerEvents: 'none',
    }}>
      <div style={{
        position: 'absolute', inset: clicking ? -4 : 0, borderRadius: '50%',
        border: `1.5px solid ${rgba(PRIMARY, clicking ? 0.85 : 0.45)}`,
      }} />
      <div style={{ position: 'absolute', inset: 3, borderRadius: '50%', background: rgba(PRIMARY, 0.9) }} />
    </div>
  );
}

// ── Main feed chat row ────────────────────────────────────────────────────────

function ChatRow({ user, tag, text, time }: { user: string; tag: string; text: string; time: string }) {
  const tagColor = TAG_COLORS[tag] ?? rgba(PRIMARY, 0.5);
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', fontSize: FONT_SIZE, padding: '1px 8px', gap: 4, flexShrink: 0 }}>
      <span style={{ flex: 1 }}>
        <span style={{ color: rgba(SECONDARY, 0.45), fontSize: 9, marginRight: 4 }}>{time}</span>
        <span style={{ color: tagColor, fontSize: Math.max(7, FONT_SIZE - 2), marginRight: 4 }}>[{tag}]</span>
        <span style={{ fontWeight: 'bold', color: rgba(PRIMARY, 0.9), marginRight: 3 }}>{user}:{' '}</span>
        <span style={{ color: TEXT }}>{text}</span>
      </span>
    </div>
  );
}

// ── Inline party invite row ───────────────────────────────────────────────────

function InviteRow({ frame, joined }: { frame: number; joined: boolean }) {
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [T_INVITE_IN, T_INVITE_IN + 12], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const joinPulse = interpolate(frame, [T_JOINED, T_JOINED + 8, T_JOINED + 16], [1, 1.1, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const accent = PRIMARY;
  const generalColor = CHANNEL_COLORS.General;

  return (
    <div style={{ display: 'flex', alignItems: 'baseline', fontSize: FONT_SIZE, padding: '1px 8px', gap: 4, flexShrink: 0, opacity }}>
      <span style={{ flex: 1 }}>
        <span style={{ color: rgba(SECONDARY, 0.45), fontSize: 9, marginRight: 4 }}>14:42</span>
        <span style={{ color: rgba(generalColor, 0.9), fontSize: Math.max(7, FONT_SIZE - 2), marginRight: 4 }}>[General]</span>
        <span style={{ fontWeight: 'bold', color: rgba(PRIMARY, 0.9), marginRight: 3 }}>GhoulSlayer:{' '}</span>
        <span style={{ color: rgba(accent, 0.65), marginRight: 3 }}>✦</span>
        <span style={{ color: rgba(TEXT, 0.75) }}>invited everyone to </span>
        <span style={{ fontWeight: 'bold', color: accent }}>Uranium Fever</span>
        <span style={{
          marginLeft: 5, padding: '0 4px',
          fontSize: Math.max(8, FONT_SIZE - 3),
          border: `1px solid ${accent}`, color: accent,
          letterSpacing: '0.05em', verticalAlign: 'middle',
        }}>PARTY</span>
        {joined ? (
          <span style={{
            marginLeft: 6,
            fontSize: Math.max(8, FONT_SIZE - 3),
            color: rgba(accent, 0.7),
            letterSpacing: '0.04em',
            verticalAlign: 'middle',
          }}>JOINED</span>
        ) : (
          <span style={{
            marginLeft: 6,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            height: 16, padding: '0 7px',
            fontSize: Math.max(9, FONT_SIZE - 2),
            background: rgba(accent, 0.18),
            border: `1px solid ${rgba(accent, 0.6)}`,
            color: accent, fontWeight: 'bold',
            letterSpacing: '0.04em',
            boxSizing: 'border-box', verticalAlign: 'middle',
            transform: `scale(${joinPulse})`, transformOrigin: 'center center',
          }}>JOIN</span>
        )}
      </span>
    </div>
  );
}

// ── Party view ────────────────────────────────────────────────────────────────

const PARTY_MSGS = [
  { user: 'GhoulSlayer',   text: 'stick to the shaft — I\'ll call ore spawns',  time: '14:43' },
  { user: 'AtomicAnnie',   text: 'on explosives, cover me 🧨',                   time: '14:43' },
  { user: 'Devotek',       text: 'spawning at Wayward, 2 mins',  discord: true,  time: '14:44' },
  { user: 'VaultHunter76', text: 'ready 👍',                                      time: '14:44' },
];

const PARTY_MEMBERS = [
  { name: 'GhoulSlayer',   level: 112, online: true,  isMe: false },
  { name: 'AtomicAnnie',   level: 87,  online: true,  isMe: false },
  { name: 'VaultHunter76', level: 64,  online: true,  isMe: true  },
  { name: '[open slot]',   level: 0,   online: false, isMe: false },
];

function InitialsAvatar({ name, size = 18 }: { name: string; size?: number }) {
  const initial = name[0]?.toUpperCase() ?? '?';
  const isOpen = name.startsWith('[');
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: isOpen ? rgba(SECONDARY, 0.12) : rgba(PRIMARY, 0.18),
      border: `1px solid ${rgba(PRIMARY, isOpen ? 0.15 : 0.35)}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.max(7, size * 0.5),
      fontWeight: 'bold',
      color: isOpen ? rgba(SECONDARY, 0.35) : rgba(PRIMARY, 0.85),
    }}>
      {isOpen ? '' : initial}
    </div>
  );
}

function MemberPanel({ showCtx, ctxTargetIdx }: { showCtx: boolean; ctxTargetIdx: number | null }) {
  return (
    <div style={{
      width: 140, flexShrink: 0,
      display: 'flex', flexDirection: 'column',
      borderLeft: `1px solid ${rgba(PRIMARY, 0.18)}`,
    }}>
      {/* Panel header */}
      <div style={{
        padding: '4px 10px',
        borderBottom: `1px solid ${rgba(PRIMARY, 0.18)}`,
        flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 5,
      }}>
        <span style={{ color: rgba(PRIMARY, 0.6), fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 'bold' }}>
          Members
        </span>
        <span style={{ color: rgba(SECONDARY, 0.4), fontSize: 8, marginLeft: 'auto' }}>
          {PARTY_MEMBERS.filter(m => m.online).length}/{PARTY_MEMBERS.length}
        </span>
      </div>

      {/* Member rows */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {PARTY_MEMBERS.map((m, i) => {
          const isRightClickTarget = ctxTargetIdx === i;
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center',
              padding: '5px 8px', gap: 6,
              fontSize: 10,
              opacity: m.online ? 1 : 0.38,
              background: isRightClickTarget
                ? rgba(PRIMARY, 0.08)
                : m.isMe ? rgba(PRIMARY, 0.04) : 'transparent',
              borderBottom: `1px solid ${rgba(PRIMARY, 0.1)}`,
            }}>
              <InitialsAvatar name={m.name} size={18} />
              <span style={{
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                color: m.online ? TEXT : rgba(TEXT, 0.4),
                fontWeight: m.isMe ? 'bold' : 'normal',
                fontSize: 10,
              }}>
                {m.name.startsWith('[') ? m.name : m.name}
                {m.isMe && (
                  <span style={{ color: rgba(PRIMARY, 0.45), fontSize: 8, marginLeft: 4, fontWeight: 'normal' }}>you</span>
                )}
              </span>
              {m.level > 0 && (
                <span style={{ color: rgba(SECONDARY, 0.45), fontSize: 8, flexShrink: 0 }}>
                  {m.level}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CtxMenu({ x, y, opacity }: { x: number; y: number; opacity: number }) {
  const items = ['View Profile', 'Whisper', 'Kick from Party'];
  return (
    <div style={{
      position: 'absolute', left: x, top: y,
      background: rgba('#0c0a08', 0.98),
      border: `1px solid ${rgba(PRIMARY, 0.45)}`,
      zIndex: 50, opacity, pointerEvents: 'none',
      minWidth: 120,
    }}>
      {items.map((label, i) => (
        <div key={label} style={{
          padding: '4px 10px',
          fontSize: 10,
          color: i === 2 ? rgba('#FF6644', 0.85) : rgba(TEXT, 0.85),
          borderBottom: i < items.length - 1 ? `1px solid ${rgba(PRIMARY, 0.12)}` : 'none',
          whiteSpace: 'nowrap',
        }}>{label}</div>
      ))}
    </div>
  );
}

function PartyView({
  frame,
  showCtx,
  ctxTargetIdx,
  ctxOpacity,
}: {
  frame: number;
  showCtx: boolean;
  ctxTargetIdx: number | null;
  ctxOpacity: number;
}) {
  const opacity = interpolate(frame, [T_PARTY_IN, T_PARTY_IN + 14], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', opacity, position: 'relative' }}>
      {/* ── Party chat feed (left) ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{
          flex: 1,
          display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
          padding: '6px 0 4px',
          overflow: 'hidden', gap: 2,
        }}>
          {PARTY_MSGS.map((m, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'baseline',
              fontSize: FONT_SIZE, padding: '1px 8px', gap: 4, flexShrink: 0,
            }}>
              <span style={{ flex: 1 }}>
                <span style={{ color: rgba(SECONDARY, 0.45), fontSize: 9, marginRight: 4 }}>{m.time}</span>
                {/* Party messages show the party name as the tag */}
                <span style={{
                  color: rgba(PRIMARY, 0.65),
                  fontSize: Math.max(7, FONT_SIZE - 2),
                  marginRight: 4,
                }}>[Uranium Fever]</span>
                {(m as any).discord && (
                  <span style={{
                    color: rgba(CHANNEL_COLORS.Discord, 0.9),
                    fontSize: Math.max(7, FONT_SIZE - 2),
                    marginRight: 4,
                  }}>[Discord]</span>
                )}
                <span style={{ fontWeight: 'bold', color: rgba(PRIMARY, 0.9), marginRight: 3 }}>{m.user}:{' '}</span>
                <span style={{ color: TEXT }}>{m.text}</span>
              </span>
            </div>
          ))}
        </div>

        {/* Party input bar */}
        <div style={{ borderTop: `1px solid ${DIVIDER}`, padding: '0 10px', height: 32, display: 'flex', alignItems: 'center', background: rgba(CHROME, 0.6), flexShrink: 0, gap: 6 }}>
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: rgba(PRIMARY, 0.7), letterSpacing: '0.04em' }}>&gt;</span>
          <span style={{ display: 'inline-block', width: 1, height: 13, background: rgba(PRIMARY, 0.85), marginLeft: 2 }} />
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: 'monospace', fontSize: 9, color: rgba(PRIMARY, 0.4), letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 10 }}>☢</span>
            <span>0/255</span>
          </span>
        </div>
      </div>

      {/* ── Member panel (right) ── */}
      <MemberPanel showCtx={showCtx} ctxTargetIdx={ctxTargetIdx} />

      {/* Context menu (right-click on member) */}
      {showCtx && (
        <CtxMenu
          x={CTX_MENU_POS.x}
          y={CTX_MENU_POS.y}
          opacity={ctxOpacity}
        />
      )}
    </div>
  );
}

// ── Party browser landing page ────────────────────────────────────────────────

const BROWSER_PARTIES = [
  { name: 'Uranium Fever Squad', category: 'Events',  members: 3, max: 4, color: CHANNEL_COLORS.Events,  full: false },
  { name: 'Steel Dawn Traders',  category: 'Trading', members: 2, max: 4, color: CHANNEL_COLORS.Trading, full: false },
  { name: 'Earle Slayers',       category: 'Raids',   members: 4, max: 4, color: CHANNEL_COLORS.Raids,   full: true  },
  { name: 'New Vault Dwellers',  category: 'General', members: 1, max: 4, color: PRIMARY,                full: false },
  { name: 'CAMP Show & Tell',    category: 'Social',  members: 2, max: 4, color: '#9966FF',              full: false },
];

function PartyBrowser({ frame }: { frame: number }) {
  const opacity = interpolate(frame, [T_BROWSER_IN, T_BROWSER_IN + 14], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', opacity }}>
      {/* ── List header ── */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '5px 12px',
        borderBottom: `1px solid ${rgba(PRIMARY, 0.18)}`,
        flexShrink: 0, gap: 8,
      }}>
        <span style={{ color: rgba(PRIMARY, 0.7), fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 'bold' }}>
          Public Parties
        </span>
        <span style={{ color: rgba(SECONDARY, 0.4), fontSize: 9, marginLeft: 'auto' }}>
          {BROWSER_PARTIES.length} active
        </span>
      </div>

      {/* ── Column headers ── */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '3px 12px',
        borderBottom: `1px solid ${rgba(PRIMARY, 0.12)}`,
        flexShrink: 0,
        fontSize: 8,
        color: rgba(SECONDARY, 0.45),
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        gap: 4,
      }}>
        <span style={{ flex: 1 }}>Name</span>
        <span style={{ width: 56 }}>Category</span>
        <span style={{ width: 40, textAlign: 'right' }}>Members</span>
        <span style={{ width: 48 }} />
      </div>

      {/* ── Party rows ── */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {BROWSER_PARTIES.map((p, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center',
            padding: '6px 12px',
            borderBottom: `1px solid ${rgba(PRIMARY, 0.1)}`,
            gap: 8, fontSize: 11,
          }}>
            {/* Status dot */}
            <span style={{
              width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
              background: p.full ? rgba(SECONDARY, 0.3) : p.color,
              boxShadow: p.full ? 'none' : `0 0 4px ${p.color}`,
            }} />

            {/* Party name */}
            <span style={{
              flex: 1, fontWeight: 'bold',
              color: rgba(p.color, 0.9),
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 11,
            }}>{p.name}</span>

            {/* Category badge */}
            <span style={{
              width: 56, flexShrink: 0,
              fontSize: 8, color: rgba(p.color, 0.7),
              textTransform: 'uppercase', letterSpacing: '0.05em',
              fontWeight: 'bold',
            }}>{p.category}</span>

            {/* Member count */}
            <span style={{
              width: 40, flexShrink: 0, textAlign: 'right',
              fontSize: 9, color: rgba(SECONDARY, 0.5),
            }}>
              {p.members}/{p.max}
            </span>

            {/* JOIN / FULL button */}
            <span style={{
              width: 48, flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              height: 18, boxSizing: 'border-box',
              background: p.full ? 'transparent' : rgba(p.color, 0.18),
              border: `1px solid ${rgba(p.color, p.full ? 0.25 : 0.6)}`,
              color: rgba(p.color, p.full ? 0.4 : 0.9),
              fontSize: 9, fontWeight: 'bold', letterSpacing: '0.04em',
            }}>
              {p.full ? 'FULL' : 'JOIN'}
            </span>
          </div>
        ))}
      </div>

      {/* ── Create party button ── */}
      <div style={{
        padding: '6px 12px',
        borderTop: `1px solid ${rgba(PRIMARY, 0.18)}`,
        flexShrink: 0,
        display: 'flex', justifyContent: 'flex-end',
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          height: 20, padding: '0 12px', fontSize: 9,
          background: rgba(PRIMARY, 0.14),
          border: `1px solid ${rgba(PRIMARY, 0.45)}`,
          color: rgba(PRIMARY, 0.85),
          fontWeight: 'bold', letterSpacing: '0.05em',
          textTransform: 'uppercase',
        }}>
          + Create Party
        </span>
      </div>
    </div>
  );
}

// ── Main composition ──────────────────────────────────────────────────────────

export function PartyGif() {
  const frame = useCurrentFrame();

  const inviteVisible  = frame >= T_INVITE_IN;
  const joined         = frame >= T_JOINED;
  const showParty      = frame >= T_SWITCH;
  const partyContentOn = frame >= T_PARTY_IN;
  const showCtx        = frame >= T_CTX_IN && frame < T_CTX_DISMISS + 10;
  const ctxTargetIdx   = showCtx ? 1 : null; // AtomicAnnie
  const showBrowser    = frame >= T_BROWSER_IN;

  const ctxOpacity = interpolate(
    frame,
    [T_CTX_IN, T_CTX_IN + 6, T_CTX_DISMISS, T_CTX_DISMISS + 8],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  // ── Cursor — 3 movement segments ────────────────────────────────────────────
  // Seg 1: rest → JOIN button
  const seg1 = interpolate(frame, [T_INVITE_IN + 15, T_CLICK - 2], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: t => t * t * (3 - 2 * t),
  });
  // Seg 2: JOIN → member panel
  const seg2 = interpolate(frame, [T_JOINED + 20, T_RCLICK - 5], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: t => t * t * (3 - 2 * t),
  });
  // Seg 3: member panel → PARTY main tab
  const seg3 = interpolate(frame, [T_CTX_DISMISS + 5, T_NAV_CLICK - 3], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
    easing: t => t * t * (3 - 2 * t),
  });

  const startX = W * 0.72, startY = H * 0.52;

  let cursorX: number;
  let cursorY: number;
  if (frame < T_JOINED + 20) {
    cursorX = interpolate(seg1, [0, 1], [startX, JOIN_BTN.x]);
    cursorY = interpolate(seg1, [0, 1], [startY, JOIN_BTN.y]);
  } else if (frame < T_CTX_DISMISS + 5) {
    cursorX = interpolate(seg2, [0, 1], [JOIN_BTN.x, MEMBER_RCLICK.x]);
    cursorY = interpolate(seg2, [0, 1], [JOIN_BTN.y, MEMBER_RCLICK.y]);
  } else {
    cursorX = interpolate(seg3, [0, 1], [MEMBER_RCLICK.x, PARTY_MAIN_TAB.x]);
    cursorY = interpolate(seg3, [0, 1], [MEMBER_RCLICK.y, PARTY_MAIN_TAB.y]);
  }

  const cursorOpacity = interpolate(
    frame,
    [
      T_INVITE_IN + 10, T_INVITE_IN + 18,  // fade in before join
      T_JOINED + 12, T_JOINED + 20,         // fade out after join...
      T_PARTY_IN + 5, T_PARTY_IN + 15,      // ...fade back in to move to member
      T_CTX_IN - 2, T_CTX_IN + 4,           // fade during right-click
      T_CTX_DISMISS + 2, T_CTX_DISMISS + 10, // reappear after ctx dismissed
      T_NAV_CLICK + 2, T_NAV_CLICK + 10,    // fade after clicking PARTY tab
    ],
    [0, 1, 1, 0, 0, 1, 1, 0.3, 0.3, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  const clicking1 = frame >= T_CLICK && frame < T_CLICK + 8;
  const clicking2 = frame >= T_RCLICK && frame < T_RCLICK + 5;
  const clicking3 = frame >= T_NAV_CLICK && frame < T_NAV_CLICK + 6;
  const clicking = clicking1 || clicking2 || clicking3;

  const feedMessages = SAMPLE_MESSAGES.slice(-4);

  return (
    <AbsoluteFill style={{
      background: '#000', fontFamily: FONT_FAMILY,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
    }}>
      {/* ── Title callout ── */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, textAlign: 'center' }}>
        <div style={{ fontFamily: DISPLAY_FONT_FAMILY, fontSize: 16, fontWeight: 700, color: PRIMARY, letterSpacing: '0.05em', textShadow: `0 0 18px ${rgba(PRIMARY, 0.55)}, 0 0 5px ${rgba(PRIMARY, 0.4)}`, lineHeight: 1.2 }}>
          Party Up Without Leaving the Game
        </div>
        <div style={{ fontSize: 9, color: rgba(SECONDARY, 0.65), letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: DISPLAY_FONT_FAMILY }}>
          Create parties, invite players, and manage your squad — right in the overlay
        </div>
        <div style={{ width: 180, height: 1, background: `linear-gradient(to right, transparent, ${rgba(PRIMARY, 0.45)}, transparent)`, marginTop: 2 }} />
      </div>
      {/* Wrapper gives the cursor a positioned ancestor that covers the full card */}
      <div style={{ width: W, height: H, position: 'relative', flexShrink: 0 }}>
        <OverlayWindow
          width={W}
          height={H}
          activeMain={showParty ? 'party' : 'fo76'}
          activeSub="general"
        >
          {/* ── FO76 chat view ── */}
          {!showParty && (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{
                flex: 1,
                display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
                padding: '6px 0 4px', gap: 2, overflow: 'hidden',
              }}>
                {feedMessages.map(m => (
                  <ChatRow key={m.id} user={m.user} tag={m.tag} text={m.text} time={m.timestamp} />
                ))}
                {inviteVisible && <InviteRow frame={frame} joined={joined} />}
              </div>

              {/* FO76 input */}
              <div style={{ borderTop: `1px solid ${DIVIDER}`, padding: '0 10px', height: 32, display: 'flex', alignItems: 'center', background: rgba(CHROME, 0.6), flexShrink: 0, gap: 6 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: rgba(PRIMARY, 0.7), letterSpacing: '0.04em' }}>&gt;</span>
                <span style={{ display: 'inline-block', width: 1, height: 13, background: rgba(PRIMARY, 0.85), marginLeft: 2 }} />
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: 'monospace', fontSize: 9, color: rgba(PRIMARY, 0.4), letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 10 }}>☢</span>
                  <span>0/255</span>
                </span>
              </div>
            </div>
          )}

          {/* ── Party view (chat + member list) ── */}
          {showParty && !showBrowser && (
            <PartyView
              frame={frame}
              showCtx={showCtx}
              ctxTargetIdx={ctxTargetIdx}
              ctxOpacity={ctxOpacity}
            />
          )}

          {/* ── Party browser landing page ── */}
          {showBrowser && <PartyBrowser frame={frame} />}
        </OverlayWindow>

        {/* Cursor sits outside OverlayWindow so it can roam over the tab rows */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 200, opacity: cursorOpacity }}>
          <FauxCursor x={cursorX} y={cursorY} clicking={clicking} />
        </div>
      </div>
    </AbsoluteFill>
  );
}
