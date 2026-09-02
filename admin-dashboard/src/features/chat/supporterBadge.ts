/** Shared supporter marker contract for the website, previews, and Electron chat. */

export const SUPPORTER_STAR_GLYPH = '★' as const;

const DEFAULT_STAR_COLORS = {
  supporter: '#7EA8F7',
  overseer: '#FD4DA6',
} as const;

export type SupporterBadge = {
  tier: 'supporter' | 'overseer';
  glyph: typeof SUPPORTER_STAR_GLYPH;
  label: string;
};

export function supporterBadge(
  badges?: readonly string[] | null,
): SupporterBadge | null {
  // Deliberately inspect only the server-issued tier marker. Never render a glyph
  // supplied by a message, username, tag, or arbitrary badge value.
  if (badges?.includes('overseer')) {
    return { tier: 'overseer', glyph: SUPPORTER_STAR_GLYPH, label: "Overseer's Circle" };
  }
  if (badges?.includes('supporter')) {
    return { tier: 'supporter', glyph: SUPPORTER_STAR_GLYPH, label: 'Supporter' };
  }
  return null;
}
/** Resolve the final star color without accepting arbitrary CSS or losing the star. */
export function supporterStarColor(
  badges?: readonly string[] | null,
  selected?: string | null,
): string | null {
  const badge = supporterBadge(badges);
  if (!badge) return null;
  if (typeof selected === 'string' && /^#[0-9a-f]{6}$/i.test(selected)) return selected;
  return DEFAULT_STAR_COLORS[badge.tier];
}
