jest.mock('../src/services/ingestMessage', () => ({ finalizeMessage: jest.fn(async () => undefined) }));
jest.mock('../src/config/redis', () => ({ getRedisClient: jest.fn() }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));
const { getRedisClient } = require('../src/config/redis');
const { finalizeMessage } = require('../src/services/ingestMessage');
const { publishDiscordCommandRelay } = require('../src/services/discordCommandPublication');
const { MessageFlags } = require('discord.js');

beforeEach(() => jest.clearAllMocks());

test('command relays use the linked Discord identity across channels and privately reject the fourth attempt', async () => {
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
    expect(options).toEqual({ keys: ['chat_slowmode:discord:discord-user'], arguments: ['60000', '35000', '3'] });
  }
});

test('a Redis outage rejects command publication with a private retry notice', async () => {
  getRedisClient.mockRejectedValue(new Error('offline'));
  const interaction = { reply: jest.fn(async () => undefined) };
  expect(await publishDiscordCommandRelay(interaction, { userId: 'account', channelId: 'events', content: 'event', source: 'discord' }, 'discord-user')).toBe(false);
  expect(finalizeMessage).not.toHaveBeenCalled();
  expect(interaction.reply).toHaveBeenCalledWith({ content: 'You are in cooldown. Please wait 5 seconds before sending another message.', flags: MessageFlags.Ephemeral });
});
