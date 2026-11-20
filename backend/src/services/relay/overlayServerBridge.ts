import { isRowCountNoChange, runRequiredBundle, runRequiredMutation } from '../../lib/requiredEffects';
import prisma from '../../config/prisma';
import { getRedisClient } from '../../config/redis';
import { readRoster } from './worldRosterService';
import { getWorldId } from './worldIdService';

export const BRIDGE_LEASE_MS = 45_000;
const deviceKey = (id: string) => `relay:bridge:device:${id}`;
const accountKey = (id: string) => `relay:bridge:account:${id}`;

export interface BridgeBinding {
  relayUserId: string;
  accountId: string;
  requestId: string;
  room: string;
  displayName: string;
  sessionId?: string;
  worldGeneration?: string;
  sequence?: number;
}
export type BridgeResolution = { status: 'ready'; binding: BridgeBinding }
  | { status: 'inactive' | 'ambiguous' };
export const bridgeBindingId = (binding: BridgeBinding): string =>
  `${binding.relayUserId}/${binding.requestId}/${binding.room}`;

/** Only the authenticated native ROSTER control may renew this lease. Peer room
 * recomputation must never keep an absent bridge alive. No token is sent to web. */
export async function renewBridgeLease(accountId: string, relayUserId: string, requestId: string): Promise<void> {
  return runRequiredBundle('session', 'overlayServerBridge:adbb172b960e', async () => {
  const roster = await readRoster(relayUserId);
  if (!requestId || roster?.requestId !== requestId) return;
  const redis = await getRedisClient();
  const now = Date.now();
  await runRequiredMutation('session', 'ef705d65334d309e18402ee2', { stage: 'primary-write-unconfirmed' }, () => redis.set(deviceKey(relayUserId), JSON.stringify({ accountId, requestId, expiresAt: now + BRIDGE_LEASE_MS }),
    { EX: BRIDGE_LEASE_MS / 1000 }), undefined, undefined, undefined);
  await runRequiredMutation('session', '67a8f26fdca10f50b95aecd1', { stage: 'primary-write-unconfirmed' }, () => redis.zRemRangeByScore(accountKey(accountId), '-inf', now), undefined, undefined, undefined);
  await runRequiredMutation('session', '173f993ef4755a3fb4447817', { stage: 'primary-write-unconfirmed' }, () => redis.zAdd(accountKey(accountId), { score: now + BRIDGE_LEASE_MS, value: relayUserId }), undefined, undefined, undefined);
  await runRequiredMutation('session', '5b64574d664c7a5d8c80541e', { stage: 'primary-write-unconfirmed' }, () => redis.expire(accountKey(accountId), 90), undefined, undefined, undefined);

  });
}

export async function clearBridgeLease(relayUserId: string): Promise<void> {
  return runRequiredBundle('session', 'overlayServerBridge:9f393efdb1c4', async () => {
  // Index entries expire independently; deleting the device is enough to deny access.
  const redis = await getRedisClient();
  await runRequiredMutation('session', '66f634a477ad64fb10c00d94', { stage: 'primary-write-unconfirmed' }, () => redis.del(deviceKey(relayUserId)), undefined, undefined, isRowCountNoChange);

  });
}

/** Fail closed on ambiguous devices, revoked/relinked tokens, absent rosters and
 * stale nonces. The browser's requested channel is never membership authority. */
export async function resolveOverlayBridge(accountId: string): Promise<BridgeResolution> {
  const redis = await getRedisClient();
  const now = Date.now();
  const ids = await redis.zRangeByScore(accountKey(accountId), now + 1, '+inf', { LIMIT: { offset: 0, count: 17 } });
  if (ids.length > 16) return { status: 'ambiguous' };
  const bindings: BridgeBinding[] = [];
  for (const relayUserId of ids) {
    const raw = await redis.get(deviceKey(relayUserId));
    if (!raw) continue;
    let lease;
    try { lease = JSON.parse(raw); } catch { continue; }
    if (lease.accountId !== accountId || !(lease.expiresAt > now) || typeof lease.requestId !== 'string') continue;
    const token = await prisma.hudPairingToken.findFirst({
      where: { userId: relayUserId, linkedUserId: accountId, revokedAt: null },
      select: { fo76Name: true },
    });
    if (!token) continue;
    const roster = await readRoster(relayUserId);
    if (!roster || roster.requestId !== lease.requestId) continue;
    const room = await getWorldId(relayUserId);
    if (!room || !room.startsWith('r:')) continue;
    bindings.push({ relayUserId, accountId, requestId: lease.requestId, room, displayName: token.fo76Name });
  }
  if (bindings.length !== 1) return { status: bindings.length ? 'ambiguous' : 'inactive' };
  // A deleted/banned/kicked account cannot retain a private read subscription.
  const user = await prisma.user.findUnique({ where: { id: accountId }, select: { isBanned: true, kickedUntil: true } });
  if (!user || user.isBanned || (user.kickedUntil && +user.kickedUntil > now)) return { status: 'inactive' };
  // A slow account lookup may straddle lease expiry or a world transition.
  const binding = bindings[0];
  const latest = await redis.get(deviceKey(binding.relayUserId));
  if (!latest) return { status: 'inactive' };
  const lease = JSON.parse(latest);
  if (lease.accountId !== accountId || lease.requestId !== binding.requestId || !(lease.expiresAt > Date.now())
    || (await readRoster(binding.relayUserId))?.requestId !== binding.requestId
    || await getWorldId(binding.relayUserId) !== binding.room) return { status: 'inactive' };
  return { status: 'ready', binding: bindings[0] };
}
