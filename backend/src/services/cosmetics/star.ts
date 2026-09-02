/**
 * The supporter marker contract.
 *
 * The star is identity chrome, not user text: only this constant may provide its
 * glyph. Colours are separately configurable through catalog preset ids.
 */
export const SUPPORTER_STAR_GLYPH = '★' as const;

export const DEFAULT_STAR_COLORS = {
  supporter: '#7EA8F7',
  overseer: '#FD4DA6',
} as const;

export type StarTier = keyof typeof DEFAULT_STAR_COLORS;

export function defaultStarColor(tier: StarTier): string {
  return DEFAULT_STAR_COLORS[tier];
}

export default { SUPPORTER_STAR_GLYPH, DEFAULT_STAR_COLORS, defaultStarColor };

module.exports = { SUPPORTER_STAR_GLYPH, DEFAULT_STAR_COLORS, defaultStarColor };
module.exports.default = module.exports;
