/**
 * ingestMessage.ts — shared message ingestion for both WS and HUD paths.
 *
 * Runs the canonical governance pipeline in order:
 *   1. Mute check (users table isMuted / HUD identity block)
 *   2. Redis rate-limit (shared ws_rate:<userId> sliding-window bucket)
 *   3. Content validation (≤500 chars, non-empty, valid UUID channelId)
 *   4. Emoji shortcode expansion
 *   5. Channel validity check
 *   6. Automod engine (word-filter + spam + automod_rules)
 *   7. broadcast() → WS fan-out + hudPushNotify
 *   8. Write-behind persist (messageQueue → messageService fallback)
 *   9. Discord relay
 *
 * Source tag is 'hud' or 'ws' — forwarded to the persisted Message row for
 * telemetry/abuse-tracing only; it does NOT skip any governance step.
 *
 * Slash commands from HUD: OUT OF SCOPE for v1.  SEND lines starting with '/'
 * are dropped before governance runs.
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
import { relayToDiscord } from './discordService';
import { persistMessage } from './messageService';
import messageQueue from '../queues/messagePersist';
import { emojifyShortcodes } from '../utils/emoji';
import { broadcast } from '../websocket/handlers';
import { incrementMessageCount } from '../controllers/healthController';
import { shadowMute } from './autoModService';
import { getActiveBlock } from './hudIdentityService';

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
    // users), but fail CLOSED for the 'hud' and 'relay' transports — both are
    // lower-trust paths where a Redis outage must not remove flood control.
    // Returning true here marks the message as rate-limited.
    const failClosed = source === 'hud' || source === 'relay';
    logger.warn({ err, source, failClosed }, `[ingestMessage] rate-limit Redis error — ${failClosed ? `fail-closed (${source})` : 'fail-open (ws/mcp)'}`);
    return failClosed;
  }
}

// ── Result type ───────────────────────────────────────────────────────────────

export type IngestSource = 'hud' | 'ws' | 'mcp' | 'relay';

export interface IngestResult {
  ok: boolean;
  reason?: 'muted' | 'rate-limited' | 'invalid-content' | 'invalid-channel' | 'channel-not-found' | 'automod' | 'slash-command-dropped';
  messageId?: string;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Ingest a message from a user through the full governance pipeline.
 *
 * @param userId      - Resolved user ID (from WS auth or HUD identity resolution).
 * @param channelId   - UUID of the target channel.
 * @param rawContent  - Raw text from the client (before emoji expansion).
 * @param source      - 'hud' or 'ws' (telemetry tag only).
 * @param identityHash - (HUD only) identityHash for block lookup; undefined for WS path.
 * @param relaySeq    - (relay ONLY) pre-computed monotonic cursor from nextRelaySeq().
 *                      Threaded through to finalizeMessage so the persisted row carries
 *                      relay_seq and the single broadcast carries relaySeq. Omitted (and
 *                      therefore NULL) for all non-relay sources — their behavior is
 *                      unchanged.
 */
export async function ingestMessage(opts: {
  userId: string;
  channelId: string;
  rawContent: string;
  source: IngestSource;
  identityHash?: string;
  relaySeq?: number;
  // Explicit display-name override. The relay/HUD path passes the in-game CHARACTER name
  // (identity.fo76Name, e.g. "Wanderer") so chat shows that, not the linked FCM account's
  // Discord name (the message is still attributed to the linked user UUID for moderation).
  displayName?: string;
}): Promise<IngestResult> {
  const { userId, channelId, source, identityHash, relaySeq } = opts;
  let rawContent = opts.rawContent;

  // Drop slash commands from HUD — not supported on the HUD transport.
  if (source === 'hud' && rawContent.trim().startsWith('/')) {
    logger.info({ userId }, '[ingestMessage] dropping HUD slash command (not supported on hud transport)');
    return { ok: false, reason: 'slash-command-dropped' };
  }

  // ── 1. Mute check ─────────────────────────────────────────────────────────
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { isMuted: true, muteExpiresAt: true, username: true, discordUsername: true, discordDisplayName: true, fo76AccountName: true, fo76CharacterName: true },
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

  // HUD identity block check (mute at ingest = defense-in-depth).
  if (identityHash) {
    const block = await getActiveBlock(identityHash);
    if (block) {
      // 'ban' should have been caught at HELLO; treat both as muted here.
      return { ok: false, reason: 'muted' };
    }
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

  // HUD send guard: reject sends to container channels (parentId IS NULL).
  // The root "Fallout 76" channel is a grouping container — messages must only
  // be posted to leaf channels (General/Trading/Events/Raids). This guard fires
  // for any source ('hud' or 'ws') so the WS path is also protected.
  if (source === 'hud') {
    const chanInfo = await getChannelInfo(channelId);
    if (chanInfo.parentId === null) {
      logger.info({ userId, channelId }, '[ingestMessage] SEND to container channel rejected (invalid-channel)');
      return { ok: false, reason: 'invalid-channel' };
    }
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
  // HUD messages display the player's FO76 in-game name (which carries exact
  // formatting like a trailing '-'), NOT their Discord handle. The FO76 account
  // name is the social/player name shown in-game; fall back to character name,
  // then the generic chain. WS (dashboard) messages keep the Discord display name.
  const displayName =
    (opts.displayName && opts.displayName.trim())
      ? opts.displayName.trim()
      : source === 'hud'
        ? (dbUser.fo76AccountName || dbUser.fo76CharacterName || dbUser.discordDisplayName || dbUser.discordUsername || dbUser.username)
        : (dbUser.discordDisplayName ?? dbUser.discordUsername ?? dbUser.username);
  const { messageId } = await finalizeMessage({
    userId,
    channelId,
    content: content.trim(),
    displayName,
    source,
    // relaySeq is relay-only — undefined for hud/ws/mcp so finalizeMessage leaves
    // relay_seq NULL and the broadcast payload omits it (unchanged behavior).
    relaySeq,
  });

  return { ok: true, messageId };
}

// ── Shared finalize tail ────────────────────────────────────────────────────

/**
 * Broadcast + write-behind persist + Discord relay for a fully-governed message.
 *
 * This is the single source of truth for the chat:message wire payload, the
 * persisted Message row, and the Discord relay — called by BOTH ingestMessage
 * (HUD path, source 'hud') and the WS chat:send handler (source 'game').
 * Keeping it here prevents the two paths' output formats from drifting.
 *
 * Optional fields are included ONLY when the caller provides them, so the HUD
 * payload stays lean (no avatarUrl/metadata/mentions) while the WS payload keeps
 * its richer shape unchanged. Persist is fire-and-forget (write-behind) so the
 * caller's ack stays on the low-latency hot path.
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
}): Promise<{ messageId: string; createdAt: string }> {
  const messageId   = opts.messageId ?? uuidv4();
  const createdAt   = opts.createdAt ?? new Date().toISOString();
  const hasMetadata = 'metadata' in opts;

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
  if (hasMetadata) payload.metadata = opts.metadata ?? null;
  if (opts.relaySeq !== undefined) payload.relaySeq = opts.relaySeq;

  broadcast({ type: 'chat:message', payload });
  incrementMessageCount();

  // Write-behind persist — fire-and-forget so it never blocks the sender ack.
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
  if (hasMetadata) record.metadata = opts.metadata ?? null;
  if (opts.relaySeq !== undefined) record.relaySeq = opts.relaySeq;

  Promise.resolve(messageQueue.add(record as any)).catch((qErr) => {
    logger.warn({ err: qErr, messageId }, '[finalizeMessage] queue failed — falling back to direct persist');
    persistMessage(record as any).catch((err) => logger.error({ err, messageId }, '[finalizeMessage] direct persist also failed'));
  });

  // Discord relay — fire-and-forget. Pass the mentions/metadata tail only when
  // the caller supplied them (WS path) so the lean HUD call stays 4-arg.
  const relayPromise = (opts.mentions !== undefined || hasMetadata)
    ? relayToDiscord(opts.channelId, opts.displayName, opts.content, channelName ?? undefined, opts.mentions, hasMetadata ? (opts.metadata ?? undefined) : undefined)
    : relayToDiscord(opts.channelId, opts.displayName, opts.content, channelName ?? undefined);
  relayPromise.catch((err) => logger.warn({ err }, '[finalizeMessage] Discord relay failed (non-fatal)'));

  return { messageId, createdAt };
}
