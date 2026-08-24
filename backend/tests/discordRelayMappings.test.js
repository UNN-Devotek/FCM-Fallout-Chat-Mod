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
const mockDiscordMessageLinkFindUnique = jest.fn().mockResolvedValue(null);
const mockMessageFindFirst = jest.fn().mockResolvedValue(null);
const mockExecuteRaw = jest.fn().mockResolvedValue(1);
const mockBroadcast = jest.fn();

jest.mock('../src/config/prisma', () => ({
  channel: {
    findMany: (...args) => mockChannelFindMany(...args),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
  },
  discordRelayMapping: {
    findMany: (...args) => mockMappingFindMany(...args),
  },
  discordMessageLink: {
    findUnique: (...args) => mockDiscordMessageLinkFindUnique(...args),
  },
  message: { create: jest.fn(), findFirst: (...args) => mockMessageFindFirst(...args) },
  $executeRaw: (...args) => mockExecuteRaw(...args),
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
jest.mock('../src/services/autoModEngine', () => ({ engineEvaluate: jest.fn().mockResolvedValue({ block: false, matches: [] }) }));

// ── Load the module once — cache is reset via invalidateRelayMappingsCache() ──

const svc = require('../src/services/discordService');

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockChannelFindMany.mockClear().mockResolvedValue([]);
  mockMappingFindMany.mockClear().mockResolvedValue([]);
  mockDiscordMessageLinkFindUnique.mockClear().mockResolvedValue(null);
  mockMessageFindFirst.mockClear().mockResolvedValue(null);
  mockExecuteRaw.mockClear().mockResolvedValue(1);
  mockBroadcast.mockClear();
  // Bust the 60-second cache so each test starts with a fresh load
  svc.invalidateRelayMappingsCache();
  svc.setBroadcast(mockBroadcast);
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

describe('syncDiscordMessageUpdate', () => {
  it('updates the linked overlay row and broadcasts chat:edit for a human Discord edit', async () => {
    mockDiscordMessageLinkFindUnique.mockResolvedValue({
      messageId: '11111111-1111-4111-8111-111111111111',
      isBotMessage: false,
    });
    mockMessageFindFirst.mockResolvedValue({
      userId: '22222222-2222-4222-8222-222222222222',
      channelId: '33333333-3333-4333-8333-333333333333',
    });

    const changed = await svc.syncDiscordMessageUpdate({
      id: 'discord-message-1',
      channelId: 'discord-channel-1',
      content: 'edited from Discord',
      author: { bot: false },
      webhookId: null,
    });

    expect(changed).toBe(true);
    expect(mockExecuteRaw).toHaveBeenCalled();
    expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat:edit',
      payload: expect.objectContaining({
        messageId: '11111111-1111-4111-8111-111111111111',
        content: 'edited from Discord',
        source: 'discord',
      }),
    }));
  });

  it('ignores edits to bot-authored relay copies to prevent an echo loop', async () => {
    mockDiscordMessageLinkFindUnique.mockResolvedValue({ isBotMessage: true });

    const changed = await svc.syncDiscordMessageUpdate({
      id: 'discord-bot-message',
      channelId: 'discord-channel-1',
      content: 'bot edit',
      author: { bot: true },
    });

    expect(changed).toBe(false);
    expect(mockMessageFindFirst).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe('editDiscordRelayMessage', () => {
  it('edits the bot-authored Discord copy using the retained prefix', async () => {
    mockDiscordMessageLinkFindUnique.mockResolvedValue({
      messageId: '11111111-1111-4111-8111-111111111111',
      discordMessageId: 'discord-message-1',
      discordChannelId: 'discord-channel-1',
      discordPrefix: '**[General]** **VaultEller**: ',
      isBotMessage: true,
    });
    const edit = jest.fn().mockResolvedValue(undefined);
    const fakeChannel = {
      isTextBased: () => true,
      messages: { fetch: jest.fn().mockResolvedValue({ edit }) },
    };
    const fakeClient = { channels: { fetch: jest.fn().mockResolvedValue(fakeChannel) } };

    const changed = await svc.editDiscordRelayMessage(
      '11111111-1111-4111-8111-111111111111',
      'corrected text',
      fakeClient,
    );

    expect(changed).toBe(true);
    expect(edit).toHaveBeenCalledWith({ content: '**[General]** **VaultEller**: corrected text\u200b' });
  });
});
