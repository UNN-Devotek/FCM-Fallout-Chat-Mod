import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRelayLiveChatEvent,
  fanoutRelayLiveChatMessage,
  type RelayLiveSubscriber,
} from '../relayLiveFanout';

const GLOBAL_CHANNEL = '00000000-0000-0000-0000-000000000005';

function chatBroadcast(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'chat:message',
    payload: {
      id: 'message-42',
      content: 'hello',
      username: 'Devotek',
      userId: 'account-42',
      channelId: GLOBAL_CHANNEL,
      relaySeq: 42,
      timestamp: '2026-09-04T01:00:00.000Z',
      tag: 'X',
      badges: ['supporter'],
      starColor: '#FD4DA6',
      ...overrides,
    },
  };
}

describe('relay live chat fan-out', () => {
  test('projects the same canonical event used by direct and Redis delivery', () => {
    assert.deepEqual(buildRelayLiveChatEvent(chatBroadcast()), {
      relaySeq: 42,
      event: {
        id: 42,
        kind: 'chat.message',
        messageId: 'message-42',
        channel: 'global',
        senderUserId: 'account-42',
        senderDisplayName: 'Devotek',
        body: 'hello',
        targetUserId: '',
        createdAt: '2026-09-04T01:00:00.000Z',
        tag: 'X',
        supporterStar: true,
        starColor: '#FD4DA6',
      },
    });
  });

  test('pushes once, advances each cursor, and adds the native cosmetic carrier', () => {
    const native: RelayLiveSubscriber = { cursor: 0, supportsHudCosmeticsTransport: true };
    const raw: RelayLiveSubscriber = { cursor: 0, supportsHudCosmeticsTransport: false };
    const stale: RelayLiveSubscriber = { cursor: 42, supportsHudCosmeticsTransport: true };
    const subscribers = new Set([native, raw, stale]);
    const frames: string[] = [];

    const pushed = fanoutRelayLiveChatMessage(
      chatBroadcast(),
      subscribers,
      (_subscriber, frame) => {
        frames.push(frame);
        return true;
      },
    );

    assert.equal(pushed, 2);
    assert.equal(native.cursor, 42);
    assert.equal(raw.cursor, 42);
    assert.equal(stale.cursor, 42);
    assert.equal(frames.length, 2);
    assert.ok(frames.some((frame) => frame.includes('FCMHUD/1;m=message-42')));
    assert.ok(frames.some((frame) => !frame.includes('FCMHUD/1;')));

    // A same-cursor replay is a no-op, so a direct delivery plus Redis fallback
    // cannot create a second HUD event on this process.
    assert.equal(fanoutRelayLiveChatMessage(chatBroadcast(), subscribers, () => true), 0);
  });

  test('removes a subscriber whose socket cannot accept the frame', () => {
    const failed: RelayLiveSubscriber = { cursor: 0, supportsHudCosmeticsTransport: true };
    const subscribers = new Set([failed]);
    const pushed = fanoutRelayLiveChatMessage(
      chatBroadcast(),
      subscribers,
      () => false,
    );

    assert.equal(pushed, 0);
    assert.equal(subscribers.size, 0);
  });

  test('ignores non-chat, malformed, and non-relay broadcasts', () => {
    const subscribers = new Set<RelayLiveSubscriber>();
    const send = () => {
      throw new Error('should not send');
    };
    for (const payload of [
      null,
      {},
      { type: 'presence:update', payload: {} },
      { type: 'chat:message', payload: null },
      { type: 'chat:message', payload: { channelId: GLOBAL_CHANNEL, relaySeq: 0 } },
      { type: 'chat:message', payload: { channelId: GLOBAL_CHANNEL, relaySeq: '42' } },
    ]) {
      assert.equal(fanoutRelayLiveChatMessage(payload, subscribers, send), 0);
    }
  });
});
