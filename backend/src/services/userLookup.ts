/**
 * Shared Discord-ID → FCM user lookup.
 *
 * This lookup was copy-pasted ~15 times across controllers, services and the bot
 * (`prisma.user.findFirst({ where: { discordId } })`), each with slightly different
 * `select` sets and its own idea of what a "real" FO76 name is. The Discord slash
 * commands need it too, so it lives here once.
 *
 * `resolveGameUser` (middleware/resolveGameUser.ts) covers the same ground for HTTP
 * requests, but it is Express-request-scoped and therefore unusable from a Discord
 * interaction or a background job — this is the transport-agnostic form.
 */
import prisma from '../config/prisma';

export interface LookedUpUser {
  id: string;
  username: string;
  chatName: string | null;
  discordId: string | null;
  discordUsername: string | null;
  discordDisplayName: string | null;
  isBanned: boolean;
  isMuted: boolean;
  /**
   * True when `username` is a real FO76 character name the user supplied, rather than
   * a placeholder. Mirrors the checks in discordService: 'Wanderer' is the default for
   * an unlinked account, `pending-*` is assigned when a name fails moderation, and
   * `Overlay<digits>` is the desktop client's auto-generated fallback.
   */
  hasRealFo76Name: boolean;
}

const SELECT = {
  id: true,
  username: true,
  chatName: true,
  discordId: true,
  discordUsername: true,
  discordDisplayName: true,
  isBanned: true,
  isMuted: true,
} as const;

/** Pure predicate — exported for unit tests and reuse by callers holding a raw name. */
export function isRealFo76Name(username: string | null | undefined): boolean {
  if (!username) return false;
  if (username === 'Wanderer') return false;
  if (username.startsWith('pending-')) return false;
  if (/^Overlay\d+$/.test(username)) return false;
  return true;
}

function decorate(row: Omit<LookedUpUser, 'hasRealFo76Name'> | null): LookedUpUser | null {
  if (!row) return null;
  return { ...row, hasRealFo76Name: isRealFo76Name(row.username) };
}

/** Look up the FCM user linked to a Discord account. Returns null when unlinked. */
export async function getUserByDiscordId(discordId: string): Promise<LookedUpUser | null> {
  if (!discordId) return null;
  const row = await prisma.user.findFirst({ where: { discordId }, select: SELECT });
  return decorate(row);
}

/** Look up by internal FCM user id, returning the same shape. */
export async function getUserById(userId: string): Promise<LookedUpUser | null> {
  if (!userId) return null;
  const row = await prisma.user.findUnique({ where: { id: userId }, select: SELECT });
  return decorate(row);
}

export default { getUserByDiscordId, getUserById, isRealFo76Name };
module.exports = { getUserByDiscordId, getUserById, isRealFo76Name };
module.exports.default = module.exports;
