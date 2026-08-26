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

jest.mock('discord.js', () => ({
  Client: jest.fn(() => mockClient),
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    GuildVoiceStates: 8,
    GuildMembers: 16,
    GuildMessageReactions: 32,
  },
  Partials: { Message: 'Message', Channel: 'Channel', Reaction: 'Reaction' },
}));

jest.mock('../src/config/environment', () => ({
  __esModule: true,
  default: {
    DISCORD_TOKEN: 'test-token',
    DISCORD_CHANNEL_ID: 'default-discord-channel',
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
    }),
  }));
  expect(mockQueueAdd).toHaveBeenCalledWith(expect.objectContaining({
    source: 'discord',
    relaySeq: 123,
  }));
});
