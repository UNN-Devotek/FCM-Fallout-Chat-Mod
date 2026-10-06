import type { WebSocket } from 'ws';
import prisma from '../config/prisma';
import { checkChatSlowmode, chatSlowmodeMessage } from '../services/chatSlowmodeService';

/** Used by both authenticated channel-send handlers before publication. */
export async function rejectChatSlowmode(ws: Pick<WebSocket, 'send'>, actor: { id: string; discordId?: string | null }): Promise<boolean> {
  // Socket identity fields were loaded at connection time. Re-read the account's
  // verified Discord ID so connected clients agree on the current linked identity.
  const account = await prisma.user.findUnique({ where: { id: actor.id }, select: { discordId: true } });
  if (!account) {
    ws.send(JSON.stringify({ type: 'error', payload: { message: 'Your account is unavailable. Please reconnect.' } }));
    return true;
  }
  const status = await checkChatSlowmode({ id: actor.id, discordId: account.discordId });
  if (status.allowed) return false;
  ws.send(JSON.stringify({ type: 'rate:status', payload: { scope: 'chat', remaining: 0, retryAfterMs: status.retryAfterMs } }));
  ws.send(JSON.stringify({ type: 'error', payload: { message: chatSlowmodeMessage(status.retryAfterMs) } }));
  return true;
}
