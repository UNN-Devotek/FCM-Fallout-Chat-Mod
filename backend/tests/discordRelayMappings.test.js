'use strict';
/**
 * Unit tests for loadRelayMappings() and invalidateRelayMappingsCache().
 *
 * Verifies three things introduced/fixed recently:
 *  1. Channel.discordChannelId rows (discordRelay:true) are included in the map.
 *  2. Explicit DiscordRelayMapping rows override Channel.discordChannelId when both
 *     point the same in-game channel at a different Discord channel.
 *  3. invalidateRelayMappingsCache() forces a fresh DB query on the next call
 *     (no 60-second wait after a channel is created or updated).
 */

// ── Prisma mock stubs — captured by reference so tests can swap return values ─

const mockChannelFindMany = jest.fn().mockResolvedValue([]);
const mockMappingFindMany = jest.fn().mockResolvedValue([]);

jest.mock('../src/config/prisma', () => ({
  channel: {
    findMany: (...args) => mockChannelFindMany(...args),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
  },
  discordRelayMapping: {
    findMany: (...args) => mockMappingFindMany(...args),
  },
  message: { create: jest.fn() },
}));

// ── Other heavy dependency mocks ──────────────────────────────────────────────

jest.mock('discord.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    on: jest.fn(), login: jest.fn(), destroy: jest.fn(),
    channels: { fetch: jest.fn() },
    guilds: { cache: { first: jest.fn() } },
  })),
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, GuildVoiceStates: 8, GuildMembers: 16, GuildMessageReactions: 32 },
  Partials: { Message: 'Message', Channel: 'Channel', Reaction: 'Reaction' },
  TextChannel: jest.fn(),
  EmbedBuilder: jest.fn().mockImplementation(() => ({
    setTitle: jest.fn().mockReturnThis(), setDescription: jest.fn().mockReturnThis(),
    setColor: jest.fn().mockReturnThis(), setTimestamp: jest.fn().mockReturnThis(),
    addFields: jest.fn().mockReturnThis(),
  })),
  ActivityType: { Playing: 0 },
}));

jest.mock('../src/config/environment', () => ({
  default: { DISCORD_TOKEN: '', DISCORD_CHANNEL_ID: 'default-discord-ch', NODE_ENV: 'test' },
}));

jest.mock('../src/config/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../src/queues/messagePersist', () => ({ add: jest.fn(), process: jest.fn(), on: jest.fn() }));
jest.mock('../src/services/voiceService', () => ({ default: { handleVoiceStateUpdate: jest.fn() } }));
jest.mock('../src/services/reactionRoleService', () => ({ default: { handleReactionAdd: jest.fn(), handleReactionRemove: jest.fn() } }));
jest.mock('../src/services/wikiCatalogService', () => ({ getEntry: jest.fn(), bestMatch: jest.fn() }));

// ── Load the module once — cache is reset via invalidateRelayMappingsCache() ──

const svc = require('../src/services/discordService');

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockChannelFindMany.mockClear().mockResolvedValue([]);
  mockMappingFindMany.mockClear().mockResolvedValue([]);
  // Bust the 60-second cache so each test starts with a fresh load
  svc.invalidateRelayMappingsCache();
});

describe('loadRelayMappings — channel.discordChannelId source', () => {
  it('includes a channel that has discordRelay:true and discordChannelId set', async () => {
    mockChannelFindMany.mockResolvedValue([
      { id: 'game-ch-uuid', discordChannelId: 'discord-ch-123' },
    ]);

    const map = await svc.loadRelayMappings();

    expect(map.get('discord-ch-123')).toBe('game-ch-uuid');
  });

  it('includes sub-channels (parentId would be non-null) the same as top-level channels', async () => {
    mockChannelFindMany.mockResolvedValue([
      { id: 'sub-ch-uuid', discordChannelId: 'discord-sub-456' },
    ]);

    const map = await svc.loadRelayMappings();

    expect(map.get('discord-sub-456')).toBe('sub-ch-uuid');
  });

  it('returns empty map when no channels or explicit mappings exist', async () => {
    const map = await svc.loadRelayMappings();

    expect(map.size).toBe(0);
  });

  it('maps multiple channels independently', async () => {
    mockChannelFindMany.mockResolvedValue([
      { id: 'game-ch-general', discordChannelId: 'discord-general' },
      { id: 'game-ch-trading', discordChannelId: 'discord-trading' },
    ]);

    const map = await svc.loadRelayMappings();

    expect(map.get('discord-general')).toBe('game-ch-general');
    expect(map.get('discord-trading')).toBe('game-ch-trading');
  });
});

describe('loadRelayMappings — DiscordRelayMapping override priority', () => {
  it('explicit DiscordRelayMapping entries override Channel.discordChannelId', async () => {
    // Channel row says game-ch-1 ↔ discord-ch-A
    mockChannelFindMany.mockResolvedValue([
      { id: 'game-ch-1', discordChannelId: 'discord-ch-A' },
    ]);
    // Explicit mapping overrides: game-ch-1 ↔ discord-ch-B
    mockMappingFindMany.mockResolvedValue([
      { inGameChannelId: 'game-ch-1', discordChannelId: 'discord-ch-B' },
    ]);

    const map = await svc.loadRelayMappings();

    // The explicit mapping (discord-ch-B) should win
    expect(map.get('discord-ch-B')).toBe('game-ch-1');
    // The channel row entry (discord-ch-A) is still present (different key)
    expect(map.get('discord-ch-A')).toBe('game-ch-1');
  });

  it('includes entries from both sources when they use different Discord channels', async () => {
    mockChannelFindMany.mockResolvedValue([
      { id: 'game-ch-1', discordChannelId: 'discord-ch-A' },
    ]);
    mockMappingFindMany.mockResolvedValue([
      { inGameChannelId: 'game-ch-2', discordChannelId: 'discord-ch-B' },
    ]);

    const map = await svc.loadRelayMappings();

    expect(map.get('discord-ch-A')).toBe('game-ch-1');
    expect(map.get('discord-ch-B')).toBe('game-ch-2');
    expect(map.size).toBe(2);
  });
});

describe('invalidateRelayMappingsCache', () => {
  it('forces a fresh DB query on the next loadRelayMappings call', async () => {
    mockChannelFindMany.mockResolvedValue([
      { id: 'game-ch-uuid', discordChannelId: 'discord-ch-first' },
    ]);

    // First call — populates the cache
    const map1 = await svc.loadRelayMappings();
    expect(map1.get('discord-ch-first')).toBe('game-ch-uuid');
    const callsAfterFirst = mockChannelFindMany.mock.calls.length;

    // Second call without invalidation — must use the cache, not hit DB again
    await svc.loadRelayMappings();
    expect(mockChannelFindMany.mock.calls.length).toBe(callsAfterFirst);

    // Invalidate, then change the mock data
    svc.invalidateRelayMappingsCache();
    mockChannelFindMany.mockResolvedValue([
      { id: 'game-ch-uuid', discordChannelId: 'discord-ch-updated' },
    ]);

    // Third call — must re-query and see the new channel ID
    const map3 = await svc.loadRelayMappings();
    expect(map3.get('discord-ch-updated')).toBe('game-ch-uuid');
    expect(map3.has('discord-ch-first')).toBe(false);
    expect(mockChannelFindMany.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
