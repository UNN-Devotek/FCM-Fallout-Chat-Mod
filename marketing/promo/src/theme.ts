/**
 * Pip-Boy "fo76-wasteland" theme — single source of truth for all Remotion
 * marketing compositions. Values are sampled directly from the live overlay
 * (ChatOverlay.tsx THEMES[0] id='fo76-wasteland') and the in-game Fallout 76
 * UI palette.
 */

// ── Core colours ─────────────────────────────────────────────────────────────

/** Warm near-black window background (bgAlpha 0.941 in the live overlay). */
export const BG = '#0A0907';

/** Chrome / titlebar / tab-row background (chromeAlpha 0.980). */
export const CHROME = '#0C0A08';

/**
 * Primary amber-gold — sampled from in-game FO76 header text (#F5CB5B).
 * Used for active tab text, borders, status dots, highlights.
 */
export const PRIMARY = '#F5CB5B';

/**
 * Secondary amber — dimmer version of primary used for inactive-tab text,
 * faint borders, and decorative lines.
 */
export const SECONDARY = '#C9A84E';

/**
 * Warm off-white text — pushed slightly brighter than the game avg (#E1DDCB)
 * toward its highlight (#FFFFCB) for legibility over dark backgrounds.
 */
export const TEXT = '#FAF4DA';

/** Active tab text color (dark so it reads on the filled amber gradient). */
export const ACTIVE_TAB_TEXT = '#120D00';

/** Top of the active-tab fill gradient. */
export const ACTIVE_GRAD_TOP = '#F5CB5B';

/** Bottom of the active-tab fill gradient. */
export const ACTIVE_GRAD_BOTTOM = '#6A4808';

/** Input field text color. */
export const INPUT_TEXT = '#F3ECCF';

/** Input field background. */
export const INPUT_BG = '#0A0907';

// ── Alpha helpers ─────────────────────────────────────────────────────────────

/** Render a hex color at the given 0-1 alpha as an rgba() string. */
export function rgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

/** Window background with overlay alpha (0.941). */
export const BG_RGBA = rgba(BG, 0.941);

/** Chrome background with overlay alpha (0.980). */
export const CHROME_RGBA = rgba(CHROME, 0.98);

/** Active tab border at 50% alpha. */
export const TAB_BORDER = rgba(PRIMARY, 0.5);

/** Inactive sub-tab text at 50% alpha of SECONDARY. */
export const INACTIVE_TAB = rgba(SECONDARY, 0.5);

/** Divider lines (primary at 45%). */
export const DIVIDER = rgba(PRIMARY, 0.45);

// ── Typography ────────────────────────────────────────────────────────────────

/** Same font stack used in the live overlay for fo76-wasteland. */
export const FONT_FAMILY = 'Segoe UI, system-ui, sans-serif';

/**
 * Display / hero font — bold serif matching the FCM app icon (icon-1024.png).
 * The icon uses Georgia Bold; this stack falls back through other classic serifs.
 * Used for the large "FCM" monogram and any marquee headings in marketing stills.
 */
export const DISPLAY_FONT_FAMILY = 'Georgia, "Palatino Linotype", Palatino, "Book Antiqua", "Times New Roman", serif';

/** Base font size (px) — matches overlay default. */
export const FONT_SIZE = 11;

/** Tab letter spacing — tighter than default to match condensed Pip-Boy look. */
export const TAB_LETTER_SPACING = '0.04em';

// ── Scanline overlay ──────────────────────────────────────────────────────────

/**
 * CSS for a faint CRT-style scanline effect as a repeating-linear-gradient.
 * fo76-wasteland has scanlinesEnabled=false in the live overlay, but we enable
 * a very faint version in marketing stills for visual depth.
 */
export const SCANLINE_GRADIENT =
  'repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px)';

// ── Convenience object (for spread into style props) ──────────────────────────

export const THEME = {
  BG,
  CHROME,
  PRIMARY,
  SECONDARY,
  TEXT,
  ACTIVE_TAB_TEXT,
  ACTIVE_GRAD_TOP,
  ACTIVE_GRAD_BOTTOM,
  INPUT_TEXT,
  INPUT_BG,
  BG_RGBA,
  CHROME_RGBA,
  TAB_BORDER,
  INACTIVE_TAB,
  DIVIDER,
  FONT_FAMILY,
  DISPLAY_FONT_FAMILY,
  FONT_SIZE,
  TAB_LETTER_SPACING,
  SCANLINE_GRADIENT,
  rgba,
} as const;
