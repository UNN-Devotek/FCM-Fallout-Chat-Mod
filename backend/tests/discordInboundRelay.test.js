'use strict';

// Regression coverage for Discord -> relay history. Discord messages must carry
// the same monotonic relay cursor as HUD/WS messages; otherwise the relay's
// pub/sub listener and SQL history query both discard them.

const mockHandlers = new Map();
const mockOn = jest.fn((event, callback) => mockHandlers.set(event, callback));
const mockOnce = jest.fn((event, callback) => mockHandlers.set(`once:${event}`, callback));
const mockClient = {
  on: mockOn,
  once: mockOnce,
  login: jest.fn().mockResolvedValue('logged-in'),
  destroy: jest.fn(),
  user: { tag: 'FCM#0001' },
  channels: { fetch: jest.fn() },
  guilds: { cache: { first: jest.fn() } },
};

const mockChannelFindMany = jest.fn().mockResolvedValue([
  { id: 'game-channel-id', discordChannelId: 'discord-channel-id' },
]);
const mockPrisma = {
  channel: {
    findMany: (...args) => mockChannelFindMany(...args),
    findUnique: jest.fn().mockResolvedValue({ allowGifs: false, name: 'General' }),
  },
  discordRelayMapping: { findMany: jest.fn().mockResolvedValue([]) },
  user: {
    findFirst: jest.fn().mockResolvedValue({
      id: 'user-uuid',
      username: 'VaultDweller',
      chatName: null,
    }),
    findMany: jest.fn().mockResolvedValue([]),
  },
  discordMessageLink: {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({}),
  },
  message: { findFirst: jest.fn().mockResolvedValue(null) },
  $executeRaw: jest.fn().mockResolvedValue(1),
};

const mockBroadcast = jest.fn();
const mockQueueAdd = jest.fn().mockResolvedValue(undefined);
const mockRedis = { incr: jest.fn().mockResolvedValue(123) };
const mockAttachCosmetics = jest.fn(async (payload) => {
  payload.nameColor = '#57DBDB';
  payload.effectId = 'glow-soft';
  payload.tag = 'SUPPORTER';
  payload.badges = ['supporter'];
  return payload;
});

jest.mock('discord.js', () => ({
  Client: jest.fn(() => mockClient),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    GuildVoiceStates: 8,
    GuildMembers: 16,
    GuildMessageReactions: 32,
    GuildMessageTyping: 2048,
  },
  Partials: { Message: 'Message', Channel: 'Channel', Reaction: 'Reaction' },
}));

jest.mock('../src/config/environment', () => ({
  __esModule: true,
  default: {
    DISCORD_TOKEN: 'test-token',
    DISCORD_CHANNEL_ID: 'default-discord-channel',
    DISCORD_SERVER_ID: 'dev-guild-id',
    NODE_ENV: 'test',
  },
}));

jest.mock('../src/config/prisma', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue(mockRedis),
}));
jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../src/queues/messagePersist', () => ({
  __esModule: true,
  default: { add: (...args) => mockQueueAdd(...args) },
}));
jest.mock('../src/services/voiceService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/reactionRoleService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/ticketService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/supporterSyncService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/cosmeticsCommandService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/chatNameCommandService', () => ({ __esModule: true, default: { register: jest.fn() } }));
jest.mock('../src/services/cosmetics/cosmeticsService', () => ({
  attachCosmetics: (...args) => mockAttachCosmetics(...args),
}));
jest.mock('../src/services/autoModEngine', () => ({
  engineEvaluate: jest.fn().mockResolvedValue({ block: false, matches: [] }),
}));
jest.mock('../src/services/wikiCatalogService', () => ({
  getEntry: jest.fn(),
  bestMatch: jest.fn(),
}));

const service = require('../src/services/discordService');

beforeAll(async () => {
  service.setBroadcast(mockBroadcast);
  await service.start();
});

beforeEach(() => {
  mockBroadcast.mockClear();
  mockQueueAdd.mockClear();
  mockAttachCosmetics.mockClear();
  mockRedis.incr.mockClear().mockResolvedValue(123);
  mockPrisma.discordMessageLink.upsert.mockClear();
});

test('Discord inbound messages carry relaySeq into live broadcast and history persistence', async () => {
  const handler = mockHandlers.get('messageCreate');
  expect(handler).toEqual(expect.any(Function));

  await handler({
    id: 'discord-message-id',
    channelId: 'discord-channel-id',
    content: 'message from Discord',
    author: {
      id: 'discord-user-id',
      bot: false,
      username: 'discord-user',
      globalName: 'Discord User',
      send: jest.fn().mockResolvedValue(undefined),
    },
    webhookId: null,
    attachments: new Map(),
    embeds: [],
    guild: null,
    channel: { messages: { fetch: jest.fn() } },
  });

  expect(mockRedis.incr).toHaveBeenCalledWith('relay:seq');
  expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({
    type: 'chat:message',
    payload: expect.objectContaining({
      source: 'discord',
      relaySeq: 123,
      nameColor: '#57DBDB',
      effectId: 'glow-soft',
      tag: 'SUPPORTER',
      badges: ['supporter'],
    }),
  }));
  expect(mockAttachCosmetics).toHaveBeenCalledWith(expect.objectContaining({
    source: 'discord',
    userId: 'user-uuid',
  }));
  expect(mockQueueAdd).toHaveBeenCalledWith(expect.objectContaining({
    source: 'discord',
    relaySeq: 123,
  }));
});

test('Discord typingStart events use the mapped FCM identity and chat:typing protocol', async () => {
  const handler = mockHandlers.get('typingStart');
  expect(handler).toEqual(expect.any(Function));

  await handler({
    guild: { id: 'dev-guild-id' },
    channel: { id: 'discord-channel-id' },
    user: {
      id: 'discord-typing-user',
      bot: false,
      username: 'discord-user',
      globalName: 'Discord User',
    },
  });

  expect(mockBroadcast).toHaveBeenCalledWith({
    type: 'chat:typing',
    payload: {
      channelId: 'game-channel-id',
      username: 'VaultDweller',
      userId: 'user-uuid',
      source: 'discord',
    },
  });
});

test('Discord typing relay throttles repeats, ignores bots, and ignores unmapped channels', async () => {
  const handler = mockHandlers.get('typingStart');
  expect(handler).toEqual(expect.any(Function));

  await handler({
    guild: { id: 'dev-guild-id' },
    channel: { id: 'discord-channel-id' },
    user: { id: 'discord-throttle-user', bot: false, username: 'typing-user' },
  });
  await handler({
    guild: { id: 'dev-guild-id' },
    channel: { id: 'discord-channel-id' },
    user: { id: 'discord-throttle-user', bot: false, username: 'typing-user' },
  });
  expect(mockBroadcast).toHaveBeenCalledTimes(1);

  mockBroadcast.mockClear();
  await handler({
    guild: { id: 'dev-guild-id' },
    channel: { id: 'discord-channel-id' },
    user: { id: 'discord-bot-user', bot: true, username: 'relay-bot' },
  });
  await handler({
    guild: { id: 'dev-guild-id' },
    channel: { id: 'unmapped-discord-channel' },
    user: { id: 'discord-unmapped-user', bot: false, username: 'unmapped-user' },
  });
  expect(mockBroadcast).not.toHaveBeenCalled();
});

test('Discord typing relay does not create or relay an unlinked user', async () => {
  const handler = mockHandlers.get('typingStart');
  expect(handler).toEqual(expect.any(Function));
  mockPrisma.user.findFirst.mockResolvedValueOnce(null);

  await handler({
    guild: { id: 'dev-guild-id' },
    channel: { id: 'discord-channel-id' },
    user: { id: 'discord-unlinked-user', bot: false, username: 'unlinked-user' },
  });

  expect(mockBroadcast).not.toHaveBeenCalled();
  expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
    where: { discordId: 'discord-unlinked-user' },
  }));
});

test('Discord client requests the GuildMessageTyping gateway intent', () => {
  const discord = require('discord.js');
  expect(discord.Client.mock.calls[0][0].intents).toContain(2048);
});
