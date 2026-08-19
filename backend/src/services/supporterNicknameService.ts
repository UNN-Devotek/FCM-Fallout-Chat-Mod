/**
 * Discord guild nickname presentation for active supporters.
 *
 * Discord bots cannot change a member's global username. This service only changes
 * the nickname in the configured FCM guild, and deliberately derives it from the
 * same resolved cosmetics used by the chat surfaces:
 *
 *   ★ [TAG] Fallout name
 *
 * The star is a role benefit; tags appear only for active Overseer's Circle members.
 * Effects and colours remain FCM-only because Discord nicknames cannot render them.
 */
import logger from '../config/logger';
import type { SupporterTier } from '../utils/supporterTier';
import { getUserByDiscordId, type LookedUpUser } from './userLookup';
import {
  bustCosmeticsCache,
  pushCosmeticsUpdate,
  resolveCosmetics,
  type ResolvedCosmetics,
} from './cosmetics/cosmeticsService';

export const DISCORD_NICKNAME_MAX_LENGTH = 32;
export const SUPPORTER_NICKNAME_STAR = '★';

export interface SupporterNicknameInput {
  baseName: string;
  tier: SupporterTier;
  tag: string | null;
}

/** Discord measures nickname length in characters, not UTF-16 code units. */
function cropNickname(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('');
}

/**
 * Build the member's FCM guild nickname while preserving the recognisable prefix
 * when a long character name needs truncating. The caller supplies only validated
 * chat-name/tag values; this function is intentionally presentation-only.
 */
export function formatSupporterNickname(input: SupporterNicknameInput): string {
  const baseName = input.baseName.trim();
  if (input.tier === 'none') return cropNickname(baseName, DISCORD_NICKNAME_MAX_LENGTH);

  const prefix = input.tag ? `${SUPPORTER_NICKNAME_STAR} [${input.tag}] ` : `${SUPPORTER_NICKNAME_STAR} `;
  const remaining = Math.max(0, DISCORD_NICKNAME_MAX_LENGTH - Array.from(prefix).length);
  return `${prefix}${cropNickname(baseName, remaining)}`;
}

/**
 * Choose the human-readable base for a guild nickname. Internal `discord:`
 * placeholders must never be presented back to Discord as a member nickname.
 */
export function resolveSupporterNicknameBase(user: LookedUpUser): string | null {
  if (user.chatName?.trim()) return user.chatName.trim();
  if (user.hasRealFo76Name) return user.username.trim();
  // A linked player may not have supplied a Fallout name yet. Their Discord display
  // name is still a legitimate FCM identity fallback, and lets the guild show their
  // supporter star without inventing a placeholder nickname.
  const fallback = user.discordDisplayName?.trim() || user.discordUsername?.trim() || null;
  if (!fallback) return null;
  // Discord inbound messages can arrive after the bot has applied its own nickname.
  // Do not use that `★ [TAG] Name` echo as the next base name or each later save
  // would compound the prefix (`★ [TAG] ★ [TAG] Name`).
  return fallback.replace(/^★(?: \[[^\r\n]*\])?\s+/u, '').trim() || null;
}

async function setResolvedNickname(user: LookedUpUser, cosmetics: ResolvedCosmetics): Promise<boolean> {
  if (!user.discordId) return false;
  const baseName = resolveSupporterNicknameBase(user);
  if (!baseName) return false;

  const nickname = formatSupporterNickname({
    baseName,
    tier: cosmetics.tier,
    tag: cosmetics.tag,
  });

  try {
    // Deliberately lazy: discordService statically registers supporterSyncService,
    // while this service is also used by supporterSyncService. Resolving it only at
    // the point of an actual update avoids an initialization cycle.
    const { setMemberNickname } = await import('./discordService.js');
    return await setMemberNickname(user.discordId, nickname, 'Supporter chat appearance sync');
  } catch (err) {
    logger.warn({ err, userId: user.id, discordId: user.discordId }, '[supporterNickname] nickname sync failed (non-fatal)');
    return false;
  }
}

/** Refresh only the Discord nickname after a website or slash-command cosmetic edit. */
export async function syncSupporterNickname(discordId: string): Promise<boolean> {
  const user = await getUserByDiscordId(discordId);
  if (!user) return false;
  return setResolvedNickname(user, await resolveCosmetics(user.id));
}

/**
 * Refresh every user-visible representation after a tier role changes. This is the
 * one place that pairs entitlement cache invalidation with the cosmetics cache and
 * live identity push; leaving either stale makes a purchase/cancellation appear to
 * work only after a reconnect or TTL expiry.
 */
export async function refreshSupporterPresentation(
  discordId: string,
  options: { syncNickname?: boolean } = {},
): Promise<boolean> {
  const user = await getUserByDiscordId(discordId);
  if (!user) return false;

  await bustCosmeticsCache(user.id);
  const cosmetics = await resolveCosmetics(user.id);
  await pushCosmeticsUpdate(user.id, cosmetics);
  if (options.syncNickname === false) return false;
  return setResolvedNickname(user, cosmetics);
}

export default { formatSupporterNickname, syncSupporterNickname, refreshSupporterPresentation };
module.exports = {
  DISCORD_NICKNAME_MAX_LENGTH,
  SUPPORTER_NICKNAME_STAR,
  formatSupporterNickname,
  resolveSupporterNicknameBase,
  syncSupporterNickname,
  refreshSupporterPresentation,
};
module.exports.default = module.exports;
