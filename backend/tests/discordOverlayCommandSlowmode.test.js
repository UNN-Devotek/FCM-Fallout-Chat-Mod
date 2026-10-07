jest.mock('../src/config/environment', () => ({ __esModule: true, default: { FCM_PUBLIC_BASE_URL: 'https://dev.falloutchatmod.com' } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: {
  discordRelayMapping: { findFirst: jest.fn(async () => ({ inGameChannelId: 'general' })) },
  channel: { findUnique: jest.fn(async () => ({ id: 'general', name: 'General', parentId: null })) },
} }));
jest.mock('../src/services/commandService', () => ({ getCommands: jest.fn(), tryHandleCommand: jest.fn(), buildHelpResponse: jest.fn() }));
jest.mock('../src/services/discordOverlayCommandEmbeds', () => ({ buildDiscordOverlayCard: jest.fn() }));
jest.mock('../src/services/giveawayService', () => ({}));
jest.mock('../src/services/giveawayButtonAction', () => ({}));
jest.mock('../src/lib/discordResponsePagination', () => ({ splitDiscordResponse: text => [text] }));
jest.mock('../src/services/wikiCatalogService', () => ({}));
jest.mock('../src/services/campService', () => ({}));
jest.mock('../src/services/userRoleService', () => ({}));
jest.mock('../src/services/moderationActionsService', () => ({}));
jest.mock('../src/services/userLookup', () => ({ getUserByDiscordId: jest.fn(async () => ({ id: 'account', username: 'tester', discordId: 'discord-user' })) }));
jest.mock('../src/services/ingestMessage', () => ({ finalizeMessage: jest.fn(async () => undefined) }));
jest.mock('../src/services/chatSlowmodeService', () => ({
  ...jest.requireActual('../src/services/chatSlowmodeService'), checkChatSlowmode: jest.fn(),
}));
jest.mock('../src/config/redis', () => ({ getRedisClient: jest.fn() }));
const { register } = require('../src/services/discordOverlayCommandService');
const { getCommands, tryHandleCommand } = require('../src/services/commandService');
const { checkChatSlowmode } = require('../src/services/chatSlowmodeService');
const { finalizeMessage } = require('../src/services/ingestMessage');
const logger = require('../src/config/logger').default;
const { MessageFlags } = require('discord.js');

async function dispatch(commandName, raw) {
  let handler;
  register({ on: (_event, cb) => { handler = cb; }, once: jest.fn() });
  const interaction = {
    commandName, channelId: 'discord-channel', user: { id: 'discord-user' },
    options: { getString: () => raw },
    isButton: () => false, isAutocomplete: () => false, isChatInputCommand: () => true,
    reply: jest.fn(async () => undefined),
  };
  handler(interaction);
  await new Promise(resolve => setImmediate(resolve));
  expect(logger.error).not.toHaveBeenCalled();
  return interaction;
}

beforeEach(() => {
  jest.clearAllMocks();
  getCommands.mockResolvedValue([{ trigger: '/sos', alias: null, actionType: 'announce' }]);
  tryHandleCommand.mockResolvedValue({ handled: true, actionType: 'relay', targetChannelId: 'events', relayContent: 'Swarm of Suitors' });
  checkChatSlowmode.mockResolvedValue({ allowed: false, remaining: 0, retryAfterMs: 35000 });
});

test.each([['fcm', '/g Hello'], ['sos', null], ['events', '/sos']])('%s interaction cannot bypass an active shared cooldown', async (name, raw) => {
  const cancelCooldown = jest.fn();
  tryHandleCommand.mockResolvedValue({ handled: true, actionType: 'relay', targetChannelId: 'events', relayContent: 'Swarm of Suitors', cancelCooldown });
  const interaction = await dispatch(name, raw);
  expect(cancelCooldown).toHaveBeenCalledTimes(1);
  expect(checkChatSlowmode).toHaveBeenCalledWith({ id: 'account', discordId: 'discord-user' });
  expect(finalizeMessage).not.toHaveBeenCalled();
  expect(interaction.reply).toHaveBeenCalledTimes(1);
  expect(interaction.reply).toHaveBeenCalledWith({ content: 'You are in cooldown. Please wait 35 seconds before sending another message.', flags: MessageFlags.Ephemeral });
});

test('allowed event shortcut publishes once and replies with private success', async () => {
  checkChatSlowmode.mockResolvedValue({ allowed: true, remaining: 2, retryAfterMs: 0 });
  const interaction = await dispatch('sos', null);
  expect(finalizeMessage).toHaveBeenCalledTimes(1);
  expect(finalizeMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'account', channelId: 'events', content: 'Swarm of Suitors' }));
  expect(interaction.reply).toHaveBeenCalledWith({ content: 'Event announcement sent.', flags: MessageFlags.Ephemeral });
});

test('private commands remain available during cooldown', async () => {
  tryHandleCommand.mockResolvedValue({ handled: true, actionType: 'private', targetChannelId: 'general', botMessage: 'Private response' });
  const interaction = await dispatch('fcm', '/help');
  expect(checkChatSlowmode).not.toHaveBeenCalled();
  expect(finalizeMessage).not.toHaveBeenCalled();
  expect(interaction.reply).toHaveBeenCalled();
});
