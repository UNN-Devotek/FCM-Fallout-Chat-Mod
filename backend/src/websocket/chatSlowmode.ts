import type { WebSocket } from 'ws';
import prisma from '../config/prisma';
import type { CommandResult } from '../services/commandService';
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

/** Only human command publications share channel-chat slots. Unknown commands
 * fall through to ordinary chat, so they must still be checked.
 */
export async function rejectCommandSlowmode(
  ws: Pick<WebSocket, 'send'>,
  actor: { id: string; discordId?: string | null },
  result: CommandResult,
): Promise<boolean> {
  if (result.handled && result.actionType !== 'relay') return false;
  const rejected = await rejectChatSlowmode(ws, actor);
  if (rejected && result.handled && result.actionType === 'relay') result.cancelCooldown?.();
  return rejected;
}
