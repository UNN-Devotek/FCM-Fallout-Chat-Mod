/**
 * hudPush.ts — transport-agnostic HUD push core
 *
 * Manages a registry of connected HUD push clients (TCP sockets, WS frames, …)
 * and fans out live chat:message events to them in FCMHUD/1 wire format.
 *
 * On client registration:
 *   1. Send HELLO~1~<backfillCount>
 *   2. Backfill: fetchFeedRows() → buildFeedLines(rows.reverse()) → one line per send
 *
 * On chat:message broadcast: hudPushNotify(payload) is called from
 * localBroadcast() in handlers.ts; it resolves the channel, applies the same
 * predicate as the hud-feed SQL, formats the line and fans out.
 *
 * Filter-parity: the live-push channel predicate (parentId !== null &&
 * !isArchived) mirrors the hud-feed SQL WHERE clause verbatim.  Leaf channels
 * (General/Trading/Events/Raids) have a non-null parentId; the root container
 * ("Fallout 76") has parentId IS NULL and is excluded from both feed and push.
 * The predicate is kept in one exported function (isHudEligibleChannel) so it
 * stays in sync with the SQL in a single place.
 */

import prisma from '../config/prisma';
import logger from '../config/logger';
import env from '../config/environment';
import { buildFeedLines, fetchFeedRows, fetchFeedRowsForChannel } from './hudFeedService';

// ── Public interface ──────────────────────────────────────────────────────────

export interface HudPushClient {
  send(line: string): void;
  close(): void;
  transport: 'tcp' | 'ws';
  /** The channel this connection is currently subscribed to. Set on connect and on CHAN switch. */
  activeChannelId: string;
}

// ── Channel eligibility ───────────────────────────────────────────────────────

interface ChannelInfo {
  name: string;
  color: string | null;
  parentId: string | null;
  isArchived: boolean;
}

/**
 * Apply the same channel predicate as the hud-feed SQL:
 *   WHERE c.parent_id IS NOT NULL AND NOT c.is_archived
 *
 * Leaf channels (General, Trading, Events, Raids) have a non-null parentId.
 * The root container ("Fallout 76", parent_id IS NULL) is excluded — it is a
 * grouping container, not a real chat channel, and must never appear in the feed
 * or receive messages from HUD sends.
 */
export function isHudEligibleChannel(info: ChannelInfo): boolean {
  return info.parentId !== null && !info.isArchived;
}

/**
 * General is the AGGREGATE feed — a client whose active channel is General sees
 * messages from EVERY leaf channel (each tagged with its own channel/colour).
 * Every other channel is scoped to its own messages only.
 */
export function isAggregateChannel(channelId: string): boolean {
  return channelId === env.HUD_DEFAULT_CHANNEL_ID;
}

// ── Channel info cache (60 s TTL) ─────────────────────────────────────────────

interface CachedChannel {
  info: ChannelInfo | null;
  cachedAt: number;
}

const CHANNEL_CACHE_TTL_MS = 60_000;

// Allow injection of a custom resolver for unit tests (see resolveChannel).
type ChannelResolver = (channelId: string) => Promise<ChannelInfo | null>;

let _channelResolver: ChannelResolver | null = null;
const channelCache = new Map<string, CachedChannel>();

/** Override the channel resolver (for unit tests — pass null to restore default). */
export function _setChannelResolver(fn: ChannelResolver | null): void {
  _channelResolver = fn;
  channelCache.clear();
}

// ── Feed rows fetcher injection (unit tests) ──────────────────────────────────

type ChannelFeedFetcher = (channelId: string, limit?: number) => Promise<any[]>;
type AggregateFeedFetcher = (limit?: number) => Promise<any[]>;

let _channelFeedFetcher: ChannelFeedFetcher | null = null;
let _aggregateFeedFetcher: AggregateFeedFetcher | null = null;

/** Override the aggregate (General) feed fetcher (for unit tests — pass null to restore default). */
export function _setAggregateFeedFetcher(fn: AggregateFeedFetcher | null): void {
  _aggregateFeedFetcher = fn;
}

function resolveAggregateFeedFetcher(): AggregateFeedFetcher {
  return _aggregateFeedFetcher ?? fetchFeedRows;
}

/** Override the per-channel feed fetcher (for unit tests — pass null to restore default). */
export function _setChannelFeedFetcher(fn: ChannelFeedFetcher | null): void {
  _channelFeedFetcher = fn;
}

function resolveChannelFeedFetcher(): ChannelFeedFetcher {
  return _channelFeedFetcher ?? fetchFeedRowsForChannel;
}

async function defaultChannelResolver(channelId: string): Promise<ChannelInfo | null> {
  try {
    const ch = await prisma.channel.findFirst({
      where: { id: channelId },
      select: { name: true, color: true, parentId: true, isArchived: true },
    });
    if (!ch) return null;
    return {
      name: ch.name,
      color: ch.color ?? null,
      parentId: ch.parentId ?? null,
      isArchived: ch.isArchived ?? false,
    };
  } catch {
    return null;
  }
}

async function resolveChannel(channelId: string): Promise<ChannelInfo | null> {
  const cached = channelCache.get(channelId);
  if (cached && Date.now() - cached.cachedAt < CHANNEL_CACHE_TTL_MS) {
    return cached.info;
  }
  const resolver = _channelResolver ?? defaultChannelResolver;
  const info = await resolver(channelId);
  channelCache.set(channelId, { info, cachedAt: Date.now() });
  return info;
}

// ── Client registry ───────────────────────────────────────────────────────────

const clients = new Set<HudPushClient>();

export function getClientCount(): number {
  return clients.size;
}

function unregisterClient(client: HudPushClient): void {
  clients.delete(client);
  try { client.close(); } catch { /* already closed */ }
}

/**
 * Register a new HUD push client. Immediately sends HELLO + ACTIVECHAN + channel-filtered backfill.
 * Fire-and-forget; logs on error so a slow/broken client never blocks startup.
 */
export function registerClient(client: HudPushClient): void {
  clients.add(client);
  // Backfill is async; do not await here so callers (TCP on-connection) don't stall.
  void (async () => {
    try {
      const channelId = client.activeChannelId;

      // Resolve active channel info so we can send the channel name in ACTIVECHAN.
      const channelInfo = await resolveChannel(channelId);
      const channelName = channelInfo?.name ?? 'General';

      // Backfill can be disabled (HUD_PUSH_BACKFILL_ENABLED=false) so the in-game
      // feed shows ONLY live messages — no stale history/placeholder content.
      // General is the AGGREGATE feed (all leaf channels); every other channel
      // backfills only its own messages.
      const lines = env.HUD_PUSH_BACKFILL_ENABLED
        ? buildFeedLines((await (isAggregateChannel(channelId)
            ? resolveAggregateFeedFetcher()()
            : resolveChannelFeedFetcher()(channelId))).reverse())
        : [];

      // HELLO must arrive before ACTIVECHAN and backfill lines.
      client.send(`HELLO~1~${lines.length}\n`);
      client.send(`ACTIVECHAN~${channelName}\n`);
      for (const line of lines) {
        client.send(line + '\n');
      }
    } catch (err) {
      logger.warn({ err }, '[hudPush] backfill failed; unregistering client');
      unregisterClient(client);
    }
  })();
}

/**
 * Switch the active channel for a connected client. Sends ACTIVECHAN + channel-filtered backfill.
 * Called from hudPushTcp when a CHAN verb is received.
 * Fire-and-forget; errors are logged, never propagated.
 */
export function switchClientChannel(client: HudPushClient, channelId: string): void {
  void (async () => {
    try {
      const channelInfo = await resolveChannel(channelId);
      if (!channelInfo) {
        logger.warn({ channelId }, '[hudPush] switchClientChannel: unknown channel — ignoring');
        return;
      }
      if (!isHudEligibleChannel(channelInfo)) {
        logger.warn({ channelId }, '[hudPush] switchClientChannel: non-leaf/archived channel — ignoring');
        return;
      }

      client.activeChannelId = channelId;

      // General = aggregate (all leaf channels); others = own channel only.
      const lines = env.HUD_PUSH_BACKFILL_ENABLED
        ? buildFeedLines((await (isAggregateChannel(channelId)
            ? resolveAggregateFeedFetcher()()
            : resolveChannelFeedFetcher()(channelId))).reverse())
        : [];

      client.send(`ACTIVECHAN~${channelInfo.name}\n`);
      for (const line of lines) {
        client.send(line + '\n');
      }
    } catch (err) {
      logger.warn({ err, channelId }, '[hudPush] switchClientChannel error (non-fatal)');
    }
  })();
}

export function unregisterClientPublic(client: HudPushClient): void {
  unregisterClient(client);
}

// ── Live push ─────────────────────────────────────────────────────────────────

/**
 * Called from localBroadcast() in handlers.ts with every outbound payload.
 * Fire-and-forget — NEVER throws (outer try/catch + logger.warn).
 */
export function hudPushNotify(payload: any): void {
  // Fast-path: filter without async work when there are no clients.
  if (clients.size === 0) return;

  void (async () => {
    try {
      // Only handle chat:message events.
      if (payload?.type !== 'chat:message') return;

      // Skip private messages.
      if (payload?.payload?.isPrivate) return;

      const channelId: unknown = payload?.payload?.channelId;
      if (typeof channelId !== 'string' || channelId.length === 0) return;

      const info = await resolveChannel(channelId);
      if (!info) return;
      if (!isHudEligibleChannel(info)) return;

      // Synthesize a DB-row-shaped object so buildFeedLines produces an
      // identical format to the backfill path.
      const row = {
        content: payload.payload.content ?? '',
        username: payload.payload.username ?? null,
        discord_display_name: null,
        discord_username: null,
        channel_name: info.name,
        channel_color: info.color ?? null,
      };

      const line = buildFeedLines([row])[0];
      if (!line) return;

      const frame = line + '\n';
      const toRemove: HudPushClient[] = [];

      for (const client of clients) {
        // Per-connection channel filter: General is the aggregate feed (sees every
        // channel); any other active channel only sees its own messages.
        if (!isAggregateChannel(client.activeChannelId) && client.activeChannelId !== channelId) continue;
        try {
          client.send(frame);
        } catch (err) {
          logger.warn({ err, transport: client.transport }, '[hudPush] client send failed; removing');
          toRemove.push(client);
        }
      }

      for (const client of toRemove) {
        unregisterClient(client);
      }
    } catch (err) {
      logger.warn({ err }, '[hudPush] hudPushNotify internal error (non-fatal)');
    }
  })();
}

// ── Idle heartbeat ────────────────────────────────────────────────────────────

// ZFE's native transport drops the connection after ~15 s without inbound
// bytes (observed in-game 2026-06-10: connect 18:47:04, last bytes :07,
// "live transport disconnected" :22). 10 s keeps it alive with margin and
// also stays far under Cloudflare's ~100 s idle WebSocket drop.
const PING_INTERVAL_MS = 10_000;

const pingTimer = setInterval(() => {
  if (clients.size === 0) return;
  const frame = `PING~${Math.floor(Date.now() / 1000)}\n`;
  const toRemove: HudPushClient[] = [];
  for (const client of clients) {
    try {
      client.send(frame);
    } catch (err) {
      logger.warn({ err, transport: client.transport }, '[hudPush] ping failed; removing client');
      toRemove.push(client);
    }
  }
  for (const client of toRemove) {
    unregisterClient(client);
  }
}, PING_INTERVAL_MS);

// Unref so the timer doesn't keep the Node process alive when everything else
// has exited (e.g. in tests).
pingTimer.unref();
