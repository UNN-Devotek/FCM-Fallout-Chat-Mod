/**
 * The small cosmetic subset understood by the in-game HUD widget.
 *
 * The web clients receive the complete cosmetics object. The HUD only needs the
 * validated custom tag and the immutable supporter marker, so keeping this
 * projection explicit prevents accidental exposure of unsupported effects or
 * arbitrary badge text on the Scaleform surface.
 */

export interface RelayHudCosmetics {
  tag?: string;
  supporterStar?: true;
  starColor?: string;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Project server-resolved cosmetics into the additive chat.v1 HUD fields. */
export function relayHudCosmetics(source: Record<string, unknown>): RelayHudCosmetics {
  const result: RelayHudCosmetics = {};
  if (typeof source.tag === 'string' && source.tag.trim()) {
    result.tag = source.tag;
  }

  const badges = Array.isArray(source.badges) ? source.badges : [];
  const hasSupporterTier = badges.includes('supporter') || badges.includes('overseer');
  if (!hasSupporterTier) return result;

  result.supporterStar = true;
  if (typeof source.starColor === 'string' && HEX_COLOR.test(source.starColor)) {
    result.starColor = source.starColor;
  }
  return result;
}

/** Remove only the HUD cosmetic fields before serving an older widget build. */
export function withoutRelayHudCosmetics<T extends Record<string, unknown>>(event: T): T {
  const next = { ...event } as T & Partial<RelayHudCosmetics>;
  delete next.tag;
  delete next.supporterStar;
  delete next.starColor;
  return next as T;
}

export default { relayHudCosmetics, withoutRelayHudCosmetics };
