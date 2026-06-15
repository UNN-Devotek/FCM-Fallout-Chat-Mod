/**
 * WikiFlowGif — 960×540, 14 s at 30 fps (430 frames).
 *
 * Timeline (30 fps):
 *   0–55    : Chat feed — 4 sample messages, static (0.9 opacity)
 *   55–100  : Typing — "/wiki Toilet paper" typewriter in input box
 *   100–145 : Autocomplete — dropdown slides/fades in above input, hold
 *   145–155 : Select — Tab keypress visual, panel starts opening
 *   155–270 : Wiki item panel — "Toilet paper" entry slides in from right
 *   270–330 : Scroll — wiki panel body scrolls down -110px
 *   330–370 : Locations visible — Red Rocket Mega Stop highlighted gold
 *   370–375 : Click — brief pulse on Red Rocket Mega Stop link
 *   375–430 : Location panel — transitions to Red Rocket Mega Stop entry
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
import { SAMPLE_MESSAGES, CHANNEL_COLORS } from './content';
import {
  PRIMARY,
  SECONDARY,
  TEXT,
  BG,
  CHROME,
  CHROME_RGBA,
  DIVIDER,
  FONT_FAMILY,
  DISPLAY_FONT_FAMILY,
  rgba,
} from './theme';

// ── Constants ─────────────────────────────────────────────────────────────────

const DIM = rgba(SECONDARY, 0.85);
const BORDER_FAINT = rgba(PRIMARY, 0.35);
const MONO = '"Courier New", Courier, monospace';

// ── Input bar ─────────────────────────────────────────────────────────────────

function InputBar({
  text,
  showCursor,
  flash,
}: {
  text: string;
  showCursor: boolean;
  flash: boolean;
}) {
  const charCount = text.length;
  return (
    <div style={{
      borderTop: `1px solid ${flash ? rgba(PRIMARY, 0.8) : DIVIDER}`,
      background: flash ? rgba(PRIMARY, 0.12) : rgba(CHROME, 0.6),
      padding: '0 10px',
      height: 32,
      display: 'flex',
      alignItems: 'center',
      flexShrink: 0,
      gap: 6,
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

// ── Chat feed ─────────────────────────────────────────────────────────────────

function ChatFeed({ opacity }: { opacity: number }) {
  const messages = SAMPLE_MESSAGES.slice(0, 4);
  return (
    <div style={{ flex: 1, padding: '8px 12px 4px', opacity, overflow: 'hidden' }}>
      {messages.map((m) => {
        const c = CHANNEL_COLORS[m.tag] ?? PRIMARY;
        return (
          <div key={m.id} style={{
            fontSize: 11,
            lineHeight: '18px',
            display: 'flex',
            alignItems: 'baseline',
            gap: 4,
            padding: '1px 8px',
          }}>
            <span style={{
              color: rgba(c, 0.9),
              fontWeight: 'normal',
              borderRadius: 2,
              padding: '0 1px',
              flexShrink: 0,
            }}>
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
  );
}

// ── Autocomplete dropdown ─────────────────────────────────────────────────────

interface AcItem {
  name: string;
  kind: string;
  active: boolean;
}

function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    weapon: 'WEAPON', location: 'LOCATION', creature: 'CREATURE',
    item: 'ITEM', npc: 'NPC', plan: 'PLAN', armor: 'ARMOR', ammo: 'AMMO',
  };
  return labels[kind] ?? kind.toUpperCase();
}

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

const AC_ITEMS: AcItem[] = [
  { name: 'Toilet paper',              kind: 'item',     active: true },
  { name: 'Toilet paper (Nuka-World)', kind: 'item',     active: false },
  { name: 'Outhouse',                  kind: 'location', active: false },
];

function AutocompleteDropdown({
  opacity,
  slideY,
}: {
  opacity: number;
  slideY: number;
}) {
  const menuBg   = rgba(BG, 0.97);
  const chromeBg = rgba(CHROME, 0.98);

  return (
    <div style={{
      background: menuBg,
      border: `1px solid ${BORDER_FAINT}`,
      borderBottom: 'none',
      fontFamily: FONT_FAMILY,
      opacity,
      transform: `translateY(${slideY}px)`,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 10px',
        borderBottom: `1px solid ${rgba(PRIMARY, 0.1)}`,
        background: rgba(PRIMARY, 0.06),
      }}>
        <span style={{
          fontSize: 10,
          fontWeight: 'bold',
          letterSpacing: '0.08em',
          color: rgba(PRIMARY, 0.85),
          fontFamily: DISPLAY_FONT_FAMILY,
        }}>
          /WIKI — Wiki Search
        </span>
        <span style={{
          fontSize: 9,
          letterSpacing: '0.04em',
          color: rgba(SECONDARY, 0.65),
          display: 'flex',
          alignItems: 'center',
          gap: 6,
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
      {AC_ITEMS.map((item) => {
        const isActive = item.active;
        return (
          <div key={item.name} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '4px 10px 4px 8px',
            height: 44,
            background: isActive ? rgba(PRIMARY, 0.10) : 'transparent',
            borderLeft: isActive ? `2px solid ${PRIMARY}` : '2px solid transparent',
            boxSizing: 'border-box',
          }}>
            {/* Glyph thumbnail */}
            <div style={{
              width: 44, height: 36, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <KindGlyph kind={item.kind} color={rgba(PRIMARY, 0.7)} />
            </div>
            <span style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              color: isActive ? TEXT : rgba(TEXT, 0.65),
              fontWeight: isActive ? 'bold' : 'normal',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {item.name}
            </span>
            <span style={{
              flexShrink: 0,
              fontSize: 9,
              letterSpacing: '0.06em',
              padding: '2px 5px',
              border: `1px solid ${isActive ? PRIMARY : rgba(SECONDARY, 0.4)}`,
              color: isActive ? PRIMARY : rgba(SECONDARY, 0.55),
            }}>
              {kindLabel(item.kind)}
            </span>
          </div>
        );
      })}

      {/* Footer hint */}
      <div style={{
        padding: '5px 12px',
        fontSize: 10,
        letterSpacing: '0.03em',
        color: rgba(SECONDARY, 0.5),
        borderTop: `1px solid ${rgba(PRIMARY, 0.08)}`,
        background: chromeBg,
      }}>
        ↑↓ select · Enter / Tab open · or click a result
      </div>
    </div>
  );
}

// ── Wiki panel shared sub-components ─────────────────────────────────────────

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      gap: '6px',
      alignItems: 'baseline',
      padding: '3px 0',
      borderBottom: `1px solid ${rgba(PRIMARY, 0.06)}`,
      minWidth: 0,
    }}>
      <span style={{
        flexShrink: 0,
        fontSize: '9px',
        letterSpacing: '0.06em',
        color: DIM,
        textTransform: 'uppercase',
        fontFamily: MONO,
      }}>{label}</span>
      <span style={{
        fontSize: '11px',
        color: TEXT,
        wordBreak: 'break-word',
        flex: 1,
        minWidth: 0,
        textAlign: 'right',
        fontFamily: FONT_FAMILY,
      }}>{value}</span>
    </div>
  );
}

function WikiChrome() {
  return (
    <div style={{
      background: CHROME_RGBA,
      borderBottom: `1px solid ${BORDER_FAINT}`,
      padding: '4px 10px',
      display: 'flex',
      alignItems: 'center',
      flexShrink: 0,
      position: 'relative',
    }}>
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'baseline',
        gap: '6px',
        pointerEvents: 'none',
      }}>
        <span style={{
          fontSize: '11px',
          fontWeight: 'bold',
          color: PRIMARY,
          letterSpacing: '0.1em',
          whiteSpace: 'nowrap',
          textShadow: `0 0 6px ${rgba(PRIMARY, 0.45)}`,
        }}>&#9672; FALLOUT WIKI &#8599;</span>
        <span style={{
          fontSize: '8px',
          color: rgba(SECONDARY, 0.45),
          letterSpacing: '0.03em',
          whiteSpace: 'nowrap',
        }}>&middot; CC-BY-SA 3.0</span>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{
        position: 'relative',
        minHeight: 0,
        padding: '1px 7px',
        fontSize: '11px',
        fontFamily: FONT_FAMILY,
        background: 'transparent',
        border: `1px solid ${rgba(PRIMARY, 0.4)}`,
        color: PRIMARY,
        letterSpacing: '0.05em',
        lineHeight: '16px',
      }}>&#10005;</div>
    </div>
  );
}

function EntryHeader({ name, badge }: { name: string; badge: string }) {
  return (
    <div style={{
      padding: '12px 14px 8px',
      borderBottom: `1px solid ${rgba(PRIMARY, 0.12)}`,
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      flexWrap: 'wrap',
      flexShrink: 0,
    }}>
      <span style={{
        fontSize: '15px',
        fontWeight: 'bold',
        color: PRIMARY,
        flex: 1,
        minWidth: 0,
        wordBreak: 'break-word',
        textShadow: `0 0 6px ${rgba(PRIMARY, 0.5)}`,
        fontFamily: FONT_FAMILY,
        letterSpacing: '0.04em',
      }}>{name}</span>
      <span style={{
        flexShrink: 0,
        fontSize: '9px',
        letterSpacing: '0.08em',
        fontWeight: 'bold',
        padding: '2px 6px',
        border: `1px solid ${PRIMARY}`,
        color: PRIMARY,
        background: rgba(PRIMARY, 0.1),
        fontFamily: FONT_FAMILY,
      }}>{badge}</span>
    </div>
  );
}

function ActionsBar() {
  const btn: React.CSSProperties = {
    minHeight: 0,
    padding: '4px 12px',
    fontSize: '10px',
    fontFamily: FONT_FAMILY,
    background: 'transparent',
    border: `1px solid ${rgba(PRIMARY, 0.4)}`,
    color: PRIMARY,
    letterSpacing: '0.05em',
  };
  return (
    <div style={{
      borderTop: `1px solid ${BORDER_FAINT}`,
      padding: '8px 12px',
      display: 'flex',
      gap: '6px',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      background: CHROME_RGBA,
    }}>
      <div style={btn}>SHARE TO CHAT</div>
      <div style={btn}>VIEW ARTICLE &#8599;</div>
      <div style={btn}>COPY LINK</div>
    </div>
  );
}

// ── Toilet paper panel ────────────────────────────────────────────────────────

const TP_STATS: Array<{ label: string; value: string }> = [
  { label: 'TYPE',       value: 'Junk' },
  { label: 'COMPONENTS', value: 'Cloth ×1' },
  { label: 'VALUE',      value: '1' },
  { label: 'WEIGHT',     value: '0.25' },
];

interface TpLocRow {
  text: string;
  link: boolean;
  isRedRocket: boolean;
}

const TP_LOCATIONS: TpLocRow[] = [
  { text: 'Whitespring Robo Butler Collectron station', link: false, isRedRocket: false },
  { text: 'Restrooms all across Appalachia',            link: false, isRedRocket: false },
  { text: '12 in open safe near Valley Galleria ↗',    link: true,  isRedRocket: false },
  { text: '8 at Red Rocket Mega Stop ↗',               link: true,  isRedRocket: true  },
  { text: '7 at Van Lowe Taxidermy ↗',                 link: true,  isRedRocket: false },
  { text: '7 in cabins near Whitespring Resort ↗',     link: true,  isRedRocket: false },
];

function TpWikiPanel({
  scrollY,
  highlightRedRocket,
  redRocketClickPulse,
}: {
  scrollY: number;
  highlightRedRocket: boolean;
  redRocketClickPulse: number;
}) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
      position: 'relative',
    }}>
      <WikiChrome />

      <div style={{ flex: 1, overflowY: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {/* Scrollable content */}
        <div style={{ transform: `translateY(${scrollY}px)` }}>
          <EntryHeader name="Toilet paper" badge="ITEM" />

          {/* Item image */}
          <div style={{
            padding: '8px 14px',
            borderBottom: `1px solid ${rgba(PRIMARY, 0.08)}`,
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'center',
          }}>
            <div style={{
              width: 80,
              height: 80,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: rgba('#000', 0.35),
              border: `1px solid ${rgba(PRIMARY, 0.12)}`,
              overflow: 'hidden',
            }}>
              <Img
                src={staticFile('tp-item.webp')}
                style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }}
              />
            </div>
          </div>

          {/* Stat grid */}
          <div style={{
            padding: '8px 14px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            columnGap: '16px',
            rowGap: '1px',
            alignContent: 'start',
            flexShrink: 0,
          }}>
            {TP_STATS.map((row) => (
              <StatCell key={row.label} label={row.label} value={row.value} />
            ))}
          </div>

          {/* Locations list */}
          <div style={{
            padding: '8px 14px 10px',
            borderTop: `1px solid ${rgba(PRIMARY, 0.08)}`,
            flexShrink: 0,
          }}>
            <div style={{
              fontSize: '9px',
              fontWeight: 'bold',
              letterSpacing: '0.1em',
              color: DIM,
              textTransform: 'uppercase',
              marginBottom: '6px',
              fontFamily: MONO,
            }}>LOCATIONS</div>
            <ul style={{ margin: 0, padding: '0 0 0 14px', listStyle: 'disc' }}>
              {TP_LOCATIONS.map((row, i) => {
                const isHighlighted = row.isRedRocket && highlightRedRocket;
                const pulseGlow = row.isRedRocket ? redRocketClickPulse : 0;

                const textColor = isHighlighted
                  ? '#FFE066'
                  : row.link
                  ? PRIMARY
                  : TEXT;

                return (
                  <li key={i} style={{
                    fontSize: '11px',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                    paddingBottom: '2px',
                    lineHeight: 1.4,
                    color: textColor,
                    fontFamily: FONT_FAMILY,
                    textDecoration: row.link ? 'underline' : 'none',
                    textUnderlineOffset: '2px',
                    textShadow: isHighlighted
                      ? `0 0 ${4 + pulseGlow * 8}px ${rgba('#FFE066', 0.5 + pulseGlow * 0.4)}`
                      : row.link
                      ? `0 0 4px ${rgba(PRIMARY, 0.35)}`
                      : 'none',
                    fontWeight: isHighlighted ? 'bold' : 'normal',
                  }}>
                    {row.text}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>

      <ActionsBar />
    </div>
  );
}

// ── Red Rocket Mega Stop panel ────────────────────────────────────────────────

const RR_STATS: Array<{ label: string; value: string }> = [
  { label: 'TYPE',      value: 'Workshop' },
  { label: 'PART OF',   value: 'Savage Divide, Appalachia' },
  { label: 'OWNERS',    value: 'Red Rocket (pre-War)' },
  { label: 'CREATURES', value: 'Scorched, Super mutants' },
];

function RrWikiPanel() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
      position: 'relative',
    }}>
      <WikiChrome />

      <div style={{ flex: 1, overflowY: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <EntryHeader name="Red Rocket Mega Stop" badge="LOCATION" />

        {/* Location image — wide aspect */}
        <div style={{
          padding: '8px 14px',
          borderBottom: `1px solid ${rgba(PRIMARY, 0.08)}`,
          flexShrink: 0,
        }}>
          <div style={{
            height: 100,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: rgba('#000', 0.35),
            border: `1px solid ${rgba(PRIMARY, 0.12)}`,
            overflow: 'hidden',
          }}>
            <Img
              src={staticFile('rr-megastop.webp')}
              style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'cover', width: '100%' }}
            />
          </div>
        </div>

        {/* Stat grid */}
        <div style={{
          padding: '8px 14px',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          columnGap: '16px',
          rowGap: '1px',
          alignContent: 'start',
          flexShrink: 0,
        }}>
          {RR_STATS.map((row) => (
            <StatCell key={row.label} label={row.label} value={row.value} />
          ))}
        </div>

        {/* Map thumbnail — glows on click */}
        <div style={{
          padding: '8px 14px 10px',
          borderTop: `1px solid ${rgba(PRIMARY, 0.08)}`,
          flexShrink: 0,
        }}>
          <div style={{
            fontSize: '9px',
            fontWeight: 'bold',
            letterSpacing: '0.1em',
            color: DIM,
            textTransform: 'uppercase',
            marginBottom: '6px',
            fontFamily: MONO,
          }}>MAP</div>
          <div style={{
            display: 'inline-block',
            border: `1px solid ${rgba(PRIMARY, 0.35)}`,
            overflow: 'hidden',
          }}>
            <Img
              src={staticFile('rr-megastop-map.webp')}
              style={{ display: 'block', maxWidth: 140, maxHeight: 80, objectFit: 'contain' }}
            />
          </div>
        </div>
      </div>

      <ActionsBar />
    </div>
  );
}

// ── Main composition ──────────────────────────────────────────────────────────

export function WikiFlowGif() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Phase boundaries (frames) ────────────────────────────────────────────
  const TYPE_START      = 55;
  const TYPE_CMD        = '/wiki Toilet paper';
  const TYPE_ANIM_END   = 100;
  const AC_START        = 100;
  const SELECT_START    = 145;
  const SELECT_END      = 155;
  const PANEL_START     = 155;
  const SCROLL_START    = 270;
  const SCROLL_END      = 330;
  const CLICK_START     = 370;
  const CLICK_END       = 375;
  const LOC_PANEL_START = 375;

  // ── Input bar state ───────────────────────────────────────────────────────
  let inputText = '';
  let showCursor = false;
  let flash = false;

  if (frame < TYPE_START) {
    inputText = '';
    showCursor = false;
  } else if (frame <= TYPE_ANIM_END) {
    // Typewriter: spread 18 chars over 45 frames
    const elapsed = frame - TYPE_START;
    const totalFrames = TYPE_ANIM_END - TYPE_START;
    const progress = totalFrames > 0 ? elapsed / totalFrames : 1;
    const visible = Math.min(TYPE_CMD.length, Math.ceil(progress * TYPE_CMD.length));
    inputText = TYPE_CMD.slice(0, visible);
    showCursor = visible >= TYPE_CMD.length;
  } else if (frame < SELECT_START) {
    // Autocomplete open
    inputText = TYPE_CMD;
    showCursor = true;
  } else if (frame < SELECT_END) {
    // Tab pressed — flash
    inputText = '';
    showCursor = false;
    flash = true;
  } else {
    inputText = '';
    showCursor = false;
  }

  // ── Chat feed opacity — 0.9 normally, dims to 0.3 during AC, 0 once panel opens ──
  const chatFeedOpacity: number = (() => {
    if (frame >= PANEL_START) return 0;
    if (frame >= AC_START) {
      return interpolate(frame, [AC_START, AC_START + 8], [0.9, 0.3], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
    }
    return 0.9;
  })();

  // ── Autocomplete ──────────────────────────────────────────────────────────
  const showAc = frame >= AC_START && frame < SELECT_END;
  const acOpacity = interpolate(frame, [AC_START, AC_START + 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const acSlide = interpolate(frame, [AC_START, AC_START + 12], [8, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // ── Wiki panel (Toilet paper) slide-in ───────────────────────────────────
  const showTpPanel = frame >= PANEL_START;
  const panelSlide = spring({
    frame: frame - PANEL_START,
    fps,
    config: { damping: 18, stiffness: 120 },
  });
  const panelX = interpolate(panelSlide, [0, 1], [320, 0]);
  const panelOpacity = interpolate(frame, [PANEL_START, PANEL_START + 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // ── Scroll animation ──────────────────────────────────────────────────────
  const scrollProgress = interpolate(frame, [SCROLL_START, SCROLL_END], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const scrollY = interpolate(scrollProgress, [0, 1], [0, -110]);

  // ── Red Rocket highlight (frames 330+) ────────────────────────────────────
  const highlightRedRocket = frame >= SCROLL_END;

  // ── Red Rocket click pulse (frames 370–375) ───────────────────────────────
  const redRocketClickPulse = interpolate(frame, [CLICK_START, CLICK_END], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // ── Location panel (Red Rocket) ───────────────────────────────────────────
  const showRrPanel  = frame >= LOC_PANEL_START;
  const locPanelOpacity = interpolate(
    frame,
    [LOC_PANEL_START, LOC_PANEL_START + 15],
    [0, 1],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  const WIN_W = 480;
  const WIN_H = 540;

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
          Fallout 76 Wiki Search, In Overlay
        </div>
        <div style={{ fontSize: 9, color: rgba(SECONDARY, 0.65), letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: DISPLAY_FONT_FAMILY }}>
          Type /wiki &lt;anything&gt; or /camp &lt;item&gt; — results appear instantly
        </div>
        <div style={{ width: 180, height: 1, background: `linear-gradient(to right, transparent, ${rgba(PRIMARY, 0.45)}, transparent)`, marginTop: 2 }} />
      </div>
      <div style={{ width: WIN_W, height: WIN_H, flexShrink: 0 }}>
      <OverlayWindow width={WIN_W} height={WIN_H} activeMain="fo76" activeSub="general">
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>

          {/* ── Main content area ── */}
          <div style={{
            flex: 1,
            overflow: 'hidden',
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
          }}>

            {/* Chat feed — fades out when AC opens, hidden when panel opens */}
            {chatFeedOpacity > 0 && (
              <ChatFeed opacity={chatFeedOpacity} />
            )}

            {/* Toilet paper wiki panel — visible from frame 155, fades out under RR transition */}
            {showTpPanel && (
              <div style={{
                position: 'absolute',
                inset: 0,
                transform: showRrPanel ? 'none' : `translateX(${panelX}px)`,
                opacity: showRrPanel
                  ? Math.max(0, 1 - locPanelOpacity)
                  : panelOpacity,
                background: rgba(BG, 0.97),
                zIndex: 10,
                pointerEvents: 'none',
              }}>
                <TpWikiPanel
                  scrollY={scrollY}
                  highlightRedRocket={highlightRedRocket}
                  redRocketClickPulse={redRocketClickPulse}
                />
              </div>
            )}

            {/* Red Rocket wiki panel — fades in over TP panel */}
            {showRrPanel && (
              <div style={{
                position: 'absolute',
                inset: 0,
                opacity: locPanelOpacity,
                background: rgba(BG, 0.97),
                zIndex: 11,
              }}>
                <RrWikiPanel />
              </div>
            )}

          </div>

          {/* ── Input bar — chrome row matching tab header style ── */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            {showAc && (
              <div style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                right: 0,
                zIndex: 101,
              }}>
                <AutocompleteDropdown opacity={acOpacity} slideY={acSlide} />
              </div>
            )}
            <InputBar text={inputText} showCursor={showCursor} flash={flash} />
          </div>

        </div>
      </OverlayWindow>
      </div>
    </AbsoluteFill>
  );
}
