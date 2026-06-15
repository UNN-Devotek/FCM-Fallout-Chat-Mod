'use strict';
/**
 * Unit tests for ingestMessage (backend/src/services/ingestMessage.ts).
 *
 * Strategy: mock all heavy deps (prisma, redis, automod, discordService,
 * messageQueue, broadcast) and call ingestMessage() directly.
 *
 * Coverage:
 *  - Happy path: ok=true, broadcast called, messageQueue.add called, relayToDiscord called
 *  - Muted user (isMuted=true): returns { ok: false, reason: 'muted' }
 *  - Expired mute auto-lifted: proceeds normally
 *  - HUD identity block (active mute block): returns muted
 *  - Rate-limit exceeded: returns rate-limited
 *  - Content too long (>500): returns invalid-content
 *  - Empty content: returns invalid-content
 *  - Invalid channelId (not UUID): returns invalid-channel
 *  - Channel not found: returns channel-not-found
 *  - Automod blocks: returns automod
 *  - Slash command from HUD source: returns slash-command-dropped
 *  - Slash command from ws source: NOT dropped (handled by WS path)
 */

// ── Mock all heavy external deps before any require of server code ─────────────

jest.mock('../src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn().mockImplementation(async (cb) =>
    cb({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }),
  ),
  pool: { on: jest.fn() },
}));

jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue('PONG'),
    connect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    zRemRangeByScore: jest.fn().mockResolvedValue(0),
    zAdd: jest.fn().mockResolvedValue(1),
    zCard: jest.fn().mockResolvedValue(1),
    multi: jest.fn().mockReturnValue({
      zRemRangeByScore: jest.fn().mockReturnThis(),
      zAdd: jest.fn().mockReturnThis(),
      zCard: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([0, 1, 1, 1]),
    }),
  }),
  healthCheck: jest.fn().mockResolvedValue(true),
  client: { on: jest.fn(), ping: jest.fn().mockResolvedValue('PONG'), isOpen: true },
  subscriberClient: { on: jest.fn(), isOpen: true },
}));

jest.mock('rate-limit-redis', () => ({
  RedisStore: jest.fn().mockImplementation(() => ({
    init: jest.fn().mockResolvedValue(undefined),
    increment: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }),
  })),
}));

jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));

jest.mock('../src/services/discordService', () => ({
  start: jest.fn().mockResolvedValue(undefined),
  setBroadcast: jest.fn(),
  getStatus: jest.fn().mockReturnValue('disconnected'),
  relayToDiscord: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/queues/messagePersist', () => ({
  add: jest.fn().mockResolvedValue({}),
  process: jest.fn(),
  on: jest.fn(),
}));

jest.mock('../src/services/autoModEngine', () => ({
  engineEvaluate: jest.fn().mockResolvedValue({ block: false, matches: [] }),
}));

jest.mock('../src/services/autoModService', () => ({
  shadowMute: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/messageService', () => ({
  persistMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/websocket/handlers', () => ({
  broadcast: jest.fn(),
  resolveDisplayName: jest.fn((u) => u.username || 'Wanderer'),
}));

jest.mock('../src/controllers/healthController', () => ({
  incrementMessageCount: jest.fn(),
  setFullscreenStatus: jest.fn(),
  removeFullscreenClient: jest.fn(),
}));

jest.mock('../src/services/hudIdentityService', () => ({
  deriveIdentityHash: jest.fn((a) => `hash-${a}`),
  resolveHudIdentity: jest.fn().mockResolvedValue({ userId: 'uid', identityHash: 'ihash' }),
  getActiveBlock: jest.fn().mockResolvedValue(null),
  blockHash: jest.fn().mockResolvedValue(undefined),
  unblockHash: jest.fn().mockResolvedValue(1),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

const { ingestMessage, _clearIngestCaches } = require('../src/services/ingestMessage');
const prismaStub = require('./setup/prisma-stub').default;
const { broadcast } = require('../src/websocket/handlers');
const { relayToDiscord } = require('../src/services/discordService');
const messageQueue = require('../src/queues/messagePersist');
const { engineEvaluate } = require('../src/services/autoModEngine');
const { getActiveBlock } = require('../src/services/hudIdentityService');
const { getRedisClient } = require('../src/config/redis');

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_CHANNEL_ID = '11111111-1111-1111-1111-111111111111';
const BASE_USER = {
  isMuted: false,
  muteExpiresAt: null,
  username: 'VaultEller',
  discordUsername: null,
  discordDisplayName: null,
};

/** Reset all mocks between tests. */
beforeEach(() => {
  jest.clearAllMocks();
  // Clear module-level channel caches to prevent cross-test cache leakage.
  _clearIngestCaches();

  // Default: user exists, not muted, channel is valid and is a leaf channel
  // (parentId !== null). The root container has parentId: null — tests that need
  // a container channel override this default explicitly.
  prismaStub.user.findUnique.mockResolvedValue(BASE_USER);
  prismaStub.channel.findFirst.mockResolvedValue({ id: VALID_CHANNEL_ID, name: 'General', parentId: '00000000-0000-0000-0000-000000000001' });

  // Default rate-limit multi: count = 1 (under limit of 5).
  getRedisClient.mockResolvedValue({
    multi: jest.fn().mockReturnValue({
      zRemRangeByScore: jest.fn().mockReturnThis(),
      zAdd: jest.fn().mockReturnThis(),
      zCard: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([0, 1, 1, 1]), // zCard result = 1
    }),
  });

  engineEvaluate.mockResolvedValue({ block: false, matches: [] });
  broadcast.mockReset();
  relayToDiscord.mockResolvedValue(undefined);
  messageQueue.add.mockResolvedValue({});
  getActiveBlock.mockResolvedValue(null);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ingestMessage — happy path', () => {
  it('broadcasts, queues, and relays to Discord on success', async () => {
    const result = await ingestMessage({
      userId: 'user-1',
      channelId: VALID_CHANNEL_ID,
      rawContent: 'Hello vault!',
      source: 'hud',
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBeDefined();

    // broadcast called with a chat:message payload
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat:message',
      payload: expect.objectContaining({
        content: 'Hello vault!',
        channelId: VALID_CHANNEL_ID,
        source: 'hud',
      }),
    }));

    // Write-behind queue
    expect(messageQueue.add).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Hello vault!',
      userId: 'user-1',
      channelId: VALID_CHANNEL_ID,
      source: 'hud',
    }));

    // Discord relay
    expect(relayToDiscord).toHaveBeenCalledWith(
      VALID_CHANNEL_ID,
      expect.any(String),
      'Hello vault!',
      expect.any(String),
    );
  });

  it('works with source=ws too', async () => {
    const result = await ingestMessage({
      userId: 'user-2',
      channelId: VALID_CHANNEL_ID,
      rawContent: 'ws message',
      source: 'ws',
    });
    expect(result.ok).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ source: 'ws' }),
    }));
  });
});

describe('ingestMessage — mute checks', () => {
  it('returns muted when user isMuted=true (permanent)', async () => {
    prismaStub.user.findUnique.mockResolvedValue({ ...BASE_USER, isMuted: true, muteExpiresAt: null });
    const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: 'hi', source: 'hud' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('muted');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('auto-lifts expired mute and proceeds', async () => {
    const expired = new Date(Date.now() - 1000).toISOString();
    prismaStub.user.findUnique.mockResolvedValue({ ...BASE_USER, isMuted: true, muteExpiresAt: expired });
    prismaStub.user.update.mockResolvedValue({ ...BASE_USER, isMuted: false });

    const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: 'hi', source: 'hud' });
    expect(result.ok).toBe(true);
    expect(prismaStub.user.update).toHaveBeenCalled();
  });

  it('returns muted when HUD identity block is active', async () => {
    getActiveBlock.mockResolvedValue({ type: 'mute', identityHash: 'ihash' });
    const result = await ingestMessage({
      userId: 'u',
      channelId: VALID_CHANNEL_ID,
      rawContent: 'hi',
      source: 'hud',
      identityHash: 'ihash',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('muted');
  });
});

describe('ingestMessage — rate limit', () => {
  it('returns rate-limited when Redis zCard > 5', async () => {
    getRedisClient.mockResolvedValue({
      multi: jest.fn().mockReturnValue({
        zRemRangeByScore: jest.fn().mockReturnThis(),
        zAdd: jest.fn().mockReturnThis(),
        zCard: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([0, 1, 6, 1]), // zCard = 6 > limit of 5
      }),
    });

    const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: 'hi', source: 'hud' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('rate-limited');
  });

  // SR-004: Redis outage must fail CLOSED for the unauthenticated 'hud'
  // transport (its only flood control) but fail OPEN for the authenticated
  // 'ws' path (availability for known users).
  describe('Redis error during rate-limit check', () => {
    beforeEach(() => {
      getRedisClient.mockResolvedValue({
        multi: jest.fn().mockReturnValue({
          zRemRangeByScore: jest.fn().mockReturnThis(),
          zAdd: jest.fn().mockReturnThis(),
          zCard: jest.fn().mockReturnThis(),
          expire: jest.fn().mockReturnThis(),
          exec: jest.fn().mockRejectedValue(new Error('redis down')),
        }),
      });
    });

    it('fails CLOSED for hud source (returns rate-limited)', async () => {
      const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: 'hi', source: 'hud' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('rate-limited');
    });

    it('fails OPEN for ws source (message passes)', async () => {
      const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: 'hi', source: 'ws' });
      expect(result.ok).toBe(true);
    });
  });
});

describe('ingestMessage — content validation', () => {
  it('rejects empty content', async () => {
    const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: '   ', source: 'hud' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-content');
  });

  it('rejects content > 500 chars', async () => {
    const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: 'x'.repeat(501), source: 'hud' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-content');
  });

  it('accepts exactly 500 chars', async () => {
    const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: 'x'.repeat(500), source: 'hud' });
    expect(result.ok).toBe(true);
  });

  it('rejects non-UUID channelId', async () => {
    const result = await ingestMessage({ userId: 'u', channelId: 'not-a-uuid', rawContent: 'hi', source: 'hud' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-channel');
  });
});

describe('ingestMessage — channel not found', () => {
  it('returns channel-not-found when channel does not exist', async () => {
    prismaStub.channel.findFirst.mockResolvedValue(null);
    const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: 'hi', source: 'hud' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('channel-not-found');
  });
});

describe('ingestMessage — automod', () => {
  it('returns automod when engine blocks', async () => {
    engineEvaluate.mockResolvedValue({ block: true, matches: ['badword'], customMessage: 'Blocked.' });
    const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: 'badword', source: 'hud' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('automod');
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('ingestMessage — slash command handling', () => {
  it('drops slash command from HUD source', async () => {
    const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: '/wiki Nuka-Cola', source: 'hud' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('slash-command-dropped');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does NOT drop slash command from ws source (WS handler owns that)', async () => {
    const result = await ingestMessage({ userId: 'u', channelId: VALID_CHANNEL_ID, rawContent: '/wiki Nuka-Cola', source: 'ws' });
    // WS slash commands fall through to broadcast (they pass the governance pipeline)
    // Only the WS handler intercepts them; ingestMessage should not block them.
    // The test just confirms ingestMessage doesn't return slash-command-dropped for ws.
    expect(result.reason).not.toBe('slash-command-dropped');
  });
});

describe('ingestMessage — HUD send guard (container channel rejection)', () => {
  const ROOT_CHANNEL_ID = '00000000-0000-0000-0000-000000000001';
  const GENERAL_CHANNEL_ID = '00000000-0000-0000-0000-000000000005';

  it('rejects SEND to root container channel (parentId: null) from hud source', async () => {
    // Root container channel: parentId IS NULL (no parent).
    prismaStub.channel.findFirst.mockResolvedValue({
      id: ROOT_CHANNEL_ID,
      name: 'Fallout 76',
      parentId: null,
    });
    _clearIngestCaches();

    const result = await ingestMessage({
      userId: 'u',
      channelId: ROOT_CHANNEL_ID,
      rawContent: 'should be rejected',
      source: 'hud',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-channel');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('accepts SEND to General leaf channel (parentId non-null) from hud source', async () => {
    // Leaf channel: parentId points to the root container.
    prismaStub.channel.findFirst.mockResolvedValue({
      id: GENERAL_CHANNEL_ID,
      name: 'General',
      parentId: ROOT_CHANNEL_ID,
    });
    _clearIngestCaches();

    const result = await ingestMessage({
      userId: 'u',
      channelId: GENERAL_CHANNEL_ID,
      rawContent: 'hello general',
      source: 'hud',
    });

    expect(result.ok).toBe(true);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat:message',
      payload: expect.objectContaining({ channelId: GENERAL_CHANNEL_ID }),
    }));
  });

  it('does NOT apply container guard for ws source (ws path does not use guard)', async () => {
    // The ws path is allowed to send to any valid channel (WS handler manages channel scope).
    prismaStub.channel.findFirst.mockResolvedValue({
      id: ROOT_CHANNEL_ID,
      name: 'Fallout 76',
      parentId: null,
    });
    _clearIngestCaches();

    const result = await ingestMessage({
      userId: 'u',
      channelId: ROOT_CHANNEL_ID,
      rawContent: 'ws root send',
      source: 'ws',
    });

    // ws path should not be blocked by the hud-specific guard
    expect(result.reason).not.toBe('invalid-channel');
  });
});
