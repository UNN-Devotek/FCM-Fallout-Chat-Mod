// Discord `/moderate` and `/report` interaction behaviour: acknowledgement
// before lookups, input validation, unban-by-player, bridged-message deletion,
// specific failure replies and the /report search and rate limit.
jest.mock('../src/config/environment', () => ({ __esModule: true, default: { FCM_PUBLIC_BASE_URL: 'https://dev.falloutchatmod.com' } }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));
const mockPrisma = {
  user: { findMany: jest.fn() },
  discordMessageLink: { findFirst: jest.fn() },
  playerReport: { create: jest.fn(async () => ({ id: 'report-id' })) },
};
jest.mock('../src/config/prisma', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../src/lib/requiredEffects', () => ({
  runRequiredBundle: (_scope, _id, fn) => fn(),
  runRequiredMutation: (_scope, _id, _ctx, fn) => fn(),
  isPrismaAtomicRefusal: () => false,
}));
const mockIsStaff = jest.fn();
jest.mock('../src/services/commandService', () => ({
  getCommands: jest.fn(), tryHandleCommand: jest.fn(), buildHelpResponse: jest.fn(),
  isStaffAccount: (...args) => mockIsStaff(...args),
}));
jest.mock('../src/services/discordOverlayCommandEmbeds', () => ({ buildDiscordOverlayCard: jest.fn() }));
jest.mock('../src/services/giveawayService', () => ({}));
jest.mock('../src/services/giveawayButtonAction', () => ({}));
jest.mock('../src/services/wikiCatalogService', () => ({}));
jest.mock('../src/services/campService', () => ({}));
jest.mock('../src/services/ingestMessage', () => ({ finalizeMessage: jest.fn() }));
jest.mock('../src/services/discordCommandPublication', () => ({ publishDiscordCommandRelay: jest.fn() }));
jest.mock('../src/services/discordService', () => ({ postModAlert: jest.fn(async () => undefined) }));
const mockModeration = {
  REASON_CATEGORIES: ['Spam', 'Other'],
  createBan: jest.fn(), deleteMessageById: jest.fn(), kickUser: jest.fn(), muteUser: jest.fn(),
  reverseBan: jest.fn(), unbanUser: jest.fn(), unmuteUser: jest.fn(),
};
jest.mock('../src/services/moderationActionsService', () => mockModeration);
const mockLookup = { getUserByDiscordId: jest.fn(), getUserById: jest.fn() };
jest.mock('../src/services/userLookup', () => mockLookup);

const { MessageFlags } = require('discord.js');
const { register, moderationFailureMessage, parseModerationMessageReference } = require('../src/services/discordOverlayCommandService');
const { ModerationError, ProtectedTargetError } = require('../src/services/moderationErrors');

const MOD = { id: '11111111-1111-4111-8111-111111111111', username: 'Overseer', discordId: 'discord-mod' };
const TARGET = { id: '22222222-2222-4222-8222-222222222222', username: 'Raider', chatName: 'Raider', discordId: null };

let handler;
register({ on: (_event, cb) => { handler = cb; }, once: jest.fn() });
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function command(commandName, subcommand, strings = {}, integers = {}) {
  const interaction = {
    commandName, channelId: 'discord-channel', user: { id: 'discord-mod' }, deferred: false, replied: false,
    options: {
      getSubcommand: () => subcommand,
      getString: (name) => strings[name] ?? null,
      getInteger: (name) => integers[name] ?? null,
    },
    isButton: () => false, isAutocomplete: () => false, isChatInputCommand: () => true,
    deferReply: jest.fn(async () => { interaction.deferred = true; }),
    editReply: jest.fn(async () => { interaction.replied = true; }),
    reply: jest.fn(async () => { interaction.replied = true; }),
  };
  return interaction;
}

async function run(interaction) {
  handler(interaction);
  await flush();
  return interaction;
}

const lastReply = (interaction) => interaction.editReply.mock.calls.at(-1)?.[0]?.content;

beforeEach(() => {
  jest.clearAllMocks();
  mockLookup.getUserByDiscordId.mockResolvedValue(MOD);
  mockLookup.getUserById.mockImplementation(async (id) => (id === TARGET.id ? TARGET : null));
  mockIsStaff.mockResolvedValue(true);
});

describe('/moderate acknowledgement and access', () => {
  test('defers before the first lookup and denies non-staff privately through the deferred reply', async () => {
    mockIsStaff.mockResolvedValue(false);
    const interaction = await run(command('moderate', 'kick', { user: TARGET.id, reason: 'x' }));
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(mockLookup.getUserByDiscordId.mock.invocationCallOrder[0]);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(lastReply(interaction)).toMatch(/Only Fallout Chat Mod moderators/);
    expect(mockModeration.kickUser).not.toHaveBeenCalled();
  });
});

describe('/moderate unban', () => {
  test('rejects a malformed ban ID without calling the service', async () => {
    const interaction = await run(command('moderate', 'unban', { 'ban-id': 'not-a-uuid' }));
    expect(lastReply(interaction)).toMatch(/not a valid FCM ban ID/);
    expect(mockModeration.reverseBan).not.toHaveBeenCalled();
  });

  test('keeps ban-ID input working', async () => {
    const banId = '33333333-3333-4333-8333-333333333333';
    const interaction = await run(command('moderate', 'unban', { 'ban-id': banId, reason: 'appeal' }));
    expect(mockModeration.reverseBan).toHaveBeenCalledWith(banId, MOD.id, 'appeal');
    expect(lastReply(interaction)).toBe('Ban reversed.');
  });

  test('unbans by player through the active-ban service', async () => {
    const interaction = await run(command('moderate', 'unban', { user: TARGET.id }));
    expect(mockModeration.unbanUser).toHaveBeenCalledWith(TARGET.id, MOD.id, 'Reversed from Discord');
    expect(lastReply(interaction)).toBe('Ban on Raider reversed.');
  });

  test('explains when the chosen player has no active ban', async () => {
    mockModeration.unbanUser.mockRejectedValueOnce(new ModerationError('NotBanned', 'Target has no active ban'));
    const interaction = await run(command('moderate', 'unban', { user: TARGET.id }));
    expect(lastReply(interaction)).toBe('That player has no active FCM ban.');
  });

  test('asks for a player or ban ID when neither is given', async () => {
    const interaction = await run(command('moderate', 'unban', {}));
    expect(lastReply(interaction)).toMatch(/Pick the banned player/);
  });
});

describe('/moderate delete-message', () => {
  test('parses FCM IDs, Discord message links and Discord message IDs', () => {
    expect(parseModerationMessageReference('33333333-3333-4333-8333-333333333333')).toEqual({ kind: 'fcm', messageId: '33333333-3333-4333-8333-333333333333' });
    expect(parseModerationMessageReference('https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678'))
      .toEqual({ kind: 'discord', discordChannelId: '223456789012345678', discordMessageId: '323456789012345678' });
    expect(parseModerationMessageReference('323456789012345678')).toEqual({ kind: 'discord', discordChannelId: null, discordMessageId: '323456789012345678' });
    expect(parseModerationMessageReference('hello')).toBeNull();
  });

  test('deletes the FCM message linked to a bridged Discord message link', async () => {
    mockPrisma.discordMessageLink.findFirst.mockResolvedValue({ messageId: '44444444-4444-4444-8444-444444444444' });
    const interaction = await run(command('moderate', 'delete-message', {
      'message-id': 'https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678',
    }));
    expect(mockPrisma.discordMessageLink.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { discordMessageId: '323456789012345678', discordChannelId: '223456789012345678' },
    }));
    expect(mockModeration.deleteMessageById).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444', MOD.id, expect.any(String));
    expect(lastReply(interaction)).toBe('Message deleted.');
  });

  test('rejects unrecognised input and unlinked Discord messages', async () => {
    let interaction = await run(command('moderate', 'delete-message', { 'message-id': 'oops' }));
    expect(lastReply(interaction)).toMatch(/Paste an FCM message ID/);
    mockPrisma.discordMessageLink.findFirst.mockResolvedValue(null);
    interaction = await run(command('moderate', 'delete-message', { 'message-id': '323456789012345678' }));
    expect(lastReply(interaction)).toMatch(/not linked to an FCM chat message/);
    expect(mockModeration.deleteMessageById).not.toHaveBeenCalled();
  });
});

describe('/moderate failure and result replies', () => {
  test.each([
    [new ProtectedTargetError('moderator'), /protected staff role/],
    [new ModerationError('AlreadyBanned', 'Target is already banned'), /already banned/],
    [new ModerationError('BanNotFound', 'Ban not found'), /No FCM ban matches/],
    [new ModerationError('BanAlreadyReversed', 'Ban already reversed'), /already been reversed/],
    [new ModerationError('TargetNotFound', 'Target user not found'), /was not found/],
    [Object.assign(new Error('Missing Permissions'), { code: 50013 }), /missing a Discord permission/],
    [new Error('boom'), /Moderation action failed/],
  ])('maps %p to a specific private reply', (err, expected) => {
    expect(moderationFailureMessage(err)).toMatch(expected);
  });

  test('a protected target gets the specific reply through the command', async () => {
    mockModeration.createBan.mockRejectedValueOnce(new ProtectedTargetError('admin'));
    const interaction = await run(command('moderate', 'ban', { user: TARGET.id, reason: 'r', evidence: 'e' }));
    expect(lastReply(interaction)).toMatch(/protected staff role/);
  });

  test('mute of a player with no linked Discord account says no timeout was possible', async () => {
    mockModeration.muteUser.mockResolvedValue({ until: new Date('2026-11-13T12:00:00.000Z'), discordPropagated: false });
    const interaction = await run(command('moderate', 'mute', { user: TARGET.id, reason: 'r' }, { minutes: 10 }));
    expect(lastReply(interaction)).toBe('Muted Raider in FCM until 2026-11-13T12:00:00.000Z. No Discord timeout was applied because this player has no linked Discord account.');
  });
});

describe('/moderate ban reply', () => {
  const { banReplyText } = require('../src/services/discordOverlayCommandService');
  const until = new Date('2026-11-14T00:00:00.000Z');
  test('temporary bans report role removal instead of a missing guild ban', () => {
    expect(banReplyText('Raider', until, { guildBanApplied: null, warnings: [] }, true))
      .toBe('Banned Raider from FCM until 2026-11-14T00:00:00.000Z. Their Discord roles were removed for the ban (temporary bans do not ban from the server).');
  });
  test('permanent bans report the guild ban result', () => {
    expect(banReplyText('Raider', null, { guildBanApplied: true, warnings: [] }, true)).toBe('Banned Raider from FCM and Discord permanently.');
    expect(banReplyText('Raider', null, { guildBanApplied: false, warnings: ['missing Ban Members'] }, true)).toMatch(/Discord ban was not applied: missing Ban Members/);
  });
  test('players without a linked Discord account get an FCM-only reply', () => {
    expect(banReplyText('Raider', null, { guildBanApplied: null, warnings: [] }, false)).toMatch(/no linked Discord account/);
  });
});

describe('/report', () => {
  function autocomplete(focused) {
    return {
      commandName: 'report', user: { id: 'discord-player' },
      options: { getFocused: (full) => (full ? { name: 'user', value: focused } : focused) },
      isButton: () => false, isAutocomplete: () => true,
      respond: jest.fn(async () => undefined),
    };
  }
  const steamUser = {
    id: TARGET.id, chatName: null, username: 'pending-abc', steamDisplayName: 'RaiderSteam', steamId: '76561198000000001',
    discordId: '523456789012345678', discordDisplayName: 'RaiderDiscord', discordUsername: 'raider', fo76CharacterName: 'Rad', fo76AccountName: null,
  };

  test('returns nothing for empty or one-character queries (no recent-user dump)', async () => {
    for (const query of ['', 'r']) {
      const interaction = await run(autocomplete(query));
      expect(interaction.respond).toHaveBeenCalledWith([]);
    }
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  test('non-staff see only the public display name and cannot search by IDs', async () => {
    mockIsStaff.mockResolvedValue(false);
    mockPrisma.user.findMany.mockResolvedValue([steamUser]);
    const interaction = await run(autocomplete('raider'));
    const where = mockPrisma.user.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).not.toMatch(/steamId|discordId/);
    expect(interaction.respond).toHaveBeenCalledWith([{ name: 'RaiderSteam', value: TARGET.id }]);
  });

  test('staff keep the richer moderation label', async () => {
    mockPrisma.user.findMany.mockResolvedValue([steamUser]);
    const interaction = await run(autocomplete('raider'));
    expect(interaction.respond.mock.calls[0][0][0].name).toMatch(/RaiderSteam — RaiderDiscord/);
  });

  test('defers first and rate-limits a reporter to three reports per ten minutes', async () => {
    const replies = [];
    for (let i = 0; i < 4; i += 1) {
      const interaction = await run(command('report', 'bug', { description: `bug ${i}` }));
      expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(mockLookup.getUserByDiscordId.mock.invocationCallOrder.at(-1));
      replies.push(lastReply(interaction));
    }
    expect(mockPrisma.playerReport.create).toHaveBeenCalledTimes(3);
    expect(replies.slice(0, 3)).toEqual(Array(3).fill('Bug report submitted. Thank you.'));
    expect(replies[3]).toMatch(/You have sent 3 reports in the last 10 minutes\. Please wait 10 minutes/);
  });
});
