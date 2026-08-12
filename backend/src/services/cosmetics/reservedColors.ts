/**
 * Colours users may never pick for their chat name.
 *
 * Before this module there was no shared source of truth: ROLE_COLORS lived
 * unexported in Profile.tsx, theme primaries lived in ChatOverlay's THEMES array, and
 * the channel-tag colours were inline literals. The catalog, the validator and the
 * frontend picker all need the same list, so it lives here and is served to the
 * frontend as part of GET /api/cosmetics/catalog.
 *
 * Two distinct reasons a colour is reserved:
 *   1. IMPERSONATION — role colours. A user whose name renders in moderator green or
 *      owner gold can pass themselves off as staff. This is the important one.
 *   2. AMBIGUITY — theme primaries and channel-tag colours. A name in the exact theme
 *      primary is indistinguishable from system text; a name in the Discord tag purple
 *      reads as channel chrome.
 */

/** Exclusion radius in RGB euclidean distance. Colours nearer than this are rejected. */
export const RESERVED_MIN_DISTANCE = 70;

export interface ReservedColor {
  hex: string;
  label: string;
  reason: 'impersonation' | 'ambiguity';
}

export const RESERVED_COLORS: readonly ReservedColor[] = [
  // ── Role colours (impersonation risk) ──────────────────────────────────────
  { hex: '#50C878', label: 'Moderator green', reason: 'impersonation' },
  { hex: '#FFB000', label: 'Owner gold', reason: 'impersonation' },
  { hex: '#d4b040', label: 'Admin gold (phosphor)', reason: 'impersonation' },
  // Discord brand blurple. Reserved rather than assigned to the supporter tier: it is
  // used as the literal Discord brand colour across a dozen frontend surfaces, so a
  // name in it reads as a Discord affordance rather than a supporter.
  { hex: '#5865F2', label: 'Discord blurple', reason: 'ambiguity' },

  // ── Theme primaries (system-text ambiguity) ────────────────────────────────
  { hex: '#F5CB5B', label: 'Theme primary — FO76 Wasteland', reason: 'ambiguity' },
  { hex: '#18FF62', label: 'Theme primary — Vault-Tec Green', reason: 'ambiguity' },
  { hex: '#F0F0F0', label: 'Theme primary — White', reason: 'ambiguity' },
  // '#FFB000' is also the Amber theme primary — already listed above as owner gold.

  // ── Channel tag colours (chrome ambiguity) ─────────────────────────────────
  { hex: '#B57AFF', label: 'Discord channel tag', reason: 'ambiguity' },
  { hex: '#1ABAFF', label: 'General channel', reason: 'ambiguity' },
  { hex: '#008F37', label: 'Trading channel', reason: 'ambiguity' },
  { hex: '#C88A51', label: 'Events channel', reason: 'ambiguity' },
  { hex: '#5ABD0A', label: 'Infests channel', reason: 'ambiguity' },
  { hex: '#CE0909', label: 'Raids channel', reason: 'ambiguity' },
  { hex: '#ECBB51', label: 'Server channel', reason: 'ambiguity' },
] as const;

function parse(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Euclidean RGB distance. Crude versus CIEDE2000, but predictable and good enough. */
export function colorDistance(a: string, b: string): number {
  const A = parse(a);
  const B = parse(b);
  if (!A || !B) return Number.POSITIVE_INFINITY;
  return Math.sqrt((A.r - B.r) ** 2 + (A.g - B.g) ** 2 + (A.b - B.b) ** 2);
}

/**
 * The reserved colour this hex is too close to, or null when it is safely distinct.
 * Returning the match (not just a boolean) lets the picker tell the user WHY.
 */
export function findReservedConflict(hex: string): ReservedColor | null {
  let closest: ReservedColor | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const reserved of RESERVED_COLORS) {
    const d = colorDistance(hex, reserved.hex);
    if (d < closestDistance) {
      closestDistance = d;
      closest = reserved;
    }
  }
  return closestDistance < RESERVED_MIN_DISTANCE ? closest : null;
}

/** True when the colour is far enough from every reserved colour. */
export function isColorAllowed(hex: string): boolean {
  return findReservedConflict(hex) === null;
}

export default { RESERVED_COLORS, RESERVED_MIN_DISTANCE, colorDistance, findReservedConflict, isColorAllowed };
module.exports = { RESERVED_COLORS, RESERVED_MIN_DISTANCE, colorDistance, findReservedConflict, isColorAllowed };
module.exports.default = module.exports;
