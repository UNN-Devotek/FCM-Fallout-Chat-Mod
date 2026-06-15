/**
 * WikiPageStill — 480×690 still of the in-overlay wiki panel open on "The Fixer".
 */

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, staticFile } from 'remotion';
import { OverlayWindow } from './OverlayWindow';
import { FIXER_ENTRY } from './content';
import {
  PRIMARY,
  SECONDARY,
  TEXT,
  CHROME_RGBA,
  BG,
  FONT_FAMILY,
  DISPLAY_FONT_FAMILY,
  SCANLINE_GRADIENT,
  rgba,
} from './theme';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Dim version of the secondary colour — mirrors `dimText` in the live panel. */
const DIM = rgba(SECONDARY, 0.85);

/** Very faint amber border used throughout the live panel. */
const BORDER_FAINT = rgba(PRIMARY, 0.35);

/** Monospace font for labels — same fallback chain as the live overlay. */
const MONO = '"Courier New", Courier, monospace';

// ── Sample location data for The Fixer ────────────────────────────────────────

interface LocationSeg {
  text: string;
  title?: string; // present → gold hyperlink
}

type LocationRow = LocationSeg[];

const FIXER_LOCATIONS: LocationRow[] = [
  [{ text: 'Encryptid ', }, { text: 'event reward', title: 'Encryptid' }],
  [{ text: 'Loot from ', }, { text: 'Eviction Notice', title: 'Eviction Notice' }, { text: ' event' }],
  [{ text: 'Player vendors across ', }, { text: 'Appalachia', title: 'Appalachia' }],
  [{ text: 'Reward: ', }, { text: 'Daily Ops', title: 'Daily Ops' }],
  [{ text: 'Found in ', }, { text: 'Whitespring Resort', title: 'Whitespring Resort' }],
];

// ── Stat rows ─────────────────────────────────────────────────────────────────

interface StatRow {
  key: string;
  label: string;
  value: string;
}

function buildStatRows(): StatRow[] {
  const f = FIXER_ENTRY.fields;
  const order: Array<[string, string]> = [
    ['damage',      'Damage'],
    ['level',       'Level'],
    ['ap used',     'AP Used'],
    ['range',       'Range'],
    ['accuracy',    'Accuracy'],
    ['crit',        'Crit'],
    ['ammo',        'Ammo'],
    ['value',       'Value'],
    ['weight',      'Weight'],
    ['clip size',   'Clip Size'],
    ['fire rate',   'Fire Rate'],
    ['reload time', 'Reload'],
    ['base type',   'Base Type'],
    ['formid',      'Form ID'],
  ];
  return order
    .filter(([k]) => f[k] != null)
    .map(([k, label]) => ({ key: k, label, value: f[k] }));
}

const STAT_ROWS = buildStatRows();

// ── Sub-components ────────────────────────────────────────────────────────────

/** One stat cell — label left (dim mono), value right. */
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

/** Chrome header — ◈ FALLOUT WIKI centered, ✕ close right. */
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
      {/* Centered title */}
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
      {/* Spacer pushes close button to the right */}
      <div style={{ flex: 1 }} />
      {/* ✕ close button */}
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

/** Entry name + WEAPON badge — mirrors the entry header in the live panel. */
function EntryHeader() {
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
      }}>{FIXER_ENTRY.name}</span>
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
      }}>WEAPON</span>
    </div>
  );
}

/** Weapon image strip — ultrawide aspect, faux-image with gold-tinted frame. */
function WeaponImage() {
  return (
    <div style={{
      padding: '10px 14px',
      borderBottom: `1px solid ${rgba(PRIMARY, 0.08)}`,
      flexShrink: 0,
    }}>
      <div style={{
        position: 'relative',
        height: '100px',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        background: rgba('#000', 0.35),
        border: `1px solid ${rgba(PRIMARY, 0.12)}`,
        overflow: 'hidden',
      }}>
        <img
          src={staticFile('fixer-nobg.png')}
          alt={FIXER_ENTRY.name}
          style={{
            maxHeight: '100%',
            maxWidth: '100%',
            objectFit: 'contain',
            background: 'transparent',
          }}
        />
        {/* Subtle vignette over the image */}
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to right, rgba(10,9,7,0.35) 0%, transparent 20%, transparent 80%, rgba(10,9,7,0.35) 100%)',
          pointerEvents: 'none',
        }} />
      </div>

      {/* Carousel dots — 3 faux dots, dot 0 active */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '5px',
        marginTop: '7px',
      }}>
        {[0, 1, 2].map(i => (
          <div
            key={i}
            style={{
              width:  i === 0 ? '8px' : '6px',
              height: i === 0 ? '8px' : '6px',
              borderRadius: '50%',
              background: i === 0 ? PRIMARY : rgba(PRIMARY, 0.3),
              flexShrink: 0,
            }}
          />
        ))}
        <span style={{
          fontSize: '9px',
          color: DIM,
          letterSpacing: '0.05em',
          marginLeft: '4px',
          fontFamily: MONO,
        }}>1 / 3</span>
      </div>
    </div>
  );
}

/** Two-column stat grid — mirrors the CSS grid in the live panel. */
function StatGrid() {
  return (
    <div style={{
      padding: '8px 14px',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      columnGap: '16px',
      rowGap: '1px',
      alignContent: 'start',
      flexShrink: 0,
    }}>
      {STAT_ROWS.map(row => (
        <StatCell key={row.key} label={row.label} value={row.value} />
      ))}
    </div>
  );
}

/** LOCATIONS list with gold underlined hyperlinks. */
function LocationsList() {
  return (
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
        {FIXER_LOCATIONS.map((segs, i) => (
          <li key={i} style={{
            fontSize: '11px',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            paddingBottom: '2px',
            lineHeight: 1.4,
            color: TEXT,
            fontFamily: FONT_FAMILY,
          }}>
            {segs.map((seg, si) =>
              seg.title != null ? (
                <span
                  key={si}
                  style={{
                    color: PRIMARY,
                    textDecoration: 'underline',
                    textUnderlineOffset: '2px',
                    cursor: 'pointer',
                    textShadow: `0 0 4px ${rgba(PRIMARY, 0.35)}`,
                  }}
                >{seg.text}</span>
              ) : (
                <span key={si}>{seg.text}</span>
              )
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Actions bar — mirrors the bottom chrome of the live panel. */
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

// ── Callout badge — centered above the card ───────────────────────────────────

function CalloutBadge() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '6px',
      pointerEvents: 'none',
      marginBottom: '18px',
    }}>
      {/* Main callout text */}
      <div style={{
        textAlign: 'center',
        fontFamily: DISPLAY_FONT_FAMILY,
      }}>
        <div style={{
          fontSize: '22px',
          fontWeight: 'bold',
          color: PRIMARY,
          letterSpacing: '0.05em',
          textShadow: `0 0 20px ${rgba(PRIMARY, 0.6)}, 0 0 6px ${rgba(PRIMARY, 0.4)}`,
          lineHeight: 1.15,
        }}>Full Fallout 76 Wiki, In Overlay.</div>
      </div>

      {/* Sub-label */}
      <div style={{
        fontSize: '11px',
        color: rgba(SECONDARY, 0.7),
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        fontFamily: DISPLAY_FONT_FAMILY,
        textAlign: 'center',
      }}>Type /wiki &lt;anything&gt; in chat</div>

      {/* Decorative line */}
      <div style={{
        width: '220px',
        height: '1px',
        background: `linear-gradient(to right, transparent, ${rgba(PRIMARY, 0.5)}, transparent)`,
        marginTop: '2px',
      }} />
    </div>
  );
}

// ── Wiki panel body ───────────────────────────────────────────────────────────

function WikiPanelBody() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
      position: 'relative',
    }}>
      <WikiChrome />

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <EntryHeader />
        <WeaponImage />
        <StatGrid />
        <LocationsList />
      </div>

      <ActionsBar />
    </div>
  );
}

// ── Root composition ──────────────────────────────────────────────────────────

export function WikiPageStill() {
  // Referenced to satisfy Remotion's hook usage requirement.
  void useCurrentFrame();
  const { width, height } = useVideoConfig();

  const WIN_W = 480;
  const WIN_H = 620;

  return (
    <AbsoluteFill style={{
      fontFamily: FONT_FAMILY,
      overflow: 'hidden',
      backgroundColor: '#070605',
      backgroundImage: 'radial-gradient(ellipse 75% 70% at 50% 55%, #1a150a 0%, #07060500 100%)',
    }}>

      {/* Very faint amber grid lines */}
      <div style={{
        position: 'absolute',
        inset: 0,
        backgroundImage: [
          'linear-gradient(rgba(197,160,50,0.025) 1px, transparent 1px)',
          'linear-gradient(90deg, rgba(197,160,50,0.025) 1px, transparent 1px)',
        ].join(', '),
        backgroundSize: '40px 40px',
        pointerEvents: 'none',
      }} />

      {/* Scanline overlay */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: SCANLINE_GRADIENT,
        pointerEvents: 'none',
        opacity: 0.35,
      }} />

      {/* Callout above card — both centered horizontally as a flex column */}
      <div style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <CalloutBadge />

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
            showParty
          >
            <WikiPanelBody />
          </OverlayWindow>
        </div>
      </div>

      {/* Bottom-left attribution watermark */}
      <div style={{
        position: 'absolute',
        bottom: '18px',
        left: '24px',
        fontSize: '9px',
        color: rgba(SECONDARY, 0.35),
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        fontFamily: FONT_FAMILY,
      }}>
        {FIXER_ENTRY.attribution}
      </div>
    </AbsoluteFill>
  );
}
