/**
 * Shared overlay-window chrome for all Remotion marketing compositions.
 *
 * Renders the Pip-Boy two-row tab bar:
 *   Row 1 — main tabs  : "FALLOUT 76" (active, 3-sided bordered box) | "PARTY"
 *   Row 2 — sub tabs   : "GENERAL" (active) | "TRADING" | "EVENTS" | "RAIDS"
 *
 * ALIGNMENT RULE — the left edge of the "FALLOUT 76" bordered box AND the "F"
 * glyph within it must align with the "G" glyph of "GENERAL" below (within
 * ~1 px). This is achieved by:
 *   • main-tab row: paddingLeft = TAB_ALIGN_X
 *   • main-tab box: paddingLeft = 0 (box left ≡ row left ≡ F-glyph x)
 *   • sub-tab row:  paddingLeft = TAB_ALIGN_X  (G-glyph x ≡ TAB_ALIGN_X)
 */

import React from 'react';
import {
  BG,
  CHROME_RGBA,
  PRIMARY,
  SECONDARY,
  TEXT,
  DIVIDER,
  TAB_BORDER,
  INACTIVE_TAB,
  FONT_FAMILY,
  FONT_SIZE,
  TAB_LETTER_SPACING,
  SCANLINE_GRADIENT,
  rgba,
} from './theme';

// ── Geometry constants ────────────────────────────────────────────────────────

/** Left x-coordinate shared by the "F" glyph, box left-edge, and "G" glyph. */
const TAB_ALIGN_X = 16;

/** Height of the main-tab row (matches live overlay shell height). */
const MAIN_ROW_H = 23;

/** Height of the sub-tab row. */
const SUB_ROW_H = 22;

// ── Types ────────────────────────────────────────────────────────────────────

export type MainTab = 'fo76' | 'party';
export type SubTab = 'general' | 'trading' | 'events' | 'infests' | 'raids';

export interface OverlayWindowProps {
  /** Width of the composition canvas. */
  width: number;
  /** Height of the composition canvas. */
  height: number;
  /** Which main tab is active (default: 'fo76'). */
  activeMain?: MainTab;
  /** Which sub-tab is active (default: 'general'). */
  activeSub?: SubTab;
  /** Whether to show the Party main tab at all (default: true). */
  showParty?: boolean;
  /** Body content rendered inside the window (below both tab rows). */
  children?: React.ReactNode;
}

// ── Sub-component: icon buttons (faux refresh / min / close) ─────────────────

function IconButtons({ color }: { color: string }) {
  const iconStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    marginLeft: 2,
    color,
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {/* Refresh */}
      <span style={iconStyle}>
        <svg width="12" height="12" viewBox="-8 -8 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M5.5 -2.5 A5 5 0 1 0 6 2" />
          <path d="M5.5 -5 L5.5 -2.5 L3 -2.5" />
        </svg>
      </span>
      {/* Settings gear */}
      <span style={iconStyle}>
        <svg width="12" height="12" viewBox="-8 -8 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="0" cy="0" r="2.5" />
          <path d="M0 -6 L0 -4 M0 4 L0 6 M-6 0 L-4 0 M4 0 L6 0 M-4.2 -4.2 L-2.8 -2.8 M2.8 2.8 L4.2 4.2 M4.2 -4.2 L2.8 -2.8 M-2.8 2.8 L-4.2 4.2" />
        </svg>
      </span>
      {/* Minimize */}
      <span style={iconStyle}>
        <svg width="12" height="12" viewBox="-8 -8 16 16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <line x1="-5" y1="0" x2="5" y2="0" />
        </svg>
      </span>
      {/* Close */}
      <span style={{ ...iconStyle, color: rgba('#FF6644', 0.85) }}>
        <svg width="12" height="12" viewBox="-8 -8 16 16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <line x1="-4.5" y1="-4.5" x2="4.5" y2="4.5" />
          <line x1="4.5" y1="-4.5" x2="-4.5" y2="4.5" />
        </svg>
      </span>
    </div>
  );
}

// ── Sub-component: live status dot ───────────────────────────────────────────

function StatusDot({ color }: { color: string }) {
  return (
    <span style={{
      width: 5,
      height: 5,
      borderRadius: '50%',
      background: color,
      boxShadow: `0 0 4px ${color}`,
      display: 'inline-block',
      marginRight: 4,
      flexShrink: 0,
    }} />
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function OverlayWindow({
  width,
  height,
  activeMain = 'fo76',
  activeSub = 'general',
  showParty = true,
  children,
}: OverlayWindowProps) {
  const mainTabs: Array<{ id: MainTab; label: string }> = [
    { id: 'fo76', label: 'Fallout 76' },
    ...(showParty ? [{ id: 'party' as MainTab, label: 'Party' }] : []),
  ];

  const subTabs: Array<{ id: SubTab; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'trading', label: 'Trading' },
    { id: 'events', label: 'Events' },
    { id: 'infests', label: 'Infests' },
    { id: 'raids', label: 'Raids' },
  ];

  const primaryText = rgba(PRIMARY, 0.9);
  const inactiveTabText = rgba(SECONDARY, 0.72 * 0.9);

  return (
    <div style={{
      width,
      height,
      background: BG,
      fontFamily: FONT_FAMILY,
      color: TEXT,
      fontSize: FONT_SIZE,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      position: 'relative',
    }}>

      {/* ── Row 1: main tabs + status dot + icon buttons ── */}
      {/* Active tab uses marginBottom=-1 to cover the row's borderBottom beneath it. */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'nowrap',
        padding: `0 6px 0 ${TAB_ALIGN_X}px`,
        height: MAIN_ROW_H,
        background: 'transparent',
        borderBottom: `1px solid ${DIVIDER}`,
        flexShrink: 0,
        gap: 0,
      }}>
        {mainTabs.map(tab => {
          const isActive = tab.id === activeMain;
          return (
            <div key={tab.id} style={{
              height: 20,
              alignSelf: 'flex-end',
              padding: '0 9px 0 6px',
              marginRight: 4,
              marginBottom: -1,
              fontSize: FONT_SIZE,
              fontWeight: 'bold',
              letterSpacing: TAB_LETTER_SPACING,
              color: isActive ? primaryText : inactiveTabText,
              background: isActive ? BG : 'transparent',
              borderTop: isActive ? `1px solid ${TAB_BORDER}` : '1px solid transparent',
              borderLeft: isActive ? `1px solid ${TAB_BORDER}` : '1px solid transparent',
              borderRight: isActive ? `1px solid ${TAB_BORDER}` : '1px solid transparent',
              borderBottom: 'none',
              textTransform: 'uppercase',
              userSelect: 'none',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              boxSizing: 'border-box',
            }}>
              {tab.label}
            </div>
          );
        })}

        {/* Push right-side elements to the far right */}
        <div style={{ flex: 1 }} />

        <StatusDot color={PRIMARY} />
        <IconButtons color={primaryText} />
      </div>

      {/* ── Row 2: sub-tabs (shown when on fo76 main tab) ── */}
      {activeMain === 'fo76' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          // +6: inner padding of the main-tab box, so G-glyph aligns with F-glyph.
          padding: `0 6px 0 ${TAB_ALIGN_X + 6}px`,
          height: SUB_ROW_H,
          boxSizing: 'border-box',
          background: CHROME_RGBA,
          borderBottom: `1px solid ${DIVIDER}`,
          flexShrink: 0,
        }}>
          {subTabs.map(sub => {
            const isActive = sub.id === activeSub;
            return (
              <span key={sub.id} style={{
                fontSize: Math.max(8, FONT_SIZE - 1),
                letterSpacing: TAB_LETTER_SPACING,
                color: isActive ? primaryText : inactiveTabText,
                fontWeight: 'bold',
                textTransform: 'uppercase',
                marginRight: 12,
                borderBottom: 'none',
                paddingBottom: 1,
                userSelect: 'none',
                whiteSpace: 'nowrap',
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
              }}>
                {sub.label}
              </span>
            );
          })}
        </div>
      )}

      {/* ── Body content slot ── */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {children}
      </div>

      {/* ── Scanline overlay (very faint, for visual depth) ── */}
      <div style={{
        position: 'absolute',
        inset: 0,
        background: SCANLINE_GRADIENT,
        pointerEvents: 'none',
        opacity: 0.4,
      }} />
    </div>
  );
}
