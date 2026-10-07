import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getRedisClient } from '../../config/redis';
import prisma from '../../config/prisma';
import { getAllRosters, readRoster, normalizeRosterName, type RosterEntry } from './worldRosterService';
import { getWorldId } from './worldIdService';
import type { LocalBridgeObservation } from './localExportBridge';

export const NAMEPLATE_CONTROL = 'FCMCTL/1/NAMEPLATES;';
export const NAMEPLATE_EVENT = 'FCMNAMEPLATES/1;';
const MAX_LEASE_MS = 10_000;
const nonce = z.string().regex(/^[a-z0-9-]{1,64}$/);
const requestSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('hud'), requestId: nonce, nativeRequestId: nonce }),
  z.strictObject({ mode: z.literal('bridge'), requestId: nonce, sessionId: nonce, worldGeneration: nonce }),
]);
export type NameplateRequest = z.infer<typeof requestSchema>;
export interface NameplateReply { version: 1; requestId: string; context: string; ttlMs: number; names: string[] }
const replySchema = z.strictObject({ version: z.literal(1), requestId: nonce,
  context: z.string().regex(/^(?:hud:[a-z0-9-]{1,64}|bridge:[a-z0-9-]{1,64}\/[a-z0-9-]{1,64})$/),
  ttlMs: z.number().int().min(0).max(MAX_LEASE_MS), names: z.array(z.string().min(1).max(64)
    .refine(name => name === normalizeRosterName(name) && !/[\x00-\x1f\x7f]/.test(name))).max(24) });
export function parseNameplateReply(value: unknown): NameplateReply | null {
  const result = replySchema.safeParse(value);
  return result.success ? result.data : null;
}
interface BridgePresenceIndex {
  actorId: string; accountId: string; authKey: string; owner: string; connectionOrder: number; expiresAt: number;
}
const bridgeKey = (session: string, world: string): string => 'relay:nameplates:bridge:'
  + createHash('sha256').update(`${session}\0${world}`).digest('hex');

export function parseNameplateRequest(body: string): NameplateRequest | null {
  if (!body.startsWith(NAMEPLATE_CONTROL) || Buffer.byteLength(body, 'utf8') > 512) return null;
  try { const result = requestSchema.safeParse(JSON.parse(body.slice(NAMEPLATE_CONTROL.length)));
    return result.success ? result.data : null;
  } catch { return null; }
}
export function nameplateContext(request: NameplateRequest): string {
  return request.mode === 'hud' ? `hud:${request.nativeRequestId}` : `bridge:${request.sessionId}/${request.worldGeneration}`;
}

/** Backend-only rendezvous. This does not grant room/chat authority to the native
 * transport. The current authenticated desktop remains the observation owner. */
export async function indexBridgeNameplates(snapshot: LocalBridgeObservation, accountId: string, token: string,
  actorId: string, owner: string, connectionOrder: number, expiresAt: number): Promise<void> {
  if (expiresAt <= Date.now() || connectionOrder <= 0) return;
  const index: BridgePresenceIndex = { actorId, accountId, authKey: `session:${token}`, owner, connectionOrder, expiresAt };
  await (await getRedisClient()).set(bridgeKey(snapshot.sessionId, snapshot.worldGeneration), JSON.stringify(index),
    { PX: Math.max(1, Math.ceil(expiresAt - Date.now())) });
}

async function allowedAccount(accountId: string): Promise<boolean> {
  const account = await prisma.user.findUnique({ where: { id: accountId }, select: { isBanned: true, kickedUntil: true } });
  return !!account && !account.isBanned && !(account.kickedUntil && new Date(account.kickedUntil).getTime() > Date.now());
}

async function bridgeActor(index: BridgePresenceIndex, request?: Extract<NameplateRequest, { mode: 'bridge' }>): Promise<boolean> {
  const redis = await getRedisClient();
  const raw = await redis.get(`relay:local-export:${index.actorId}`);
  if (!raw || index.expiresAt <= Date.now()) return false;
  const state = JSON.parse(raw);
  const snapshot = state.snapshot;
  if (!state.active || state.owner !== index.owner || state.expiresAt <= Date.now() || !snapshot
    || (request && (snapshot.sessionId !== request.sessionId || snapshot.worldGeneration !== request.worldGeneration))
    || await redis.get(`relay:local-export:${index.actorId}:connection`) !== String(index.connectionOrder)
    || await redis.get(index.authKey) !== index.accountId || !(await allowedAccount(index.accountId))) return false;
  return true;
}

async function activeActor(roster: RosterEntry): Promise<boolean> {
  if (roster.observationSource === 'native') {
    const credential = await prisma.hudPairingToken.findFirst({ where: { userId: roster.userId, revokedAt: null,
      linkedUserId: { not: null } }, select: { linkedUserId: true } });
    return !!credential?.linkedUserId && await allowedAccount(credential.linkedUserId);
  }
  if (!roster.observationSource?.startsWith('bridge:')) return false;
  const redis = await getRedisClient();
  const raw = await redis.get(`relay:local-export:${roster.userId}`);
  if (!raw) return false;
  const state = JSON.parse(raw);
  if (!state.snapshot) return false;
  if (roster.requestId !== createHash('sha256').update(`${state.snapshot.sessionId}\0${state.snapshot.worldGeneration}`).digest('hex')) return false;
  const indexed = await redis.get(bridgeKey(state.snapshot.sessionId, state.snapshot.worldGeneration));
  if (!indexed) return false;
  const index = JSON.parse(indexed) as BridgePresenceIndex;
  return index.actorId === roster.userId && await bridgeActor(index);
}

function evidenceDeadline(roster: RosterEntry): number {
  // A readable roster or renewed transport heartbeat is not a fresh observation.
  return Math.min(roster.expiresAt ?? Infinity, (roster.observedAt ?? 0) + 30_000);
}

/** Names are cosmetic matching evidence only. Return peers already in the same
 * canonical room, intersected with what this viewer's HUD actually observed. */
export async function nameplateReply(request: NameplateRequest, nativeActor: { userId: string; linkedUserId: string | null }): Promise<NameplateReply> {
  const empty: NameplateReply = { version: 1, requestId: request.requestId, context: nameplateContext(request), ttlMs: 0, names: [] };
  const redis = await getRedisClient();
  let actor = nativeActor.userId;
  let index: BridgePresenceIndex | null = null;
  if (request.mode === 'bridge') {
    const raw = await redis.get(bridgeKey(request.sessionId, request.worldGeneration));
    if (!raw) return empty;
    index = JSON.parse(raw) as BridgePresenceIndex;
    if (!(await bridgeActor(index, request))) return empty;
    actor = index.actorId;
  } else if (!nativeActor.linkedUserId || !(await allowedAccount(nativeActor.linkedUserId))) return empty;
  const own = await readRoster(actor);
  const room = await getWorldId(actor);
  if (!own || !room?.startsWith('r:') || own.roomKey !== room || evidenceDeadline(own) <= Date.now()
    || (request.mode === 'hud' ? own.requestId !== request.nativeRequestId
      : own.requestId !== createHash('sha256').update(`${request.sessionId}\0${request.worldGeneration}`).digest('hex'))) return empty;
  const observed = new Set(own.seen.map(normalizeRosterName));
  const names = new Set<string>();
  let deadline = Math.min(Date.now() + MAX_LEASE_MS, evidenceDeadline(own), index?.expiresAt ?? Infinity);
  const peers = (await getAllRosters()).filter(peer => peer.userId !== actor && peer.roomKey === room
    && evidenceDeadline(peer) > Date.now());
  for (const peer of peers) {
    const matches = [peer.name, ...(peer.aliases ?? [])].map(normalizeRosterName)
      .filter(name => name && name.length <= 64 && !/[\x00-\x1f\x7f]/.test(name) && observed.has(name));
    if (!matches.length || await getWorldId(peer.userId) !== room || !(await activeActor(peer))) continue;
    for (const name of matches) if (names.size < 24) names.add(name);
    deadline = Math.min(deadline, evidenceDeadline(peer));
  }
  // Fence asynchronous reads against a hop, logout, owner replacement or expiry.
  const latest = await readRoster(actor);
  if (!latest || latest.requestId !== own.requestId || evidenceDeadline(latest) <= Date.now()
    || latest.roomKey !== room || await getWorldId(actor) !== room
    || (request.mode === 'hud' && !(await allowedAccount(nativeActor.linkedUserId!)))
    || (index && !(await bridgeActor(index, request.mode === 'bridge' ? request : undefined)))) return empty;
  const ttlMs = Math.max(0, Math.floor(deadline - Date.now()));
  return { ...empty, ttlMs, names: ttlMs > 0 ? [...names].sort() : [] };
}
