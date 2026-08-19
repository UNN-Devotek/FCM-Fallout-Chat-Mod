/**
 * Free self-service chat-name setting.
 *
 * This is intentionally separate from supporter cosmetics: every linked user can
 * change it from the website or the Discord bot, it has no tier gate and no
 * cooldown, and disabling supporter cosmetics never disables name changes.
 */
import prisma from '../config/prisma';
import logger from '../config/logger';
import { validateChatName } from '../utils/chatName';
import { findBlacklistMatch } from './nameBlacklistService';
import { findProhibitedPhrase } from './autoModService';

export type ChatNameChangeReason = 'not_found' | 'invalid_name' | 'blacklisted';

export type ChatNameChangeResult =
  | { ok: true; chatName: string | null; changed: boolean }
  | { ok: false; reason: ChatNameChangeReason; message: string; code?: string };

async function nameBlocked(name: string): Promise<boolean> {
  try {
    if (findBlacklistMatch(name)) return true;
  } catch (err) {
    logger.warn({ err }, '[chatName] blacklist check failed (non-fatal)');
  }

  try {
    if (await findProhibitedPhrase(name)) return true;
  } catch (err) {
    logger.warn({ err }, '[chatName] prohibited-phrase check failed (non-fatal)');
  }

  return false;
}

/**
 * Set (or clear) a user's free chat name. An explicit null restores the ordinary
 * FO76/Discord-derived name. The caller has already authenticated ownership.
 */
export async function setChatName(input: {
  userId: string;
  chatName: string | null;
  source: 'website' | 'discord';
}): Promise<ChatNameChangeResult> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      chatName: true,
      username: true,
      discordUsername: true,
      discordDisplayName: true,
      installToken: true,
      discordId: true,
    },
  });
  if (!user) return { ok: false, reason: 'not_found', message: 'No such user.' };

  let next: string | null = null;
  if (input.chatName !== null) {
    const validation = validateChatName(input.chatName);
    if (!validation.ok) {
      return { ok: false, reason: 'invalid_name', code: validation.code, message: 'That name is not usable.' };
    }
    if (await nameBlocked(validation.value)) {
      // Do not expose which blacklist / automod rule matched: that would create a
      // probing oracle on both web and Discord surfaces.
      return { ok: false, reason: 'blacklisted', message: 'That name is not allowed. Please choose another.' };
    }
    next = validation.value;
  }

  if (user.chatName === next) return { ok: true, chatName: next, changed: false };

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { chatName: next },
    select: {
      id: true,
      chatName: true,
      username: true,
      discordUsername: true,
      discordDisplayName: true,
      installToken: true,
      discordId: true,
    },
  });

  prisma.auditLog.create({
    data: {
      actorId: updated.id,
      action: 'chat_name_updated',
      targetId: updated.id,
      targetType: 'user',
      metadata: { source: input.source, cleared: next === null },
    },
  }).catch((err: unknown) => logger.warn({ err, userId: updated.id }, '[chatName] audit write failed'));

  // Update live clients and back-apply their already-rendered history. Resolve the
  // handler here rather than at module load: Discord registers the `/name` service
  // during its own initialization, while websocket handlers import automod which
  // imports Discord alerts. A top-level import would form a Discord → name → WS →
  // automod → Discord cycle and capture an incomplete alert export.
  try {
    const { refreshClientIdentity } = require('../websocket/handlers') as typeof import('../websocket/handlers');
    refreshClientIdentity(
      updated.id,
      updated.username,
      updated.discordUsername,
      updated.discordDisplayName,
      updated.installToken,
      updated.chatName,
    );
  } catch (err) {
    logger.warn({ err, userId: updated.id }, '[chatName] live identity push failed (non-fatal)');
  }

  // Keep an active supporter's FCM guild nickname in sync with their free chat
  // name while preserving the supporter star and any validated Overseer tag.
  if (updated.discordId) {
    const discordId = updated.discordId;
    void import('./supporterNicknameService.js')
      .then(({ syncSupporterNickname }) => syncSupporterNickname(discordId))
      .catch((err: unknown) => logger.warn({ err, userId: updated.id }, '[chatName] Discord nickname sync failed (non-fatal)'));
  }

  return { ok: true, chatName: updated.chatName, changed: true };
}

export default { setChatName };
module.exports = { setChatName };
module.exports.default = module.exports;
