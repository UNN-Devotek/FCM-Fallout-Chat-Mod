import prisma from '../../config/prisma';
import { engineEvaluate } from '../autoModEngine';
import { attachCosmetics } from '../cosmetics/cosmeticsService';
import { refreshSupporterFromHudSend } from '../supporterSyncService';
import { relayHudCosmetics } from './relayCosmetics';
import { getWorldId } from './worldIdService';
import { nextRelaySeq } from './relaySeq';
import { checkServerRateLimit, publishServerMessage, type ServerRoomEvent } from './serverChat';

export class ServerMessageError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Shared native/web send path. One event, one ID, one room publication. */
export async function sendServerMessage(actor: { accountId: string; relayUserId: string; displayName: string },
  room: string, body: string, stillAuthorized?: () => Promise<boolean>): Promise<ServerRoomEvent> {
  if (!body.trim() || body.length > 500) throw new ServerMessageError('invalid_request', 'Message must contain 1–500 characters');
  const user = await prisma.user.findUnique({ where: { id: actor.accountId },
    select: { isBanned: true, isMuted: true, kickedUntil: true, discordId: true } });
  if (!user || user.isBanned) throw new ServerMessageError('user_banned', 'Account unavailable');
  if (user.kickedUntil && +user.kickedUntil > Date.now()) throw new ServerMessageError('user_kicked', 'This account is temporarily kicked');
  if (user.isMuted) throw new ServerMessageError('user_muted', 'You are currently muted');
  if (!(await checkServerRateLimit(actor.accountId))) throw new ServerMessageError('rate_limited', 'You are sending messages too quickly');
  const mod = await engineEvaluate(body, undefined, { id: actor.accountId, username: actor.displayName });
  if (mod.block) throw new ServerMessageError('message_blocked', 'Message blocked by the chat filter');
  await refreshSupporterFromHudSend({ userId: actor.accountId, discordId: user.discordId });
  const source: Record<string, unknown> = { userId: actor.accountId };
  await attachCosmetics(source);
  const id = await nextRelaySeq();
  // Check again after moderation/cosmetics I/O: queued sends must not follow a hop.
  if (await getWorldId(actor.relayUserId) !== room || (stillAuthorized && !(await stillAuthorized()))) {
    throw new ServerMessageError('invalid_channel', 'Server session changed; wait for a fresh room confirmation');
  }
  const event: ServerRoomEvent = { id, kind: 'chat.message', messageId: `server:${room}:${id}`,
    channel: 'server', senderUserId: actor.relayUserId, linkedUserId: actor.accountId,
    senderDisplayName: actor.displayName, body, targetUserId: '', createdAt: new Date().toISOString(),
    ...relayHudCosmetics(source) };
  await publishServerMessage(room, id, event);
  return event;
}
