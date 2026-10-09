jest.mock('../src/services/chatSlowmodeService', () => ({ ...jest.requireActual('../src/services/chatSlowmodeService'), checkChatSlowmode: jest.fn(async () => ({ allowed: true, remaining: 2, retryAfterMs: 0 })) }));
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
  user: { tag: 'FCM#0001', setPresence: jest.fn() },
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
    update: jest.fn().mockResolvedValue({}),
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
  ActivityType: { Custom: 4 },
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
const mockActivity = jest.fn(async () => {});
const mockGlobalCount = jest.fn(async () => 17);
jest.mock('../src/services/onlinePresenceService', () => ({
  registerLocalPresenceSource: jest.fn(), getLocalOnlineUserIds: () => [],
  noteUserConnected: jest.fn(), noteUserDisconnected: jest.fn(),
  noteUserPendingDisconnect: jest.fn(), notePendingDisconnectSuppressed: jest.fn(),
  noteDiscordMessageActivity: (...args) => mockActivity(...args),
  getGlobalOnlineCount: (...args) => mockGlobalCount(...args),
}));
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

jest.useFakeTimers();
const service = require('../src/services/discordService');
afterAll(() => { jest.clearAllTimers(); jest.useRealTimers(); });

beforeAll(async () => {
  service.setBroadcast(mockBroadcast);
  await service.start();
});

beforeEach(() => {
  mockActivity.mockClear();
  mockBroadcast.mockClear();
  mockQueueAdd.mockClear();
  mockAttachCosmetics.mockClear();
  mockRedis.incr.mockClear().mockResolvedValue(123);
  mockPrisma.discordMessageLink.upsert.mockClear();
  mockPrisma.user.update.mockClear();
  mockPrisma.user.findFirst.mockReset().mockResolvedValue({
    id: 'user-uuid',
    username: 'VaultDweller',
    chatName: null,
  });
});

test('bot presence uses the shared count and reports unavailable instead of false zero', async () => {
  jest.useFakeTimers();
  try {
    mockGlobalCount.mockResolvedValueOnce(17).mockRejectedValueOnce(new Error('redis offline'));
    mockHandlers.get('once:ready')();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockClient.user.setPresence).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'online', activities: [expect.objectContaining({ name: 'Watching 17 dwellers' })] }));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockClient.user.setPresence).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'online', activities: [expect.objectContaining({ name: 'Active user count unavailable' })] }));
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});

test('only human posts in linked channels refresh activity, including media-only posts', async () => {
  const handler = mockHandlers.get('messageCreate');
  const message = { id: 'presence-fixture', channelId: 'discord-channel-id', content: '',
    author: { id: '123456789012345678', bot: false }, webhookId: null, embeds: [], attachments: new Map() };
  await handler(message);
  expect(mockActivity).toHaveBeenCalledWith(message.author.id);
  await handler(message); expect(mockActivity).toHaveBeenCalledTimes(2);
  await handler({ ...message, channelId: 'unlinked' });
  await handler({ ...message, author: { ...message.author, bot: true } });
  await handler({ ...message, webhookId: 'webhook' });
  expect(mockActivity).toHaveBeenCalledTimes(2);
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
  expect(require('../src/services/autoModEngine').engineEvaluate).toHaveBeenCalledWith(
    'message from Discord', expect.any(String), expect.objectContaining({ discordId: 'discord-user-id' }),
    { spamPolicy: 'shared-chat' });
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

test('Discord inbound messages never render an Overlay auto-handle for a linked account', async () => {
  const handler = mockHandlers.get('messageCreate');
  mockPrisma.user.findFirst.mockResolvedValue({
    id: 'canonical-user-uuid',
    username: 'Overlay2288',
    chatName: null,
  });

  await handler({
    id: 'discord-overlay-placeholder-message',
    channelId: 'discord-channel-id',
    content: 'test',
    author: {
      id: 'discord-user-id',
      bot: false,
      username: '.devotek',
      globalName: 'Devotek',
      send: jest.fn().mockResolvedValue(undefined),
    },
    webhookId: null,
    attachments: new Map(),
    embeds: [],
    guild: null,
    channel: { messages: { fetch: jest.fn() } },
  });

  expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({
    payload: expect.objectContaining({
      userId: 'canonical-user-uuid',
      username: 'Devotek',
      source: 'discord',
    }),
  }));
  expect(mockQueueAdd).toHaveBeenCalledWith(expect.objectContaining({
    userId: 'canonical-user-uuid',
    source: 'discord',
  }));
});

test('Discord inbound mentions fall back from placeholder usernames to the Discord display name', async () => {
  const handler = mockHandlers.get('messageCreate');
  const mentionedDiscordId = '185069913252167681';
  mockPrisma.user.findMany.mockResolvedValueOnce([
    { discordId: mentionedDiscordId, username: `discord:${mentionedDiscordId}` },
  ]);

  await handler({
    id: 'discord-mention-message-id',
    channelId: 'discord-channel-id',
    content: `<@${mentionedDiscordId}>`,
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
    guildId: 'dev-guild-id',
    mentions: {
      users: new Map([[mentionedDiscordId, {
        username: 'infestations',
        globalName: 'Infestations',
      }]]),
      members: new Map(),
      roles: new Map(),
      channels: new Map(),
    },
    channel: { messages: { fetch: jest.fn() } },
  });

  expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({
    type: 'chat:message',
    payload: expect.objectContaining({
      content: '@Infestations',
      metadata: {
        type: 'chat_entities',
        entities: [{ type: 'user', discordId: mentionedDiscordId, label: 'Infestations' }],
      },
    }),
  }));
});

test('Discord inbound mentions prefer a linked Fallout 76 username', async () => {
  const handler = mockHandlers.get('messageCreate');
  const mentionedDiscordId = '285069913252167681';
  mockPrisma.user.findMany.mockResolvedValueOnce([
    { discordId: mentionedDiscordId, username: 'VaultDweller76' },
  ]);

  await handler({
    id: 'discord-fo76-mention-message-id',
    channelId: 'discord-channel-id',
    content: `<@!${mentionedDiscordId}>`,
    author: {
      id: 'discord-user-id', bot: false, username: 'discord-user', globalName: 'Discord User',
      send: jest.fn().mockResolvedValue(undefined),
    },
    webhookId: null,
    attachments: new Map(),
    embeds: [],
    guild: null,
    guildId: 'dev-guild-id',
    mentions: {
      users: new Map([[mentionedDiscordId, {
        username: 'discord-handle', globalName: 'Discord Display',
      }]]),
      members: new Map(), roles: new Map(), channels: new Map(),
    },
    channel: { messages: { fetch: jest.fn() } },
  });

  expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({
    type: 'chat:message',
    payload: expect.objectContaining({ content: '@VaultDweller76' }),
  }));
});

test('HUD supporter relay uses the immutable star in the Discord author prefix', () => {
  expect(service.buildDiscordRelayPrefix('General', 'Devotek-', ['overseer']))
    .toBe('**[General]** **★ Devotek-**: ');
  expect(service.buildDiscordRelayPrefix('General', 'Regular', ['★', 'moderator']))
    .toBe('**[General]** **Regular**: ');
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

test.each([false, true])('slowmode deletes blocked Discord posts and never relays even when deletion/DM fails (%s)', async fail => {
  const { checkChatSlowmode } = require('../src/services/chatSlowmodeService');
  checkChatSlowmode.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 35000 });
  const remove = fail ? jest.fn().mockRejectedValue(new Error('missing permission')) : jest.fn().mockResolvedValue();
  const dm = fail ? jest.fn().mockRejectedValue(new Error('DM closed')) : jest.fn().mockResolvedValue();
  await mockHandlers.get('messageCreate')({ id: 'blocked', channelId: 'discord-channel-id', content: 'fourth message',
    author: { id: 'person', bot: false, send: dm }, webhookId: null, embeds: [], delete: remove });
  expect(checkChatSlowmode).toHaveBeenLastCalledWith({ id: 'person', discordId: 'person' });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(dm).toHaveBeenCalledWith('You are in cooldown. Please wait 35 seconds before sending another message.');
  expect(mockBroadcast).not.toHaveBeenCalled();
  expect(mockQueueAdd).not.toHaveBeenCalled();
});
test('unrelated Discord channels do not consume the chat allowance', async () => {
  const { checkChatSlowmode } = require('../src/services/chatSlowmodeService');
  checkChatSlowmode.mockClear();
  await mockHandlers.get('messageCreate')({ channelId: 'unrelated-channel', content: 'hello', author: { id: 'person', bot: false }, embeds: [] });
  expect(checkChatSlowmode).not.toHaveBeenCalled();
});

test('human posts cannot evade Discord cooldown deletion by including the relay watermark', async () => {
  const { checkChatSlowmode } = require('../src/services/chatSlowmodeService');
  checkChatSlowmode.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 35000 });
  const remove = jest.fn().mockResolvedValue(), dm = jest.fn().mockResolvedValue();
  await mockHandlers.get('messageCreate')({ channelId: 'discord-channel-id', content: 'fourth message\u200B',
    author: { id: 'person', bot: false, send: dm }, webhookId: null, embeds: [], delete: remove });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(dm).toHaveBeenCalledWith(expect.stringContaining('You are in cooldown'));
  expect(mockBroadcast).not.toHaveBeenCalled();
});
