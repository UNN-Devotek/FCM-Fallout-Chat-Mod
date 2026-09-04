import { v4 as uuidv4 } from 'uuid';
import { WebSocket, RawData } from 'ws';
import { IncomingMessage } from 'http';
import { getRedisClient, getSubscriberClient } from '../config/redis';
import prisma from '../config/prisma';
import { query as dbQuery } from '../config/database';
import { computeDiscriminator } from '../utils/discriminator';
import { buildAvatarUrl } from '../services/avatarService';
import { hudPushNotify } from '../services/hudPush';
import { isSocketSuperseded } from './socketSupersession';
import { getLatestVersion } from '../services/latestReleaseVersion';
import { shadowMute } from '../services/autoModService';
import { engineEvaluate } from '../services/autoModEngine';
import { relayToDiscord, editDiscordRelayMessage, invalidateRelayMappingsCache } from '../services/discordService';
import { persistMessage } from '../services/messageService';
import { finalizeMessage } from '../services/ingestMessage';
import { attachCosmetics, attachCosmeticsToHistory } from '../services/cosmetics/cosmeticsService';
import messageQueue from '../queues/messagePersist';
import logger from '../config/logger';
import { incrementMessageCount, setFullscreenStatus, removeFullscreenClient } from '../controllers/healthController';
import { tryHandleCommand } from '../services/commandService';
import { getServerPlayers } from '../services/playerListService';
import {
  notePendingDisconnectSuppressed,
  noteUserConnected,
  noteUserDisconnected,
  noteUserPendingDisconnect,
  registerLocalPresenceSource,
} from '../services/onlinePresenceService';
import {
  PrivateConversationAccessError,
  PrivateMessageUnavailableError,
  getOrCreatePrivateConversation,
  getPrivateHistory,
  listPrivateConversations,
  markPrivateConversationRead,
  sendPrivateMessage,
} from '../services/privateMessagingService';
import { emojifyShortcodes } from '../utils/emoji';
import { editOwnedMessage, MessageEditError } from '../services/messageEditService';
import { evaluateBuildGate } from '../services/buildLock';
import { getActiveQaVersion } from '../services/activeQaVersion';
import env from '../config/environment';
import { INSTANCE_ID } from '../config/instanceIdentity';
import { notifyRelayLiveChatMessage } from '../services/relay/relayLiveFanout';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the best display name for a user.
 *   1. Free user-selected chat name
 *   2. FO76 in-game name (if set and not the default placeholder)
 *   3. Discord username (fallback)
 *   4. Raw username
 *
 * NO #XXXX discriminator suffix — uniqueness is guaranteed by the
 * unique constraint on users.username and the Discord link.
 */
export function resolveDisplayName(user: {
  username: string;
  chatName?: string | null;
  discordUsername: string | null;
  discordDisplayName?: string | null;
  installToken: string;
}): string {
  // A chat name is an account identity setting, not a paid cosmetic. It is already
  // validated on write, but trim defensively for rows created before that contract.
  if (user.chatName && user.chatName.trim()) return user.chatName.trim();

  // 1. Real FO76 name (skip Wanderer, pending-*, Overlay<digits> auto-handles,
  //    and discord:/pending-discord- synthetic relay usernames).
  const isPlaceholderUsername = (u: string) =>
    u === 'Wanderer'
    || u.startsWith('pending-')          // pending-<installToken> and pending-discord-<id>
    || /^overlay\d+$/i.test(u)           // Overlay7734, overlay2467, etc.
    || u.startsWith('discord:');         // synthetic relay installToken-keyed usernames
  if (
    user.username
    && user.username.length > 0
    && !isPlaceholderUsername(user.username)
  ) {
    return user.username;
  }
  // 2. Discord display/global name — preferred user-facing label when there's
  //    no FO76 name (e.g. "Devotek" rather than the @handle "devotek").
  if (user.discordDisplayName && user.discordDisplayName.length > 0) {
    return user.discordDisplayName;
  }
  // 3. Discord @handle as fallback.
  if (user.discordUsername && user.discordUsername.length > 0) {
    return user.discordUsername;
  }
  // Don't expose placeholder usernames as display names — return Wanderer instead.
  if (user.username && !isPlaceholderUsername(user.username)) return user.username;
  return 'Wanderer';
}
// Bounds for client_created_at: reject timestamps more than 5 minutes in the past or future
const CLIENT_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/**
 * Tiny Redis-backed sliding-window rate-limit for WS frames. Used to cap
 * destructive / server-state-mutating frames (server:join-manual,
 * server:leave-manual) so a malicious client that bypasses the overlay's
 * own cooldown can't thrash sessions or DoS the same-server attach logic.
 *
 * Pattern: `INCR rl_ws:<bucket>:<userId>` then `EXPIRE ... NX` on first
 * write. Atomic enough — even if two concurrent INCRs race past the limit
 * we're only off by one and the next call rejects.
 *
 * Returns `true` when the call is within the limit (caller may proceed),
 * `false` when the limit has been exceeded.
 */
async function checkWsRateLimitBucket(
  bucket: string,
  userId: string,
  max: number,
  windowSec: number,
): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    const key = `rl_ws:${bucket}:${userId}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSec);
    }
    return count <= max;
  } catch (err) {
    // Fail-open on Redis errors — better to allow a few extra calls than to
    // hard-block legitimate users when Redis hiccups.
    logger.warn({ err, bucket, userId }, '[checkWsRateLimitBucket] Redis error — fail-open');
    return true;
  }
}

// Short-lived channel validity cache to avoid a DB round-trip on every single message.
const channelCache = new Map<string, { valid: boolean; cachedAt: number }>();
const CHANNEL_CACHE_TTL_MS = 60_000;

async function isChannelValid(channelId: string): Promise<boolean> {
  const cached = channelCache.get(channelId);
  if (cached && Date.now() - cached.cachedAt < CHANNEL_CACHE_TTL_MS) return cached.valid;
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, isArchived: false },
    select: { id: true },
  });
  const valid = !!channel;
  channelCache.set(channelId, { valid, cachedAt: Date.now() });
  return valid;
}

// Short-lived channel name + parent cache for command variable resolution and allowedChannelId checks
const channelNameCache = new Map<string, { name: string; parentId: string | null; cachedAt: number }>();

async function getChannelInfo(channelId: string): Promise<{ name: string; parentId: string | null }> {
  const cached = channelNameCache.get(channelId);
  if (cached && Date.now() - cached.cachedAt < 60_000) return { name: cached.name, parentId: cached.parentId };
  try {
    const ch = await prisma.channel.findFirst({ where: { id: channelId }, select: { name: true, parentId: true } });
    const info = { name: ch?.name ?? 'chat', parentId: ch?.parentId ?? null };
    channelNameCache.set(channelId, { ...info, cachedAt: Date.now() });
    return info;
  } catch { return { name: 'chat', parentId: null }; }
}

async function getChannelName(channelId: string): Promise<string> {
  return (await getChannelInfo(channelId)).name;
}

/**
 * Broadcast a payload to all clients in a given world session.
 * Membership is FK equality on `worldSessionId`.
 */
export async function broadcastToSession(payload: any, sessionId: string | null | undefined, excludeWs: WebSocket | null = null): Promise<number> {
  if (!sessionId) return 0;
  if (payload?.type === 'chat:message') {
    logger.info({
      via: 'broadcastToSession',
      sessionId,
      content: String(payload.payload?.content ?? '').slice(0, 80),
      username: payload.payload?.username,
      userId: payload.payload?.userId,
      source: payload.payload?.source,
      channelId: payload.payload?.channelId,
    }, '[chat-trace] broadcastToSession');
  }
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let delivered = 0;
  for (const [, client] of clients) {
    if (client.ws === excludeWs || client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.worldSessionId === sessionId) {
      // Block enforcement: skip recipients who have blocked the sender.
      if (recipientHasBlockedSender(payload, client)) continue;
      if (safeSend(client.ws, data, `broadcastToSession:${client.userId}`)) delivered++;
    }
  }
  if (payload?.type === 'chat:message') {
    logger.info({ via: 'broadcastToSession', sessionId, delivered }, '[chat-trace] broadcastToSession — completed');
  }
  // Cross-instance relay: publish a scope:'session' envelope so other backend
  // instances can deliver to their local clients on the same world session.
  if (pubsubActive) {
    const envelope = JSON.stringify({ instanceId: INSTANCE_ID, payload, scope: 'session', sessionId });
    getRedisClient()
      .then((redis) => redis.publish(PUBSUB_CHANNEL, envelope))
      .catch((err) => logger.warn({ err }, 'broadcastToSession: Redis publish failed (non-fatal)'));
  }
  return delivered;
}
// WebSocket close codes
const WS_CLOSE_AUTH_FAILED = 4001;
const WS_CLOSE_BANNED = 4002;
const WS_CLOSE_OUTDATED_BUILD = 4003;

interface ClientEntry {
  ws: WebSocket;
  userId: string;
  username: string;
  displayName: string;
  isMuted: boolean;
  worldSessionId?: string | null;
  // Block enforcement: the set of user IDs THIS client has blocked. Loaded on
  // connect via getBlockedIds(userId) and refreshed live via
  // global.refreshClientBlocks(userId) when the user adds/removes a block.
  // A message authored by sender S is never delivered to a client whose
  // blockedIds contains S (the blocked user is invisible to the blocker).
  blockedIds: Set<string>;
  // True when the client has reported that Fallout 76 is currently running.
  // Defaults false. A user whose overlay is connected but whose game isn't
  // running is OFFLINE for presence purposes (party online counts, member dots).
  inGame: boolean;
  // Effective moderation role, resolved at connect-time via getEffectiveRole().
  // Stored so party:send mod-observer fan-out can walk the clients map without
  // an async role lookup per message. Defaults to 'user' — fail-safe.
  role: import('../services/userRoleService').EffectiveRole;
}



// In-memory client registry
const clients = new Map<string, ClientEntry>();

export async function broadcastToUsers(
  payload: any,
  userIds: string[],
  excludeWs: WebSocket | null = null,
): Promise<number> {
  const userSet = new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0));
  if (userSet.size === 0) return 0;

  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let delivered = 0;

  for (const [, client] of clients) {
    if (!userSet.has(client.userId)) continue;
    if (client.ws === excludeWs || client.ws.readyState !== WebSocket.OPEN) continue;
    if (recipientHasBlockedSender(payload, client)) continue;
    try {
      if (safeSend(client.ws, data, `broadcastToUsers:${client.userId}`)) delivered++;
    } catch (err) {
      logger.warn({ err, userId: client.userId }, 'broadcastToUsers: send failed (non-fatal)');
    }
  }

  if (pubsubActive) {
    const envelope = JSON.stringify({
      instanceId: INSTANCE_ID,
      payload,
      scope: 'users',
      userIds: [...userSet],
    });
    getRedisClient()
      .then((redis) => redis.publish(PUBSUB_CHANNEL, envelope))
      .catch((err) => logger.warn({ err }, 'broadcastToUsers: Redis publish failed (non-fatal)'));
  }

  return delivered;
}

// ── WS-flap grace window ──────────────────────────────────────────────────────
// When a WS socket closes and the same user reconnects within WS_FLAP_GRACE_MS,
// suppress "left/joined" announcements — the user was effectively never gone.
// Per-userId map. The timer fires the deferred work; on a fresh connection for
// the same user we cancel the pending entry — and if the new endpoint differs
// from the old one, we fire the leave immediately (real transition, not a flap).
const WS_FLAP_GRACE_MS = parseInt(process.env.WS_FLAP_GRACE_MS ?? '30000', 10);
interface PendingDisconnectEntry {
  endpoint: string | null;
  timer: ReturnType<typeof setTimeout>;
  // Run when the timer fires (no reconnect within grace).
  fire: () => void;
}
const pendingDisconnect = new Map<string, PendingDisconnectEntry>();

// ── Test seams ────────────────────────────────────────────────────────────────
// Pure helpers that capture the flap-decision logic so unit tests can exercise
// it without spinning up a full WebSocket lifecycle.

export type FlapDecision =
  | { kind: 'suppress' }                          // reconnect within grace, same endpoint
  | { kind: 'fire-old-immediately' }              // endpoint changed; fire OLD-ep leave now
  | { kind: 'no-pending' };                       // no in-flight grace timer

/**
 * Decide how a fresh connection should treat an in-flight pending-disconnect
 * entry.  Pure function — no side effects.
 */
export function decideFlapHandoff(
  pending: { endpoint: string | null } | undefined,
  newEndpoint: string | null,
): FlapDecision {
  if (!pending) return { kind: 'no-pending' };
  if (newEndpoint !== null && pending.endpoint !== null && newEndpoint !== pending.endpoint) {
    return { kind: 'fire-old-immediately' };
  }
  return { kind: 'suppress' };
}

export const WS_FLAP_GRACE_MS_EXPORT = 30_000;

// Read-only admin observer connections (authenticated via short-lived WS ticket)
const adminObservers = new Set<WebSocket>();

/**
 * Refresh cached username / displayName on every live WS client whose
 * userId matches. Called from the register controller when a user's row
 * is upserted so an already-connected overlay picks up the new FO76 name
 * immediately without needing to reconnect the WebSocket. Returns the
 * number of sessions touched.
 */
export function refreshClientIdentity(
  userId: string,
  username: string,
  discordUsername: string | null,
  discordDisplayName: string | null,
  installToken: string,
  chatName: string | null = null,
): number {
  const displayName = resolveDisplayName({ username, chatName, discordUsername, discordDisplayName, installToken });
  let touched = 0;
  for (const c of clients.values()) {
    if (c.userId === userId) {
      c.username = username;
      c.displayName = displayName;
      touched++;
    }
  }
  // Broadcast unconditionally, NOT gated on `touched > 0`.
  //
  // `touched` counts sockets on THIS instance only. The old `if (touched > 0)` guard
  // looked like a sensible "don't wake everyone for a phantom update" optimization,
  // but it silently dropped the frame whenever the user's socket lived on a different
  // instance from the one handling their register/link request — and since broadcast()
  // fans out over Redis pub/sub, that frame is exactly how the other instance (and
  // every other viewer's rendered history) learns about the rename. Single-instance
  // today, so this is latent rather than live, but it breaks the moment replicas > 1.
  //
  // The frame is cheap and viewers ignore unknown userIds, so unconditional is both
  // correct and inexpensive. Wrapped in try/catch so a broadcast failure never breaks
  // the register-path caller.
  try {
    if (typeof broadcast === 'function') {
      broadcast({
        type: 'user:identity_updated',
        payload: { userId, username, displayName },
      });
    }
  } catch (err) {
    logger.warn({ err, userId }, 'refreshClientIdentity: broadcast failed (non-fatal)');
  }
  return touched;
}

/**
 * Push updated cosmetics (name colour, effect, tag, badges, star colour) to every viewer so
 * already-rendered messages re-style without anyone reconnecting.
 *
 * Rides the same `user:identity_updated` frame the rename path uses, because
 * ChatOverlay's handler for it already back-applies to message history — adding the
 * cosmetic fields there means one handler covers both cases.
 *
 * Note what this deliberately does NOT do: mutate any per-socket cached state.
 * Cosmetics are resolved server-side at message-finalize time from a Redis cache, so a
 * tier change only needs that cache busted (cosmeticsService does it) plus this frame
 * for history. `ClientEntry.role` is frozen at connect and stays that way — supporter
 * tier is resolved fresh per message, never read off the socket.
 */
export function refreshClientCosmetics(
  userId: string,
  cosmetics: { nameColor?: string | null; effectId?: string | null; tag?: string | null; badges?: string[]; starColor?: string | null },
): void {
  try {
    if (typeof broadcast !== 'function') return;
    broadcast({
      type: 'user:identity_updated',
      payload: {
        userId,
        nameColor: cosmetics.nameColor ?? null,
        effectId: cosmetics.effectId ?? null,
        tag: cosmetics.tag ?? null,
        badges: cosmetics.badges ?? [],
        starColor: cosmetics.starColor ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err, userId }, 'refreshClientCosmetics: broadcast failed (non-fatal)');
  }
}

/**
 * Push a payload to every live WS session for a single user. Local-instance
 * only — used by latency-optimization hooks (e.g. player-list POST) that want
 * to notify a specific peer without waiting for their next overlay poll.
 * Walks the clients Map like refreshClientIdentity() does. Returns the number
 * of sessions touched.
 */
export function pushToUser(userId: string, payload: any): number {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let sent = 0;
  for (const c of clients.values()) {
    if (c.userId !== userId) continue;
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    try {
      c.ws.send(data);
      sent++;
    } catch (err) {
      logger.warn({ err, userId }, 'pushToUser: send failed (non-fatal)');
    }
  }
  return sent;
}

/**
 * Block enforcement: re-load `userId`'s blocked-set from blockService and update
 * the cached `blockedIds` on every connected socket belonging to that user, so a
 * just-added/removed block takes effect immediately (without waiting for a
 * reconnect or the 60s service-cache TTL). Called from blockController on
 * add/remove via the `global.refreshClientBlocks` hook.
 *
 * Lazy-require of blockService avoids a static import cycle (blockService
 * statically imports resolveDisplayName from this module).
 */
export async function refreshClientBlocks(userId: string): Promise<void> {
  // Only do work if this user actually has a live socket here.
  let hasSocket = false;
  for (const c of clients.values()) {
    if (c.userId === userId) { hasSocket = true; break; }
  }
  if (!hasSocket) return;

  try {
    const { getBlockedIds } = require('../services/blockService') as typeof import('../services/blockService');
    const ids = await getBlockedIds(userId);
    for (const c of clients.values()) {
      if (c.userId === userId) c.blockedIds = ids;
    }
    logger.info({ userId, blockedCount: ids.size }, '[block] refreshed connected client block-set');
  } catch (err) {
    logger.warn({ err, userId }, '[block] refreshClientBlocks failed (non-fatal)');
  }
}

/**
 * Return userIds of all currently-connected game clients on this instance.
 * Used by latency-optimization paths to cheaply fetch "who might care."
 */
export function getConnectedUserIds(): string[] {
  const out = new Set<string>();
  for (const c of clients.values()) {
    if (c.ws.readyState === WebSocket.OPEN) out.add(c.userId);
  }
  return Array.from(out);
}

/**
 * Authoritative set of userIds that are "present" on THIS instance: anyone with
 * an OPEN socket, plus anyone inside the flap-grace window (pendingDisconnect).
 * This is the same set getClientCount() sizes, exposed so onlinePresenceService
 * can flush it to Redis for the cross-instance /online count without keeping a
 * drift-prone parallel refcount. Order doesn't matter — callers dedup.
 */
export function getLocallyPresentUserIds(): string[] {
  const seen = new Set<string>();
  for (const c of clients.values()) {
    if (c.userId && c.ws.readyState === WebSocket.OPEN) seen.add(c.userId);
  }
  for (const userId of pendingDisconnect.keys()) seen.add(userId);
  return Array.from(seen);
}

// Wire the WS layer in as the single source of truth for local presence.
registerLocalPresenceSource(getLocallyPresentUserIds);

/** No-op stub retained for call-site compatibility. World-detection was removed. */
export function updateClientEndpoint(_userId: string, _endpoint: string | null): void {
}


/**
 * Returns true if at least one OPEN WebSocket session exists for the given userId.
 * Used by stale-presence cron to skip demoting users whose WS is still healthy.
 */
export function isUserWsConnected(userId: string): boolean {
  for (const c of clients.values()) {
    if (c.userId === userId && c.ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

/**
 * Returns true if a pendingDisconnect grace-window timer is currently active
 * for the given userId.  Used by stale-presence cron to avoid double-firing
 * a peer-leave when ws.on('close') already has a deferred announce in flight.
 */
export function isPendingDisconnect(userId: string): boolean {
  return pendingDisconnect.has(userId);
}





/** No-op stub retained for call-site compatibility. World-detection was removed. */
export function isUserAutoAttachBlocked(_userId: string): boolean {
  return false;
}


export function snapshotActiveClients() {
  const out: Array<{
    userId: string; username: string; displayName: string;
    worldSessionId: string | null;
    readyState: number;
  }> = [];
  for (const c of clients.values()) {
    out.push({
      userId: c.userId, username: c.username, displayName: c.displayName,
      worldSessionId: c.worldSessionId ?? null,
      readyState: c.ws.readyState,
    });
  }
  return { totalClients: clients.size, totalAdminObservers: adminObservers.size, clients: out };
}


// Maximum bytes allowed in a socket's send buffer before we skip that client.
// 5 MB — a slow/stuck client whose buffer is this full will never drain in time;
// dropping this frame prevents the event loop from stalling on a large .send().
const WS_MAX_BUFFERED_BYTES = 5 * 1024 * 1024;

/**
 * Send `data` on `ws` if the socket is OPEN and its send buffer is below
 * WS_MAX_BUFFERED_BYTES. Logs a one-time warning per skip.
 * Returns true when the data was sent (or attempted), false when skipped.
 */
function safeSend(ws: WebSocket, data: string, label: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
    logger.warn({ label, bufferedAmount: ws.bufferedAmount }, '[safeSend] skipping slow client — send buffer full');
    return false;
  }
  ws.send(data);
  return true;
}

const PUBSUB_CHANNEL = 'chat:broadcast';

// Tracks whether Redis pub/sub is active; when false, broadcast is local-only.
let pubsubActive = false;

// Per-socket rate limiter: 5 msg/sec sliding window using Redis.
// Raised from 2→5 to accommodate overlay reconnect bursts (WS-lifecycle
// change: hide→show reconnects send history + status frames on open).
//
// NOTE: returns TRUE when the limit IS EXCEEDED (caller should reject the frame).
// This is the inverse of checkWsRateLimitBucket (which returns true=OK).
async function checkWsRateLimit(userId: string): Promise<boolean> {
  const redis = await getRedisClient();
  const key = `ws_rate:${userId}`;
  const now = Date.now();
  const window = 1000; // 1 second
  const limit = 5;

  const multi = redis.multi();
  multi.zRemRangeByScore(key, '-inf', now - window);
  multi.zAdd(key, { score: now, value: String(now) });
  multi.zCard(key);
  multi.expire(key, 5);
  const results = await multi.exec() as any[];

  // results[2] is zCard count AFTER the add; reject if it exceeds the limit
  return results[2] > limit;
}

/**
 * Block enforcement: returns true when this payload must NOT be delivered to
 * `recipient` because the recipient has blocked the message's author. The
 * blocked user is invisible to the blocker — their chat messages, and the bot
 * output of their slash commands, never reach the blocker.
 *
 * Only filters message-bearing frames that carry an author id (chat:message and
 * bot replies echo it as `userId`; private-message frames carry it as `senderId`).
 * Frames without a sender id, or system/global frames, are never filtered.
 */
function recipientHasBlockedSender(payload: any, recipient: ClientEntry): boolean {
  // chat/bot frames author the sender as `userId`; PM frames use `senderId`.
  const senderId: unknown = payload?.payload?.userId ?? payload?.payload?.senderId;
  if (typeof senderId !== 'string' || senderId.length === 0) return false;
  // 'system' is the synthetic id for [Vault-Tec]/system frames — never blocked.
  if (senderId === 'system') return false;
  const blocked = recipient.blockedIds;
  // Defensive: any entry created outside clients.set (e.g. a test mock) may lack
  // the set — treat as "no blocks" rather than throwing.
  if (!(blocked instanceof Set) || blocked.size === 0) return false;
  return blocked.has(senderId);
}

/**
 * Deliver a payload to all local WebSocket clients and admin observers.
 * This is the low-level send -- it does NOT publish to Redis.
 */
function localBroadcast(
  payload: any,
  excludeWs: WebSocket | null = null,
  notifyRelay: boolean = true,
): void {
  try { hudPushNotify(payload); } catch { /* hud push must never break chat */ }
  if (notifyRelay && payload?.type === 'chat:message') {
    // The native relay subscriber lives in this same process. Deliver the event
    // directly before Redis; Redis remains the cross-instance path. Keeping this
    // callback in a dependency-free module avoids handlers <-> relayHandler's
    // existing ingest initialization cycle.
    try { notifyRelayLiveChatMessage(payload); } catch { /* relay fan-out must not break web chat */ }
  }
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const [, client] of clients) {
    if (client.ws === excludeWs || client.ws.readyState !== WebSocket.OPEN) continue;
    // Block enforcement: skip recipients who have blocked the sender.
    if (recipientHasBlockedSender(payload, client)) continue;
    safeSend(client.ws, data, `localBroadcast:${client.userId}`);
  }
  // Broadcast to read-only admin observers; prune stale sockets defensively
  for (const ws of adminObservers) {
    if (ws.readyState !== WebSocket.OPEN) {
      adminObservers.delete(ws);
      continue;
    }
    if (ws === excludeWs) continue;
    try {
      safeSend(ws, data, 'localBroadcast:adminObserver');
    } catch (err) {
      logger.warn({ err }, 'Admin observer send failed, removing from set');
      adminObservers.delete(ws);
    }
  }
}

/**
 * Broadcast a payload to all backend instances via Redis Pub/Sub.
 * Falls back to local-only broadcast if pub/sub is unavailable.
 * Exported so external services (e.g. ingestMessage) can fan out without a
 * direct WebSocket handle — no WS-specific concerns leak to callers.
 * (The named export lives in the export{} statement at the bottom of this file.)
 */
function broadcast(payload: any, excludeWs: WebSocket | null = null): void {
  if (payload?.type === 'chat:message') {
    logger.info({
      via: 'broadcast',
      content: String(payload.payload?.content ?? '').slice(0, 80),
      username: payload.payload?.username,
      userId: payload.payload?.userId,
      source: payload.payload?.source,
      channelId: payload.payload?.channelId,
    }, '[chat-trace] broadcast');
  }
  // Always deliver to local clients immediately (low latency hot path)
  localBroadcast(payload, excludeWs);

  // Publish to Redis so other instances can relay to their local clients
  if (pubsubActive) {
    const envelope = JSON.stringify({ instanceId: INSTANCE_ID, payload });
    getRedisClient()
      .then((redis) => redis.publish(PUBSUB_CHANNEL, envelope))
      .catch((err) => {
        logger.warn({ err }, 'Redis pub/sub publish failed; other instances will not receive this message');
      });
  }
}

// Guard against concurrent initPubSub calls (e.g. retry overlapping with
// a 'ready' event re-init). True while an init attempt is in flight.
let pubsubInitializing = false;

/**
 * Initialise Redis Pub/Sub subscriber.
 *
 * On failure, schedules an automatic retry every 30 s so a transient Redis
 * blip at startup does not permanently disable cross-instance delivery.
 * The ready/reconnect guard prevents duplicate subscriptions.
 */
async function initPubSub(): Promise<void> {
  if (pubsubActive || pubsubInitializing) return;
  pubsubInitializing = true;
  try {
    const subscriber = await getSubscriberClient();
    await subscriber.subscribe(PUBSUB_CHANNEL, (message: string) => {
      try {
        const envelope = JSON.parse(message);
        // Skip messages that originated from this instance
        if (envelope.instanceId === INSTANCE_ID) return;
        // Party-scoped broadcasts: deliver only to the listed member userIds.
        // Also fan-out to local privileged non-member clients (mod observers).
        if (envelope.scope === 'party' && Array.isArray(envelope.memberUserIds)) {
          const memberSet = new Set<string>(envelope.memberUserIds);
          const data = JSON.stringify(envelope.payload);
          let isPrivilegedRoleFn: ((r: string) => boolean) | null = null;
          try {
            isPrivilegedRoleFn = (require('../services/userRoleService') as { isPrivilegedRole: (r: string) => boolean }).isPrivilegedRole;
          } catch { /* non-fatal */ }
          const observerPayload = { ...envelope.payload, payload: { ...envelope.payload?.payload, _modObserver: true } };
          const observerData = JSON.stringify(observerPayload);
          for (const [, client] of clients) {
            if (client.ws.readyState !== WebSocket.OPEN) continue;
            if (memberSet.has(client.userId)) {
              // Member path: normal delivery with block check
              if (recipientHasBlockedSender(envelope.payload, client)) continue;
              try { safeSend(client.ws, data, `pubsub:party:${client.userId}`); } catch { /* non-fatal */ }
            } else if (isPrivilegedRoleFn && isPrivilegedRoleFn(client.role)) {
              // Privileged non-member: observer path (no block suppression)
              try { safeSend(client.ws, observerData, `pubsub:observer:${client.userId}`); } catch { /* non-fatal */ }
            }
          }
          return;
        }
        // Session-scoped broadcasts: deliver only to clients on the matching world session.
        if (envelope.scope === 'session' && typeof envelope.sessionId === 'string') {
          const data = JSON.stringify(envelope.payload);
          for (const [, client] of clients) {
            if (client.ws.readyState !== WebSocket.OPEN) continue;
            if (client.worldSessionId !== envelope.sessionId) continue;
            if (recipientHasBlockedSender(envelope.payload, client)) continue;
            try { safeSend(client.ws, data, `pubsub:session:${client.userId}`); } catch { /* non-fatal */ }
          }
          return;
        }
        if (envelope.scope === 'users' && Array.isArray(envelope.userIds)) {
          const userSet = new Set<string>(envelope.userIds);
          const data = JSON.stringify(envelope.payload);
          for (const [, client] of clients) {
            if (client.ws.readyState !== WebSocket.OPEN) continue;
            if (!userSet.has(client.userId)) continue;
            if (recipientHasBlockedSender(envelope.payload, client)) continue;
            try { safeSend(client.ws, data, `pubsub:user:${client.userId}`); } catch { /* non-fatal */ }
          }
          return;
        }
        // The relay module receives this same cross-instance envelope directly;
        // do not notify its local subscribers a second time from this web path.
        localBroadcast(envelope.payload, null, false);
      } catch (err) {
        logger.warn({ err }, 'Failed to process pub/sub message');
      }
    });
    pubsubActive = true;
    pubsubInitializing = false;
    logger.info({ instanceId: INSTANCE_ID }, 'Redis pub/sub subscriber active on channel ' + PUBSUB_CHANNEL);
  } catch (err) {
    pubsubActive = false;
    pubsubInitializing = false;
    logger.warn({ err }, 'Redis pub/sub unavailable -- falling back to local-only broadcast; retrying in 30s');
    // Schedule a retry so a transient startup blip doesn't permanently disable pub/sub.
    setTimeout(() => { initPubSub().catch(() => {}); }, 30_000);
  }
}

interface AdminIdentity {
  discordId?: string;
  username?: string;
}

/**
 * Handle an admin observer WebSocket connection authenticated via WS ticket.
 * Receives all broadcast frames and can send chat messages as the linked game user.
 */
async function handleAdminObserver(ws: WebSocket, identity: AdminIdentity = {}): Promise<void> {
  logger.info({ discordId: identity.discordId, username: identity.username }, 'Admin observer WS connected');

  // Don't push cross-channel history on connect — the frontend will request
  // channel-specific history via chat:history once it selects a channel.
  adminObservers.add(ws);

  ws.on('message', async (raw: RawData) => {
    let frame: any;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      sendWsError(ws, 'Malformed JSON');
      return;
    }

    if (!frame.type) return;

    try {
      switch (frame.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', payload: {} }));
          break;

        case 'chat:history': {
          const { channelId, limit = 300, offset = 0 } = frame.payload || {};
          const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 300, 1), 300);
          const safeOffset = Math.min(Math.max(parseInt(offset, 10) || 0, 0), 10000);

          if (!channelId || !UUID_RE.test(channelId)) break;
          try {
            const result = await dbQuery(
              `SELECT m.id, m.content, u.username, u.chat_name, u.discord_id_link AS discord_id, u.discord_username, u.discord_display_name, u.install_token, m.user_id, m.channel_id, m.source, m.metadata, m.created_at, m.edited_at
               FROM messages m JOIN users u ON u.id = m.user_id
               WHERE m.channel_id = $1 AND NOT m.is_deleted
               ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`,
              [channelId, safeLimit, safeOffset]
            );
            const messages = result.rows.map((row: any) => {
              const dn = resolveDisplayName({ username: row.username, chatName: row.chat_name, discordUsername: row.discord_username, discordDisplayName: row.discord_display_name, installToken: row.install_token });
              const avatarUrl = buildAvatarUrl(row.discord_id);
              const { install_token, username, chat_name, discord_username, discord_display_name, discord_id, metadata, ...rest } = row;
              return { ...rest, username: dn, avatarUrl, metadata: metadata ?? null };
            });
            await attachCosmeticsToHistory(messages);
            ws.send(JSON.stringify({ type: 'chat:history', payload: { messages: messages.reverse() } }));
          } catch (err) {
            logger.error({ err }, 'Admin observer: failed to load history');
          }
          break;
        }

        case 'chat:edit': {
          if (!identity.discordId) {
            sendWsError(ws, 'No linked game account — cannot edit messages.');
            return;
          }

          const messageId = frame.payload?.messageId;
          const content = frame.payload?.content;
          const source = frame.payload?.source;
          const channelId = frame.payload?.channelId;
          const conversationId = frame.payload?.conversationId;

          if (typeof messageId !== 'string' || !UUID_RE.test(messageId)) {
            sendWsError(ws, 'Invalid messageId.');
            break;
          }
          if (typeof source !== 'string' || source === 'bot' || source === 'system' || source === 'server') {
            sendWsError(ws, 'This message cannot be edited.');
            break;
          }
          if (source === 'pm') {
            if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
              sendWsError(ws, 'Invalid conversationId.');
              break;
            }
          } else if (source === 'party') {
            if (typeof channelId !== 'string' || !UUID_RE.test(channelId)) {
              sendWsError(ws, 'Invalid partyId.');
              break;
            }
          } else if (typeof channelId !== 'string' || !UUID_RE.test(channelId)) {
            sendWsError(ws, 'Invalid channelId.');
            break;
          }

          let gameUser: any;
          try {
            gameUser = await prisma.user.findFirst({
              where: { discordId: identity.discordId },
              select: {
                id: true, username: true, discordUsername: true, discordDisplayName: true,
                installToken: true, isBanned: true, isMuted: true,
              },
            });
          } catch (err) {
            logger.error({ err }, 'Admin observer: DB error resolving game user for edit');
            sendWsError(ws, 'Server error.');
            return;
          }
          if (!gameUser) {
            sendWsError(ws, 'No game account linked to this Discord user.');
            return;
          }
          if (gameUser.isBanned) {
            sendWsError(ws, 'Your game account is banned.');
            return;
          }
          if (gameUser.isMuted) {
            sendWsError(ws, 'You are muted.');
            return;
          }

          if (await checkWsRateLimit(gameUser.id)) {
            ws.send(JSON.stringify({ type: 'rate:status', payload: { remaining: 0, retryAfterMs: 1000 } }));
            sendWsError(ws, 'Rate limit exceeded. Slow down.');
            break;
          }

          try {
            const edited = await editOwnedMessage({
              userId: gameUser.id,
              messageId,
              content,
              source,
              channelId: source === 'pm' ? undefined : channelId,
              conversationId: source === 'pm' ? conversationId : undefined,
              user: gameUser,
            });
            const payload = { ...edited };

            if (edited.source === 'party' && edited.channelId) {
              const members = await prisma.partyMember.findMany({
                where: { partyId: edited.channelId },
                select: { userId: true },
              });
              await broadcastToPartyMembers({ type: 'chat:edit', payload }, members.map(m => m.userId));
              ws.send(JSON.stringify({ type: 'chat:edit', payload }));
            } else if (edited.source === 'pm' && edited.recipientId) {
              await broadcastToUsers({ type: 'chat:edit', payload }, [gameUser.id, edited.recipientId]);
              ws.send(JSON.stringify({ type: 'chat:edit', payload }));
            } else {
              broadcast({ type: 'chat:edit', payload });
            }

            if (edited.source !== 'party' && edited.source !== 'pm') {
              editDiscordRelayMessage(edited.messageId, edited.content).catch((err) => {
                logger.warn({ err, messageId: edited.messageId }, '[chat:edit] admin observer Discord mirror failed (non-fatal)');
              });
            }

            ws.send(JSON.stringify({ type: 'message:edit:ack', payload }));
          } catch (err: any) {
            if (err instanceof MessageEditError) {
              sendWsError(ws, err.message);
            } else {
              logger.warn({ err, userId: gameUser.id, messageId, source }, '[chat:edit] admin observer failed');
              sendWsError(ws, 'Could not edit message.');
            }
          }
          break;
        }

        case 'chat:send': {
          if (!identity.discordId) {
            sendWsError(ws, 'No linked game account — cannot send messages.');
            return;
          }

          // Resolve the game user linked to this Discord account
          let gameUser: any;
          try {
            gameUser = await prisma.user.findFirst({
              where: { discordId: identity.discordId },
              select: { id: true, username: true, discordUsername: true, discordDisplayName: true, installToken: true, isBanned: true, isMuted: true, muteExpiresAt: true, muteReason: true, muteCategory: true },
            });
          } catch (err) {
            logger.error({ err }, 'Admin observer: DB error resolving game user');
            sendWsError(ws, 'Server error.');
            return;
          }

          if (!gameUser) {
            sendWsError(ws, 'No game account linked to this Discord user.');
            return;
          }

          if (gameUser.isBanned) {
            sendWsError(ws, 'Your game account is banned.');
            return;
          }

          // Auto-lift expired mutes
          if (gameUser.isMuted && gameUser.muteExpiresAt && new Date(gameUser.muteExpiresAt) < new Date()) {
            await prisma.user.update({ where: { id: gameUser.id }, data: { isMuted: false, muteExpiresAt: null, muteReason: null, muteCategory: null, mutedById: null } });
            gameUser.isMuted = false;
          }

          if (gameUser.isMuted) {
            const untilIso = gameUser.muteExpiresAt ? new Date(gameUser.muteExpiresAt).toISOString() : null;
            const detail = gameUser.muteReason
              ? `${gameUser.muteCategory ? `${gameUser.muteCategory}: ` : ''}${gameUser.muteReason}`
              : '';
            ws.send(JSON.stringify({ type: 'user:muted', payload: { until: untilIso, reason: gameUser.muteReason, category: gameUser.muteCategory } }));
            sendWsError(ws, detail ? `You are muted — ${detail}` : 'You are muted.');
            return;
          }

          // WS-level rate limit (5 msg/sec)
          const rateLimited = await checkWsRateLimit(gameUser.id);
          if (rateLimited) {
            logger.warn(
              { userId: gameUser.id, username: gameUser.username, type: frame.type },
              '[ws] rate limit exceeded — frame rejected',
            );
            ws.send(JSON.stringify({ type: 'rate:status', payload: { remaining: 0, retryAfterMs: 1000 } }));
            sendWsError(ws, 'Rate limit exceeded. Slow down.');
            return;
          }

          let { content } = frame.payload || {};
          const { channelId, clientCreatedAt } = frame.payload || {};
          // Optional {name, discordId} list from the @mention autocomplete on the
          // client. Lets the Discord relay map @name → <@discordId> precisely
          // (no fuzzy matching). Anything not in this list still falls back to
          // resolveAppMentions on the relay side.
          const rawMentions: Array<{ name: unknown; discordId: unknown }> = Array.isArray(frame.payload?.mentions)
            ? frame.payload.mentions : [];
          const inMentions = rawMentions
            .filter(m => typeof m?.name === 'string' && typeof m?.discordId === 'string'
                         && /^\d{16,22}$/.test(m.discordId as string))
            .map(m => ({ name: (m.name as string).slice(0, 64), discordId: m.discordId as string }))
            .slice(0, 16);

          if (!content || typeof content !== 'string' || content.trim().length === 0) {
            sendWsError(ws, 'Invalid message content.');
            return;
          }
          // Convert :shortcode: emoji to Unicode before persist/broadcast/relay.
          content = emojifyShortcodes(content);

          if (content.length > 500) {
            sendWsError(ws, 'Message too long (max 500 chars).');
            return;
          }

          if (!channelId || !UUID_RE.test(channelId)) {
            sendWsError(ws, 'Invalid channelId.');
            return;
          }

          if (clientCreatedAt) {
            const clientTime = new Date(clientCreatedAt).getTime();
            if (isNaN(clientTime) || Math.abs(Date.now() - clientTime) > CLIENT_TIMESTAMP_SKEW_MS) {
              sendWsError(ws, 'Message timestamp out of range.');
              return;
            }
          }

          try {
            if (!(await isChannelValid(channelId))) {
              sendWsError(ws, 'Channel not found.');
              return;
            }
          } catch (err) {
            logger.error({ err }, 'Admin observer: channel existence check failed');
            sendWsError(ws, 'Server error.');
            return;
          }

          // Single engine call replaces separate filterContent + detectSpam
          const engineResult = await engineEvaluate(content, channelId, gameUser);
          if (engineResult.block) {
            sendWsError(ws, engineResult.customMessage || 'Message blocked by content filter.');
            logger.info({ userId: gameUser.id }, 'Admin observer message blocked by engine');
            return;
          }

          const displayName = resolveDisplayName(gameUser);

          // ── Slash command interception (admin observer) ───────────────────
          if (content.trim().startsWith('/')) {
            const { name: channelName, parentId: parentChannelId } = await getChannelInfo(channelId);
            const cmdResult = await tryHandleCommand(
              content.trim(), gameUser.id, displayName, channelId, channelName,
              null, getClientCount(), parentChannelId,
            );
            if (cmdResult.handled) {
              if (cmdResult.actionType === 'message') {
                broadcast({
                  type: 'chat:message',
                  payload: {
                    id: uuidv4(),
                    content: cmdResult.botMessage,
                    username: '[Vault-Tec]',
                    userId: 'system',
                    channelId: cmdResult.targetChannelId,
                    source: 'bot',
                    timestamp: new Date().toISOString(),
                    ...(cmdResult.metadata ? { metadata: cmdResult.metadata } : {}),
                  },
                });
              } else if (cmdResult.actionType === 'relay') {
                const relayId = uuidv4();
                const relayTs = new Date().toISOString();
                const adminRelayPayload: Record<string, unknown> = {
                  id: relayId,
                  content: cmdResult.relayContent,
                  username: displayName,
                  userId: gameUser.id,
                  channelId: cmdResult.targetChannelId,
                  source: 'web',
                  timestamp: relayTs,
                  ...(cmdResult.responseColor != null ? { responseColor: cmdResult.responseColor } : {}),
                };
                await attachCosmetics(adminRelayPayload);
                broadcast({
                  type: 'chat:message',
                  payload: adminRelayPayload,
                });
                const { parentId: adminRelayParent } = await getChannelInfo(cmdResult.targetChannelId);
                messageQueue.add({
                  id: relayId,
                  content: cmdResult.relayContent,
                  userId: gameUser.id,
                  channelId: cmdResult.targetChannelId,
                  parentChannelId: adminRelayParent,
                  source: 'web',
                  createdAt: relayTs,
                }).catch((err: unknown) => logger.warn({ err }, 'Admin relay message queue failed'));
              } else if (cmdResult.actionType === 'private') {
                sendBotMsg(ws, cmdResult.botMessage, cmdResult.targetChannelId, true, cmdResult.metadata);
              } else if (cmdResult.actionType === 'report') {
                const reportId = uuidv4();
                try {
                  await prisma.playerReport.create({
                    data: { id: reportId, userId: gameUser.id, content: cmdResult.reportContent, reportType: cmdResult.reportType },
                  });
                } catch (err) {
                  logger.error({ err }, 'Admin observer: failed to create player report');
                }
                const ackMsg = cmdResult.reportType === 'bug'
                  ? '✓ Bug report submitted. Thank you — the team will investigate.'
                  : '✓ Player report submitted. The moderation team has been notified.';
                sendBotMsg(ws, ackMsg, cmdResult.targetChannelId, true);
                broadcastToAdmins({
                  type: 'report:new',
                  payload: {
                    id: reportId,
                    reportType: cmdResult.reportType,
                    content: cmdResult.reportContent,
                    username: displayName,
                    userId: gameUser.id,
                    createdAt: new Date().toISOString(),
                  },
                });
              }
              if ('privateNotice' in cmdResult && cmdResult.privateNotice) {
                sendBotMsg(ws, cmdResult.privateNotice, cmdResult.targetChannelId, true);
              }
              ws.send(JSON.stringify({ type: 'message:ack', payload: { messageId: uuidv4(), rateRemaining: 0 } }));
              break;
            }
          }
          // ── End slash command interception ────────────────────────────────

          const messageId = uuidv4();
          const createdAt = new Date().toISOString();

          const adminMessagePayload: Record<string, unknown> = {
            id: messageId,
            content: content.trim(),
            username: displayName,
            userId: gameUser.id,
            channelId,
            source: 'web',
            timestamp: createdAt,
          };
          await attachCosmetics(adminMessagePayload);
          broadcast({
            type: 'chat:message',
            payload: adminMessagePayload,
          });

          incrementMessageCount();

          ws.send(JSON.stringify({ type: 'message:ack', payload: { messageId, rateRemaining: 0 } }));

          const { parentId: adminMsgParent, name: adminChannelName } = await getChannelInfo(channelId);
          try {
            await messageQueue.add({
              id: messageId,
              content: content.trim(),
              userId: gameUser.id,
              channelId,
              parentChannelId: adminMsgParent,
              source: 'web',
              createdAt,
            });
          } catch (queueErr) {
            logger.warn({ err: queueErr, messageId }, 'Admin observer queue failed — falling back to direct persist');
            persistMessage({ id: messageId, content: content.trim(), userId: gameUser.id, channelId, parentChannelId: adminMsgParent, source: 'web', createdAt }).catch((err: unknown) => {
              logger.error({ err, messageId }, 'Admin observer direct persist also failed');
            });
          }

          relayToDiscord(channelId, displayName, content.trim(), adminChannelName ?? undefined, inMentions, undefined, messageId).catch((err) => {
            logger.warn({ err }, 'Admin observer Discord relay failed (non-fatal)');
          });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      logger.error({ err }, 'Unhandled error in admin observer WS message handler');
      try { sendWsError(ws, 'Internal server error.'); } catch {}
    }
  });

  ws.on('close', () => {
    adminObservers.delete(ws);
    logger.info('Admin observer WS disconnected');
  });
  ws.on('error', () => adminObservers.delete(ws));
}

function broadcastMessageDeletion(messageId: string): void {
  broadcast({ type: 'chat:delete', payload: { messageId } });
}

function broadcastReportAlert(report: any): void {
  broadcast({ type: 'mod:report', payload: report });
}

function broadcastChannelUpdate(action: string, channel: any): void {
  if (channel?.id) channelCache.delete(channel.id);
  // Invalidate the relay mappings cache so the first message on a newly
  // created/updated channel finds its Discord target without waiting 60s.
  // Guarded so a failed import never silences the broadcast that follows.
  try { invalidateRelayMappingsCache(); } catch { /* non-fatal */ }
  // Send channels:refresh — clients refetch /api/channels immediately.
  // (channel:update was broadcast here before but no client consumed it.)
  broadcast({ type: 'channels:refresh', payload: {} });
}

export function broadcastCommandsUpdate(commands: any[]): void {
  broadcast({ type: 'commands:updated', payload: { commands } });
}

/**
 * Broadcast a payload to party members (identified by memberUserIds).
 *
 * Local delivery: walks the `clients` Map and sends to any OPEN socket whose
 * userId is in the memberUserIds set, optionally excluding one socket.
 *
 * Cross-instance relay: publishes a `scope:'party'` envelope to Redis pub/sub
 * so other backend instances deliver to their own local members.
 *
 * Returns the count of local sockets that received the message.
 */
export async function broadcastToPartyMembers(
  payload: any,
  memberUserIds: string[],
  excludeWs: WebSocket | null = null,
): Promise<number> {
  const memberSet = new Set(memberUserIds);
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let delivered = 0;

  // Local delivery
  for (const [, client] of clients) {
    if (!memberSet.has(client.userId)) continue;
    if (client.ws === excludeWs || client.ws.readyState !== WebSocket.OPEN) continue;
    // Block enforcement: skip party members who have blocked the sender.
    if (recipientHasBlockedSender(payload, client)) continue;
    try {
      if (safeSend(client.ws, data, `broadcastToPartyMembers:${client.userId}`)) delivered++;
    } catch (err) {
      logger.warn({ err, userId: client.userId }, 'broadcastToPartyMembers: send failed (non-fatal)');
    }
  }

  // Cross-instance relay via Redis pub/sub
  if (pubsubActive) {
    const envelope = JSON.stringify({
      instanceId: INSTANCE_ID,
      payload,
      scope: 'party',
      memberUserIds,
    });
    getRedisClient()
      .then((redis) => redis.publish(PUBSUB_CHANNEL, envelope))
      .catch((err) => logger.warn({ err }, 'broadcastToPartyMembers: Redis publish failed (non-fatal)'));
  }

  return delivered;
}

/**
 * Returns true if the given user has at least one OPEN WebSocket connection.
 * Used to determine party-member "online" status — connected to chat = online.
 */
export function isUserConnected(userId: string): boolean {
  for (const c of clients.values()) {
    if (c.userId === userId && c.ws.readyState === WebSocket.OPEN) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if the given user has at least one OPEN client entry where
 * inGame === true (i.e. Fallout 76 is currently running on their machine).
 * Used to gate presence "online" status — WS-connected but not in-game = OFFLINE.
 */
export function isUserInGame(userId: string): boolean {
  for (const c of clients.values()) {
    if (c.userId === userId && c.ws.readyState === WebSocket.OPEN && c.inGame === true) {
      return true;
    }
  }
  return false;
}

/**
 * Count how many members of each party are currently online (OPEN WS + in-game).
 * A user is "online" only when Fallout 76 is running — WS-connected alone is not enough.
 * Accepts a Map of partyId → array of member userIds.
 * Returns a Map of partyId → online count.
 */
export function getOnlinePartyCounts(partyIdToUserIds: Map<string, string[]>): Map<string, number> {
  // Build the set of all in-game userIds in a single pass
  const onlineSet = new Set<string>();
  for (const [, client] of clients) {
    if (client.ws.readyState === WebSocket.OPEN && client.inGame === true) onlineSet.add(client.userId);
  }
  const result = new Map<string, number>();
  for (const [partyId, memberIds] of partyIdToUserIds) {
    result.set(partyId, memberIds.filter(id => onlineSet.has(id)).length);
  }
  return result;
}

/** Send an error frame to a single WebSocket connection. */
function sendWsError(ws: WebSocket, message: string): void {
  ws.send(JSON.stringify({ type: 'error', payload: { message } }));
}

/** Send a [Vault-Tec] bot message to a single WebSocket connection. */
function sendBotMsg(ws: WebSocket, content: string, channelId: string, isPrivate = false, metadata?: Record<string, unknown> | null): void {
  ws.send(JSON.stringify({
    type: 'chat:message',
    payload: {
      id: uuidv4(),
      content,
      username: '[Vault-Tec]',
      userId: 'system',
      channelId,
      source: 'bot',
      ...(isPrivate ? { isPrivate: true } : {}),
      ...(metadata ? { metadata } : {}),
      timestamp: new Date().toISOString(),
    },
  }));
}

function broadcastToAdmins(payload: object): void {
  const data = JSON.stringify(payload);
  for (const obs of adminObservers) {
    if (obs.readyState === WebSocket.OPEN) {
      try { obs.send(data); } catch { /* non-fatal */ }
    }
  }
}

// Count unique connected users with at least one OPEN socket. The `clients` map
// is keyed by session token, so a user with multiple sessions must be deduplicated.
// Also counts users whose flap-grace disconnect timer is still pending to avoid
// the Discord bot presence cycling "Watching 0 dwellers" ↔ N during reconnects.
function getClientCount(): number {
  const seen = new Set<string>();
  for (const c of clients.values()) {
    if (c.userId && c.ws.readyState === WebSocket.OPEN) seen.add(c.userId);
  }
  // Include users with an in-flight flap-grace timer (not yet disconnected).
  for (const userId of pendingDisconnect.keys()) {
    seen.add(userId);
  }
  return seen.size;
}

/**
 * Force-disconnect every open WS for a given user (used by moderation kick/ban).
 * Iterates clients Map since it's keyed by session token, not userId.
 * Returns count closed.
 */
function disconnectByUserId(userId: string, code: number, reason: string): number {
  let n = 0;
  for (const [, entry] of clients.entries()) {
    if (entry.userId !== userId) continue;
    // Mark the entry as force-disconnected so the ws.on('close') handler can
    // skip the room:leave broadcast — we don't want a spurious leave on kick/ban.
    (entry as any)._forceDisconnected = true;
    try { entry.ws.close(code, reason); } catch { /* socket already gone */ }
    // DO NOT pre-delete from `clients` — let ws.on('close') clean up normally.
    n++;
  }
  return n;
}

/**
 * Send a typed notice frame to every open WS for a user, give them ~250ms
 * to render it, then force-disconnect. Used for kick / ban so the overlay
 * can show "You were kicked: <reason>" before the close hits.
 */
function notifyAndDisconnect(userId: string, frame: { type: string; payload: unknown }, closeCode: number, closeReason: string): number {
  let n = 0;
  for (const entry of clients.values()) {
    if (entry.userId !== userId) continue;
    // SR-001 race fix: flip the in-memory mute flag immediately so chat:send
    // rejects any further outbound messages during the 250ms render window
    // between notice-send and ws.close. Without this, a banned/kicked user
    // could burst-send messages for up to 250ms after the ban took effect.
    entry.isMuted = true;
    try { entry.ws.send(JSON.stringify(frame)); } catch { /* socket already gone */ }
    n++;
  }
  setTimeout(() => disconnectByUserId(userId, closeCode, closeReason), 250);
  return n;
}

/**
 * Flip the in-memory `isMuted` flag for every open WS of the user, and emit
 * a typed `user:muted` (or `user:unmuted`) event so the overlay can grey/
 * ungrey the input immediately without a reconnect.
 */
function markClientMuted(userId: string, muted: boolean, detail?: { until: string | null; reason: string | null; category: string | null }): void {
  for (const entry of clients.values()) {
    if (entry.userId !== userId) continue;
    entry.isMuted = muted;
    try {
      entry.ws.send(JSON.stringify({
        type: muted ? 'user:muted' : 'user:unmuted',
        payload: muted ? (detail ?? { until: null, reason: null, category: null }) : {},
      }));
    } catch { /* socket already gone */ }
  }
}

async function handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  // Check for admin observer ticket (?ticket=<uuid>)
  const urlParams = new URLSearchParams((req.url || '').split('?')[1] || '');
  const ticket = urlParams.get('ticket');

  if (ticket) {
    let adminIdentity: AdminIdentity = {};
    try {
      const redis = await getRedisClient();
      const ticketVal = await redis.get(`ws_ticket:${ticket}`); await redis.del(`ws_ticket:${ticket}`);
      if (!ticketVal) {
        ws.close(WS_CLOSE_AUTH_FAILED, 'Invalid or expired ticket');
        return;
      }
      // Parse JSON ticket value; fall back to legacy plain 'admin' string for backward compat
      if (ticketVal === 'admin') {
        // legacy format — no identity
      } else {
        try {
          const parsed = JSON.parse(ticketVal);
          if (parsed.type !== 'admin') {
            ws.close(WS_CLOSE_AUTH_FAILED, 'Invalid ticket type');
            return;
          }
          // Defense-in-depth: re-validate the stored role even if the ticket
          // endpoint already checked. Protects against role degradation races
          // and legacy tickets issued without the role gate.
          const { isPrivilegedRole } = require('../services/userRoleService') as typeof import('../services/userRoleService');
          if (!isPrivilegedRole(parsed.role ?? '')) {
            ws.close(WS_CLOSE_AUTH_FAILED, 'Insufficient role');
            return;
          }
          adminIdentity = { discordId: parsed.discordId, username: parsed.username };
        } catch {
          ws.close(WS_CLOSE_AUTH_FAILED, 'Malformed ticket');
          return;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Redis error during WS ticket auth');
      ws.close(WS_CLOSE_AUTH_FAILED, 'Auth service unavailable');
      return;
    }
    handleAdminObserver(ws, adminIdentity);
    return;
  }

  // ── Early-frame buffer (connect-time race fix) ─────────────────────────────
  // The real message handler is attached far below, AFTER several async
  // connect-time steps (token auth, role lookup, presence snapshot). The `ws`
  // library does NOT replay messages for a late listener, so any client frame
  // that arrives during that window is silently LOST. On low-latency localhost
  // the overlay's chat:history burst lands in exactly this gap (prod works only
  // because WSS/Cloudflare latency delays the burst past setup). Buffer those
  // frames now and replay them once the real handler is attached (see below).
  const earlyFrames: RawData[] = [];
  const earlyFrameBuffer = (raw: RawData) => { earlyFrames.push(raw); };
  ws.on('message', earlyFrameBuffer);

  // Extract token from header (game client upgrade request)
  const token = req.headers['x-auth-token'] as string | undefined;

  if (!token) {
    ws.close(WS_CLOSE_AUTH_FAILED, 'Missing X-Auth-Token');
    return;
  }

  // Validate token against Redis
  let userId: string | null;
  try {
    const redis = await getRedisClient();
    userId = await redis.get(`session:${token}`);
  } catch (err) {
    logger.error({ err }, 'Redis error during WS auth');
    ws.close(WS_CLOSE_AUTH_FAILED, 'Auth service unavailable');
    return;
  }

  if (!userId) {
    ws.close(WS_CLOSE_AUTH_FAILED, 'Invalid or expired token');
    return;
  }

  // Load user
  let user: any;
  try {
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, discordId: true, discordUsername: true, discordDisplayName: true, installToken: true, isBanned: true, isMuted: true, muteExpiresAt: true, muteReason: true, muteCategory: true, bannedUntil: true, banCategory: true, banReason: true, kickedUntil: true },
    });
  } catch (err) {
    logger.error({ err }, 'DB error during WS auth');
    ws.close(WS_CLOSE_AUTH_FAILED, 'Database error');
    return;
  }

  if (!user) {
    ws.close(WS_CLOSE_AUTH_FAILED, 'User not found');
    return;
  }

  // Auto-lift expired temp bans before the reject check (cron also does this hourly).
  if (user.isBanned && user.bannedUntil && new Date(user.bannedUntil) < new Date()) {
    await prisma.user.update({
      where: { id: userId },
      data: { isBanned: false, bannedUntil: null, banReason: null, banCategory: null, bannedById: null, bannedAt: null },
    });
    user.isBanned = false;
  }

  if (user.isBanned) {
    ws.close(WS_CLOSE_BANNED, 'Banned');
    return;
  }

  // Kick cooldown — 5 minutes after a moderator kick. Send a typed close-reason
  // string the overlay can parse to show "Kicked — try again in N seconds".
  if (user.kickedUntil && new Date(user.kickedUntil) > new Date()) {
    const secs = Math.ceil((new Date(user.kickedUntil).getTime() - Date.now()) / 1000);
    ws.close(WS_CLOSE_BANNED, `KICK_COOLDOWN:${secs}`);
    return;
  }

  // Check if mute has expired
  if (user.isMuted && user.muteExpiresAt && new Date(user.muteExpiresAt) < new Date()) {
    await prisma.user.update({
      where: { id: userId },
      data: { isMuted: false, muteExpiresAt: null, muteReason: null, muteCategory: null, mutedById: null },
    });
    user.isMuted = false;
  }

  // Compute display name using priority: FO76 name → Discord name → fallback
  const displayName = resolveDisplayName(user);


  // Block enforcement: load this user's blocked-set so message delivery can
  // skip authors they've blocked without a per-message DB round-trip. Failure
  // is non-fatal — default to an empty set (no filtering).
  let initialBlockedIds = new Set<string>();
  try {
    const { getBlockedIds } = require('../services/blockService') as typeof import('../services/blockService');
    initialBlockedIds = await getBlockedIds(user.id);
  } catch (err) {
    logger.warn({ err, userId: user.id }, '[ws-connect] getBlockedIds failed (non-fatal) — no block filtering');
  }

  // Resolve effective role at connect-time so party:send mod-observer fan-out
  // can walk the clients map synchronously. Default to 'user' (fail-safe).
  let connectTimeRole: import('../services/userRoleService').EffectiveRole = 'user';
  try {
    const { getEffectiveRole: _getRoleForConnect } = require('../services/userRoleService') as { getEffectiveRole: (id: string) => Promise<import('../services/userRoleService').EffectiveRole> };
    connectTimeRole = await _getRoleForConnect(user.id);
  } catch { /* default 'user' */ }

  clients.set(token, {
    ws, userId: user.id, username: user.username, displayName,
    isMuted: user.isMuted,
    blockedIds: initialBlockedIds,
    inGame: false,
    role: connectTimeRole,
  });
  logger.info({ userId: user.id, username: user.username, displayName }, 'WS client connected');

  // ── WS-flap grace handoff ──────────────────────────────────────────────────
  // If this user has a pending-disconnect entry from a recent close, decide
  // whether the new socket suppresses the deferred peer-leave or fires it now.
  {
    const pd = pendingDisconnect.get(user.id);
    if (pd) {
      const newEp: string | null = null;
      const decision = decideFlapHandoff({ endpoint: pd.endpoint }, newEp);
      clearTimeout(pd.timer);
      pendingDisconnect.delete(user.id);
      notePendingDisconnectSuppressed(user.id);
      if (decision.kind === 'fire-old-immediately') {
        try { pd.fire(); } catch { /* non-fatal */ }
        logger.info(
          { userId: user.id, oldEp: pd.endpoint, newEp },
          '[ws-flap] reconnect with different endpoint — firing OLD-endpoint leave immediately',
        );
      } else {
        logger.info(
          { userId: user.id, ep: pd.endpoint },
          '[ws-flap] reconnect within grace window — suppressing peer-leave + welcome-key clear',
        );
      }
    }
  }

  // Push a presence snapshot on connect so the overlay can reconcile any state
  // that drifted while the WS was disconnected. One-shot, server→client only.
  try {
    ws.send(JSON.stringify({
      type: 'presence:state',
      payload: {
        userId: user.id,
        role: connectTimeRole,
      },
    }));
    // If the user is currently muted, push the typed event so the overlay
    // greys the input immediately without a chat:send round-trip.
    if (user.isMuted) {
      ws.send(JSON.stringify({
        type: 'user:muted',
        payload: {
          until: user.muteExpiresAt ? new Date(user.muteExpiresAt).toISOString() : null,
          reason: user.muteReason ?? null,
          category: user.muteCategory ?? null,
        },
      }));
    }
  } catch (err) {
    logger.warn({ err, userId: user.id }, '[presence:state] connect-time snapshot send failed (non-fatal)');
  }

  // Telemetry collection was removed. Emit a one-time telemetry:set{enabled:false}
  // on connect as a permanent kill-switch so any already-installed client that
  // listens for it stops collecting. No DB lookup; always off.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'telemetry:set', payload: { enabled: false } }));
  }

  // Deliver the latest published version to the newly connected client so it can
  // show a passive OS notification when a newer version is available (Nexus ToS
  // compliance: version rides the existing chat WS — no dedicated update call).
  // Only sent when a version is known (cache populated at boot / after publish).
  try {
    const latestVersion = getLatestVersion();
    if (latestVersion && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'app:update-available', payload: { latestVersion } }));
    }
  } catch (err) {
    logger.warn({ err, userId: user.id }, '[app:update-available] connect-time send failed (non-fatal)');
  }

  // Golden-build lock (dev-only): reject a stale QA build. No-op in prod, where
  // QA_BUILD_LOCK is unset. Fail-open when no active version is configured.
  if (env.QA_BUILD_LOCK) {
    try {
      const activeQaVersion = await getActiveQaVersion();
      const gate = evaluateBuildGate(req.headers as Record<string, unknown>, activeQaVersion, true);
      if (!gate.allowed) {
        logger.info({ userId: user.id, clientVersion: gate.clientVersion, activeQaVersion }, '[ws] rejecting outdated build');
        ws.close(WS_CLOSE_OUTDATED_BUILD, `OUTDATED_BUILD:${activeQaVersion || ''}`);
        clients.delete(token);
        noteUserDisconnected(user.id);
        return;
      }
    } catch (err) {
      logger.warn({ err, userId: user.id }, '[ws] build-gate check failed; failing open');
    }
  }

  noteUserConnected(user.id);

  // Broadcast room:join (user connected)
  broadcast({ type: 'room:join', payload: { username: displayName, timestamp: new Date().toISOString() } }, ws);


  ws.on('message', async (raw: RawData) => {
    let frame: any;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      sendWsError(ws, 'Malformed JSON');
      return;
    }

    if (!frame.type) return;

    // -- Deprecation layer: accept old event names for one release cycle --
    const EVENT_ALIASES: Record<string, string> = {
      'send-message': 'chat:send',
      'load-history': 'chat:history',
      'user-join':    'room:join',
    };
    if (EVENT_ALIASES[frame.type]) frame.type = EVENT_ALIASES[frame.type];

    try {
    switch (frame.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', payload: {} }));
        break;

      case 'room:join':
        // Re-auth frame (optional client identification)
        break;

      // ── Moderator-only WS actions (desktop overlay drives these; web uses REST) ──
      case 'mod:kick':
      case 'mod:mute':
      case 'mod:unmute': {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { getEffectiveRole } = require('../services/userRoleService') as { getEffectiveRole: (id: string) => Promise<string> };
          const role = await getEffectiveRole(user.id);
          if (!['moderator', 'admin', 'owner'].includes(role)) {
            sendWsError(ws, 'Insufficient role for moderation actions.');
            return;
          }
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const ms = require('../services/moderationActionsService') as any;
          const p = frame.payload || {};
          const targetId = p.userId;
          // SR-006: strict UUID match (same shape the REST controller enforces).
          // The prior /^[0-9a-f-]{36}$/i regex matched any 36-char hex-or-dash
          // string (e.g. 36 dashes), letting malformed input through to Prisma.
          if (typeof targetId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId)) {
            sendWsError(ws, 'mod action: userId must be a UUID');
            return;
          }
          if (frame.type === 'mod:kick') {
            const kr = String(p.reason ?? '').trim();
            if (!kr) { sendWsError(ws, 'kick reason is required'); return; }
            await ms.kickUser(targetId, user.id, kr.slice(0, 300));
          } else if (frame.type === 'mod:mute') {
            const minutes = Number(p.durationMinutes);
            if (!Number.isFinite(minutes) || minutes <= 0) { sendWsError(ws, 'durationMinutes required'); return; }
            const capped = Math.min(minutes, 30 * 24 * 60);
            await ms.muteUser(targetId, user.id, capped * 60_000, String(p.category || 'Other').slice(0, 100), String(p.reason || '').slice(0, 500));
          } else {
            await ms.unmuteUser(targetId, user.id, String(p.reason ?? 'unmuted from overlay').slice(0, 300));
          }
        } catch (err: any) {
          if (err?.name === 'ProtectedTargetError') {
            sendWsError(ws, err.message);
          } else {
            logger.warn({ err, type: frame.type }, 'mod WS action failed');
            sendWsError(ws, `${frame.type} failed: ${err?.message ?? 'unknown'}`);
          }
        }
        break;
      }

      case 'pm:list': {
        try {
          const conversations = await listPrivateConversations(user.id);
          ws.send(JSON.stringify({ type: 'pm:list', payload: { conversations } }));
        } catch (err) {
          logger.warn({ err, userId: user.id }, '[pm:list] failed');
          sendWsError(ws, 'Could not load private messages.');
        }
        break;
      }

      case 'pm:open': {
        const targetUserId = frame.payload?.targetUserId;
        if (typeof targetUserId !== 'string' || !UUID_RE.test(targetUserId)) {
          sendWsError(ws, 'Invalid targetUserId.');
          break;
        }
        try {
          const conversation = await getOrCreatePrivateConversation(user.id, targetUserId);
          const conversations = await listPrivateConversations(user.id);
          ws.send(JSON.stringify({
            type: 'pm:list',
            payload: {
              conversations,
              openedConversationId: conversation.id,
            },
          }));
        } catch (err: any) {
          if (err instanceof PrivateMessageUnavailableError) {
            sendWsError(ws, err.message);
          } else {
            logger.warn({ err, userId: user.id, targetUserId }, '[pm:open] failed');
            sendWsError(ws, 'Could not open private conversation.');
          }
        }
        break;
      }

      case 'pm:history': {
        const conversationId = frame.payload?.conversationId;
        if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
          sendWsError(ws, 'Invalid conversationId.');
          break;
        }
        try {
          const messages = await getPrivateHistory(
            user.id,
            conversationId,
            frame.payload?.limit ?? 100,
            frame.payload?.offset ?? 0,
          );
          await markPrivateConversationRead(user.id, conversationId);
          ws.send(JSON.stringify({
            type: 'pm:history',
            payload: {
              conversationId,
              messages,
            },
          }));
          await broadcastToUsers({
            type: 'pm:read',
            payload: { conversationId, unreadCount: 0 },
          }, [user.id]);
        } catch (err: any) {
          if (err instanceof PrivateConversationAccessError || err instanceof PrivateMessageUnavailableError) {
            sendWsError(ws, err.message);
          } else {
            logger.warn({ err, userId: user.id, conversationId }, '[pm:history] failed');
            sendWsError(ws, 'Could not load private conversation.');
          }
        }
        break;
      }

      case 'pm:read': {
        const conversationId = frame.payload?.conversationId;
        if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
          sendWsError(ws, 'Invalid conversationId.');
          break;
        }
        try {
          await markPrivateConversationRead(user.id, conversationId);
          await broadcastToUsers({
            type: 'pm:read',
            payload: { conversationId, unreadCount: 0 },
          }, [user.id]);
        } catch (err: any) {
          if (err instanceof PrivateConversationAccessError || err instanceof PrivateMessageUnavailableError) {
            sendWsError(ws, err.message);
          } else {
            logger.warn({ err, userId: user.id, conversationId }, '[pm:read] failed');
            sendWsError(ws, 'Could not update private message state.');
          }
        }
        break;
      }

      case 'pm:send': {
        const pmClient = clients.get(token);
        if (!pmClient) break;

        let pmMuteDetail: { until: string | null; reason: string | null; category: string | null } | null = null;
        if (pmClient.isMuted) {
          const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: { isMuted: true, muteExpiresAt: true, muteReason: true, muteCategory: true },
          });
          if (dbUser) {
            if (dbUser.isMuted && dbUser.muteExpiresAt && new Date(dbUser.muteExpiresAt) < new Date()) {
              await prisma.user.update({
                where: { id: user.id },
                data: { isMuted: false, muteExpiresAt: null, muteReason: null, muteCategory: null, mutedById: null },
              });
              pmClient.isMuted = false;
            } else if (!dbUser.isMuted) {
              pmClient.isMuted = false;
            } else {
              pmMuteDetail = {
                until: dbUser.muteExpiresAt ? new Date(dbUser.muteExpiresAt).toISOString() : null,
                reason: dbUser.muteReason ?? null,
                category: dbUser.muteCategory ?? null,
              };
            }
          }
        }
        if (pmClient.isMuted) {
          ws.send(JSON.stringify({ type: 'user:muted', payload: pmMuteDetail ?? { until: null, reason: null, category: null } }));
          const detail = pmMuteDetail?.reason
            ? `${pmMuteDetail.category ? `${pmMuteDetail.category}: ` : ''}${pmMuteDetail.reason}`
            : '';
          sendWsError(ws, detail ? `You are muted — ${detail}` : 'You are muted.');
          break;
        }

        const rateLimited = await checkWsRateLimit(user.id);
        if (rateLimited) {
          ws.send(JSON.stringify({ type: 'rate:status', payload: { remaining: 0, retryAfterMs: 1000 } }));
          sendWsError(ws, 'Rate limit exceeded. Slow down.');
          break;
        }

        const recipientUserId = frame.payload?.recipientUserId;
        const conversationId = frame.payload?.conversationId;
        const clientCreatedAt = frame.payload?.clientCreatedAt;
        let content = frame.payload?.content;

        if (typeof recipientUserId !== 'string' || !UUID_RE.test(recipientUserId)) {
          sendWsError(ws, 'Invalid recipientUserId.');
          break;
        }
        if (conversationId != null && (typeof conversationId !== 'string' || !UUID_RE.test(conversationId))) {
          sendWsError(ws, 'Invalid conversationId.');
          break;
        }
        if (typeof content !== 'string' || content.trim().length === 0) {
          sendWsError(ws, 'Invalid message content.');
          break;
        }
        if (clientCreatedAt) {
          const clientTime = new Date(clientCreatedAt).getTime();
          if (isNaN(clientTime) || Math.abs(Date.now() - clientTime) > CLIENT_TIMESTAMP_SKEW_MS) {
            sendWsError(ws, 'Message timestamp out of range.');
            break;
          }
        }

        content = emojifyShortcodes(content);
        const pmEngineResult = await engineEvaluate(content, `pm:${recipientUserId}`, user);
        if (pmEngineResult.block) {
          if (pmEngineResult.customMessage?.includes('Spam')) {
            await shadowMute(user.id);
            pmClient.isMuted = true;
          }
          sendWsError(ws, pmEngineResult.customMessage || 'Message blocked by content filter.');
          break;
        }

        try {
          if (conversationId) {
            const conversation = await getOrCreatePrivateConversation(user.id, recipientUserId);
            if (conversation.id !== conversationId) {
              sendWsError(ws, 'Invalid conversationId.');
              break;
            }
          }

          const message = await sendPrivateMessage(user.id, recipientUserId, content);
          await broadcastToUsers({
            type: 'pm:message',
            payload: {
              ...message,
              isPrivate: true,
            },
          }, [user.id, recipientUserId]);
        } catch (err: any) {
          if (err instanceof PrivateConversationAccessError || err instanceof PrivateMessageUnavailableError) {
            sendWsError(ws, err.message);
          } else if (err?.statusCode === 400) {
            sendWsError(ws, err.message);
          } else {
            logger.warn({ err, userId: user.id, recipientUserId }, '[pm:send] failed');
            sendWsError(ws, 'Could not send private message.');
          }
        }
        break;
      }

      case 'chat:edit': {
        const editClient = clients.get(token);
        if (!editClient) break;
        if (editClient.isMuted) {
          sendWsError(ws, 'You are muted.');
          break;
        }

        const messageId = frame.payload?.messageId;
        const content = frame.payload?.content;
        const source = frame.payload?.source;
        const channelId = frame.payload?.channelId;
        const conversationId = frame.payload?.conversationId;

        if (typeof messageId !== 'string' || !UUID_RE.test(messageId)) {
          sendWsError(ws, 'Invalid messageId.');
          break;
        }
        if (typeof source !== 'string' || source === 'bot' || source === 'system' || source === 'server') {
          sendWsError(ws, 'This message cannot be edited.');
          break;
        }
        if (source === 'pm') {
          if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
            sendWsError(ws, 'Invalid conversationId.');
            break;
          }
        } else if (source === 'party') {
          if (typeof channelId !== 'string' || !UUID_RE.test(channelId)) {
            sendWsError(ws, 'Invalid partyId.');
            break;
          }
        } else if (typeof channelId !== 'string' || !UUID_RE.test(channelId)) {
          // Virtual server feeds and non-persisted system messages are not editable.
          sendWsError(ws, 'Invalid channelId.');
          break;
        }

        if (await checkWsRateLimit(user.id)) {
          ws.send(JSON.stringify({ type: 'rate:status', payload: { remaining: 0, retryAfterMs: 1000 } }));
          sendWsError(ws, 'Rate limit exceeded. Slow down.');
          break;
        }

        try {
          const edited = await editOwnedMessage({
            userId: user.id,
            messageId,
            content,
            source,
            channelId: source === 'pm' ? undefined : channelId,
            conversationId: source === 'pm' ? conversationId : undefined,
            user,
          });
          const payload = { ...edited };

          if (edited.source === 'party' && edited.channelId) {
            const members = await prisma.partyMember.findMany({
              where: { partyId: edited.channelId },
              select: { userId: true },
            });
            broadcastToPartyMembers({ type: 'chat:edit', payload }, members.map(m => m.userId));

            // Keep privileged observers in sync even when they are not members
            // of the party, matching the party:send observer fan-out.
            try {
              const { isPrivilegedRole } = require('../services/userRoleService') as { isPrivilegedRole: (r: string) => boolean };
              const memberIds = new Set(members.map(m => m.userId));
              const observerPayload = JSON.stringify({ type: 'chat:edit', payload: { ...payload, _modObserver: true } });
              for (const [, observer] of clients) {
                if (!isPrivilegedRole(observer.role) || memberIds.has(observer.userId)) continue;
                safeSend(observer.ws, observerPayload, `chat:edit:party-observer:${observer.userId}`);
              }
            } catch (err) {
              logger.warn({ err, partyId: edited.channelId }, '[chat:edit] party observer fan-out failed (non-fatal)');
            }
          } else if (edited.source === 'pm' && edited.recipientId) {
            await broadcastToUsers({ type: 'chat:edit', payload }, [user.id, edited.recipientId]);
          } else {
            broadcast({ type: 'chat:edit', payload });
          }

          // The local edit is authoritative for the overlay. If this channel
          // message has a bot-authored Discord counterpart, mirror the edit
          // asynchronously; a Discord outage must not reject the user's edit.
          if (edited.source !== 'party' && edited.source !== 'pm') {
            editDiscordRelayMessage(edited.messageId, edited.content).catch((err) => {
              logger.warn({ err, messageId: edited.messageId }, '[chat:edit] Discord mirror failed (non-fatal)');
            });
          }

          ws.send(JSON.stringify({ type: 'message:edit:ack', payload }));
        } catch (err: any) {
          if (err instanceof MessageEditError) {
            sendWsError(ws, err.message);
          } else {
            logger.warn({ err, userId: user.id, messageId, source }, '[chat:edit] failed');
            sendWsError(ws, 'Could not edit message.');
          }
        }
        break;
      }

      case 'chat:send': {
        const client = clients.get(token);
        if (!client) return;
        logger.info({
          userId: user.id, username: user.username,
          channelId: frame.payload?.channelId,
          content: String(frame.payload?.content ?? '').slice(0, 32),
        }, '[chat:send] received');

        // Re-check mute status; auto-lift expired mutes in-flight
        let muteDetail: { until: string | null; reason: string | null; category: string | null } | null = null;
        if (client.isMuted) {
          const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: { isMuted: true, muteExpiresAt: true, muteReason: true, muteCategory: true },
          });
          if (dbUser) {
            if (dbUser.isMuted && dbUser.muteExpiresAt && new Date(dbUser.muteExpiresAt) < new Date()) {
              await prisma.user.update({
                where: { id: user.id },
                data: { isMuted: false, muteExpiresAt: null, muteReason: null, muteCategory: null, mutedById: null },
              });
              client.isMuted = false;
            } else if (!dbUser.isMuted) {
              client.isMuted = false; // moderator unmuted externally
            } else {
              muteDetail = {
                until: dbUser.muteExpiresAt ? new Date(dbUser.muteExpiresAt).toISOString() : null,
                reason: dbUser.muteReason ?? null,
                category: dbUser.muteCategory ?? null,
              };
            }
          }
        }
        if (client.isMuted) {
          // Push a typed event so the overlay can grey the input + show the
          // "muted until X" banner without having to parse the error string.
          ws.send(JSON.stringify({ type: 'user:muted', payload: muteDetail ?? { until: null, reason: null, category: null } }));
          const detail = muteDetail?.reason
            ? `${muteDetail.category ? `${muteDetail.category}: ` : ''}${muteDetail.reason}`
            : '';
          sendWsError(ws, detail ? `You are muted — ${detail}` : 'You are muted.');
          return;
        }

        // WS-level rate limit (5 msg/sec)
        const rateLimited = await checkWsRateLimit(user.id);
        if (rateLimited) {
          ws.send(JSON.stringify({ type: 'rate:status', payload: { remaining: 0, retryAfterMs: 1000 } }));
          sendWsError(ws, 'Rate limit exceeded. Slow down.');
          return;
        }

        let { content } = frame.payload || {};
        const { clientCreatedAt } = frame.payload || {};
        let channelId: string = frame.payload?.channelId;
        // {name, discordId} pairs from the @ autocomplete (see handler 1 for details).
        const rawMentions2: Array<{ name: unknown; discordId: unknown }> = Array.isArray(frame.payload?.mentions)
          ? frame.payload.mentions : [];
        const inMentions2 = rawMentions2
          .filter(m => typeof m?.name === 'string' && typeof m?.discordId === 'string'
                       && /^\d{16,22}$/.test(m.discordId as string))
          .map(m => ({ name: (m.name as string).slice(0, 64), discordId: m.discordId as string }))
          .slice(0, 16);

        if (!content || typeof content !== 'string' || content.trim().length === 0) {
          sendWsError(ws, 'Invalid message content.');
          return;
        }

        if (content.length > 500) {
          sendWsError(ws, 'Message too long (max 500 chars).');
          return;
        }
        // Convert :shortcode: emoji to Unicode before persist/broadcast/relay.
        content = emojifyShortcodes(content);

        if (!channelId || !UUID_RE.test(channelId)) {
          sendWsError(ws, 'Invalid channelId.');
          return;
        }

        // Validate client-supplied timestamp is within +/- 5 minutes
        if (clientCreatedAt) {
          const clientTime = new Date(clientCreatedAt).getTime();
          if (isNaN(clientTime) || Math.abs(Date.now() - clientTime) > CLIENT_TIMESTAMP_SKEW_MS) {
            sendWsError(ws, 'Message timestamp out of range.');
            return;
          }
        }

        // Validate channelId exists (cached 60s to avoid DB hit on every message)
        try {
          if (!(await isChannelValid(channelId))) {
            sendWsError(ws, 'Channel not found.');
            return;
          }
        } catch (err) {
          logger.error({ err }, 'Channel existence check failed');
          sendWsError(ws, 'Server error.');
          return;
        }

        // Pre-broadcast auto-moderation
        // Single engine call: legacy word_filter + Redis spam + new automod_rules
        const engineResult = await engineEvaluate(content, channelId, user);
        if (engineResult.block) {
          // If it was spam detection, also set in-memory muted flag
          if (engineResult.customMessage?.includes('Spam')) {
            await shadowMute(user.id);
            client.isMuted = true;
          }
          sendWsError(ws, engineResult.customMessage || 'Message blocked by content filter.');
          logger.info({ userId: user.id, matches: engineResult.matches.length }, 'Message blocked by automod engine');
          return;
        }

        // ── Slash command interception ────────────────────────────────────
        // Runs after all auth/mute/rate-limit/filter checks. Non-command
        // messages fall through to the normal broadcast path unchanged.
        if (content.trim().startsWith('/')) {
          const { name: channelName, parentId: parentChannelId } = await getChannelInfo(channelId);
          const cmdResult = await tryHandleCommand(
            content.trim(), user.id, displayName, channelId, channelName,
            null,
            getClientCount(), parentChannelId,
          );
          logger.info({
            userId: user.id, trigger: content.trim().split(/\s+/)[0],
            actionType: (cmdResult as any).actionType,
            target: (cmdResult as any).targetChannelId,
            handled: cmdResult.handled,
          }, '[chat:send] slash command result');
          if (cmdResult.handled) {
            if (cmdResult.actionType === 'message') {
              broadcast({
                type: 'chat:message',
                payload: {
                  id: uuidv4(),
                  content: cmdResult.botMessage,
                  username: '[Vault-Tec]',
                  userId: 'system',
                  channelId: cmdResult.targetChannelId,
                  source: 'bot',
                  timestamp: new Date().toISOString(),
                  ...(cmdResult.metadata ? { metadata: cmdResult.metadata } : {}),
                },
              });
            } else if (cmdResult.actionType === 'relay') {
              // Relay: send user's message to target channel as themselves
              const relayId = uuidv4();
              const relayTs = new Date().toISOString();
              const relayPayload = {
                type: 'chat:message' as const,
                payload: {
                  id: relayId,
                  content: cmdResult.relayContent,
                  username: displayName,
                  userId: user.id,
                  channelId: cmdResult.targetChannelId,
                  source: 'game',
                  timestamp: relayTs,
                  ...(cmdResult.responseColor != null ? { responseColor: cmdResult.responseColor } : {}),
                },
              };
              {
                // Regular channel relay — existing broadcast + messages-table persist.
                broadcast(relayPayload);
                const { parentId: relayParent, name: relayChannelName } = await getChannelInfo(cmdResult.targetChannelId);
                messageQueue.add({
                  id: relayId,
                  content: cmdResult.relayContent,
                  userId: user.id,
                  channelId: cmdResult.targetChannelId,
                  parentChannelId: relayParent,
                  source: 'game',
                  createdAt: relayTs,
                }).catch((err: unknown) => logger.warn({ err }, 'Relay message queue failed'));
                if (cmdResult.relayToDiscord) {
                  relayToDiscord(cmdResult.targetChannelId, displayName, cmdResult.relayContent, relayChannelName ?? undefined, undefined, undefined, relayId).catch((err) => {
                    logger.warn({ err }, 'Discord relay for command failed (non-fatal)');
                  });
                }
              }
            } else if (cmdResult.actionType === 'private') {
              sendBotMsg(ws, cmdResult.botMessage, cmdResult.targetChannelId, true, cmdResult.metadata);
            } else if (cmdResult.actionType === 'report') {
              const reportId = uuidv4();
              try {
                await prisma.playerReport.create({
                  data: { id: reportId, userId: user.id, content: cmdResult.reportContent, reportType: cmdResult.reportType },
                });
              } catch (err) {
                logger.error({ err }, 'Failed to create player report');
              }
              const ackMsg = cmdResult.reportType === 'bug'
                ? '✓ Bug report submitted. Thank you — the team will investigate.'
                : '✓ Player report submitted. The moderation team has been notified.';
              sendBotMsg(ws, ackMsg, cmdResult.targetChannelId, true);
              broadcastToAdmins({
                type: 'report:new',
                payload: {
                  id: reportId,
                  reportType: cmdResult.reportType,
                  content: cmdResult.reportContent,
                  username: displayName,
                  userId: user.id,
                  createdAt: new Date().toISOString(),
                },
              });
            } else if ((cmdResult as any).actionType === 'server-broadcast') {
              const r = cmdResult as any;
              const sessionId: string | null = null;
              if (sessionId) {
                await broadcastToSession({
                  type: 'chat:message',
                  payload: {
                    id: uuidv4(),
                    content: r.botMessage,
                    username: '[Vault-Tec]',
                    userId: 'system',
                    channelId: r.targetChannelId,
                    source: 'bot',
                    timestamp: new Date().toISOString(),
                  },
                }, sessionId, null);
              }
            }
            if ('privateNotice' in cmdResult && cmdResult.privateNotice) {
              sendBotMsg(ws, cmdResult.privateNotice, cmdResult.targetChannelId, true);
            }
            logger.info({
              trigger: content.trim().split(/\s+/)[0],
              actionType: cmdResult.actionType,
              targetChannelId: (cmdResult as any).targetChannelId,
              userId: user.id,
            }, '[chat-trace] slash command processed end');
            ws.send(JSON.stringify({ type: 'message:ack', payload: { messageId: uuidv4(), rateRemaining: 0 } }));
            break;
          }
        }
        // ── End slash command interception ────────────────────────────────

        // Pass-through message metadata (e.g. wiki_share cards). Capped for safety;
        // rendered as plain text nodes client-side (no HTML injection).
        let wsMetadata: Record<string, unknown> | null = (frame.payload as any)?.metadata ?? null;
        try { if (wsMetadata && JSON.stringify(wsMetadata).length > 2000) wsMetadata = null; } catch { wsMetadata = null; }

        // Query remaining rate tokens for the sender's ack
        let rateRemaining = 0;
        try {
          const redis = await getRedisClient();
          const key = `ws_rate:${user.id}`;
          const count = await redis.zCard(key);
          rateRemaining = Math.max(0, 2 - count);
        } catch { /* non-fatal */ }

        // Shared durable persist + broadcast + Discord relay (same path the HUD
        // ingestMessage uses — keeps the wire/persist/relay format in one place).
        // WS-specific extras (avatarUrl, metadata, @mentions, source 'game') are
        // passed through so the WS payload is unchanged.
        const { messageId } = await finalizeMessage({
          userId: user.id,
          channelId,
          content: content.trim(),
          displayName,
          source: 'game',
          avatarUrl: buildAvatarUrl(user.discordId),
          metadata: wsMetadata,
          mentions: inMentions2,
        });

        // Send ack with rate info back to sender
        ws.send(JSON.stringify({ type: 'message:ack', payload: { messageId, rateRemaining } }));
        break;
      }

      case 'chat:typing': {
        // Ephemeral typing indicator — never persisted. In-game typing is not
        // sent back to Discord; Discord-originated typing enters via the
        // discordService typingStart listener and uses this same frame shape.
        // Throttle: clients should send at most once every 2s; we enforce a
        // per-user server-side cooldown so a spammy client can't flood peers.
        const typingClient = clients.get(token);
        if (!typingClient) break;
        const { channelId: typingChannelId, partyId: typingPartyId } = frame.payload || {};
        // Channel typing: validate channelId before broadcast.
        // Accept UUIDs (standard channels) and server:<id> virtual channels.
        if (typingChannelId && typeof typingChannelId === 'string'
            && UUID_RE.test(typingChannelId)) {
          const typingPayload = {
            type: 'chat:typing',
            payload: {
              channelId: typingChannelId,
              username: typingClient.displayName || typingClient.username,
              userId: typingClient.userId,
            },
          };
          // Broadcast to all OTHER clients (not back to the sender).
          localBroadcast(typingPayload, ws);
        }
        // Party typing: broadcast only to party members.
        if (typingPartyId && typeof typingPartyId === 'string' && UUID_RE.test(typingPartyId)) {
          try {
            const { PARTIES_ENABLED } = await import('../config/features.js');
            if (PARTIES_ENABLED) {
              const ptMembers = await prisma.partyMember.findMany({
                where: { partyId: typingPartyId, leftAt: null },
                select: { userId: true },
              });
              const ptMemberIds = ptMembers.map(m => m.userId);
              if (ptMemberIds.includes(typingClient.userId)) {
                const ptPayload = {
                  type: 'chat:typing',
                  payload: {
                    partyId: typingPartyId,
                    username: typingClient.displayName || typingClient.username,
                    userId: typingClient.userId,
                  },
                };
                broadcastToPartyMembers(ptPayload, ptMemberIds, ws).catch(() => { /* non-fatal */ });
              }
            }
          } catch { /* non-fatal — typing is ephemeral */ }
        }
        break;
      }

      case 'chat:history': {
        const { channelId, limit = 300, offset = 0 } = frame.payload || {};
        if (!channelId || !UUID_RE.test(channelId)) break;
        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 300, 1), 300);
        const safeOffset = Math.min(Math.max(parseInt(offset, 10) || 0, 0), 10000);
        try {
          const result = await dbQuery(
            `SELECT m.id, m.content, u.username, u.chat_name, u.discord_id_link AS discord_id, u.discord_username, u.discord_display_name, u.install_token, m.user_id, m.channel_id, m.source, m.metadata, m.created_at, m.edited_at
             FROM messages m JOIN users u ON u.id = m.user_id
             WHERE m.channel_id = $1 AND NOT m.is_deleted
             ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`,
            [channelId, safeLimit, safeOffset]
          );
          // Block enforcement: drop rows authored by anyone the requester has blocked.
          let histBlocked = new Set<string>();
          try {
            const { getBlockedIds } = require('../services/blockService') as typeof import('../services/blockService');
            histBlocked = await getBlockedIds(user.id);
          } catch { /* non-fatal — no filtering */ }
          // Compute displayName for each historical message and strip install_token.
          // metadata is passed through (null for normal messages) so the overlay
          // can render party_invite embeds from history.
          const messages = result.rows
            .filter((row: any) => !histBlocked.has(row.user_id))
            .map((row: any) => {
              const dn = resolveDisplayName({ username: row.username, chatName: row.chat_name, discordUsername: row.discord_username, discordDisplayName: row.discord_display_name, installToken: row.install_token });
              const avatarUrl = buildAvatarUrl(row.discord_id);
              const { install_token, username, chat_name, discord_username, discord_display_name, discord_id, metadata, ...rest } = row;
              return { ...rest, username: dn, avatarUrl, metadata: metadata ?? null };
            });
          await attachCosmeticsToHistory(messages);
          ws.send(JSON.stringify({ type: 'chat:history', payload: { messages: messages.reverse() } }));
        } catch (err) {
          logger.error({ err }, 'Failed to load history');
        }
        break;
      }

      case 'client:status': {
        // Clients report display mode (e.g. exclusive fullscreen detection)
        // and in-game state (FO76 process running → online for presence).
        const { fullscreen, inGame } = frame.payload || {};
        if (typeof fullscreen === 'boolean') {
          setFullscreenStatus(user.id, fullscreen);
        }
        if (typeof inGame === 'boolean') {
          // Propagate to all open client entries for this user (multi-tab / multi-window).
          for (const c of clients.values()) {
            if (c.userId === user.id && c.ws.readyState === WebSocket.OPEN) {
              c.inGame = inGame;
            }
          }
        }
        break;
      }




      // ── Party chat frames ──────────────────────────────────────────────────

      case 'party:send': {
        const { PARTIES_ENABLED } = await import('../config/features.js');
        if (!PARTIES_ENABLED) { sendWsError(ws, 'Party feature is disabled.'); break; }

        const { partyId: psSendPartyId, content: psRawContent, clientCreatedAt: psClientTs } = frame.payload || {};
        if (!psSendPartyId || !UUID_RE.test(psSendPartyId)) {
          sendWsError(ws, 'Invalid partyId.'); break;
        }

        // Mute check (re-use same pattern as chat:send)
        const psClient = clients.get(token);
        let psMuteDetail: { until: string | null; reason: string | null; category: string | null } | null = null;
        if (psClient?.isMuted) {
          const psDbUser = await prisma.user.findUnique({
            where: { id: user.id },
            select: { isMuted: true, muteExpiresAt: true, muteReason: true, muteCategory: true },
          });
          if (psDbUser) {
            if (psDbUser.isMuted && psDbUser.muteExpiresAt && new Date(psDbUser.muteExpiresAt) < new Date()) {
              await prisma.user.update({ where: { id: user.id }, data: { isMuted: false, muteExpiresAt: null, muteReason: null, muteCategory: null, mutedById: null } });
              if (psClient) psClient.isMuted = false;
            } else if (!psDbUser.isMuted) {
              if (psClient) psClient.isMuted = false;
            } else {
              psMuteDetail = { until: psDbUser.muteExpiresAt ? new Date(psDbUser.muteExpiresAt).toISOString() : null, reason: psDbUser.muteReason ?? null, category: psDbUser.muteCategory ?? null };
            }
          }
        }
        if (psClient?.isMuted) {
          ws.send(JSON.stringify({ type: 'user:muted', payload: psMuteDetail ?? { until: null, reason: null, category: null } }));
          sendWsError(ws, 'You are muted.'); break;
        }

        // WS rate limit
        const psRateLimited = await checkWsRateLimit(user.id);
        if (psRateLimited) {
          ws.send(JSON.stringify({ type: 'rate:status', payload: { remaining: 0, retryAfterMs: 1000 } }));
          sendWsError(ws, 'Rate limit exceeded. Slow down.'); break;
        }

        let psContent = psRawContent;
        if (!psContent || typeof psContent !== 'string' || psContent.trim().length === 0) {
          sendWsError(ws, 'Invalid message content.'); break;
        }
        if (psContent.length > 500) { sendWsError(ws, 'Message too long (max 500 chars).'); break; }
        psContent = emojifyShortcodes(psContent);

        if (psClientTs) {
          const psClientTime = new Date(psClientTs).getTime();
          if (isNaN(psClientTime) || Math.abs(Date.now() - psClientTime) > CLIENT_TIMESTAMP_SKEW_MS) {
            sendWsError(ws, 'Message timestamp out of range.'); break;
          }
        }

        // Membership check
        const psMembership = await prisma.partyMember.findFirst({
          where: { partyId: psSendPartyId, userId: user.id },
        });
        if (!psMembership) { sendWsError(ws, 'You are not a member of this party.'); break; }

        // Automod
        const psEngineResult = await engineEvaluate(psContent, psSendPartyId, user);
        if (psEngineResult.block) {
          sendWsError(ws, psEngineResult.customMessage || 'Message blocked by content filter.'); break;
        }

        // Slash command check
        if (psContent.trim().startsWith('/')) {
          const psCmdResult = await tryHandleCommand(
            psContent.trim(), user.id, displayName, psSendPartyId, 'Party', null, getClientCount(), null,
          );
          if (psCmdResult.handled) {
            // Only handle private bot responses in party context
            if (psCmdResult.actionType === 'message' || psCmdResult.actionType === 'private') {
              sendBotMsg(ws, psCmdResult.botMessage, psSendPartyId, true);
            }
            ws.send(JSON.stringify({ type: 'message:ack', payload: { messageId: uuidv4(), rateRemaining: 0 } }));
            break;
          }
        }

        const psMessageId = uuidv4();
        const psCreatedAt = new Date().toISOString();

        // Persist PartyMessage directly (fire-and-forget, like serverMessage in server channel)
        prisma.partyMessage.create({
          data: {
            id: psMessageId,
            partyId: psSendPartyId,
            userId: user.id,
            username: displayName,
            content: psContent.trim(),
            source: 'party',
            createdAt: new Date(psCreatedAt),
          },
        }).catch((err: unknown) => logger.warn({ err, messageId: psMessageId }, '[party:send] persist failed (non-fatal)'));

        // Bump Party.lastMessageAt and recentMsgCount (fire-and-forget)
        prisma.party.update({
          where: { id: psSendPartyId },
          data: { lastMessageAt: new Date(), recentMsgCount: { increment: 1 } },
        }).catch((err: unknown) => logger.warn({ err, partyId: psSendPartyId }, '[party:send] party stats bump failed (non-fatal)'));

        // Get party member IDs for broadcast
        const psAllMembers = await prisma.partyMember.findMany({
          where: { partyId: psSendPartyId },
          select: { userId: true },
        });
        const psMemberIds = psAllMembers.map((m: { userId: string }) => m.userId);

        const psBroadcastPayload = {
          type: 'chat:message',
          payload: {
            id: psMessageId,
            channelId: psSendPartyId,
            content: psContent.trim(),
            username: displayName,
            userId: user.id,
            source: 'party',
            createdAt: psCreatedAt,
            avatarUrl: buildAvatarUrl(user.discordId),
          },
        };

        broadcastToPartyMembers(psBroadcastPayload, psMemberIds).catch(
          (err: unknown) => logger.warn({ err }, '[party:send] broadcast failed (non-fatal)'),
        );

        // Privileged mod-observer fan-out: send to connected privileged clients
        // who are NOT party members. Uses the role stored on ClientEntry at
        // connect-time — no async DB call here. Never mutates psMemberIds.
        try {
          const { isPrivilegedRole } = require('../services/userRoleService') as { isPrivilegedRole: (r: string) => boolean };
          const psMemberSet = new Set(psMemberIds);
          // _modObserver lives INSIDE payload for contract consistency.
          const psObserverPayload = { ...psBroadcastPayload, payload: { ...psBroadcastPayload.payload, _modObserver: true } };
          const psObserverData = JSON.stringify(psObserverPayload);
          for (const [, obsClient] of clients) {
            if (!isPrivilegedRole(obsClient.role)) continue;
            if (psMemberSet.has(obsClient.userId)) continue; // member path wins
            // safeSend applies the same readyState + backpressure guard as every
            // other broadcast path (skips clients whose buffer exceeds the cap).
            safeSend(obsClient.ws, psObserverData, `party:send:observer:${obsClient.userId}`);
          }
        } catch (err) {
          logger.warn({ err }, '[party:send] mod-observer fan-out failed (non-fatal)');
        }

        incrementMessageCount();
        ws.send(JSON.stringify({ type: 'message:ack', payload: { messageId: psMessageId, rateRemaining: 0 } }));
        break;
      }

      case 'party:history': {
        const { PARTIES_ENABLED: phEnabled } = await import('../config/features.js');
        if (!phEnabled) { ws.send(JSON.stringify({ type: 'chat:history', payload: { channelId: null, messages: [] } })); break; }

        const { partyId: phPartyId, limit: phLimit = 300, offset: phOffset = 0 } = frame.payload || {};
        if (!phPartyId || !UUID_RE.test(phPartyId)) {
          ws.send(JSON.stringify({ type: 'chat:history', payload: { channelId: phPartyId ?? null, messages: [] } })); break;
        }

        // Membership check
        const phMembership = await prisma.partyMember.findFirst({
          where: { partyId: phPartyId, userId: user.id },
        });
        if (!phMembership) {
          ws.send(JSON.stringify({ type: 'chat:history', payload: { channelId: phPartyId, messages: [] } })); break;
        }

        try {
          const phSafeLimit = Math.min(Math.max(parseInt(phLimit, 10) || 300, 1), 300);
          const phSafeOffset = Math.min(Math.max(parseInt(phOffset, 10) || 0, 0), 10000);

          const phRows = await prisma.partyMessage.findMany({
            where: { partyId: phPartyId, isDeleted: false },
            orderBy: { createdAt: 'desc' },
            take: phSafeLimit,
            skip: phSafeOffset,
            select: {
              id: true, content: true, username: true, userId: true,
              partyId: true, source: true, createdAt: true,
              user: { select: { username: true, chatName: true, discordId: true, discordUsername: true, discordDisplayName: true, installToken: true } },
            },
          });

          // Block enforcement: drop party messages authored by anyone the requester blocked.
          let partyBlocked = new Set<string>();
          try {
            const { getBlockedIds } = require('../services/blockService') as typeof import('../services/blockService');
            partyBlocked = await getBlockedIds(user.id);
          } catch { /* non-fatal */ }
          // Per-message fields use snake_case to match the existing channel/server
          // chat:history shape the frontend normalizes (m.user_id / m.channel_id /
          // m.created_at — see ChatOverlay.tsx chat:history handler). Emitting
          // camelCase here would leave channelId undefined client-side and the
          // party history would never render under its tab.
          const phMessages = phRows.reverse()
            .filter((r: any) => !(r.userId && partyBlocked.has(r.userId)))
            .map((r: any) => ({
              id: r.id,
              content: r.content,
              username: r.user ? resolveDisplayName(r.user) : r.username,
              user_id: r.userId,
              channel_id: phPartyId,
              source: 'party' as const,
              created_at: r.createdAt.toISOString(),
              edited_at: r.editedAt?.toISOString() ?? null,
              avatarUrl: buildAvatarUrl(r.user?.discordId ?? null),
            }));

          await attachCosmeticsToHistory(phMessages);

          ws.send(JSON.stringify({ type: 'chat:history', payload: { channelId: phPartyId, messages: phMessages } }));
        } catch (err) {
          logger.error({ err, partyId: phPartyId }, '[party:history] failed to load party history');
          ws.send(JSON.stringify({ type: 'chat:history', payload: { channelId: phPartyId, messages: [] } }));
        }
        break;
      }

      default:
        // Unknown type -- silently ignore per spec
        break;
    }
    } catch (err) {
      logger.error({ err, userId: user.id }, 'Unhandled error in WS message handler');
      try { sendWsError(ws, 'Internal server error.'); } catch {}
    }
  });

  // The real message handler is now attached: stop early-buffering and replay any
  // frames captured during the async connect-time setup above (see earlyFrameBuffer).
  ws.removeListener('message', earlyFrameBuffer);
  for (const raw of earlyFrames.splice(0)) ws.emit('message', raw);

  // 30-second heartbeat monitor (secondary guard — the primary is the global
  // ping/pong sweep in server.ts which handles all OPEN sockets uniformly).
  // Registered after clients.set() so the client entry always exists when the
  // interval fires. The ws.on('close') handler also clears this interval, so
  // cleanup is robust against both normal and error-path disconnects.
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      clearInterval(heartbeat);
      // Only evict if WE are still the current socket for this token. A newer
      // socket may have replaced us in the map (same session token reconnect) —
      // deleting by token blindly would evict the LIVE socket. See the close
      // handler's supersession guard for the full rationale.
      if (!isSocketSuperseded(clients.get(token)?.ws, ws)) clients.delete(token);
    }
  }, 30_000);
  // Register an error handler that guarantees the interval is cleared if the
  // socket errors before ws.on('close') fires.
  ws.once('error', () => { clearInterval(heartbeat); });

  ws.on('close', () => {
    clearInterval(heartbeat);
    // ── Supersession guard (token-keyed clients map) ───────────────────────────
    // The clients map is keyed by SESSION TOKEN, and the overlay reconnects with
    // the SAME token across WS flaps (the desktop relay proxy reuses sessionToken
    // until a re-register). So a fresh socket calls clients.set(token, NEW) while
    // an old socket for the same token is still settling. If this (now-stale)
    // socket's close ran the normal teardown, its unconditional clients.delete(token)
    // would EVICT THE LIVE SOCKET from the map — after which no broadcasts/presence
    // reach the user (chat goes blank, "messages stop popping up") until the next
    // reconnect. Root cause of the in-game blank-chat-after-flap reports.
    //
    // Fix: if the map no longer points at THIS ws, we've been superseded by a newer
    // socket. Tear down quietly — do NOT delete the (newer) entry, do NOT fire
    // room:leave / schedule a peer-leave (the user is still connected via the new
    // socket). The per-IP connection counter is decremented by server.ts's own
    // independent ws.on('close'), so we don't need to touch it here.
    const currentEntry = clients.get(token);
    if (isSocketSuperseded(currentEntry?.ws, ws)) {
      logger.info({ userId: user.id }, '[ws-close] superseded by newer socket for same token — quiet teardown (no leave, map preserved)');
      return;
    }
    const closingEntry = currentEntry;
    const closingEndpoint: string | null = null;
    const wasForceDisconnected = !!(closingEntry as any)?._forceDisconnected;
    clients.delete(token);
    removeFullscreenClient(user.id);
    // Suppress spurious room:leave after a moderation kick/ban — the force-
    // disconnect already handled the notification; we don't want a second leave.
    if (!wasForceDisconnected) {
      broadcast({ type: 'room:leave', payload: { username: displayName, timestamp: new Date().toISOString() } });
    }

    // v1.1.37 (Fix #2): consolidated WS-flap grace.  Defer BOTH the peer-leave
    // broadcast AND clearJoinDedupKeys behind WS_FLAP_GRACE_MS via the shared
    // pendingDisconnect map.  A reconnect within the window cancels both.
    // The previous design only deferred the leave broadcast and cleared welcome
    // keys immediately on close, which caused the next reconnect to re-fire
    // welcome+peer-join even when the user effectively never left (live trace
    // 2026-05-01 18:18:37 → 18:20:08).
    const fireDeferred = (_ep: string | null) => {
      // World-detection removed — no peer-leave announce needed.
    };

    const scheduleDeferred = (ep: string | null) => {
      // Replace any prior pending entry (rare: shouldn't happen — handoff
      // cancels on connect — but be safe).
      const prior = pendingDisconnect.get(user.id);
      if (prior) clearTimeout(prior.timer);

      const timer = setTimeout(async () => {
        // Re-check at fire time: if a fresh client for this user is on the
        // same endpoint, suppress (belt-and-suspenders for race conditions
        // where the connect-side handoff hasn't yet observed pendingDisconnect).
        let stillGone = true;
        for (const c of clients.values()) {
          if (c.userId === user.id) { stillGone = false; break; }
        }
        pendingDisconnect.delete(user.id);
        if (!stillGone) {
          notePendingDisconnectSuppressed(user.id);
          logger.info({ userId: user.id, ep }, '[ws-flap] reconnected before timer fired — suppressing');
          return;
        }
        noteUserDisconnected(user.id);
        fireDeferred(ep);
      }, WS_FLAP_GRACE_MS);

      pendingDisconnect.set(user.id, {
        endpoint: ep,
        timer,
        fire: () => fireDeferred(ep),
      });
    };

    // Flush presence, then decide from the AUTHORITATIVE socket registry whether
    // this was the user's last live socket. The closing token was already removed
    // from `clients` above (line ~2439), so isUserWsConnected() is false iff no
    // other OPEN socket remains. (Previously this relied on a refcount return
    // value from noteUserPendingDisconnect, which could drift; see
    // onlinePresenceService for why the refcount was removed.)
    noteUserPendingDisconnect(user.id);
    const enteredPresenceGrace = !isUserWsConnected(user.id);
    if (enteredPresenceGrace) {
      scheduleDeferred(closingEndpoint);
    }
    // Do NOT null serverEndpoint/alternateEndpoints/serverJoinedAt on close.
    // Backend deploys drop every WS in flight; clearing on each close caused
    // state loss across deploys (serverEndpoint nulled → reconnect's :3000
    // report preserved null → user stuck, no welcome, no sub-tab until the
    // next /api/channels-triggered resolveEffectiveEndpoint writeback).
    // Staleness is handled elsewhere via `serverSeenAt > 15min ago` filters.
    // If we ever need a hard eviction, add a delayed reconciler keyed on a
    // missed-reconnect timer, not a direct close-time clear.

    // v1.1.37 (Fix #2): clearJoinDedupKeys is now invoked from inside the
    // pendingDisconnect timer's fire() callback ONLY if the leave actually
    // fires (no reconnect within WS_FLAP_GRACE_MS).  Calling it
    // unconditionally on close — as the previous design did — meant a quick
    // reconnect found welcome dedup keys already gone and re-fired welcome.
    logger.info({ userId: user.id, closingEndpoint }, 'WS client disconnected');
  });

  ws.on('error', (err) => {
    clearInterval(heartbeat);
    logger.error({ err, userId: user.id }, 'WS client error');
    // Same supersession guard as the close handler — never evict a newer socket
    // for this token, and don't drop its fullscreen registration.
    if (!isSocketSuperseded(clients.get(token)?.ws, ws)) {
      clients.delete(token);
      removeFullscreenClient(user.id);
      noteUserDisconnected(user.id);
    }
  });
}



export { handleConnection, broadcast, broadcastMessageDeletion, broadcastReportAlert, broadcastChannelUpdate, getClientCount, initPubSub, disconnectByUserId, markClientMuted, notifyAndDisconnect };
// The manual module.exports assignment OVERWRITES the ESM exports that
// tsc compiles to `exports.X = ...` above — so every name needed for
// CJS require() interop MUST be listed here. Missed names produce
// `(0 , handlers_1.X) is not a function` at runtime. Keep this list in
// sync with every `export function` / `export const` declared above.
module.exports = {
  handleConnection, broadcast,
  broadcastMessageDeletion, broadcastReportAlert, broadcastChannelUpdate,
  broadcastCommandsUpdate, getClientCount, initPubSub,
  disconnectByUserId, markClientMuted, notifyAndDisconnect,
  snapshotActiveClients, refreshClientIdentity, refreshClientCosmetics,
  pushToUser, getConnectedUserIds, refreshClientBlocks,
  updateClientEndpoint,
  broadcastToSession,
  broadcastToUsers,
  resolveDisplayName,
  decideFlapHandoff,
  WS_FLAP_GRACE_MS_EXPORT,
  isUserWsConnected,
  isPendingDisconnect,
  isUserAutoAttachBlocked,
  broadcastToPartyMembers,
  getOnlinePartyCounts,
  isUserInGame,
};
