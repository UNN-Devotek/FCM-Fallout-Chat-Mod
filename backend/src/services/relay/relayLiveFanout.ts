import {
  relayHudCosmetics,
  relayHudEventForClient,
} from './relayCosmetics';
import { channelIdToSlug } from './channelMap';

/** The relay state needed by the chat-message fan-out; deliberately excludes WebSocket. */
export interface RelayLiveSubscriber {
  cursor: number;
  supportsHudCosmeticsTransport: boolean;
}

/** Live frames held while a native subscriber is receiving its cursor-zero snapshot. */
export interface PendingLiveFrame {
  cursor: number;
  frame: string;
}

export const MAX_PENDING_LIVE_FRAMES = 128;
export const MAX_PENDING_LIVE_BYTES = 512 * 1024;

/**
 * Bounded subscribe barrier. A slow database/Redis read must not turn a busy server into an
 * unbounded per-socket memory sink. The caller closes the subscriber when this returns false so
 * the client can reconnect from a clean cursor instead of receiving an incomplete stream.
 */
export function enqueuePendingLiveFrame(
  queue: PendingLiveFrame[],
  currentBytes: number,
  item: PendingLiveFrame,
  maxFrames = MAX_PENDING_LIVE_FRAMES,
  maxBytes = MAX_PENDING_LIVE_BYTES,
): { accepted: boolean; bytes: number } {
  const frameBytes = Buffer.byteLength(item.frame, 'utf8');
  if (queue.length >= maxFrames || frameBytes > maxBytes || currentBytes + frameBytes > maxBytes) {
    return { accepted: false, bytes: currentBytes };
  }
  queue.push(item);
  return { accepted: true, bytes: currentBytes + frameBytes };
}

export type RelayLiveFrameSender<T extends RelayLiveSubscriber> =
  (subscriber: T, frame: string, relaySeq: number) => boolean;

export interface RelayLiveChatEvent {
  relaySeq: number;
  event: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Project the ordinary websocket broadcast shape into the event shape consumed by
 * a long-lived chat.v1 subscriber. Kept pure so the direct and Redis paths cannot
 * drift apart again.
 */
export function buildRelayLiveChatEvent(payload: unknown): RelayLiveChatEvent | null {
  const root = asRecord(payload);
  if (root?.type !== 'chat:message') return null;

  const source = asRecord(root.payload);
  if (!source) return null;

  const relaySeq = typeof source.relaySeq === 'number' && Number.isFinite(source.relaySeq)
    ? source.relaySeq
    : null;
  const channelId = typeof source.channelId === 'string' ? source.channelId : null;
  if (relaySeq === null || channelId === null) return null;

  const createdAt = typeof source.timestamp === 'string'
    ? source.timestamp
    : (typeof source.createdAt === 'string' ? source.createdAt : '');

  return {
    relaySeq,
    event: {
      id: relaySeq,
      kind: 'chat.message',
      messageId: source.id,
      channel: channelIdToSlug(channelId) ?? channelId,
      senderUserId: source.userId,
      senderDisplayName: source.username,
      body: source.content,
      targetUserId: '',
      createdAt,
      ...relayHudCosmetics(source),
    },
  };
}

/**
 * Deliver one static-channel chat broadcast to local native subscribers.
 *
 * The caller supplies the WebSocket-aware send function so this module remains
 * independently testable and can be called from the normal web broadcast hot path
 * without importing relayHandler (which would create an initialization cycle).
 */
export function fanoutRelayLiveChatMessage<T extends RelayLiveSubscriber>(
  payload: unknown,
  subscribers: Set<T>,
  sendFrame: RelayLiveFrameSender<T>,
): number {
  const built = buildRelayLiveChatEvent(payload);
  if (!built) return 0;

  let pushed = 0;
  for (const subscriber of subscribers) {
    if (subscriber.cursor >= built.relaySeq) continue;

    const event = relayHudEventForClient(
      built.event,
      subscriber.supportsHudCosmeticsTransport,
    );
    const frame = JSON.stringify({ op: 'event', cursor: built.relaySeq, event });
    if (sendFrame(subscriber, frame, built.relaySeq)) {
      subscriber.cursor = built.relaySeq;
      pushed++;
    } else {
      subscribers.delete(subscriber);
    }
  }
  return pushed;
}

type RelayLiveFanout = (payload: unknown) => number;
let registeredFanout: RelayLiveFanout = () => 0;

/** Register the relay-owned subscriber set without importing relayHandler into handlers.ts. */
export function registerRelayLiveFanout(fanout: RelayLiveFanout): void {
  registeredFanout = fanout;
}

/** Notify the relay subscriber registry from the ordinary local broadcast path. */
export function notifyRelayLiveChatMessage(payload: unknown): number {
  return registeredFanout(payload);
}
