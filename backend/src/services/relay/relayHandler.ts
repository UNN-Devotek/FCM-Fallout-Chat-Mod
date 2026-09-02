/**
 * relayHandler.ts — ZFE chat.v1 JSON-frame op dispatcher.
 *
 * Handles a single WebSocket connection on the /relay path. Supports two
 * connection modes:
 *   - Short-lived RPC: one request frame → one response frame (register, hello,
 *     send, poll, report, moderationAction).
 *   - Long-lived push: subscribe → acknowledgement + live event push.
 *
 * Identity model:
 *   - register: server mints userId + token; stores argon2id hash; returns token
 *     ONCE (never again). User is "limited" until linked (no Discord/Nexus account).
 *   - hello: token re-auth; may update displayName. Never returns the token.
 *   - Every subsequent op re-validates the token per frame.
 *
 * World/roster controls:
 *   Reserved control messages are intercepted before ingestMessage. The authenticated
 *   relay token supplies the actor identity; payloads are bounded HUD metadata and
 *   are never broadcast or persisted as chat.
 *
 * Production guard: default-off until RELAY_PRODUCTION_ENABLED is explicitly enabled.
 */

import type WebSocket from 'ws';
import type http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { getRedisClient, getSubscriberClient } from '../../config/redis';
import prisma from '../../config/prisma';
import logger from '../../config/logger';
import env from '../../config/environment';
import { clientIp } from '../../utils/clientIp';
import { mintToken, verifyToken, updateDisplayName, markRelayTokenLinked } from './tokenService';
import { slugToChannelId, channelIdToSlug, ALL_SLUGS } from './channelMap';
import { repairChannel, repairBody, readWireDisplayName } from './wireSanitize';
import { setWorldId, getWorldId, clearWorldId } from './worldIdService';
import { setRoster, clearRoster, computeRooms } from './worldRosterService';
import { nextRelaySeq } from './relaySeq';
import {
  rememberClientVersion,
} from './clientCapability';
import {
  rememberTokenClientVersionDurable,
  tokenSupportsHudCosmeticsTransportDurable,
} from './clientCapabilityStore';
import { ingestMessage } from '../ingestMessage';
import { attachCosmetics, attachCosmeticsToHistory } from '../cosmetics/cosmeticsService';
import { refreshSupporterFromHudSend } from '../supporterSyncService';
import {
  relayHudCosmetics,
  relayHudEventForClient,
  relayHudSendAck,
  type RelayHudCosmetics,
} from './relayCosmetics';
import { engineEvaluate } from '../autoModEngine';
import { getEffectiveRole, isPrivilegedRole } from '../userRoleService';
import {
  publishServerMessage,
  publishRebind,
  publishHistoryResync,
  getServerHistory,
  checkServerRateLimit,
  SERVER_EVENTS_CHANNEL,
  type ServerRoomEvent,
} from './serverChat';
import type { RelayToken } from './tokenService';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Printable sentinel that the SWF prepends to worldId control messages when it
 * sends on channel 'server'. ZFE rejects/truncates NUL-prefixed chat bodies.
 * Wire format: "FCMCTL/1/WORLD:<worldId>".
 */
const WORLD_ID_SENTINEL_PREFIX  = 'FCMCTL/1/WORLD:';
// LEAVE control: sent when the player leaves a world (worldId cleared). Body is
// exactly the sentinel; identity comes from the authenticated relay frame.
const WORLD_LEAVE_SENTINEL_PREFIX = 'FCMCTL/1/LEAVE';
// ROSTER control: observed nearby character names (the HUD publishes no worldId —
// rooms are derived from sightings). Body is a pipe-separated bounded name list.
const WORLD_ROSTER_SENTINEL_PREFIX = 'FCMCTL/1/ROSTER:';
// Explicit UI-reload recovery. Static history is replayed immediately; server-room
// history is held until the next authenticated roster/world bind confirms the room.
const HISTORY_RESYNC_SENTINEL = 'FCMCTL/1/RESYNC';
// v2.9.2 and earlier emitted NUL-prefixed controls. Retain acceptance for clients
// already in a session, but all new widget requests use printable framing.
const LEGACY_WORLD_ID_SENTINEL_PREFIX = '\x00fcm.world.v1\x00';
const LEGACY_WORLD_LEAVE_SENTINEL_PREFIX = '\x00fcm.world.leave.v1\x00';
const LEGACY_WORLD_ROSTER_SENTINEL_PREFIX = '\x00fcm.world.roster.v1\x00';
const MAX_WORLD_ID_LENGTH       = 128;
const MAX_ROSTER_CONTROL_BYTES  = 2048;
const WORLD_CONTROL_WINDOW_SECONDS = 10;
const MAX_WORLD_CONTROLS_PER_WINDOW = 6;
const REGISTER_WINDOW_SECONDS = 60;
const MAX_REGISTRATIONS_PER_IP = 3;
const REPORT_WINDOW_SECONDS = 10 * 60;
const MAX_REPORTS_PER_WINDOW = 5;
const RELAY_FIRST_FRAME_TIMEOUT_MS = 10_000;
const RELAY_RPC_IDLE_CLOSE_MS = 250;
const POLL_HISTORY_LIMIT        = 75;    // SQL initial history window on cursor=0; handlePoll applies the caller's final max after merging server history
const REDIS_BROADCAST_CHANNEL   = 'chat:broadcast';
const RELAY_CONTROL_CHANNEL     = 'relay:control';
const MAX_SOCKET_BUFFER_BYTES    = 1_048_576;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HISTORY_RESYNC_BIND_WINDOW_MS = 60_000;
const relayInstanceId = uuidv4();

/**
 * Build the human-facing link-flow URL (bare host + /link) from the public base URL.
 * Env-aware (FCM_PUBLIC_BASE_URL) so dev shows dev.falloutchatmod.com/link and prod shows
 * falloutchatmod.com/link. Scheme is stripped to match the in-game notice's bare-host format.
 */
export function deriveLinkUrl(baseUrl: string): string {
  const host = (baseUrl || 'https://falloutchatmod.com')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  return `${host}/link`;
}
const LINK_URL                  = deriveLinkUrl(env.FCM_PUBLIC_BASE_URL);

// ── Link-code service (dynamic import — WT2 may not yet be merged) ────────────

/**
 * Issue a link code for a limited relay identity.
 * Dynamic import so this module compiles solo before WT2 merges into the same
 * deployment. If WT2's linkCodeService is absent, returns null (no-op).
 */
function issueLinkCode(relayUserId: string): Promise<string | null> {
  // Use require() so this works in both CJS (Jest/tests) and bundled ESM.
  // Dynamic import() fails in Jest's CJS transform context without --experimental-vm-modules.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const svc: any = require('../../services/linkCodeService');
    if (typeof svc.issueLinkCode === 'function') {
      return Promise.resolve(svc.issueLinkCode(relayUserId));
    }
  } catch (err: any) {
    if (
      err?.code === 'MODULE_NOT_FOUND' ||
      (err?.message && (err.message as string).includes('Cannot find module'))
    ) {
      // WT2 not yet merged — graceful no-op.
    } else {
      logger.warn({ err, relayUserId }, '[relayHandler] issueLinkCode failed');
    }
  }
  return Promise.resolve(null);
}

/**
 * Push a SYSTEM NOTICE event to a subscriber connection immediately.
 * Used to deliver the link code to the SWF client right after register/hello.
 *
 * Canonical shape (canonical — WT3 gamemod-dev matches on this):
 *   { id: <cursor>, kind: 'chat.message', channel: 'system',
 *     senderUserId: 'system', senderDisplayName: 'FCM',
 *     body: 'LINK REQUIRED - visit falloutchatmod.com/link, sign in, and enter code: XXXX-XXXX (expires 10m)',
 *     targetUserId: '' }
 *
 * Delivered directly on `ws` — not broadcast (only the registering/hello-ing client sees it).
 */
async function pushLinkNotice(ws: WebSocket, relayUserId: string): Promise<void> {
  const code = await issueLinkCode(relayUserId);
  // Format code as XXXX-XXXX if it looks like an 8-char hex/alphanum string.
  const formatted = code && code.length === 8
    ? `${code.slice(0, 4)}-${code.slice(4)}`
    : code ?? '????-????';

  const redis  = await getRedisClient();
  const cursor = await redis.incr('relay:seq');

  const event = {
    id:                cursor,
    kind:              'chat.message',
    channel:           'system',
    senderUserId:      'system',
    senderDisplayName: 'FCM',
    body:              `LINK REQUIRED - visit ${LINK_URL}, sign in, and enter code: ${formatted} (expires 10m)`,
    targetUserId:      '',
    createdAt:         new Date().toISOString(),
  };
  send(ws, { op: 'event', cursor, event });
}

/**
 * Push a one-shot "link complete" system event to a user's live subscriber(s). Called from the
 * web redeem flow right after markRelayTokenLinked, so an ALREADY-CONNECTED in-game widget
 * transitions from the link screen to chat without waiting for a reconnect. The widget treats a
 * "LINK COMPLETE" system body as the authoritative "now linked" signal (clears its link gate).
 */
export async function notifyLinkComplete(relayUserId: string): Promise<void> {
  const pushed = await pushLinkCompleteLocal(relayUserId);
  try {
    const redis = await getRedisClient();
    await redis.publish(RELAY_CONTROL_CHANNEL, JSON.stringify({
      kind: 'link-complete',
      relayUserId,
      sourceInstanceId: relayInstanceId,
    }));
  } catch (err) {
    logger.warn({ err, relayUserId }, '[relayHandler] cross-instance link completion publish failed');
  }
  logger.info({ relayUserId, pushed }, '[relayHandler] notifyLinkComplete pushed');
}

/** Deliver a link completion only to subscribers owned by this process. */
async function pushLinkCompleteLocal(relayUserId: string): Promise<number> {
  const redis  = await getRedisClient();
  const cursor = await redis.incr('relay:seq');
  const event = {
    id:                cursor,
    kind:              'chat.message',
    channel:           'system',
    senderUserId:      'system',
    senderDisplayName: 'FCM',
    body:              'LINK COMPLETE - account linked. Chat activated.',
    targetUserId:      '',
    createdAt:         new Date().toISOString(),
  };
  let pushed = 0;
  for (const sub of subscribers) {
    if (sub.userId === relayUserId && sub.ws.readyState === 1) {
      if (sendRaw(sub.ws, JSON.stringify({ op: 'event', cursor, event }))) {
        sub.cursor = Math.max(sub.cursor, cursor);
        pushed++;
      } else {
        subscribers.delete(sub);
      }
    }
  }
  return pushed;
}

// ── Error envelope ────────────────────────────────────────────────────────────

/**
 * Stable error codes:
 *   auth_token_invalid  — token not found / stale
 *   auth_token_revoked  — explicitly revoked
 *   user_banned         — user is banned
 *   rate_limited        — hit ws_rate limit
 *
 * Operational codes (surfaced to SWF but ZFE takes no special action):
 *   permission_denied   — limited identity (not linked), or insufficient role
 *   invalid_channel     — unknown/omitted slug
 *   message_too_long    — body > 500 chars
 *   user_muted          — user is muted
 *   message_blocked     — rejected by automod (NOT a link/permission problem)
 *   slash_ignored       — a "/command" was typed in-game (not supported there)
 *   invalid_action      — unknown moderationAction action
 */
function errEnvelope(code: string, message: string): object {
  return { success: false, error: { code, message } };
}

class RelayReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayReportInputError';
  }
}

interface RelayReportMessage {
  targetUserId: string;
  targetDisplayName: string | null;
}

function sendRaw(ws: WebSocket, frame: string): boolean {
  if (ws.readyState !== 1) return false;
  if (ws.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
    logger.warn({ bufferedAmount: ws.bufferedAmount }, '[relayHandler] closing slow subscriber');
    try { ws.close(1013, 'subscriber too slow'); } catch { /* already closed */ }
    return false;
  }
  try {
    ws.send(frame);
    return true;
  } catch { return false; }
}

function send(ws: WebSocket, payload: object): void {
  sendRaw(ws, JSON.stringify(payload));
}

/**
 * A consumed server control is still a successful chat.v1 `send` operation.
 * ZFE requires every successful send response to carry a non-empty messageId,
 * even though controls are intentionally not persisted as chat messages.
 */
function sendControlAck(ws: WebSocket): void {
  send(ws, { success: true, messageId: uuidv4() });
}

/** Resolve just the HUD-safe cosmetic projection for an ephemeral sender. */
async function resolveHudCosmetics(userId: string | null): Promise<RelayHudCosmetics> {
  if (!userId) return {};
  const source: Record<string, unknown> = { userId };
  await attachCosmetics(source);
  return relayHudCosmetics(source);
}

/** Log only cosmetic-presence booleans at the native send boundary. */
function logHudSendAckCosmetics(
  ack: Record<string, unknown>,
  cosmetics: RelayHudCosmetics,
  transportEnabled: boolean,
): void {
  logger.info({
    transportEnabled,
    hasTag: typeof cosmetics.tag === 'string' && cosmetics.tag.trim().length > 0,
    hasStar: cosmetics.supporterStar === true,
    hasStarColor: typeof cosmetics.starColor === 'string' && cosmetics.starColor.length > 0,
    carrierPresent: typeof ack.targetUserId === 'string'
      && ack.targetUserId.startsWith('FCMHUD/1;'),
  }, '[relayHandler] HUD send acknowledgement cosmetics');
}

// ── Authenticated world/roster control parsing ────────────────────────────────

function validWorldId(value: string): string | null {
  const worldId = value.trim();
  if (!worldId || worldId.length > MAX_WORLD_ID_LENGTH || worldId.includes('|')) return null;
  return worldId;
}

function validLegacyTimestamp(value: string): boolean {
  if (!/^\d{1,12}$/.test(value)) return false;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= 300;
}

function parseWorldIdControl(body: string, actorUserId: string): string | null {
  const prefix = body.startsWith(WORLD_ID_SENTINEL_PREFIX)
    ? WORLD_ID_SENTINEL_PREFIX
    : (body.startsWith(LEGACY_WORLD_ID_SENTINEL_PREFIX) ? LEGACY_WORLD_ID_SENTINEL_PREFIX : null);
  if (!prefix) return null;
  const suffix = body.slice(prefix.length);
  if (prefix === WORLD_ID_SENTINEL_PREFIX || !suffix.includes('|')) return validWorldId(suffix);

  // Standalone FCMBridge legacy format:
  // <worldId>|<relayUserId>|<unixSeconds>|<hmacHex>
  // The relay token is the real authority. The embedded id must match it and
  // the timestamp/signature fields are structural freshness guards; the old
  // client embeds a build-time secret that cannot be treated as a server secret.
  const fields = suffix.split('|');
  if (fields.length !== 4 || fields[1] !== actorUserId || !validLegacyTimestamp(fields[2])) return null;
  if (!/^[0-9a-f]{64}$/i.test(fields[3])) return null;
  return validWorldId(fields[0]);
}

function isWorldLeaveControl(body: string, actorUserId: string): boolean {
  if (body === WORLD_LEAVE_SENTINEL_PREFIX) return true;
  if (!body.startsWith(LEGACY_WORLD_LEAVE_SENTINEL_PREFIX)) return false;
  const fields = body.slice(LEGACY_WORLD_LEAVE_SENTINEL_PREFIX.length).split('|');
  return fields.length === 3
    && fields[0] === actorUserId
    && validLegacyTimestamp(fields[1])
    && /^[0-9a-f]{64}$/i.test(fields[2]);
}

function parseWorldRosterControl(body: string): string[] | null {
  const prefix = body.startsWith(WORLD_ROSTER_SENTINEL_PREFIX)
    ? WORLD_ROSTER_SENTINEL_PREFIX
    : (body.startsWith(LEGACY_WORLD_ROSTER_SENTINEL_PREFIX) ? LEGACY_WORLD_ROSTER_SENTINEL_PREFIX : null);
  if (!prefix) return null;
  const namesField = body.slice(prefix.length);
  if (namesField.length > MAX_ROSTER_CONTROL_BYTES) return null;
  return namesField.length > 0 ? namesField.split(prefix === WORLD_ROSTER_SENTINEL_PREFIX ? '|' : '\x1F') : [];
}

/** Per-identity limit prevents a modified client from forcing room recomputation. */
async function checkWorldControlRateLimit(userId: string): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    const bucket = Math.floor(Date.now() / 1000 / WORLD_CONTROL_WINDOW_SECONDS);
    const key = `relay:world-control:${userId}:${bucket}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WORLD_CONTROL_WINDOW_SECONDS + 1);
    return count <= MAX_WORLD_CONTROLS_PER_WINDOW;
  } catch (err) {
    logger.warn({ err, userId }, '[relayHandler] world-control rate limit unavailable');
    return false;
  }
}

/**
 * Registration is intentionally anonymous, but each request performs a 64 MiB
 * Argon2id hash and inserts a token row. Bound it before minting so a public
 * relay cannot be used as an expensive hashing or database-write oracle.
 */
async function checkRegisterRateLimit(ip: string): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    const bucket = Math.floor(Date.now() / 1000 / REGISTER_WINDOW_SECONDS);
    const key = `relay:register:${ip}:${bucket}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, REGISTER_WINDOW_SECONDS + 1);
    return count <= MAX_REGISTRATIONS_PER_IP;
  } catch (err) {
    logger.warn({ err, ip }, '[relayHandler] registration rate limit unavailable');
    return false;
  }
}

/** Reports are a moderation queue write and therefore fail closed if Redis is unavailable. */
async function checkReportRateLimit(userId: string): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    const bucket = Math.floor(Date.now() / 1000 / REPORT_WINDOW_SECONDS);
    const key = `relay:report:${userId}:${bucket}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, REPORT_WINDOW_SECONDS + 1);
    return count <= MAX_REPORTS_PER_WINDOW;
  } catch (err) {
    logger.error({ err, userId }, '[relayHandler] report rate limit unavailable');
    return false;
  }
}

async function accountBlockReason(linkedUserId: string): Promise<'user_banned' | 'user_kicked' | null> {
  const user = await prisma.user.findUnique({
    where: { id: linkedUserId },
    select: { isBanned: true, kickedUntil: true },
  });
  if (user?.isBanned) return 'user_banned';
  if (user?.kickedUntil && new Date(user.kickedUntil).getTime() > Date.now()) return 'user_kicked';
  return null;
}

async function rejectBlockedAccount(ws: WebSocket, linkedUserId: string): Promise<boolean> {
  const reason = await accountBlockReason(linkedUserId);
  if (!reason) return false;
  send(ws, errEnvelope(reason, reason === 'user_banned' ? 'This account is banned' : 'This account is temporarily kicked'));
  return true;
}

// ── Subscribe registry ────────────────────────────────────────────────────────

interface SubscriberState {
  ws: WebSocket;
  userId: string;
  linkedUserId: string | null;
  cursor: number;
  worldId: string | null;
  supportsHudCosmeticsTransport: boolean;
}

// Module-level subscriber set — cleared on disconnect.
const subscribers = new Set<SubscriberState>();
const pendingSubscriptions = new WeakSet<WebSocket>();

function hasSubscriberSocket(ws: WebSocket): boolean {
  for (const subscriber of subscribers) {
    if (subscriber.ws === ws) return true;
  }
  return false;
}

function evictLocalRelayUser(linkedUserId: string, code: string, message: string): number {
  let evicted = 0;
  for (const sub of subscribers) {
    if (sub.linkedUserId !== linkedUserId) continue;
    send(sub.ws, errEnvelope(code, message));
    try { sub.ws.close(4002, code === 'user_kicked' ? 'Kicked' : 'Banned'); } catch { /* closing */ }
    subscribers.delete(sub);
    evicted++;
  }
  return evicted;
}

/**
 * Evict all live chat.v1 sessions for an FCM account, including subscribers on
 * other backend instances. The local close is immediate; Redis carries the
 * same control event to the other instances.
 */
export async function evictRelayUser(
  linkedUserId: string,
  options: { code: string; message: string },
): Promise<number> {
  const evicted = evictLocalRelayUser(linkedUserId, options.code, options.message);
  try {
    const redis = await getRedisClient();
    await redis.publish(RELAY_CONTROL_CHANNEL, JSON.stringify({
      kind: 'evict', linkedUserId, code: options.code, message: options.message,
    }));
  } catch (err) {
    logger.warn({ err, linkedUserId }, '[relayHandler] cross-instance relay eviction publish failed');
  }
  return evicted;
}

// A resync may arrive while a player is hopping worlds. Never replay the previous
// room: consume this marker only when the next bind confirms the current room.
const pendingServerHistoryResyncs = new Map<string, number>();

function markServerHistoryResyncPending(userId: string): void {
  const now = Date.now();
  for (const [pendingUserId, expiresAt] of pendingServerHistoryResyncs) {
    if (expiresAt <= now) pendingServerHistoryResyncs.delete(pendingUserId);
  }
  pendingServerHistoryResyncs.set(userId, now + HISTORY_RESYNC_BIND_WINDOW_MS);
}

function consumeServerHistoryResyncPending(userId: string): boolean {
  const expiresAt = pendingServerHistoryResyncs.get(userId);
  pendingServerHistoryResyncs.delete(userId);
  return expiresAt !== undefined && expiresAt > Date.now();
}

// Redis pub/sub listener — initialised once per process.
let pubSubReady = false;

// ── Server-room (worldId) membership ────────────────────────────────────────────

/** Update every live subscriber for `userId` to point at `worldId` (null = left). */
function rebindLocalSubscribers(userId: string, worldId: string | null): void {
  for (const sub of subscribers) {
    if (sub.userId === userId) sub.worldId = worldId;
  }
}

/** Push a world's recent history to a user's live subscriber(s) on join. */
async function backfillWorldToUser(userId: string, worldId: string): Promise<void> {
  const history = await getServerHistory(worldId, 0, POLL_HISTORY_LIMIT);
  if (history.length === 0) return;
  for (const sub of subscribers) {
    if (sub.userId !== userId || sub.ws.readyState !== 1) continue;
    for (const ev of history) {
      const event = relayHudEventForClient(
        ev as unknown as Record<string, unknown>,
        sub.supportsHudCosmeticsTransport,
      );
      if (!sendRaw(sub.ws, JSON.stringify({ op: 'event', cursor: ev.id, event }))) {
        subscribers.delete(sub);
        break;
      }
      sub.cursor = Math.max(sub.cursor, ev.id);
    }
  }
}

/** Replay the bounded SQL-backed history to every local native subscriber for a user. */
async function backfillStaticHistoryToUser(userId: string): Promise<void> {
  // Resolve cosmetics once, then adapt the native-known transport per subscriber.
  const history = await fetchHistoryEvents(0, POLL_HISTORY_LIMIT);
  if (history.length === 0) return;
  for (const sub of subscribers) {
    if (sub.userId !== userId || sub.ws.readyState !== 1) continue;
    for (const ev of history) {
      const event = relayHudEventForClient(ev, sub.supportsHudCosmeticsTransport);
      send(sub.ws, { op: 'event', cursor: ev.id as number, event });
    }
  }
}

/**
 * JOIN: the player entered `worldId`. Refresh the TTL always; on an actual world
 * CHANGE, re-bind this user's subscriber(s) (locally + across instances) and
 * backfill the new world's recent history so the SERVER tab populates on join.
 */
async function handleWorldJoin(identity: RelayToken, worldId: string): Promise<void> {
  const prev = await getWorldId(identity.userId);
  const shouldBackfillResync = consumeServerHistoryResyncPending(identity.userId);
  await setWorldId(identity.userId, worldId); // refresh 60s TTL (keepalive)
  if (prev === worldId && !shouldBackfillResync) return; // same world — just a keepalive, no membership change
  rebindLocalSubscribers(identity.userId, worldId);
  await publishRebind(identity.userId, worldId);
  await backfillWorldToUser(identity.userId, worldId);
}

/**
 * Recompute roster-derived rooms and apply changes: any user whose roomKey moved is
 * re-bound exactly like a worldId change (setWorldId + subscriber rebind + backfill).
 */
async function applyRoomAssignments(): Promise<void> {
  const rooms = await computeRooms();
  for (const [userId, roomKey] of rooms) {
    const current = await getWorldId(userId);
    const shouldBackfillResync = consumeServerHistoryResyncPending(userId);
    if (current === roomKey) {
      await setWorldId(userId, roomKey); // refresh TTL
      if (shouldBackfillResync) {
        rebindLocalSubscribers(userId, roomKey);
        await publishRebind(userId, roomKey);
        await backfillWorldToUser(userId, roomKey);
      }
      continue;
    }
    await setWorldId(userId, roomKey);
    rebindLocalSubscribers(userId, roomKey);
    await publishRebind(userId, roomKey);
    await backfillWorldToUser(userId, roomKey);
    logger.info({ userId, roomKey }, '[relayHandler] roster room assigned');
  }
}

/** LEAVE: the player left their world. Clear membership locally + across instances. */
async function handleWorldLeave(identity: RelayToken): Promise<void> {
  pendingServerHistoryResyncs.delete(identity.userId);
  await clearWorldId(identity.userId);
  await clearRoster(identity.userId);
  rebindLocalSubscribers(identity.userId, null);
  await publishRebind(identity.userId, null);
}

async function ensurePubSub(): Promise<void> {
  if (pubSubReady) return;
  pubSubReady = true; // set before await to prevent double-init races

  try {
    const sub = await getSubscriberClient();
    await sub.subscribe(REDIS_BROADCAST_CHANNEL, (message: string) => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(message); } catch { return; }

      // The WS handler's broadcast() publishes a wrapped envelope on this same
      // Redis channel: { instanceId, payload: { type:'chat:message', payload:{…} } }.
      // Unwrap one level when the envelope shape is present; tolerate an already
      // unwrapped { type, payload } too (defensive).
      const envelope = (parsed.instanceId !== undefined && parsed.payload !== undefined)
        ? (parsed.payload as Record<string, unknown>)
        : parsed;

      // We only forward chat:message events.
      if (envelope.type !== 'chat:message') return;
      const p = envelope.payload as Record<string, unknown>;
      if (!p) return;

      const relaySeq    = typeof p.relaySeq === 'number' ? p.relaySeq : null;
      const channelId   = typeof p.channelId === 'string' ? p.channelId : null;
      const slug        = channelId ? channelIdToSlug(channelId) : null;

      // No relaySeq = not a relay-originating message; skip
      if (relaySeq === null) return;

      // The broadcast() payload carries the server time as `timestamp` (ISO 8601 UTC,
      // set by finalizeMessage). Forward it as `createdAt` so clients can render times.
      const createdAt = typeof p.timestamp === 'string'
        ? p.timestamp
        : (typeof p.createdAt === 'string' ? p.createdAt : '');

      const eventObj = {
        id:                relaySeq,
        kind:              'chat.message',
        messageId:         p.id,
        channel:           slug ?? channelId, // fall back to UUID if no slug
        senderUserId:      p.userId,
        senderDisplayName: p.username,
        body:              p.content,
        targetUserId:      '',
        createdAt,
        ...relayHudCosmetics(p),
      };

      // Static channels only. The worldId-scoped 'server' room is fanned out via
      // SERVER_EVENTS_CHANNEL below (server messages never hit chat:broadcast).
      for (const sub of subscribers) {
        if (sub.cursor >= relaySeq) continue; // already seen
        const event = relayHudEventForClient(eventObj, sub.supportsHudCosmeticsTransport);
        const frame = JSON.stringify({ op: 'event', cursor: relaySeq, event });
        if (sendRaw(sub.ws, frame)) {
          sub.cursor = relaySeq;
        } else {
          subscribers.delete(sub);
        }
      }
    });

    await sub.subscribe(RELAY_CONTROL_CHANNEL, (message: string) => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(message); } catch { return; }
      if (parsed.sourceInstanceId !== undefined
        && (typeof parsed.sourceInstanceId !== 'string' || !UUID_RE.test(parsed.sourceInstanceId))) return;
      if (parsed.sourceInstanceId === relayInstanceId) return;

      if (parsed.kind === 'evict' && typeof parsed.linkedUserId === 'string') {
        evictLocalRelayUser(
          parsed.linkedUserId,
          typeof parsed.code === 'string' ? parsed.code : 'user_banned',
          typeof parsed.message === 'string' ? parsed.message : 'This account is banned',
        );
        return;
      }

      // Link redemption can happen on a different backend replica than the
      // long-lived HUD subscriber. Recreate the same system event locally;
      // never republish control messages received from Redis.
      if (parsed.kind === 'link-complete'
        && typeof parsed.relayUserId === 'string'
        && /^user_[0-9a-f]{32}$/i.test(parsed.relayUserId)) {
        pushLinkCompleteLocal(parsed.relayUserId).catch((err) =>
          logger.warn({ err, relayUserId: parsed.relayUserId }, '[relayHandler] remote link completion delivery failed'),
        );
      }
    });

    // Server-room events: worldId-scoped chat + membership rebinds.
    await sub.subscribe(SERVER_EVENTS_CHANNEL, async (message: string) => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(message); } catch { return; }

      if (parsed.kind === 'rebind') {
        const userId = typeof parsed.userId === 'string' ? parsed.userId : null;
        const worldId = typeof parsed.worldId === 'string' ? parsed.worldId : null;
        if (userId) {
          const shouldBackfillResync = consumeServerHistoryResyncPending(userId);
          rebindLocalSubscribers(userId, worldId);
          if (shouldBackfillResync && worldId) {
            try {
              await backfillWorldToUser(userId, worldId);
            } catch (err) {
              logger.warn({ err, userId, worldId }, '[relayHandler] server history backfill on resync rebind failed');
            }
          }
        }
        return;
      }

      if (parsed.kind === 'history-resync') {
        const userId = typeof parsed.userId === 'string' ? parsed.userId : null;
        if (!userId) return;
        if (parsed.sourceInstanceId === relayInstanceId) return;
        markServerHistoryResyncPending(userId);
        try {
          await backfillStaticHistoryToUser(userId);
        } catch (err) {
          logger.warn({ err, userId }, '[relayHandler] static history backfill on resync failed');
        }
        return;
      }

      if (parsed.kind === 'msg') {
        const worldId = typeof parsed.worldId === 'string' ? parsed.worldId : null;
        const cursor  = typeof parsed.cursor === 'number' ? parsed.cursor : null;
        if (!worldId || cursor === null) return;
        for (const sub of subscribers) {
          if (sub.worldId !== worldId) continue; // world-scoped: only same-world subscribers
          if (sub.cursor >= cursor) continue;    // already seen
          const rawEvent = parsed.event as Record<string, unknown>;
          const event = relayHudEventForClient(rawEvent, sub.supportsHudCosmeticsTransport);
          const frame = JSON.stringify({ op: 'event', cursor, event });
          if (sendRaw(sub.ws, frame)) {
            sub.cursor = cursor;
          } else {
            subscribers.delete(sub);
          }
        }
        return;
      }
    });
  } catch (err) {
    pubSubReady = false;
    logger.error({ err }, '[relayHandler] Redis pub/sub subscription failed');
  }
}

// ── Op handlers ───────────────────────────────────────────────────────────────

async function handleRegister(ws: WebSocket, frame: Record<string, unknown>, ip: string): Promise<void> {
  const displayName = readWireDisplayName(frame.displayName).trim();
  // Record the widget build so any future wire-format addition can be gated on it.
  // Old builds send nothing, which reads as "assume the oldest client" — see
  // clientCapability.ts for why that matters when the .ba2 is a manual file copy.
  rememberClientVersion(ws, frame.clientVersion);
  if (!displayName) {
    send(ws, errEnvelope('invalid_request', 'displayName is required'));
    return;
  }

  if (!(await checkRegisterRateLimit(ip))) {
    logger.warn({ ip }, '[relayHandler] registration rate limit exceeded');
    send(ws, errEnvelope('rate_limited', 'Too many registrations; try again shortly'));
    return;
  }

  const { userId, token, role } = await mintToken(displayName);
  await rememberTokenClientVersionDurable(token, frame.clientVersion);
  send(ws, {
    success:     true,
    // userId is already in "user_"+hex format from mintToken — pass through directly.
    userId,
    displayName,
    token,
    role,
    // New registrations are always limited — state='limited' until link flow completes.
    state:       'limited',
  });

  // Push a SYSTEM NOTICE with the link code so the SWF can surface it in-game
  // immediately after register. Non-blocking — failure is logged but doesn't fail
  // the register response (which is already sent above).
  pushLinkNotice(ws, userId).catch((err) =>
    logger.warn({ err, userId }, '[relayHandler] pushLinkNotice failed on register'),
  );
}

async function handleHello(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
  rememberClientVersion(ws, frame.clientVersion);
  const rawToken = typeof frame.token === 'string' ? frame.token : null;
  if (!rawToken) {
    send(ws, errEnvelope('auth_token_invalid', 'token is required'));
    return;
  }

  const identity = await verifyToken(rawToken);
  if (!identity) {
    send(ws, errEnvelope('auth_token_invalid', 'Token not found or invalid'));
    return;
  }
  await rememberTokenClientVersionDurable(rawToken, frame.clientVersion);

  // Check the linked FCM account. identity.userId is a relay TEXT id; account
  // moderation state lives on linkedUserId.
  if (identity.linkedUserId && await rejectBlockedAccount(ws, identity.linkedUserId)) return;

  // Update displayName if provided and different.
  const newName = readWireDisplayName(frame.displayName).trim();
  if (newName && newName !== identity.fo76Name) {
    await updateDisplayName(identity.userId, newName);
    // Keep the linked account's fo76_account_name in sync so chat HISTORY (which derives the
    // sender from the user row) shows the current character name, not a stale one. This is what
    // lets the real FO76 name land once the widget re-hellos with it after the game populates it.
    if (identity.linkedUserId) {
      await prisma.user.update({
        where: { id: identity.linkedUserId },
        data:  { fo76AccountName: newName },
      }).catch((err) => logger.warn({ err, userId: identity.linkedUserId }, '[relayHandler] fo76AccountName sync on hello failed'));
    }
  }

  const state = identity.isLinked ? 'authenticated' : 'limited';

  send(ws, {
    success:     true,
    // identity.userId is relay TEXT ("user_"+hex) — pass through directly.
    userId:      identity.userId,
    displayName: newName || identity.fo76Name,
    role:        identity.role,
    state,
  });

  // If still limited: push a fresh SYSTEM NOTICE with a (refreshed) link code
  // so the SWF always surfaces the correct code on reconnect.
  if (!identity.isLinked) {
    pushLinkNotice(ws, identity.userId).catch((err) =>
      logger.warn({ err, userId: identity.userId }, '[relayHandler] pushLinkNotice failed on hello'),
    );
  }
}

/**
 * getAuthState — reflects the current link state for the SWF to gate its input.
 *
 * Response shape:
 *   { success: true, userId, state: 'authenticated'|'limited', permissions: { canReport, canSend, canKickUser, ... } }
 *
 * userId is always populated so the widget can correlate its authenticated relay session.
 * state='authenticated' only when linked_user_id is set; otherwise 'limited'.
 * permissions.canSend reflects isLinked (same gate as handleSend).
 * permissions.canReport reflects the same linked-account gate as handleReport.
 * Staff-only moderation permissions reflect the currently verified Discord role.
 */
async function handleGetAuthState(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
  const rawToken = typeof frame.token === 'string' ? frame.token : null;
  if (!rawToken) {
    send(ws, errEnvelope('auth_token_invalid', 'token is required'));
    return;
  }

  const identity = await verifyToken(rawToken);
  if (!identity) {
    send(ws, errEnvelope('auth_token_invalid', 'Token not found or invalid'));
    return;
  }

  if (identity.linkedUserId && await rejectBlockedAccount(ws, identity.linkedUserId)) return;
  const role = identity.linkedUserId ? await getEffectiveRole(identity.linkedUserId) : 'user';
  const privileged = isPrivilegedRole(role);
  const state = identity.isLinked ? 'authenticated' : 'limited';

  send(ws, {
    success: true,
    // identity.userId is relay TEXT ("user_"+hex) — pass through directly.
    userId:  identity.userId,
    state,
    permissions: {
      canSend:   identity.isLinked,
      canReport: identity.isLinked,
      canDeleteMessage: identity.isLinked && privileged,
      canKickUser:      identity.isLinked && privileged,
      canMuteUser:      identity.isLinked && privileged,
      canUnmuteUser:    identity.isLinked && privileged,
      canBanUser:       identity.isLinked && privileged,
      canUnbanUser:     identity.isLinked && privileged,
      canSetSlowMode:   false,
    },
    role,
    roles: [role],
  });
}

async function handleSend(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
  const rawToken = typeof frame.token === 'string' ? frame.token : null;
  if (!rawToken) {
    send(ws, errEnvelope('auth_token_invalid', 'token is required'));
    return;
  }

  const identity = await verifyToken(rawToken);
  if (!identity) {
    send(ws, errEnvelope('auth_token_invalid', 'Token not found or invalid'));
    return;
  }

  // Auth gate: limited identities cannot send (check before any user lookup).
  // We check this BEFORE ban/mute to avoid unnecessary DB queries for limited users.
  if (!identity.isLinked) {
    send(ws, errEnvelope('permission_denied', `Account not linked — complete the link flow at ${LINK_URL}`));
    return;
  }

  // Check ban/mute on the linked FCM users row.
  // identity.userId is relay TEXT — ban state lives on the FCM account (linkedUserId).
  const user = await prisma.user.findUnique({
    where: { id: identity.linkedUserId! },
    select: { isBanned: true, isMuted: true, kickedUntil: true, discordId: true },
  });
  if (user?.isBanned) {
    send(ws, errEnvelope('user_banned', 'This account is banned'));
    return;
  }
  if (user?.kickedUntil && new Date(user.kickedUntil).getTime() > Date.now()) {
    send(ws, errEnvelope('user_kicked', 'This account is temporarily kicked'));
    return;
  }
  if (user?.isMuted) {
    send(ws, errEnvelope('user_muted', 'You are currently muted'));
    return;
  }

  // ZFE mangles mod-supplied string values on the way out (see wireSanitize.ts). Detect that
  // on the CHANNEL, where a repair is positively verifiable against the known slug set, and
  // only then repair this frame's body. A body must never be de-interleaved on its own
  // evidence: a legitimate `au0000bu0000c` matches the pattern and would be rewritten.
  const channelRepair = repairChannel(frame.channel, (s) => ALL_SLUGS.includes(s));
  const slug = channelRepair.slug;
  const body = repairBody(frame.body, channelRepair.mangled);

  // ── Authenticated world/roster control intercept (before ALL_SLUGS check) ──
  // Actor identity comes only from `identity`, derived from the relay token above.
  // Controls are bounded, applied to membership, and never broadcast/persisted.
  if (slug === 'server' && (body.startsWith(WORLD_ID_SENTINEL_PREFIX) || body.startsWith(LEGACY_WORLD_ID_SENTINEL_PREFIX))) {
    const worldId = parseWorldIdControl(body, identity.userId);
    if (worldId) {
      if (!(await checkWorldControlRateLimit(identity.userId))) {
        send(ws, errEnvelope('rate_limited', 'World controls are temporarily rate limited'));
        return;
      }
      await handleWorldJoin(identity, worldId);
      sendControlAck(ws);
      return;
    }
  }
  if (slug === 'server' && (body.startsWith(WORLD_LEAVE_SENTINEL_PREFIX) || body.startsWith(LEGACY_WORLD_LEAVE_SENTINEL_PREFIX))) {
    if (isWorldLeaveControl(body, identity.userId)) {
      if (!(await checkWorldControlRateLimit(identity.userId))) {
        send(ws, errEnvelope('rate_limited', 'World controls are temporarily rate limited'));
        return;
      }
      await handleWorldLeave(identity);
      sendControlAck(ws);
      return;
    }
  }
  if (slug === 'server' && (body.startsWith(WORLD_ROSTER_SENTINEL_PREFIX) || body.startsWith(LEGACY_WORLD_ROSTER_SENTINEL_PREFIX))) {
    const names = parseWorldRosterControl(body);
    if (names) {
      if (!(await checkWorldControlRateLimit(identity.userId))) {
        send(ws, errEnvelope('rate_limited', 'World controls are temporarily rate limited'));
        return;
      }
      await setRoster(identity.userId, identity.fo76Name, names);
      await applyRoomAssignments();
      sendControlAck(ws);
      return;
    }
  }
  if (slug === 'server' && body === HISTORY_RESYNC_SENTINEL) {
    if (!(await checkWorldControlRateLimit(identity.userId))) {
      send(ws, errEnvelope('rate_limited', 'World controls are temporarily rate limited'));
      return;
    }
    markServerHistoryResyncPending(identity.userId);
    try {
      // Serve this process directly so recovery is not dependent on pub/sub loopback,
      // then fan out to whichever backend owns the long-lived native subscriber.
      await backfillStaticHistoryToUser(identity.userId);
      await publishHistoryResync(identity.userId, relayInstanceId);
    } catch (err) {
      logger.warn({ err, userId: identity.userId }, '[relayHandler] history resync failed');
      send(ws, errEnvelope('history_unavailable', 'Chat history is temporarily unavailable'));
      return;
    }
    sendControlAck(ws);
    return;
  }

  if (!ALL_SLUGS.includes(slug)) {
    send(ws, errEnvelope('invalid_channel', `Unknown channel: ${slug}`));
    return;
  }

  if (body.length > 500) {
    send(ws, errEnvelope('message_too_long', 'Message body exceeds 500 characters'));
    return;
  }

  // HUD-originated sends are the fast path for a supporter role change. Refresh
  // the linked account's Discord roles at most once per minute before either the
  // ephemeral server event or persisted static message is decorated. The helper
  // fails open to the last known entitlement on transient Discord failures, so
  // role verification can never make chat unavailable.
  await refreshSupporterFromHudSend({
    userId: identity.linkedUserId!,
    discordId: user?.discordId ?? null,
  });
  // The native bridge preserves targetUserId but can strip newer JSON members
  // from short-lived RPC responses. Resolve this capability once for the send
  // acknowledgement and carry the same validated projection through the known
  // field when the widget understands FCMHUD/1.
  const supportsHudCosmeticsTransport = await tokenSupportsHudCosmeticsTransportDurable(rawToken);

  // Discard targetUserId on all non-whisper sends (frame.targetUserId ignored).

  // ── 'server' = worldId-scoped ephemeral room (NOT persisted to Postgres) ──
  // Same-world players share `server:<worldId>`. Messages run through automod +
  // a flood guard, get a relaySeq cursor, and are stored in a capped Redis
  // history + fanned out only to same-world subscribers. Deliberately bypasses
  // ingestMessage/Postgres — FO76 worlds churn, so this room is ephemeral.
  if (slug === 'server') {
    const worldId = await getWorldId(identity.userId);
    if (!worldId) {
      send(ws, errEnvelope('invalid_channel', 'No active server session — send worldId first'));
      return;
    }
    if (!(await checkServerRateLimit(identity.userId))) {
      send(ws, errEnvelope('rate_limited', 'You are sending messages too quickly'));
      return;
    }
    // Automod: no channel-exemption context for the ephemeral room (channelId undefined).
    const mod = await engineEvaluate(body, undefined, {
      id: identity.linkedUserId!,
      username: identity.fo76Name,
    });
    if (mod.block) {
      send(ws, errEnvelope('message_blocked', 'Message blocked by the chat filter'));
      return;
    }
    const relaySeq = await nextRelaySeq();
    const hudCosmetics = await resolveHudCosmetics(identity.linkedUserId);
    const event: ServerRoomEvent = {
      id:                relaySeq,
      kind:              'chat.message',
      messageId:         `server:${worldId}:${relaySeq}`,
      channel:           'server',
      senderUserId:      identity.userId,
      senderDisplayName: identity.fo76Name,
      body,
      targetUserId:      '',
      createdAt:         new Date().toISOString(),
      ...hudCosmetics,
    };
    await publishServerMessage(worldId, relaySeq, event);
    // Include the resolved identity cosmetics in the send acknowledgement as well as
    // the live event. ZFE renders a local optimistic row immediately; returning the
    // authoritative marker here means that row is decorated even if the asynchronous
    // subscriber echo is delayed or consumed by a separate native queue.
    const ack = relayHudSendAck(
      { success: true, messageId: event.messageId },
      hudCosmetics,
      supportsHudCosmeticsTransport,
    );
    logHudSendAckCosmetics(ack, hudCosmetics, supportsHudCosmeticsTransport);
    send(ws, ack);
    return;
  }

  // ── Static channels (global/trade/events/raids/infests) ──
  const channelId = slugToChannelId(slug);
  if (!channelId) {
    send(ws, errEnvelope('invalid_channel', `Channel '${slug}' is not mapped`));
    return;
  }

  // Assign relay cursor BEFORE ingestMessage so it is threaded through
  // finalizeMessage into BOTH the single broadcast and the persisted row.
  const relaySeq = await nextRelaySeq();

  // ingestMessage attributes messages.user_id (a UUID FK -> users.id) and runs the
  // mute/automod checks against that users row. identity.userId is the relay TEXT id
  // ("user_"+hex), NOT a UUID — passing it makes prisma.user.findUnique throw P2023
  // ("invalid UUID"). Use the linked FCM account UUID (guaranteed set: the !isLinked
  // gate above already returned permission_denied for unlinked identities).
  const result = await ingestMessage({
    userId:    identity.linkedUserId!,
    channelId,
    rawContent: body,
    source:    'relay',
    relaySeq,
    // Show the in-game CHARACTER name in chat (not the linked FCM account's Discord name).
    displayName: identity.fo76Name,
  });

  if (!result.ok) {
    // Map ingest failure reasons to stable client codes. IMPORTANT: automod + slash-command
    // failures get their OWN codes — they must NOT collapse into permission_denied, or the
    // in-game widget tells a LINKED user to "link your account" for a filtered/slash message.
    const code =
      result.reason === 'muted'             ? 'user_muted'        :
      result.reason === 'rate-limited'      ? 'rate_limited'      :
      result.reason === 'invalid-channel'   ? 'invalid_channel'   :
      result.reason === 'channel-not-found' ? 'invalid_channel'   :
      result.reason === 'invalid-content'   ? 'message_too_long'  :
      result.reason === 'automod'           ? 'message_blocked'   :
      result.reason === 'slash-command-dropped' ? 'slash_ignored' :
      'permission_denied';
    const msg =
      code === 'message_blocked' ? 'Message blocked by the chat filter' :
      code === 'slash_ignored'   ? 'Slash commands are not supported in-game' :
      (result.reason ?? 'Send rejected');
    send(ws, errEnvelope(code, msg));
    return;
  }

  const senderCosmetics = await resolveHudCosmetics(identity.linkedUserId);
  // See the server-room acknowledgement above: the HUD can paint its optimistic
  // self-row from this authoritative response without waiting for pub/sub delivery.
  const ack = relayHudSendAck(
    { success: true, messageId: result.messageId },
    senderCosmetics,
    supportsHudCosmeticsTransport,
  );
  logHudSendAckCosmetics(ack, senderCosmetics, supportsHudCosmeticsTransport);
  send(ws, ack);
}

/**
 * Submit a report for a persisted chat message. Relay identities are deliberately
 * resolved to their linked FCM user before the report is written; the message
 * itself supplies the target user so the client cannot forge either party.
 */
async function handleReport(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
  const rawToken = typeof frame.token === 'string' ? frame.token : null;
  if (!rawToken) {
    send(ws, errEnvelope('auth_token_invalid', 'token is required'));
    return;
  }

  const identity = await verifyToken(rawToken);
  if (!identity) {
    send(ws, errEnvelope('auth_token_invalid', 'Token not found or invalid'));
    return;
  }
  if (!identity.isLinked || !identity.linkedUserId) {
    send(ws, errEnvelope('permission_denied', `Account not linked — complete the link flow at ${LINK_URL}`));
    return;
  }

  if (await rejectBlockedAccount(ws, identity.linkedUserId)) return;

  const messageId = typeof frame.messageId === 'string' ? frame.messageId.trim() : '';
  if (!UUID_RE.test(messageId)) {
    send(ws, errEnvelope('invalid_request', 'messageId must be a valid message UUID'));
    return;
  }

  const reason = typeof frame.reason === 'string' ? frame.reason.trim() : '';
  if (!reason || reason.length > 500) {
    send(ws, errEnvelope('invalid_request', 'reason is required and must be 500 characters or fewer'));
    return;
  }

  if (frame.details !== undefined && frame.details !== null && typeof frame.details !== 'string') {
    send(ws, errEnvelope('invalid_request', 'details must be a string'));
    return;
  }
  const details = typeof frame.details === 'string' ? frame.details.trim() : '';
  if (details.length > 1000) {
    send(ws, errEnvelope('invalid_request', 'details must be 1000 characters or fewer'));
    return;
  }

  if (!(await checkReportRateLimit(identity.linkedUserId))) {
    send(ws, errEnvelope('rate_limited', 'Too many reports; try again later'));
    return;
  }

  let submitted: {
    report: { id: string; createdAt: Date };
    targetUserId: string;
    targetDisplayName: string | null;
  };
  try {
    submitted = await prisma.$transaction(async (tx) => {
      // Serialize reports for this exact reporter/message pair. This closes the
      // concurrent double-submit window without relying on a client-generated
      // idempotency key or a second report table.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`relay-report:${identity.linkedUserId}:${messageId}`}, 0))`;
      const duplicate = await tx.report.findFirst({
        where: { reporterUserId: identity.linkedUserId!, messageId },
        select: { id: true },
      });
      if (duplicate) throw new RelayReportInputError('You already reported this message');

      const rows = await tx.$queryRaw<RelayReportMessage[]>`
        SELECT m.user_id AS "targetUserId",
               COALESCE(u.fo76_account_name, u.discord_display_name, u.username) AS "targetDisplayName"
        FROM messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.id = ${messageId}::uuid AND NOT m.is_deleted
        FOR SHARE
      `;
      const message = rows[0];
      if (!message) throw new RelayReportInputError('Message not found or already deleted');
      if (message.targetUserId.toLowerCase() === identity.linkedUserId!.toLowerCase()) {
        throw new RelayReportInputError('You cannot report your own message');
      }

      const report = await tx.report.create({
        data: {
          reporterUserId: identity.linkedUserId!,
          targetUserId: message.targetUserId,
          messageId,
          reason,
          notes: details || null,
        },
        select: { id: true, createdAt: true },
      });
      return { report, targetUserId: message.targetUserId, targetDisplayName: message.targetDisplayName };
    });
  } catch (err) {
    if (err instanceof RelayReportInputError) {
      send(ws, errEnvelope('invalid_request', err.message));
      return;
    }
    logger.error({ err, messageId, relayUserId: identity.userId }, '[relayHandler] report persistence failed');
    send(ws, errEnvelope('internal_error', 'Unable to submit report'));
    return;
  }

  await prisma.auditLog.create({
    data: {
      actorId: identity.linkedUserId,
      action: 'submit_report',
      targetId: messageId,
      targetType: 'message',
      reason,
      metadata: {
        reportId: submitted.report.id,
        targetUserId: submitted.targetUserId,
        ...(details ? { details } : {}),
      },
    },
  }).catch((err) => logger.warn({ err, reportId: submitted.report.id }, '[relayHandler] report audit write failed'));

  if (typeof (global as any).broadcastReportAlert === 'function') {
    (global as any).broadcastReportAlert({
      id: submitted.report.id,
      createdAt: submitted.report.createdAt,
      reason,
      messageId,
      targetUserId: submitted.targetUserId,
      reporterUserId: identity.linkedUserId,
    });
  }

  // Keep Discord notification best-effort, matching the existing HTTP report path.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { postModAlert } = require('../discordService') as {
      postModAlert?: (embed: Record<string, unknown>) => Promise<void>;
    };
    if (typeof postModAlert === 'function') {
      await postModAlert({
        title: '🚩 In-game Message Report Submitted',
        color: '#FF8C00',
        fields: [
          { name: 'Reporter', value: identity.fo76Name, inline: true },
          { name: 'Reported User', value: submitted.targetDisplayName || submitted.targetUserId, inline: true },
          { name: 'Reason', value: reason.slice(0, 1024) },
          { name: 'Message ID', value: messageId, inline: true },
          ...(details ? [{ name: 'Details', value: details.slice(0, 1024) }] : []),
        ],
        timestamp: true,
        footerText: `Report ID: ${submitted.report.id}`,
      });
    }
  } catch (err) {
    logger.warn({ err, reportId: submitted.report.id }, '[relayHandler] report Discord notification failed');
  }

  send(ws, { success: true, status: 'reported' });
}

async function handlePoll(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
  const rawToken = typeof frame.token === 'string' ? frame.token : null;
  if (!rawToken) {
    send(ws, errEnvelope('auth_token_invalid', 'token is required'));
    return;
  }

  const identity = await verifyToken(rawToken);
  if (!identity) {
    send(ws, errEnvelope('auth_token_invalid', 'Token not found or invalid'));
    return;
  }

  if (identity.linkedUserId && await rejectBlockedAccount(ws, identity.linkedUserId)) return;

  const cursor = typeof frame.cursor === 'number' ? frame.cursor : 0;
  const max    = Math.max(0, Math.min(typeof frame.max === 'number' ? frame.max : 64, 100));

  // The native bridge preserves targetUserId but strips newer JSON members. Resolve
  // the negotiated capability once for this short-lived poll and carry cosmetics
  // through the known field only for the new widget.
  const supportsHudCosmeticsTransport = await tokenSupportsHudCosmeticsTransportDurable(rawToken);
  const events = (await fetchHistoryEvents(cursor, max)).map((event) =>
    relayHudEventForClient(event, supportsHudCosmeticsTransport),
  );

  // Merge in the caller's current-world server-room history (ephemeral, not in SQL).
  const worldId = await getWorldId(identity.userId);
  if (worldId) {
    const sHist = await getServerHistory(worldId, cursor, max);
    if (sHist.length > 0) {
      events.push(...sHist.map((event) =>
        relayHudEventForClient(
          event as unknown as Record<string, unknown>,
          supportsHudCosmeticsTransport,
        ),
      ));
      events.sort((a, b) => (a.id as number) - (b.id as number));
    }
  }

  // fetchHistoryEvents(cursor=0) deliberately reads a larger bounded SQL
  // window so the merge has enough candidates. The caller's requested max is
  // authoritative across both SQL and ephemeral server history.
  send(ws, { success: true, events: events.slice(0, max) });
}

const RELAY_MODERATION_ACTIONS = new Set([
  'deleteMessage', 'kickUser', 'muteUser', 'unmuteUser', 'banUser', 'unbanUser', 'setSlowMode',
]);

function boundedReason(frame: Record<string, unknown>): string {
  return typeof frame.reason === 'string' ? frame.reason.trim().slice(0, 500) : '';
}

function positiveDurationMinutes(frame: Record<string, unknown>, fallback: number): number {
  const raw = frame.durationMinutes ?? (
    typeof frame.durationHours === 'number' ? frame.durationHours * 60 : undefined
  );
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 30 * 24 * 60) : 0;
}

async function handleModerationAction(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
  const rawToken = typeof frame.token === 'string' ? frame.token : null;
  if (!rawToken) {
    send(ws, errEnvelope('auth_token_invalid', 'token is required'));
    return;
  }

  const identity = await verifyToken(rawToken);
  if (!identity) {
    send(ws, errEnvelope('auth_token_invalid', 'Token not found or invalid'));
    return;
  }
  if (!identity.isLinked || !identity.linkedUserId) {
    send(ws, errEnvelope('permission_denied', `Account not linked — complete the link flow at ${LINK_URL}`));
    return;
  }
  if (await rejectBlockedAccount(ws, identity.linkedUserId)) return;

  const action = typeof frame.action === 'string' ? frame.action : '';
  if (!RELAY_MODERATION_ACTIONS.has(action)) {
    send(ws, errEnvelope('invalid_action', `Unsupported moderation action: ${action || '(missing)'}`));
    return;
  }

  const role = await getEffectiveRole(identity.linkedUserId);
  if (!isPrivilegedRole(role)) {
    send(ws, errEnvelope('permission_denied', 'Moderation actions require a linked staff account'));
    return;
  }

  // FCM has no per-channel slow-mode primitive yet. Keep this explicit so the
  // client can distinguish a known-but-unsupported feature from bad auth.
  if (action === 'setSlowMode') {
    send(ws, errEnvelope('invalid_action', 'Slow mode is not available on this relay'));
    return;
  }

  const reason = boundedReason(frame);
  if (!reason) {
    send(ws, errEnvelope('invalid_request', 'reason is required'));
    return;
  }

  const targetUserId = typeof frame.targetUserId === 'string' ? frame.targetUserId.trim() : '';
  const service = require('../moderationActionsService') as {
    kickUser: (targetId: string, actorId: string, reason: string) => Promise<unknown>;
    deleteMessageById: (messageId: string, actorId: string, reason?: string) => Promise<void>;
    muteUser: (targetId: string, actorId: string, durationMs: number, category: string, reason: string) => Promise<unknown>;
    unmuteUser: (targetId: string, actorId: string, reason: string) => Promise<void>;
    createBan: (targetId: string, actorId: string, category: string, reason: string, bannedUntil: Date | null, evidence: Array<{ type: 'text'; textContent: string }>) => Promise<unknown>;
    reverseBan: (banId: string, actorId: string, reason: string) => Promise<void>;
    REASON_CATEGORIES?: readonly string[];
  };

  try {
    if (action === 'deleteMessage') {
      const messageId = typeof frame.messageId === 'string' ? frame.messageId.trim() : '';
      if (!UUID_RE.test(messageId)) {
        send(ws, errEnvelope('invalid_request', 'messageId must be a valid message UUID'));
        return;
      }
      await service.deleteMessageById(messageId, identity.linkedUserId, reason);
    } else {
      if (!UUID_RE.test(targetUserId)) {
        send(ws, errEnvelope('invalid_request', 'targetUserId must be a valid user UUID'));
        return;
      }

      if (action === 'kickUser') {
        await service.kickUser(targetUserId, identity.linkedUserId, reason);
      } else if (action === 'muteUser') {
        const minutes = positiveDurationMinutes(frame, 10);
        if (!minutes) {
          send(ws, errEnvelope('invalid_request', 'durationMinutes must be a positive number'));
          return;
        }
        const category = typeof frame.category === 'string' ? frame.category.trim() : 'Other';
        if (service.REASON_CATEGORIES && !service.REASON_CATEGORIES.includes(category)) {
          send(ws, errEnvelope('invalid_request', 'category is invalid'));
          return;
        }
        await service.muteUser(targetUserId, identity.linkedUserId, minutes * 60_000, category, reason);
      } else if (action === 'unmuteUser') {
        await service.unmuteUser(targetUserId, identity.linkedUserId, reason);
      } else if (action === 'banUser') {
        const category = typeof frame.category === 'string' ? frame.category.trim() : 'Other';
        if (service.REASON_CATEGORIES && !service.REASON_CATEGORIES.includes(category)) {
          send(ws, errEnvelope('invalid_request', 'category is invalid'));
          return;
        }
        const minutes = positiveDurationMinutes(frame, 0);
        const bannedUntil = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
        await service.createBan(
          targetUserId,
          identity.linkedUserId,
          category,
          reason,
          bannedUntil,
          [{ type: 'text', textContent: `In-game moderation action: ${reason}` }],
        );
      } else if (action === 'unbanUser') {
        const activeBan = await prisma.ban.findFirst({
          where: { userId: targetUserId, reversedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (!activeBan) {
          send(ws, errEnvelope('invalid_request', 'No active ban found for targetUserId'));
          return;
        }
        await service.reverseBan(activeBan.id, identity.linkedUserId, reason);
      }
    }
  } catch (err: any) {
    if (err?.name === 'ProtectedTargetError') {
      send(ws, errEnvelope('permission_denied', 'Protected staff accounts must be moderated in Discord'));
      return;
    }
    if (err?.message === 'Message not found' || err?.message === 'Ban not found' || err?.message === 'Ban already reversed') {
      send(ws, errEnvelope('invalid_request', err.message));
      return;
    }
    throw err;
  }

  send(ws, { success: true, status: 'submitted', action });
}

/**
 * Recent chat history as chat.message events. cursor=0 → the initial window (latest
 * POLL_HISTORY_LIMIT, oldest-first); otherwise everything with relay_seq > cursor.
 * Shared by handlePoll and subscribe-time backfill. ZFE's pollEvents drains the native
 * queue supplied by the long-lived subscription; it does not issue a relay poll request
 * when the HUD initializes. The returned events contain the server-resolved additive
 * projection and are adapted to the native-known transport at each delivery boundary.
 */
async function fetchHistoryEvents(
  cursor: number,
  max: number,
): Promise<Array<Record<string, unknown>>> {
  let rows: Array<{
    id: string;
    relay_seq: bigint | null;
    content: string;
    user_id: string;
    channel_id: string;
    username: string;
    fo76_account_name: string | null;
    created_at: Date | string | null;
  }>;

  if (cursor === 0) {
    rows = await prisma.$queryRaw`
      SELECT m.id, m.relay_seq, m.content, m.user_id,
             m.channel_id, m.created_at,
             COALESCE(u.fo76_account_name, u.discord_display_name, u.username) AS username,
             u.fo76_account_name
      FROM   messages m
      JOIN   users    u ON u.id = m.user_id
      JOIN   channels c ON c.id = m.channel_id
      WHERE  m.relay_seq IS NOT NULL
        AND  c.parent_id IS NOT NULL
        AND  NOT c.is_archived
        AND  NOT m.is_deleted
      ORDER BY m.relay_seq DESC
      LIMIT  ${POLL_HISTORY_LIMIT}
    `;
    rows = rows.reverse(); // oldest first
  } else {
    rows = await prisma.$queryRaw`
      SELECT m.id, m.relay_seq, m.content, m.user_id,
             m.channel_id, m.created_at,
             COALESCE(u.fo76_account_name, u.discord_display_name, u.username) AS username,
             u.fo76_account_name
      FROM   messages m
      JOIN   users    u ON u.id = m.user_id
      JOIN   channels c ON c.id = m.channel_id
      WHERE  m.relay_seq > ${BigInt(cursor)}
        AND  c.parent_id IS NOT NULL
        AND  NOT c.is_archived
        AND  NOT m.is_deleted
      ORDER BY m.relay_seq ASC
      LIMIT  ${max}
    `;
  }

  const events = rows.map((row) => ({
    id:                Number(row.relay_seq),
    kind:              'chat.message',
    messageId:         row.id,
    channel:           channelIdToSlug(row.channel_id) ?? row.channel_id,
    senderUserId:      row.user_id,
    senderDisplayName: row.username,
    body:              row.content,
    targetUserId:      '',
    createdAt:         row.created_at ? new Date(row.created_at).toISOString() : '',
    userId: row.user_id,
  }));

  // History stores identity, not a cosmetic snapshot. Resolve each distinct author
  // once through the same cache-backed service used by live chat, then project only
  // the validated HUD fields into the relay event.
  await attachCosmeticsToHistory(events);
  return events.map((event) => {
    const { userId: _userId, ...base } = event;
    return { ...base, ...relayHudCosmetics(event) };
  });
}

async function handleSubscribeInternal(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
  const rawToken = typeof frame.token === 'string' ? frame.token : null;
  if (!rawToken) {
    send(ws, errEnvelope('auth_token_invalid', 'token is required'));
    return;
  }

  const identity = await verifyToken(rawToken);
  if (!identity) {
    send(ws, errEnvelope('auth_token_invalid', 'Token not found or invalid'));
    return;
  }

  // Check ban/kick on the linked FCM account (if linked; subscribers can be limited).
  const banUser = identity.linkedUserId
    ? await prisma.user.findUnique({
        where: { id: identity.linkedUserId },
        select: { isBanned: true, kickedUntil: true },
      })
    : null;
  if (banUser?.isBanned) {
    send(ws, errEnvelope('user_banned', 'This account is banned'));
    return;
  }
  if (banUser?.kickedUntil && new Date(banUser.kickedUntil).getTime() > Date.now()) {
    send(ws, errEnvelope('user_kicked', 'This account is temporarily kicked'));
    return;
  }

  const supportsHudCosmeticsTransport = await tokenSupportsHudCosmeticsTransportDurable(rawToken);

  const cursor = typeof frame.cursor === 'number' ? frame.cursor : 0;
  const worldId = await getWorldId(identity.userId);
  const state: SubscriberState = {
    ws,
    userId: identity.userId,
    linkedUserId: identity.linkedUserId,
    cursor,
    worldId,
    supportsHudCosmeticsTransport,
  };
  subscribers.add(state);

  // Ensure pub/sub is wired.
  await ensurePubSub();

  send(ws, {
    success:     true,
    op:          'subscribed',
    cursor,
    // identity.userId is relay TEXT ("user_"+hex) — pass through directly.
    userId:      identity.userId,
    displayName: identity.fo76Name,
    role:        identity.role,
  });

  // Backfill on THIS long-lived connection. The in-game widget consumes events from
  // ZFE's native subscriber queue, so history returned only from handlePoll cannot
  // reach the HUD on initial load. Respect the supplied cursor for non-ZFE clients
  // that resume an already-established position.
  try {
    const history = await fetchHistoryEvents(cursor, POLL_HISTORY_LIMIT);
    for (const ev of history) {
      const event = relayHudEventForClient(ev, supportsHudCosmeticsTransport);
      if (!sendRaw(ws, JSON.stringify({ op: 'event', cursor: ev.id as number, event }))) {
        subscribers.delete(state);
        return;
      }
      state.cursor = Math.max(state.cursor, Number(ev.id));
    }
  } catch (err) {
    logger.warn({ err, userId: identity.userId }, '[relayHandler] history backfill on subscribe failed');
  }

  // The server tab is an ephemeral room and is not represented in the SQL history
  // query above. Backfill only the subscriber's current room using the same cursor.
  if (worldId) {
    try {
      const serverHistory = await getServerHistory(worldId, cursor, POLL_HISTORY_LIMIT);
      for (const ev of serverHistory) {
        const event = relayHudEventForClient(
          ev as unknown as Record<string, unknown>,
          supportsHudCosmeticsTransport,
        );
        if (!sendRaw(ws, JSON.stringify({ op: 'event', cursor: ev.id, event }))) {
          subscribers.delete(state);
          return;
        }
        state.cursor = Math.max(state.cursor, ev.id);
      }
    } catch (err) {
      logger.warn({ err, userId: identity.userId }, '[relayHandler] server history backfill on subscribe failed');
    }
  }

  // If still LIMITED (not linked), push the link-code notice on THIS long-lived subscribe
  // connection. The register/hello pushes land on a transient connection the client's
  // pollEvents/liveSubscriber never reads, so the code never reached the in-game widget; the
  // widget treats the arrival of a system notice as the authoritative "not linked" signal.
  if (!identity.isLinked) {
    pushLinkNotice(ws, identity.userId).catch((err) =>
      logger.warn({ err, userId: identity.userId }, '[relayHandler] pushLinkNotice failed on subscribe'),
    );
  }

  // Keepalive: ZFE's Wine/Winsock subscribe recv times out on idle (WSAETIMEDOUT /
  // "WSA error 10060") and treats it as a disconnect, dropping the live connection into
  // a reconnect loop. Send a periodic WS ping so the client's recv always sees inbound
  // traffic before its idle timeout fires. Tunable via RELAY_PING_INTERVAL_MS
  // (default 4000ms; 0 disables).
  const pingMs = Number(process.env.RELAY_PING_INTERVAL_MS ?? 4000);
  let checkingAccess = false;
  const pingTimer = pingMs > 0
    ? setInterval(() => {
        if (ws.readyState !== 1) return;       // 1 = OPEN
        if (checkingAccess) return;
        checkingAccess = true;
        const check = state.linkedUserId
          ? accountBlockReason(state.linkedUserId)
          : Promise.resolve(null);
        check.then((blocked) => {
          if (blocked) {
            evictLocalRelayUser(
              state.linkedUserId!,
              blocked,
              blocked === 'user_banned' ? 'This account is banned' : 'This account is temporarily kicked',
            );
            return;
          }
          try { ws.ping(); } catch { /* socket closing */ }
        }).catch((err) => logger.warn({ err, userId: state.userId }, '[relayHandler] subscriber access check failed'))
          .finally(() => { checkingAccess = false; });
      }, pingMs)
    : null;

  // Clean up subscriber (and stop the keepalive) on disconnect.
  ws.once('close', () => {
    if (pingTimer) clearInterval(pingTimer);
    subscribers.delete(state);
  });
}

/** Serialize subscription setup so duplicate frames cannot create duplicate timers. */
async function handleSubscribe(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
  if (pendingSubscriptions.has(ws) || [...subscribers].some((sub) => sub.ws === ws)) {
    send(ws, errEnvelope('already_subscribed', 'This connection already has a subscription'));
    return;
  }
  pendingSubscriptions.add(ws);
  try {
    await handleSubscribeInternal(ws, frame);
  } finally {
    pendingSubscriptions.delete(ws);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Handle one WebSocket connection on the /relay path.
 * Dispatches JSON frames by op field. The connection may be short-lived (RPC)
 * or long-lived (subscribe). All errors return the stable error envelope.
 */
export function isRelayAvailable(opts: { nodeEnv: string; productionEnabled: boolean }): boolean {
  return opts.nodeEnv !== 'production' || opts.productionEnabled;
}

export function handleRelayConnection(ws: WebSocket, req: http.IncomingMessage): void {
  if (!isRelayAvailable({ nodeEnv: env.NODE_ENV, productionEnabled: env.RELAY_PRODUCTION_ENABLED })) {
    logger.warn('[relayHandler] /relay connection refused: RELAY_PRODUCTION_ENABLED is false');
    ws.close(1008, 'relay not available in production');
    return;
  }

  const ip = clientIp(req);
  let receivedFirstFrame = false;
  const firstFrameTimer = setTimeout(() => {
    if (!receivedFirstFrame) {
      logger.warn({ ip }, '[relayHandler] closing idle connection before first frame');
      ws.close(1008, 'Initial relay frame required');
    }
  }, RELAY_FIRST_FRAME_TIMEOUT_MS);
  let rpcIdleCloseTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelRpcIdleClose = (): void => {
    if (rpcIdleCloseTimer === null) return;
    clearTimeout(rpcIdleCloseTimer);
    rpcIdleCloseTimer = null;
  };
  const scheduleRpcIdleClose = (): void => {
    cancelRpcIdleClose();
    rpcIdleCloseTimer = setTimeout(() => {
      rpcIdleCloseTimer = null;
      if (ws.readyState === 1) {
        try { ws.close(1000, 'relay request idle'); } catch { /* already closing */ }
      }
    }, RELAY_RPC_IDLE_CLOSE_MS);
  };
  ws.once('close', () => {
    clearTimeout(firstFrameTimer);
    cancelRpcIdleClose();
  });

  ws.on('message', async (data) => {
    cancelRpcIdleClose();
    if (!receivedFirstFrame) {
      receivedFirstFrame = true;
      clearTimeout(firstFrameTimer);
    }
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      send(ws, errEnvelope('invalid_request', 'Frame must be valid JSON'));
      scheduleRpcIdleClose();
      return;
    }

    const op = typeof frame.op === 'string' ? frame.op : '';

    try {
      switch (op) {
        case 'register':        await handleRegister(ws, frame, ip); break;
        case 'hello':           await handleHello(ws, frame); break;
        case 'getAuthState':    await handleGetAuthState(ws, frame); break;
        case 'send':            await handleSend(ws, frame); break;
        case 'poll':            await handlePoll(ws, frame); break;
        case 'subscribe':       await handleSubscribe(ws, frame); break;
        case 'report':          await handleReport(ws, frame); break;
        case 'moderationAction': await handleModerationAction(ws, frame); break;
        default:
          send(ws, errEnvelope('invalid_request', `Unknown op: ${op}`));
      }
    } catch (err) {
      logger.error({ err, op }, '[relayHandler] unhandled error in op handler');
      send(ws, errEnvelope('internal_error', 'Internal server error'));
    } finally {
      // ZFE opens a separate WebSocket for each request/response operation. Keep
      // a subscribed socket alive, but release an idle RPC socket after a short
      // grace period. The grace period preserves clients that reuse one socket
      // for sequential frames while preventing poll/send/control calls from
      // consuming the per-IP upgrade cap until the native client closes them.
      if (hasSubscriberSocket(ws)) cancelRpcIdleClose();
      else if (ws.readyState === 1) scheduleRpcIdleClose();
    }
  });

  ws.on('error', (err) => {
    logger.warn({ err }, '[relayHandler] WebSocket error');
  });
}
