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
 * worldId intercept (#293):
 *   A reserved control message is intercepted BEFORE ingestMessage when the body
 *   matches the signed worldId sentinel. It is consumed, never broadcast or persisted.
 *
 * Dev-only guard: refuses to accept connections when NODE_ENV==='production'
 * (mirrors hudPushTcp.ts pattern). Lifted explicitly at R6 rollout.
 */

import * as crypto from 'crypto';
import type WebSocket from 'ws';
import type http from 'http';
import { getRedisClient, getSubscriberClient } from '../../config/redis';
import prisma from '../../config/prisma';
import logger from '../../config/logger';
import env, { DEV_DEFAULT_RELAY_WORLD_HMAC_SECRET } from '../../config/environment';
import { mintToken, verifyToken, updateDisplayName, markRelayTokenLinked } from './tokenService';
import { slugToChannelId, channelIdToSlug, ALL_SLUGS } from './channelMap';
import { setWorldId, getWorldId } from './worldIdService';
import { nextRelaySeq } from './relaySeq';
import { ingestMessage } from '../ingestMessage';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * NUL-delimited sentinel that the SWF prepends to worldId control messages
 * when it sends on channel 'server'.
 * Wire format: "\x00fcm.world.v1\x00<worldId>|<relayUserId>|<ts>|<hmac>"
 */
const WORLD_ID_SENTINEL_PREFIX  = '\x00fcm.world.v1\x00';
const WORLD_ID_HMAC_WINDOW_S    = 30;    // 30-second replay window (ts is unix SECONDS)
const POLL_HISTORY_LIMIT        = 30;    // initial history window on cursor=0
const REDIS_BROADCAST_CHANNEL   = 'chat:broadcast';

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
      send(sub.ws, { op: 'event', cursor, event });
      pushed++;
    }
  }
  logger.info({ relayUserId, pushed }, '[relayHandler] notifyLinkComplete pushed');
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

function send(ws: WebSocket, payload: object): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch { /* already closed */ }
}

// ── worldId HMAC verification ─────────────────────────────────────────────────

/**
 * Verify a worldId control message sent by the SWF on channel 'server'.
 *
 * Wire format (body):
 *   "\x00fcm.world.v1\x00<worldId>|<relayUserId>|<ts>|<hmac>"
 *
 * Fields (pipe-delimited, after stripping the sentinel prefix):
 *   worldId     — the player's current server WorldId from BSUIDataManager
 *   relayUserId — must match the authenticated socket's userId
 *   ts          — unix SECONDS (decimal string); freshness window ±30 s
 *   hmac        — HMAC-SHA256(RELAY_WORLD_HMAC_SECRET, worldId + relayUserId + ts)
 *                 over the raw concatenation of the three field values, no separators
 *
 * Returns { worldId } on success, null on any failure (wrong prefix, stale ts,
 * mismatched relayUserId, bad HMAC).
 */
function verifyWorldIdHmac(body: string, socketUserId: string): { worldId: string } | null {
  // 1. Sentinel prefix check.
  if (!body.startsWith(WORLD_ID_SENTINEL_PREFIX)) return null;

  const payload = body.slice(WORLD_ID_SENTINEL_PREFIX.length);
  const parts   = payload.split('|');
  if (parts.length !== 4) return null;

  const [worldId, sentUserId, tsStr, hmac] = parts;
  if (!worldId || !sentUserId || !tsStr || !hmac) return null;

  // 2. relayUserId must match the authenticated socket userId.
  if (sentUserId !== socketUserId) return null;

  // 3. Freshness check (ts is unix SECONDS).
  const ts  = Number(tsStr);
  if (!Number.isFinite(ts)) return null;
  const nowS = Date.now() / 1000;
  if (Math.abs(nowS - ts) > WORLD_ID_HMAC_WINDOW_S) return null;

  // 4. HMAC verification.
  const secret = env.RELAY_WORLD_HMAC_SECRET ?? '';
  if (!secret) return null;

  // Warn in production if the secret is still the dev placeholder.
  if (env.NODE_ENV === 'production' && secret === DEV_DEFAULT_RELAY_WORLD_HMAC_SECRET) {
    logger.warn('[relayHandler] RELAY_WORLD_HMAC_SECRET is still the dev placeholder in production — worldId control messages will be rejected');
    return null;
  }

  // HMAC is over raw concatenation of the three field values (no separators).
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${worldId}${sentUserId}${tsStr}`)
    .digest('hex');

  // timingSafeEqual throws on length mismatch — guard against malformed hmac.
  let valid = false;
  try {
    const aHmac = Buffer.from(hmac,     'hex');
    const aExp  = Buffer.from(expected, 'hex');
    valid = aHmac.length === aExp.length && crypto.timingSafeEqual(aHmac, aExp);
  } catch {
    return null;
  }
  return valid ? { worldId } : null;
}

// ── Subscribe registry ────────────────────────────────────────────────────────

interface SubscriberState {
  ws: WebSocket;
  userId: string;
  cursor: number;
  worldId: string | null;
}

// Module-level subscriber set — cleared on disconnect.
const subscribers = new Set<SubscriberState>();

// Redis pub/sub listener — initialised once per process.
let pubSubReady = false;

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
      };

      const frame = JSON.stringify({ op: 'event', cursor: relaySeq, event: eventObj });

      for (const sub of subscribers) {
        if (sub.cursor >= relaySeq) continue; // already seen
        // TODO R7: worldId filter for 'server' channel once worldId is tracked on subscriber
        try { sub.ws.send(frame); } catch { /* already closed */ }
        sub.cursor = relaySeq;
      }
    });
  } catch (err) {
    pubSubReady = false;
    logger.error({ err }, '[relayHandler] Redis pub/sub subscription failed');
  }
}

// ── Op handlers ───────────────────────────────────────────────────────────────

async function handleRegister(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
  const displayName = typeof frame.displayName === 'string' ? frame.displayName.trim() : '';
  if (!displayName) {
    send(ws, errEnvelope('invalid_request', 'displayName is required'));
    return;
  }

  const { userId, token, role } = await mintToken(displayName);
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

  // Check if the linked FCM account is banned.
  // identity.userId is a relay TEXT id — ban state lives on the linked FCM users row.
  const user = identity.linkedUserId
    ? await prisma.user.findUnique({
        where: { id: identity.linkedUserId },
        select: { isBanned: true },
      })
    : null;
  if (user?.isBanned) {
    send(ws, errEnvelope('user_banned', 'This account is banned'));
    return;
  }

  // Update displayName if provided and different.
  const newName = typeof frame.displayName === 'string' ? frame.displayName.trim() : '';
  if (newName && newName !== identity.fo76Name) {
    await updateDisplayName(identity.userId, newName);
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
 *   { success: true, userId, state: 'authenticated'|'limited', permissions: { canReport, canSend } }
 *
 * userId is always populated (the SWF needs it for the worldId HMAC even while limited).
 * state='authenticated' only when linked_user_id is set; otherwise 'limited'.
 * permissions.canSend reflects isLinked (same gate as handleSend).
 * permissions.canReport: false for now (R4 wires this); always false until R4 merges.
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

  const state = identity.isLinked ? 'authenticated' : 'limited';

  send(ws, {
    success: true,
    // identity.userId is relay TEXT ("user_"+hex) — pass through directly.
    userId:  identity.userId,
    state,
    permissions: {
      canSend:   identity.isLinked,
      canReport: false, // R4: wired when report op is fully implemented
    },
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
    select: { isBanned: true, isMuted: true },
  });
  if (user?.isBanned) {
    send(ws, errEnvelope('user_banned', 'This account is banned'));
    return;
  }
  if (user?.isMuted) {
    send(ws, errEnvelope('user_muted', 'You are currently muted'));
    return;
  }

  const slug = typeof frame.channel === 'string' ? frame.channel : '';
  const body = typeof frame.body === 'string' ? frame.body : '';

  // ── worldId control-message intercept (TOP of send, before ALL_SLUGS check) ──
  // The SWF sends a NUL-sentinel-prefixed body on channel 'server' to set the
  // player's current worldId. Intercept, verify, store, and drop (no
  // broadcast/persist/cursor). Failures fall through silently so the 'server'
  // channel path handles them (returns invalid_channel if no worldId stored).
  if (slug === 'server' && body.startsWith(WORLD_ID_SENTINEL_PREFIX)) {
    const ctrl = verifyWorldIdHmac(body, identity.userId);
    if (ctrl) {
      await setWorldId(identity.userId, ctrl.worldId);
      send(ws, { success: true, messageId: '' });
      return;
    }
    // Bad/stale HMAC — fall through; 'server' without a stored worldId → invalid_channel below.
  }

  if (!ALL_SLUGS.includes(slug)) {
    send(ws, errEnvelope('invalid_channel', `Unknown channel: ${slug}`));
    return;
  }

  if (body.length > 500) {
    send(ws, errEnvelope('message_too_long', 'Message body exceeds 500 characters'));
    return;
  }

  // Discard targetUserId on all non-whisper sends (whisper is omitted).
  // (frame.targetUserId is intentionally ignored here)

  // Resolve channel UUID.
  let channelId: string | null = null;
  if (slug === 'server') {
    const worldId = await getWorldId(identity.userId);
    if (!worldId) {
      send(ws, errEnvelope('invalid_channel', 'No active server session — send worldId first'));
      return;
    }
    // Server channel is the worldId-scoped session room. FCM uses world-session
    // scope; we route to General as a fallback until world-scope is wired in.
    // TODO(R2+): resolve to the session-scoped room channel by worldId.
    channelId = env.HUD_DEFAULT_CHANNEL_ID;
  } else {
    channelId = slugToChannelId(slug);
    if (!channelId) {
      send(ws, errEnvelope('invalid_channel', `Channel '${slug}' is not mapped`));
      return;
    }
  }

  // Assign relay cursor BEFORE ingestMessage so it is threaded through
  // finalizeMessage into BOTH the single broadcast and the persisted row.
  const relaySeq = await nextRelaySeq();

  // ingestMessage attributes messages.user_id (a UUID FK -> users.id) and runs the
  // mute/automod checks against that users row. identity.userId is the relay TEXT id
  // ("user_"+hex), NOT a UUID — passing it makes prisma.user.findUnique throw P2023
  // ("invalid UUID"). Use the linked FCM account UUID (guaranteed set: the !isLinked
  // gate above already returned permission_denied for unlinked identities).
  //
  // relaySeq is passed through so finalizeMessage (1) PERSISTS it on messages.relay_seq
  // — without which poll/history (WHERE relay_seq IS NOT NULL) never return the row —
  // and (2) includes it in the single broadcast the relay pub/sub subscriber forwards.
  // This replaces the old double-broadcast hack (one broadcast without relaySeq from
  // ingest, then a second relay-only rebroadcast with relaySeq).
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

  send(ws, { success: true, messageId: result.messageId });
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

  const cursor = typeof frame.cursor === 'number' ? frame.cursor : 0;
  const max    = Math.min(typeof frame.max === 'number' ? frame.max : 64, 100);

  const events = await fetchHistoryEvents(cursor, max);
  send(ws, { success: true, events });
}

/**
 * Recent chat history as chat.message events. cursor=0 → the initial window (latest
 * POLL_HISTORY_LIMIT, oldest-first); otherwise everything with relay_seq > cursor.
 * Shared by handlePoll AND the subscribe-time backfill so history reaches the in-game
 * widget over the live subscribe connection (the path it actually drains via pollEvents).
 */
async function fetchHistoryEvents(cursor: number, max: number): Promise<Array<Record<string, unknown>>> {
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

  return rows.map((row) => ({
    id:                Number(row.relay_seq),
    kind:              'chat.message',
    messageId:         row.id,
    channel:           channelIdToSlug(row.channel_id) ?? row.channel_id,
    senderUserId:      row.user_id,
    senderDisplayName: row.username,
    body:              row.content,
    targetUserId:      '',
    createdAt:         row.created_at ? new Date(row.created_at).toISOString() : '',
  }));
}

async function handleSubscribe(ws: WebSocket, frame: Record<string, unknown>): Promise<void> {
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

  // Check ban on the linked FCM account (if linked; subscribers can be limited).
  const banUser = identity.linkedUserId
    ? await prisma.user.findUnique({
        where: { id: identity.linkedUserId },
        select: { isBanned: true },
      })
    : null;
  if (banUser?.isBanned) {
    send(ws, errEnvelope('user_banned', 'This account is banned'));
    return;
  }

  const cursor = typeof frame.cursor === 'number' ? frame.cursor : 0;
  const worldId = await getWorldId(identity.userId);

  const state: SubscriberState = {
    ws,
    userId: identity.userId,
    cursor,
    worldId,
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

  // Backfill recent history on THIS long-lived subscribe connection. The in-game widget drains
  // events via pollEvents off the subscribe stream; ZFE doesn't re-issue a cursor=0 poll, so the
  // standalone handlePoll history never reaches it. Push the initial window here as op:event
  // frames (same shape as live broadcasts) so the feed loads on connect. Advance the subscriber
  // cursor past them so the live path doesn't immediately re-send the same rows.
  try {
    const history = await fetchHistoryEvents(0, POLL_HISTORY_LIMIT);
    for (const ev of history) {
      send(ws, { op: 'event', cursor: ev.id as number, event: ev });
    }
    if (history.length > 0) {
      state.cursor = Math.max(state.cursor, Number(history[history.length - 1].id));
    }
  } catch (err) {
    logger.warn({ err, userId: identity.userId }, '[relayHandler] history backfill on subscribe failed');
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
  const pingTimer = pingMs > 0
    ? setInterval(() => {
        if (ws.readyState !== 1) return;       // 1 = OPEN
        try { ws.ping(); } catch { /* socket closing */ }
      }, pingMs)
    : null;

  // Clean up subscriber (and stop the keepalive) on disconnect.
  ws.once('close', () => {
    if (pingTimer) clearInterval(pingTimer);
    subscribers.delete(state);
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Handle one WebSocket connection on the /relay path.
 * Dispatches JSON frames by op field. The connection may be short-lived (RPC)
 * or long-lived (subscribe). All errors return the stable error envelope.
 */
export function handleRelayConnection(ws: WebSocket, _req: http.IncomingMessage): void {
  // Dev-only guard — mirrors hudPushTcp.ts initHudPushTcp pattern.
  if (env.NODE_ENV === 'production') {
    logger.warn('[relayHandler] /relay connection refused: not yet exposed in production (R6 lifts this guard)');
    ws.close(1008, 'relay not available in production');
    return;
  }

  ws.on('message', async (data) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      send(ws, errEnvelope('invalid_request', 'Frame must be valid JSON'));
      return;
    }

    const op = typeof frame.op === 'string' ? frame.op : '';

    try {
      switch (op) {
        case 'register':        await handleRegister(ws, frame); break;
        case 'hello':           await handleHello(ws, frame); break;
        case 'getAuthState':    await handleGetAuthState(ws, frame); break;
        case 'send':            await handleSend(ws, frame); break;
        case 'poll':            await handlePoll(ws, frame); break;
        case 'subscribe':       await handleSubscribe(ws, frame); break;
        case 'report':
          // R4: placeholder — returns success for now; full implementation in R4
          send(ws, { success: true, status: 'reported' });
          break;
        case 'moderationAction':
          // R5: placeholder — returns permission_denied for non-staff
          send(ws, errEnvelope('permission_denied', 'Moderation actions require a linked staff account'));
          break;
        default:
          send(ws, errEnvelope('invalid_request', `Unknown op: ${op}`));
      }
    } catch (err) {
      logger.error({ err, op }, '[relayHandler] unhandled error in op handler');
      send(ws, errEnvelope('internal_error', 'Internal server error'));
    }
  });

  ws.on('error', (err) => {
    logger.warn({ err }, '[relayHandler] WebSocket error');
  });
}
