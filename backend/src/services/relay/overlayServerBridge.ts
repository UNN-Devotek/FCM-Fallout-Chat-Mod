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
}
export type BridgeResolution = { status: 'ready'; binding: BridgeBinding }
  | { status: 'inactive' | 'ambiguous' };
export const bridgeBindingId = (binding: BridgeBinding): string =>
  `${binding.relayUserId}/${binding.requestId}/${binding.room}`;

/** Only the authenticated native ROSTER control may renew this lease. Peer room
 * recomputation must never keep an absent bridge alive. No token is sent to web. */
export async function renewBridgeLease(accountId: string, relayUserId: string, requestId: string): Promise<void> {
  const roster = await readRoster(relayUserId);
  if (!requestId || roster?.requestId !== requestId) return;
  const redis = await getRedisClient();
  const now = Date.now();
  await redis.set(deviceKey(relayUserId), JSON.stringify({ accountId, requestId, expiresAt: now + BRIDGE_LEASE_MS }),
    { EX: BRIDGE_LEASE_MS / 1000 });
  await redis.zRemRangeByScore(accountKey(accountId), '-inf', now);
  await redis.zAdd(accountKey(accountId), { score: now + BRIDGE_LEASE_MS, value: relayUserId });
  await redis.expire(accountKey(accountId), 90);
}

export async function clearBridgeLease(relayUserId: string): Promise<void> {
  // Index entries expire independently; deleting the device is enough to deny access.
  const redis = await getRedisClient();
  await redis.del(deviceKey(relayUserId));
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
