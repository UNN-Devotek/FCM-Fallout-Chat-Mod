/**
 * Pure colour maths for cosmetic validation — WCAG relative luminance and contrast.
 *
 * Used to keep every catalog colour legible on the surfaces it can appear on, and to
 * bound the user-facing HSL picker. Kept dependency-free so the catalog assertions run
 * under node:test without pulling in Prisma.
 */

export interface Rgb { r: number; g: number; b: number }

/**
 * Backgrounds a chat name is rendered against. Contrast must hold on ALL of them.
 *
 * Note on the transparent overlay: it floats over arbitrary game content, so the
 * literal backdrop can be any colour at all. Checking against a mid-grey would be the
 * naive reading — but it is the wrong model and would reject essentially every usable
 * colour. Every surface paints a multi-layer black outline immediately behind the
 * glyph (ChatOverlay `textOutline`, and the in-game widget's own panel), so the
 * colour the glyph is actually read against is that outline, not the scene behind it.
 * We therefore check the real dark surfaces plus pure black.
 */
export const CONTRAST_BACKGROUNDS = {
  /** Dashboard / website panel (--bg-dark). */
  dashboard: '#1e1908',
  /** Slightly lighter panel the message list sits on (--bg-card) — the binding case. */
  dashboardCard: '#322814',
  /** In-game HUD chat panel background (FcmConfig default bgColor). */
  inGame: '#0a0a0a',
  /** The text outline every surface paints behind the glyph. */
  outline: '#000000',
} as const;

/** Parse `#RGB` / `#RRGGBB` (with or without `#`). Returns null when unparseable. */
export function parseHex(hex: string | null | undefined): Rgb | null {
  if (!hex) return null;
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Normalize to lowercase `#rrggbb`, or null when unparseable. */
export function normalizeHex(hex: string | null | undefined): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const to2 = (n: number) => n.toString(16).padStart(2, '0');
  return `#${to2(rgb.r)}${to2(rgb.g)}${to2(rgb.b)}`;
}

/** WCAG 2.x relative luminance (0 = black, 1 = white). */
export function relativeLuminance(rgb: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio between two colours: 1 (identical) → 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return 0;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Worst-case contrast across every background a name can appear on. This is the number
 * the catalog assertion and the live picker badge both use — a colour that reads well
 * on the dashboard but vanishes on a bright in-game scene is not acceptable.
 */
export function worstCaseContrast(hex: string): number {
  const ratios = Object.values(CONTRAST_BACKGROUNDS).map((bg) => contrastRatio(hex, bg));
  return Math.min(...ratios);
}

/**
 * Minimum contrast a name colour must clear, against the WORST of the backgrounds above.
 *
 * WCAG AA is 4.5 for body text and 3.0 for large/bold. Usernames are rendered bold, so
 * 3.0 would be defensible — but chat is dense and scanned quickly, and holding the
 * stricter 4.5 across every surface costs us nothing given the palette is deliberately
 * bright-on-dark to match the Fallout aesthetic.
 */
export const MIN_CONTRAST = 4.5;

/** True when the colour is legible on every surface. */
export function meetsContrastFloor(hex: string): boolean {
  return worstCaseContrast(hex) >= MIN_CONTRAST;
}

// ── HSL, for the bounded picker ───────────────────────────────────────────────

export interface Hsl { h: number; s: number; l: number }

export function hexToHsl(hex: string): Hsl | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s: s * 100, l: l * 100 };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const hn = ((h % 360) + 360) % 360 / 360;
  const sn = Math.min(100, Math.max(0, s)) / 100;
  const ln = Math.min(100, Math.max(0, l)) / 100;
  const hue2rgb = (p: number, q: number, t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (sn === 0) {
    r = g = b = ln;
  } else {
    const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
    const p = 2 * ln - q;
    r = hue2rgb(p, q, hn + 1 / 3);
    g = hue2rgb(p, q, hn);
    b = hue2rgb(p, q, hn - 1 / 3);
  }
  const to2 = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/**
 * Lowest lightness at which (hue, saturation) still clears the contrast floor.
 *
 * A FLAT lightness floor does not work here. Relative luminance weights the channels
 * very unevenly (R 0.2126 / G 0.7152 / B 0.0722), so fully saturated blue at 75%
 * lightness is still illegible while red or green clear the bar far lower. Pinning the
 * picker to the blue-safe value (~76%) would wash out every other hue for no reason.
 *
 * So the picker clamps its lightness slider per-hue using this function, which makes
 * the contrast guarantee hold by construction while leaving reds and greens their full
 * usable range. Binary search over a monotonic function — lightness only ever raises
 * luminance, and all our backgrounds are dark.
 *
 * Returns null when even 100% lightness cannot clear the floor (never happens for our
 * backgrounds, since white clears everything, but the caller should not assume).
 */
export function minLightnessForHue(hue: number, saturation: number): number | null {
  let lo = 0;
  let hi = 100;
  if (worstCaseContrast(hslToHex({ h: hue, s: saturation, l: hi })) < MIN_CONTRAST) return null;
  // 8 iterations gets us inside 0.5% — finer than the slider can express.
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (worstCaseContrast(hslToHex({ h: hue, s: saturation, l: mid })) >= MIN_CONTRAST) hi = mid;
    else lo = mid;
  }
  return Math.ceil(hi);
}

export default {
  CONTRAST_BACKGROUNDS,
  MIN_CONTRAST,
  minLightnessForHue,
  parseHex,
  normalizeHex,
  relativeLuminance,
  contrastRatio,
  worstCaseContrast,
  meetsContrastFloor,
  hexToHsl,
  hslToHex,
};
module.exports = {
  CONTRAST_BACKGROUNDS,
  MIN_CONTRAST,
  minLightnessForHue,
  parseHex,
  normalizeHex,
  relativeLuminance,
  contrastRatio,
  worstCaseContrast,
  meetsContrastFloor,
  hexToHsl,
  hslToHex,
};
module.exports.default = module.exports;
