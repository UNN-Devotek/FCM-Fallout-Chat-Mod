/**
 * ingestMessage.ts — shared message ingestion for WS, MCP, and native relay.
 *
 * Runs the canonical governance pipeline in order:
 *   1. Mute check (users table isMuted)
 *   2. Redis rate-limit (shared ws_rate:<userId> sliding-window bucket)
 *   3. Content validation (≤500 chars, non-empty, valid UUID channelId)
 *   4. Emoji shortcode expansion
 *   5. Channel validity check
 *   6. Automod engine (word-filter + spam + automod_rules)
 *   7. Durable persist (messageQueue worker → messageService fallback)
 *   8. broadcast() → WS and native relay fan-out
 *   9. Discord relay
 *
 * Source tag is 'relay', 'mcp', or 'ws' — forwarded to the persisted Message row for
 * telemetry/abuse-tracing only; it does NOT skip any governance step.
 *
 * Slash commands from the native chat.v1 relay adapter:
 * OUT OF SCOPE for v1. SEND lines starting with '/' are dropped before governance
 * runs. The ordinary WS/web source remains available for the server-side command
 * handler in handlers.ts.
 *
 * The WS handler (handlers.ts) continues to own WS-specific concerns:
 *   - Ack frames (message:ack, rate:status, user:muted)
 *   - clientCreatedAt timestamp validation
 *   - server: virtual channel routing
 *   - slash-command interception (full command surface)
 *   - worldSession broadcast routing (broadcastToSession / broadcastToEndpoint)
 *   - metadata pass-through (wiki_share cards)
 *   - peerCount / auto-heal
 * Those remain inline in handlers.ts; this module handles the shared core only.
 */

import { v4 as uuidv4 } from 'uuid';
import { getRedisClient } from '../config/redis';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { engineEvaluate } from './autoModEngine';
import { relayToDiscord, type RelayAuthorCosmetics } from './discordService';
import { persistMessage } from './messageService';
import messageQueue from '../queues/messagePersist';
import { emojifyShortcodes } from '../utils/emoji';
import { broadcast } from '../websocket/handlers';
import { tryNextRelaySeq } from './relay/relaySeq';
import { incrementMessageCount } from '../controllers/healthController';
import { attachCosmetics } from './cosmetics/cosmeticsService';
import { shadowMute } from './autoModService';
import { shouldWaitForPersistence } from './messagePersistencePolicy';
import { projectionForSharedEvent } from './discordEventService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Short-lived channel validity + name cache (mirrors handlers.ts, 60 s TTL)
const channelValidCache = new Map<string, { valid: boolean; cachedAt: number }>();
const channelNameCache  = new Map<string, { name: string; parentId: string | null; cachedAt: number }>();
const CACHE_TTL_MS = 60_000;

/** Flush internal channel caches. Used in unit tests to prevent cross-test cache leakage. */
export function _clearIngestCaches(): void {
  channelValidCache.clear();
  channelNameCache.clear();
}

async function isChannelValid(channelId: string): Promise<boolean> {
  const cached = channelValidCache.get(channelId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.valid;
  const ch = await prisma.channel.findFirst({ where: { id: channelId, isArchived: false }, select: { id: true } });
  const valid = !!ch;
  channelValidCache.set(channelId, { valid, cachedAt: Date.now() });
  return valid;
}

async function getChannelInfo(channelId: string): Promise<{ name: string; parentId: string | null }> {
  const cached = channelNameCache.get(channelId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return { name: cached.name, parentId: cached.parentId };
  try {
    const ch = await prisma.channel.findFirst({ where: { id: channelId }, select: { name: true, parentId: true } });
    const info = { name: ch?.name ?? 'chat', parentId: ch?.parentId ?? null };
    channelNameCache.set(channelId, { ...info, cachedAt: Date.now() });
    return info;
  } catch { return { name: 'chat', parentId: null }; }
}

async function checkRateLimit(userId: string, source: IngestSource): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    const key   = `ws_rate:${userId}`;
    const now   = Date.now();
    const multi = redis.multi();
    multi.zRemRangeByScore(key, '-inf', now - 1000);
    multi.zAdd(key, { score: now, value: String(now) });
    multi.zCard(key);
    multi.expire(key, 5);
    const results = await multi.exec() as any[];
    return (results[2] as number) > 5; // true = exceeded
  } catch (err) {
    // SR-004: fail OPEN for the authenticated WS path (availability for known
    // users), but fail CLOSED for the relay transport, where a Redis outage
    // must not remove flood control.
    // Returning true here marks the message as rate-limited.
    const failClosed = source === 'relay';
    logger.warn({ err, source, failClosed }, `[ingestMessage] rate-limit Redis error — ${failClosed ? `fail-closed (${source})` : 'fail-open (ws/mcp)'}`);
    return failClosed;
  }
}

// ── Result type ───────────────────────────────────────────────────────────────

export type IngestSource = 'ws' | 'mcp' | 'relay';

export interface IngestResult {
  ok: boolean;
  reason?: 'muted' | 'rate-limited' | 'invalid-content' | 'invalid-channel' | 'channel-not-found' | 'automod' | 'slash-command-dropped';
  messageId?: string;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Ingest a message from a user through the full governance pipeline.
 *
 * @param userId      - Resolved authenticated user ID.
 * @param channelId   - UUID of the target channel.
 * @param rawContent  - Raw text from the client (before emoji expansion).
 * @param source      - 'relay' for in-game transport, or 'ws'/'mcp' for
 *                      ordinary server-side clients.
 * @param relaySeq    - (relay ONLY) pre-computed monotonic cursor from nextRelaySeq().
 *                      Threaded through to finalizeMessage so the persisted row carries
 *                      relay_seq and the single broadcast carries relaySeq. When an
 *                      ordinary producer does not supply one, finalizeMessage makes a
 *                      best-effort allocation; chat remains available if Redis is down.
 */
export async function ingestMessage(opts: {
  userId: string;
  channelId: string;
  rawContent: string;
  source: IngestSource;
  relaySeq?: number;
  waitForPersistence?: boolean;
  // Explicit display-name override. The relay path passes the in-game CHARACTER name
  // (identity.fo76Name, e.g. "Wanderer") so chat shows that, not the linked FCM account's
  // Discord name (the message is still attributed to the linked user UUID for moderation).
  displayName?: string;
}): Promise<IngestResult> {
  const { userId, channelId, source, relaySeq } = opts;
  let rawContent = opts.rawContent;

  // The chat.v1 relay adapter represents in-game HUD sends. It does not
  // implement the web command surface, so a slash line
  // must never fall through as ordinary chat. Keep WS/MCP unchanged: the web WS
  // handler owns its supported slash-command interception.
  if (source === 'relay' && rawContent.trim().startsWith('/')) {
    logger.info({ userId, source }, '[ingestMessage] dropping HUD slash command (not supported on HUD transport)');
    return { ok: false, reason: 'slash-command-dropped' };
  }

  // ── 1. Mute check ─────────────────────────────────────────────────────────
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { isMuted: true, muteExpiresAt: true, username: true, chatName: true, discordUsername: true, discordDisplayName: true },
  });

  if (!dbUser) {
    return { ok: false, reason: 'muted' }; // shouldn't happen but fail closed
  }

  // Auto-lift expired mutes.
  let isMuted = dbUser.isMuted;
  if (isMuted && dbUser.muteExpiresAt && new Date(dbUser.muteExpiresAt) < new Date()) {
    await prisma.user.update({
      where: { id: userId },
      data: { isMuted: false, muteExpiresAt: null, muteReason: null, muteCategory: null, mutedById: null },
    });
    isMuted = false;
  }

  if (isMuted) {
    return { ok: false, reason: 'muted' };
  }

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const exceeded = await checkRateLimit(userId, source);
  if (exceeded) {
    return { ok: false, reason: 'rate-limited' };
  }

  // ── 3. Content validation ─────────────────────────────────────────────────
  if (!rawContent || typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return { ok: false, reason: 'invalid-content' };
  }
  if (rawContent.length > 500) {
    return { ok: false, reason: 'invalid-content' };
  }
  if (!channelId || !UUID_RE.test(channelId)) {
    return { ok: false, reason: 'invalid-channel' };
  }

  // ── 4. Emoji expansion ────────────────────────────────────────────────────
  let content = emojifyShortcodes(rawContent);

  // ── 5. Channel validity ───────────────────────────────────────────────────
  if (!(await isChannelValid(channelId))) {
    return { ok: false, reason: 'channel-not-found' };
  }

  // ── 6. Automod ────────────────────────────────────────────────────────────
  const engineResult = await engineEvaluate(content, channelId, { id: userId, username: dbUser.username } as any);
  if (engineResult.block) {
    if (engineResult.customMessage?.includes('Spam')) {
      await shadowMute(userId);
    }
    logger.info({ userId, reason: engineResult.customMessage }, '[ingestMessage] automod blocked');
    return { ok: false, reason: 'automod' };
  }

  // ── 7-9. Broadcast + persist + Discord relay (shared with the WS path) ─────
  // Native relay passes the in-game display name explicitly. WS and MCP
  // messages use the account's usual display name.
  const displayName =
    dbUser.chatName
      ? dbUser.chatName
      : (opts.displayName && opts.displayName.trim())
      ? opts.displayName.trim()
      : (dbUser.discordDisplayName ?? dbUser.discordUsername ?? dbUser.username);
  const { messageId } = await finalizeMessage({
    userId,
    channelId,
    content: content.trim(),
    displayName,
    source,
    // A supplied relay cursor is authoritative. For ordinary producers the
    // finalizer makes a best-effort allocation without making chat depend on Redis.
    relaySeq,
    waitForPersistence: opts.waitForPersistence ?? shouldWaitForPersistence(source),
  });

  return { ok: true, messageId };
}

// ── Shared finalize tail ────────────────────────────────────────────────────

/**
 * Persist, broadcast, and relay a fully-governed message.
 *
 * This is the single source of truth for the chat:message wire payload, the
 * persisted Message row, and the Discord relay — called by ingestMessage
 * and the WS chat:send handler (source 'game').
 * Keeping it here prevents the two paths' output formats from drifting.
 *
 * Optional fields are included ONLY when the caller provides them, so the HUD
 * payload stays lean (no avatarUrl/metadata/mentions) while the WS payload keeps
 * its richer shape unchanged. Ordinary producers persist before broadcast/ack;
 * the native relay broadcasts after queue acceptance so its synchronous RPC is
 * not held open by worker completion.
 */
export async function finalizeMessage(opts: {
  userId: string;
  channelId: string;
  content: string;        // already emoji-expanded; caller trims
  displayName: string;
  source: string;         // 'hud' | 'game' | 'ws' | 'relay' | …
  messageId?: string;
  createdAt?: string;
  avatarUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  mentions?: Array<{ name: string; discordId: string }>;
  relaySeq?: number;      // relay path only — monotonic cursor assigned by nextRelaySeq()
  waitForPersistence?: boolean;
  /** The message already exists in Discord (for example an interaction reply). */
  suppressDiscordRelay?: boolean;
}): Promise<{ messageId: string; createdAt: string }> {
  const messageId   = opts.messageId ?? uuidv4();
  const createdAt   = opts.createdAt ?? new Date().toISOString();
  const sharedEvent = await projectionForSharedEvent(opts.content).catch((err) => {
    logger.debug({ err }, '[finalizeMessage] shared Discord event lookup failed (non-fatal)');
    return null;
  });
  const effectiveMetadata = sharedEvent ? { ...sharedEvent } : opts.metadata;
  const hasMetadata = sharedEvent !== null || 'metadata' in opts;
  // Ordinary chat gets a cursor when Redis is healthy so it can flow through
  // the in-game relay. During a Redis incident, omit the optional cursor rather
  // than turning the dashboard/HUD send path into a hard dependency.
  const relaySeq = opts.relaySeq !== undefined
    ? opts.relaySeq
    : await tryNextRelaySeq();

  const payload: Record<string, unknown> = {
    id: messageId,
    content: opts.content,
    username: opts.displayName,
    userId: opts.userId,
    channelId: opts.channelId,
    source: opts.source,
    timestamp: createdAt,
  };
  if (opts.avatarUrl !== undefined) payload.avatarUrl = opts.avatarUrl;
  if (hasMetadata) payload.metadata = effectiveMetadata ?? null;
  if (relaySeq !== undefined) payload.relaySeq = relaySeq;

  // Resolve the author's cosmetics (colour, effect, tag, badges) onto the
  // payload. Redis-cached ~60s and non-throwing, so it costs nothing for the vast
  // majority of users who have no cosmetics row and can never block delivery.
  if (opts.source !== 'bot') await attachCosmetics(payload);

  // Queue acceptance is enough for the relay path: Bull provides retries and
  // backoff, and waiting for a worker to finish would hold the synchronous HUD
  // RPC open. Other producers retain persist-before-broadcast behavior so
  // ordinary web traffic keeps the edit-race protection.
  const { parentId: parentChannelId, name: channelName } = await getChannelInfo(opts.channelId);
  const record: Record<string, unknown> = {
    id: messageId,
    content: opts.content,
    userId: opts.userId,
    channelId: opts.channelId,
    parentChannelId,
    source: opts.source,
    createdAt,
  };
  if (hasMetadata) record.metadata = effectiveMetadata ?? null;
  if (relaySeq !== undefined) record.relaySeq = relaySeq;

  try {
    const persistJob = await messageQueue.add(record as any);
    if (opts.waitForPersistence !== false && typeof persistJob?.finished === 'function') {
      await persistJob.finished();
    }
  } catch (qErr) {
    logger.warn({ err: qErr, messageId }, '[finalizeMessage] queue failed — falling back to direct persist');
    await persistMessage(record as any);
  }

  broadcast({ type: 'chat:message', payload });
  incrementMessageCount();

  // Discord relay — fire-and-forget. Carry the generated source ID so a
  // successful bot send can be linked for later bidirectional edits.
  if (!opts.suppressDiscordRelay) {
    const relayPromise = relayToDiscord(
      opts.channelId,
      opts.displayName,
      opts.content,
      channelName ?? undefined,
      opts.mentions,
      hasMetadata ? (effectiveMetadata ?? undefined) : undefined,
      messageId,
      Array.isArray(payload.badges)
        ? { badges: payload.badges as RelayAuthorCosmetics['badges'] }
        : undefined,
    );
    relayPromise.catch((err) => logger.warn({ err }, '[finalizeMessage] Discord relay failed (non-fatal)'));
  }

  return { messageId, createdAt };
}
