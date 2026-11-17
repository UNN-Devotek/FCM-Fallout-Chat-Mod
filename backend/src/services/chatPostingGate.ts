/**
 * Account-standing and automod gates for chat that enters FCM from Discord.
 *
 * Overlay/web chat is gated at WebSocket authentication (bans and kick
 * cooldowns close the socket) and per send (mute re-check, automod). Discord
 * producers never pass through that socket, so they must apply the same
 * checks here before anything is finalized:
 *   - `/fcm command:/g <text>` and event shortcuts (discordCommandPublication)
 *   - the typed-message bridge from mapped Discord channels (discordService)
 *
 * Expired temporary bans and mutes count as lifted. The cron sweep and the
 * WS auth path own clearing the stored flags, so this module never writes
 * account state (automod spam shadow-mutes go through autoModService).
 */
import prisma from '../config/prisma';
import logger from '../config/logger';

export const POSTING_STANDING_SELECT = {
  id: true,
  isBanned: true,
  bannedUntil: true,
  kickedUntil: true,
  isMuted: true,
  muteExpiresAt: true,
  muteReason: true,
  muteCategory: true,
} as const;

export interface PostingStandingFields {
  isBanned: boolean;
  bannedUntil: Date | null;
  kickedUntil: Date | null;
  isMuted: boolean;
  muteExpiresAt: Date | null;
  muteReason?: string | null;
  muteCategory?: string | null;
}

export type PostingRefusalReason = 'banned' | 'kicked' | 'muted' | 'automod' | 'unavailable';
export interface PostingRefusal {
  reason: PostingRefusalReason;
  message: string;
}

function minutesUntil(at: Date, now: Date): number {
  return Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 60_000));
}

/** Pure standing check for one account row. Returns null when the account may post. */
export function evaluatePostingStanding(user: PostingStandingFields, now = new Date()): PostingRefusal | null {
  const bannedUntil = user.bannedUntil ? new Date(user.bannedUntil) : null;
  if (user.isBanned && (!bannedUntil || bannedUntil > now)) {
    return {
      reason: 'banned',
      message: bannedUntil
        ? `You are banned from Fallout Chat Mod chat until ${bannedUntil.toISOString()}. Your message was not posted.`
        : 'You are banned from Fallout Chat Mod chat. Your message was not posted.',
    };
  }
  const kickedUntil = user.kickedUntil ? new Date(user.kickedUntil) : null;
  if (kickedUntil && kickedUntil > now) {
    const minutes = minutesUntil(kickedUntil, now);
    return {
      reason: 'kicked',
      message: `You were kicked from Fallout Chat Mod chat. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}. Your message was not posted.`,
    };
  }
  const muteExpiresAt = user.muteExpiresAt ? new Date(user.muteExpiresAt) : null;
  if (user.isMuted && (!muteExpiresAt || muteExpiresAt > now)) {
    const detail = user.muteReason ? ` (${user.muteCategory ? `${user.muteCategory}: ` : ''}${user.muteReason})` : '';
    return {
      reason: 'muted',
      message: `You are muted in Fallout Chat Mod chat${muteExpiresAt ? ` until ${muteExpiresAt.toISOString()}` : ''}${detail}. Your message was not posted.`,
    };
  }
  return null;
}

/**
 * Standing for an FCM account, or for every FCM row linked to a Discord id
 * (synthetic relay rows and the canonical account can coexist; any refused
 * row refuses the author). Fails closed when the database cannot answer.
 */
export async function checkPostingStanding(where: { userId: string } | { discordId: string }): Promise<PostingRefusal | null> {
  try {
    const rows = 'userId' in where
      ? [await prisma.user.findUnique({ where: { id: where.userId }, select: POSTING_STANDING_SELECT })].filter(Boolean)
      : await prisma.user.findMany({ where: { discordId: where.discordId }, select: POSTING_STANDING_SELECT, take: 10 });
    for (const row of rows) {
      const refusal = evaluatePostingStanding(row as PostingStandingFields);
      if (refusal) return refusal;
    }
    return null;
  } catch (err) {
    logger.warn({ err }, '[chatPostingGate] standing lookup failed; refusing post');
    return { reason: 'unavailable', message: 'Fallout Chat Mod could not verify your chat standing. Please try again.' };
  }
}

/**
 * The same automod engine call as overlay chat (`chat:send` / ingestMessage),
 * including the spam shadow-mute. Returns null when the content may post.
 */
export async function evaluateChatAutomod(
  content: string,
  channelId: string,
  user: { id: string; username?: string | null; discordId?: string | null; discordUsername?: string | null },
): Promise<PostingRefusal | null> {
  // Lazy: autoModEngine reaches discordService, which imports this module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { engineEvaluate } = require('./autoModEngine') as typeof import('./autoModEngine');
  const result = await engineEvaluate(content, channelId, user, { spamPolicy: 'shared-chat' });
  if (!result.block) return null;
  if (result.customMessage?.includes('Spam')) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { shadowMute } = require('./autoModService') as typeof import('./autoModService');
    await shadowMute(user.id);
  }
  logger.info({ userId: user.id, matches: result.matches.length }, '[chatPostingGate] message blocked by automod engine');
  return { reason: 'automod', message: result.customMessage || 'Message blocked by content filter.' };
}
