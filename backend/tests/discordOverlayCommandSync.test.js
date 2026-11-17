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
const { SlashCommandBuilder, ApplicationCommand, Client } = require('discord.js');
const { planCommandSync, commandMutationPacer } = require('../src/services/discordOverlayCommandService');

/**
 * Overlay slash-command registration ran ~15 unconditional edits on every boot, which
 * always hit Discord's 5-per-20-s route limit; the runtime client records that as a
 * required-effect failure and the next boot starts frozen.
 */
describe('overlay command registration sync', () => {
  const client = new Client({ intents: [] });
  // Same builder calls as buildSpecialCommand / buildEventShortcutCommand.
  const build = (description) => new SlashCommandBuilder().setName('wiki').setDescription(description).setDMPermission(false)
    .addStringOption((o) => o.setName('query').setDescription('Item, creature, weapon, perk, or location').setRequired(true).setAutocomplete(true)).toJSON();
  const shortcut = () => new SlashCommandBuilder().setName('gu').setDescription('Announce Gearing Up').setDMPermission(false).toJSON();
  // Exactly as Discord returned these guild commands for the Dev guild (2026-11-17).
  const stored = {
    wiki: { default_member_permissions: null, type: 1, name: 'wiki', description: 'Look up Fallout 76 wiki data', nsfw: false,
      options: [{ type: 3, name: 'query', description: 'Item, creature, weapon, perk, or location', required: true, autocomplete: true }] },
    gu: { default_member_permissions: null, type: 1, name: 'gu', description: 'Announce Gearing Up', nsfw: false },
  };
  const registered = (data) => {
    const command = new ApplicationCommand(client, { id: '1', application_id: '2', version: '3', guild_id: '4', ...data });
    command.edit = jest.fn(async () => command);
    command.delete = jest.fn(async () => undefined);
    return command;
  };

  afterAll(() => client.destroy());

  test('commands matching what Discord stores are not touched', () => {
    const plan = planCommandSync([build('Look up Fallout 76 wiki data'), shortcut()], [registered(stored.wiki), registered(stored.gu)]);
    expect(plan.changes.map((c) => c.command.name)).toEqual([]);
    expect(plan.stale).toBeUndefined();
  });

  test('changed commands are edited, missing ones created, the stale alias deleted', () => {
    const existingWiki = registered({ ...stored.wiki, description: 'Old text' });
    const stale = registered({ name: 'newcodes', description: 'old alias' });
    const camp = { ...build('x'), name: 'camp' };
    const plan = planCommandSync([build('Look up wiki data'), camp], [existingWiki, stale]);
    expect(plan.changes.map((c) => [c.command.name, c.current === existingWiki])).toEqual([['wiki', true], ['camp', false]]);
    expect(plan.stale).toBe(stale);
  });

  test('mutations are spaced so five never land inside a 20 s window', async () => {
    let clock = 0;
    const waits = [];
    const pace = commandMutationPacer(4_500, async (ms) => { waits.push(ms); clock += ms; }, () => clock);
    const at = [];
    for (let i = 0; i < 6; i++) { await pace(); at.push(clock); clock += 100; }
    expect(at[0]).toBe(0);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(4_500);
    expect(at[4] - at[0]).toBeGreaterThan(17_999);
    expect(waits).toHaveLength(5);
  });
});
