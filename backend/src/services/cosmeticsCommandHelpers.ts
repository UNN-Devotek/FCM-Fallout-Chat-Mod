/**
 * Pure helpers for the Discord /cosmetics command.
 *
 * Split out from cosmeticsCommandService the way githubTicketHelpers is split from
 * ticketService: everything decidable without a gateway connection lives here so it
 * can be unit-tested directly. There are currently NO tests for Discord interactions
 * anywhere in this repo, so keeping the decidable parts pure is the difference
 * between this surface being tested and not.
 */
import { SupporterTier, tierAtLeast, tierLabel } from '../utils/supporterTier';
import { ColorPreset, EffectPreset } from './cosmetics/presets';

/** customId namespace. Guards this listener against ticket/voice interactions. */
export const CUSTOM_ID_PREFIX = 'fcmcos';

export interface ParsedCustomId {
  isOurs: boolean;
  action: string;
  arg: string | null;
}

export function buildCosmeticId(action: string, arg?: string | null): string {
  return arg ? `${CUSTOM_ID_PREFIX}:${action}:${arg}` : `${CUSTOM_ID_PREFIX}:${action}`;
}

export function parseCosmeticId(customId: string | null | undefined): ParsedCustomId {
  if (!customId || typeof customId !== 'string') return { isOurs: false, action: '', arg: null };
  const parts = customId.split(':');
  if (parts[0] !== CUSTOM_ID_PREFIX) return { isOurs: false, action: '', arg: null };
  return { isOurs: true, action: parts[1] ?? '', arg: parts.slice(2).join(':') || null };
}

/** Discord caps autocomplete responses (and select menus) at 25 entries. */
export const AUTOCOMPLETE_LIMIT = 25;

export interface AutocompleteChoice {
  name: string;
  value: string;
}

/**
 * Build autocomplete choices for the colour/effect pickers.
 *
 * Locked entries stay VISIBLE and are marked, matching the frosted-but-not-hidden rule
 * the web picker follows — a user should be able to see what the tier buys before
 * buying it. Submitting one is rejected at apply time with an upsell.
 *
 * Available options sort first so the common case needs no scrolling.
 */
export function buildColorChoices(
  presets: readonly ColorPreset[],
  tier: SupporterTier,
  query: string,
): AutocompleteChoice[] {
  const q = (query ?? '').trim().toLowerCase();
  const matches = presets.filter(
    (p) => !q || p.label.toLowerCase().includes(q) || p.id.includes(q) || p.hex.toLowerCase().includes(q),
  );
  const decorated = matches.map((p) => {
    const unlocked = tierAtLeast(tier, p.tier);
    const suffix = unlocked ? (p.tier === 'none' ? 'Free' : tierLabel(p.tier)) : `${tierLabel(p.tier)} — locked`;
    return { name: `${p.label} · ${p.hex.toUpperCase()} · ${suffix}`, value: p.id, unlocked };
  });
  decorated.sort((a, b) => Number(b.unlocked) - Number(a.unlocked));
  return decorated.slice(0, AUTOCOMPLETE_LIMIT).map(({ name, value }) => ({ name, value }));
}

export function buildEffectChoices(
  presets: readonly EffectPreset[],
  tier: SupporterTier,
  query: string,
): AutocompleteChoice[] {
  const q = (query ?? '').trim().toLowerCase();
  const matches = presets.filter((p) => !q || p.label.toLowerCase().includes(q) || p.id.includes(q));
  const decorated = matches.map((p) => {
    const unlocked = tierAtLeast(tier, p.tier);
    const gate = p.tier === 'none' ? 'Free' : tierLabel(p.tier);
    const suffix = unlocked ? gate : `${gate} — locked`;
    // Effects never render in-game; say so here rather than only in the web UI, so
    // nobody buys a tier expecting it to show up where they actually play.
    const scope = p.id === 'none' ? '' : ' · desktop only';
    return { name: `${p.label} · ${suffix}${scope}`, value: p.id, unlocked };
  });
  decorated.sort((a, b) => Number(b.unlocked) - Number(a.unlocked));
  return decorated.slice(0, AUTOCOMPLETE_LIMIT).map(({ name, value }) => ({ name, value }));
}

export interface ReplyContext {
  shopUrl?: string | null;
  linkUrl?: string | null;
}

/**
 * Translate an applyCosmetics failure into user-facing Discord copy.
 *
 * Mirrors what the REST layer does with the same `reason`, so the two surfaces say
 * consistent things. Crucially, `blacklisted` NEVER echoes which pattern matched —
 * doing so would turn the command into an oracle for probing the filters.
 */
export function reasonToMessage(
  reason: string,
  detail: { requiredTier?: SupporterTier; message?: string; field?: string; code?: string },
  ctx: ReplyContext = {},
): string {
  switch (reason) {
    case 'tier_locked': {
      const need = detail.requiredTier ? tierLabel(detail.requiredTier) : 'a higher tier';
      const cta = ctx.shopUrl ? ` You can support the project here: ${ctx.shopUrl}` : '';
      return `That option is part of **${need}**.${cta}`;
    }
    case 'blacklisted':
      return detail.message ?? 'That is not allowed. Please choose something else.';
    case 'invalid_tag':
      return detail.code === 'too_long'
        ? 'That tag is too long.'
        : 'That tag is not usable — try letters and numbers.';
    case 'invalid_color':
      return detail.message ?? 'That colour is not available.';
    case 'not_linked':
      return ctx.linkUrl
        ? `Link your Discord account to Fallout Chat Mod first: ${ctx.linkUrl}`
        : 'Link your Discord account to Fallout Chat Mod first.';
    case 'not_found':
      return 'No Fallout Chat Mod account is linked to your Discord.';
    case 'rate_limited':
      return 'Too many changes just now — please wait a few minutes.';
    default:
      return 'That change could not be applied.';
  }
}

export default {
  CUSTOM_ID_PREFIX,
  AUTOCOMPLETE_LIMIT,
  buildCosmeticId,
  parseCosmeticId,
  buildColorChoices,
  buildEffectChoices,
  reasonToMessage,
};
module.exports = {
  CUSTOM_ID_PREFIX,
  AUTOCOMPLETE_LIMIT,
  buildCosmeticId,
  parseCosmeticId,
  buildColorChoices,
  buildEffectChoices,
  reasonToMessage,
};
module.exports.default = module.exports;
