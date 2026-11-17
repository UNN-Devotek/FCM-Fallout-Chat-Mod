jest.mock('../src/services/ingestMessage', () => ({ finalizeMessage: jest.fn(async () => undefined) }));
jest.mock('../src/config/redis', () => ({ getRedisClient: jest.fn() }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn() } }));
const goodStanding = { id: 'linked-account', isBanned: false, bannedUntil: null, kickedUntil: null, isMuted: false, muteExpiresAt: null, muteReason: null, muteCategory: null };
const mockPrisma = { user: { findUnique: jest.fn(async () => goodStanding) } };
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../src/services/autoModEngine', () => ({ engineEvaluate: jest.fn(async () => ({ block: false, matches: [] })) }));
jest.mock('../src/services/autoModService', () => ({ shadowMute: jest.fn(async () => undefined) }));
const { engineEvaluate } = require('../src/services/autoModEngine');
const { shadowMute } = require('../src/services/autoModService');
const { getRedisClient } = require('../src/config/redis');
const { finalizeMessage } = require('../src/services/ingestMessage');
const { publishDiscordCommandRelay } = require('../src/services/discordCommandPublication');
const { MessageFlags } = require('discord.js');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue(goodStanding);
});

test('command relays share the three-message burst across channels and privately reject the fourth attempt', async () => {
  const evalLimiter = jest.fn()
    .mockResolvedValueOnce([1, 2, 0]).mockResolvedValueOnce([1, 1, 0])
    .mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 0, 35000])
    .mockResolvedValueOnce([0, 0, 34001]).mockResolvedValueOnce([1, 2, 0]);
  getRedisClient.mockResolvedValue({ eval: evalLimiter });
  const interaction = { reply: jest.fn(async () => undefined) };
  const message = channelId => ({ userId: 'linked-account', channelId, content: 'Event announcement', source: 'discord', waitForPersistence: true });
  for (const channel of ['events', 'general', 'trading']) {
    await expect(publishDiscordCommandRelay(interaction, message(channel), 'discord-user')).resolves.toBe(true);
    expect(finalizeMessage).toHaveBeenLastCalledWith(message(channel));
  }
  for (const channel of ['events', 'general']) {
    await expect(publishDiscordCommandRelay(interaction, message(channel), 'discord-user')).resolves.toBe(false);
  }
  expect(finalizeMessage).toHaveBeenCalledTimes(3);
  expect(interaction.reply).toHaveBeenCalledTimes(2);
  expect(interaction.reply).toHaveBeenLastCalledWith({
    content: 'You are in cooldown. Please wait 35 seconds before sending another message.', flags: MessageFlags.Ephemeral,
  });
  await expect(publishDiscordCommandRelay(interaction, message('events'), 'discord-user')).resolves.toBe(true);
  expect(finalizeMessage).toHaveBeenCalledTimes(4);
  for (const [, options] of evalLimiter.mock.calls) {
    expect(options).toEqual({ keys: ['chat_slowmode:v2:discord:discord-user'],
      arguments: ['30000', '35000', '3', '300000', '900000', '60000', '60'] });
  }
});

test('a Redis outage rejects command publication with a private retry notice', async () => {
  getRedisClient.mockRejectedValue(new Error('offline'));
  const interaction = { reply: jest.fn(async () => undefined) };
  expect(await publishDiscordCommandRelay(interaction, { userId: 'account', channelId: 'events', content: 'event', source: 'discord' }, 'discord-user')).toBe(false);
  expect(finalizeMessage).not.toHaveBeenCalled();
  expect(interaction.reply).toHaveBeenCalledWith({ content: 'You are in cooldown. Please wait 5 seconds before sending another message.', flags: MessageFlags.Ephemeral });
});

describe('account standing and automod (same gates as overlay chat)', () => {
  const minutesFromNow = (m) => new Date(Date.now() + m * 60_000);
  const relay = { userId: 'linked-account', channelId: 'general', content: 'hello', displayName: 'Tester', source: 'discord' };

  beforeEach(() => getRedisClient.mockResolvedValue({ eval: jest.fn().mockResolvedValue([1, 2, 0]) }));

  test.each([
    ['permanently banned', { isBanned: true }, /You are banned/],
    ['temporarily banned', { isBanned: true, bannedUntil: minutesFromNow(30) }, /banned from Fallout Chat Mod chat until/],
    ['kick-locked', { kickedUntil: minutesFromNow(4) }, /kicked .* Try again in 4 minutes/],
    ['muted', { isMuted: true, muteExpiresAt: minutesFromNow(10), muteReason: 'spam', muteCategory: 'Spam' }, /You are muted .*Spam: spam/],
  ])('%s account cannot relay through /fcm command', async (_label, standing, message) => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...goodStanding, ...standing });
    const interaction = { reply: jest.fn(async () => undefined) };
    await expect(publishDiscordCommandRelay(interaction, relay, 'discord-user', { rawInput: '/g hello' })).resolves.toBe(false);
    expect(finalizeMessage).not.toHaveBeenCalled();
    expect(engineEvaluate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({ content: expect.stringMatching(message), flags: MessageFlags.Ephemeral });
  });

  test('expired temporary ban and mute no longer block the relay', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...goodStanding, isBanned: true, bannedUntil: minutesFromNow(-1), isMuted: true, muteExpiresAt: minutesFromNow(-1), kickedUntil: minutesFromNow(-1) });
    const interaction = { reply: jest.fn(async () => undefined) };
    await expect(publishDiscordCommandRelay(interaction, relay, 'discord-user')).resolves.toBe(true);
    expect(finalizeMessage).toHaveBeenCalledWith(relay);
  });

  test('automod evaluates the typed command text and blocks the relay; spam shadow-mutes', async () => {
    engineEvaluate.mockResolvedValueOnce({ block: true, customMessage: 'Spam detected', matches: [{}] });
    const interaction = { reply: jest.fn(async () => undefined) };
    await expect(publishDiscordCommandRelay(interaction, relay, 'discord-user', { rawInput: '/g hello' })).resolves.toBe(false);
    expect(engineEvaluate).toHaveBeenCalledWith('/g hello', 'general', expect.objectContaining({ id: 'linked-account' }), { spamPolicy: 'shared-chat' });
    expect(shadowMute).toHaveBeenCalledWith('linked-account');
    expect(finalizeMessage).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'Spam detected', flags: MessageFlags.Ephemeral });
  });

  test('a standing lookup failure refuses the relay', async () => {
    mockPrisma.user.findUnique.mockRejectedValue(new Error('db down'));
    const interaction = { reply: jest.fn(async () => undefined) };
    await expect(publishDiscordCommandRelay(interaction, relay, 'discord-user')).resolves.toBe(false);
    expect(finalizeMessage).not.toHaveBeenCalled();
  });
});
