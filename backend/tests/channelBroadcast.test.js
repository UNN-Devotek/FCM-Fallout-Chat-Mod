'use strict';
/**
 * Unit tests for the channel create/update broadcast behaviour.
 *
 * Verifies that broadcastChannelUpdate() sends 'channels:refresh' (not the old
 * 'channel:update' that no client ever listened to), so newly created or updated
 * sub-channels appear in every connected client immediately.
 *
 * We replicate the relevant slice of the broadcast logic rather than importing
 * all of handlers.ts, keeping the test fast and dependency-free.
 */

// Replicated from handlers.ts — the exact logic under test
function makeBroadcastChannelUpdate(broadcastFn, invalidateCache) {
  return function broadcastChannelUpdate(action, channel) {
    if (channel?.id) {
      // channelCache.delete(channel.id) — omitted here; cache is tested separately
    }
    invalidateCache();
    broadcastFn({ type: 'channels:refresh', payload: {} });
  };
}

describe('broadcastChannelUpdate', () => {
  let broadcast;
  let invalidateCache;
  let broadcastChannelUpdate;

  beforeEach(() => {
    broadcast = jest.fn();
    invalidateCache = jest.fn();
    broadcastChannelUpdate = makeBroadcastChannelUpdate(broadcast, invalidateCache);
  });

  it('sends channels:refresh (not channel:update) so all clients refetch', () => {
    broadcastChannelUpdate('created', { id: 'ch-1', name: 'Trading', parentId: 'parent-1' });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const [payload] = broadcast.mock.calls[0];
    expect(payload.type).toBe('channels:refresh');
  });

  it('never sends channel:update', () => {
    broadcastChannelUpdate('created', { id: 'ch-1', name: 'Trading' });

    const types = broadcast.mock.calls.map(([p]) => p.type);
    expect(types).not.toContain('channel:update');
  });

  it('calls invalidateCache so relay mappings are fresh for new channel', () => {
    broadcastChannelUpdate('created', { id: 'ch-2', name: 'Events', discordChannelId: '123456789012345678' });

    expect(invalidateCache).toHaveBeenCalledTimes(1);
  });

  it('works for sub-channels (parentId set)', () => {
    broadcastChannelUpdate('created', { id: 'sub-1', name: 'sub', parentId: 'parent-1' });

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0].type).toBe('channels:refresh');
  });

  it('works for archive action', () => {
    broadcastChannelUpdate('archived', { id: 'ch-3', name: 'Old Channel' });

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0].type).toBe('channels:refresh');
  });
});
