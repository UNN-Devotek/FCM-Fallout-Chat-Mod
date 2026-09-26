/**
 * Discord application-command surface for overlay slash commands.
 *
 * `/fcm command` is deliberately a generic bridge to commandService so newly
 * configured overlay commands work in every environment without a Discord bot
 * code change. The Fallout lookup commands also get first-class names and
 * publish their matching structured card as a public Discord embed.
 */
import {
  Client,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Interaction,
} from 'discord.js';
import env from '../config/environment';
import logger from '../config/logger';
import prisma from '../config/prisma';
import { buildHelpResponse, getCommands, tryHandleCommand, type ChatCommand, type CommandResult } from './commandService';
import { buildDiscordOverlayCard } from './discordOverlayCommandEmbeds';
import * as giveawayService from './giveawayService';
import { GiveawayError } from './giveawayService';
import { executeGiveawayButton, parseGiveawayButtonId } from './giveawayButtonAction';
import { splitDiscordResponse } from '../lib/discordResponsePagination';
import { searchEntries } from './wikiCatalogService';
import { searchCampItems } from './campService';
import { finalizeMessage } from './ingestMessage';
import { getUserByDiscordId, getUserById } from './userLookup';
import { getEffectiveRole, isPrivilegedRole } from './userRoleService';
import {
  REASON_CATEGORIES,
  createBan,
  deleteMessageById,
  kickUser,
  muteUser,
  reverseBan,
  unmuteUser,
} from './moderationActionsService';

const COMMAND_NAME = 'fcm';
const MODERATION_COMMAND = 'moderate';
const SPECIAL_COMMANDS = new Set(['wiki', 'camp', 'minerva', 'nukecodes', 'serverstatus', 'help', 'appearance', 'events', 'giveaway', 'apply', 'keybinds']);
const RESERVED_COMMAND_NAMES = new Set([COMMAND_NAME, MODERATION_COMMAND, 'report', ...SPECIAL_COMMANDS]);

type CommandContext = { channelId: string; channelName: string; parentChannelId: string | null; isLinked: boolean };
type PrivateCommandResult = {
  handled: true;
  actionType: 'private';
  botMessage: string;
  targetChannelId: string;
  metadata?: Record<string, unknown> | null;
};
type OverlayCardCommandResult = {
  handled: true;
  actionType: 'private' | 'message';
  botMessage: string;
  targetChannelId: string;
  metadata: Record<string, unknown>;
};

// Resolve this only after module initialization. moderationActionsService also
// reaches Discord services, so evaluating its exported category constant while
// the circular module graph is loading fails under Jest's module isolation.
function moderationCategoryChoices() {
  return REASON_CATEGORIES.map((name) => ({ name, value: name }));
}

/** Converts an overlay event trigger to a valid, non-reserved Discord command name. */
export function discordEventShortcutName(trigger: string): string | null {
  const name = trigger.startsWith('/') ? trigger.slice(1).toLowerCase() : '';
  if (!/^[a-z0-9_-]{1,32}$/.test(name) || RESERVED_COMMAND_NAMES.has(name)) return null;
  return name;
}

/**
 * Discord card commands belong to the channel where their interaction runs.
 * Giveaways publish their own canonical Events card from giveawayService.
 */
export function shouldRelayDiscordResultToOverlay(
  raw: string,
  result: CommandResult,
): result is PrivateCommandResult {
  return false;
}

/** A rich card mirrors to FCM only when its Discord channel has an FCM link. */
export function shouldMirrorDiscordCardToOverlay(
  isLinked: boolean,
  result: CommandResult,
): result is OverlayCardCommandResult {
  if (!isLinked || !result.handled || (result.actionType !== 'private' && result.actionType !== 'message')) return false;
  return result.metadata != null && buildDiscordOverlayCard(result.metadata) !== null;
}

function clip(value: string, limit = 1_900): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

async function replyWithPrivatePages(interaction: ChatInputCommandInteraction, value: string): Promise<void> {
  const [heading, ...body] = value.split('\n');
  const [first, ...rest] = splitDiscordResponse(body.join('\n').trim(), 4_000);
  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle(heading.replace(/^◈\s*/, '')).setColor(0xf1c40f).setDescription(first)],
  });
  for (const page of rest) {
    await interaction.followUp({
      embeds: [new EmbedBuilder().setTitle(`${heading.replace(/^◈\s*/, '')} (continued)`).setColor(0xf1c40f).setDescription(page)],
    });
  }
}

async function resolveContext(discordChannelId: string): Promise<CommandContext | null> {
  const explicit = await prisma.discordRelayMapping.findFirst({
    where: { discordChannelId },
    select: { inGameChannelId: true },
  });
  let channel = explicit
    ? await prisma.channel.findUnique({
      where: { id: explicit.inGameChannelId },
      select: { id: true, name: true, parentId: true },
    })
    : null;
  let isLinked = channel !== null;
  if (!channel) {
    channel = await prisma.channel.findFirst({
      where: { discordChannelId },
      select: { id: true, name: true, parentId: true },
    });
    isLinked = channel !== null;
  }
  if (!channel) {
    // First-class slash commands are allowed in every Discord channel where
    // the bot can respond. Unmapped command cards use General as their
    // FCM/HUD destination while mapped channels retain their own target.
    channel = await prisma.channel.findFirst({
      where: { name: 'General' },
      select: { id: true, name: true, parentId: true },
    });
  }
  return channel ? { channelId: channel.id, channelName: channel.name, parentChannelId: channel.parentId, isLinked } : null;
}

async function requireLinkedUser(interaction: ChatInputCommandInteraction) {
  const user = await getUserByDiscordId(interaction.user.id);
  if (!user) {
    await interaction.reply({
      content: `Link your Discord account to Fallout Chat Mod first: ${env.FCM_PUBLIC_BASE_URL}/link`,
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return user;
}

function commandText(interaction: ChatInputCommandInteraction): string | null {
  if (interaction.commandName === COMMAND_NAME) return interaction.options.getString('command', true).trim();
  if (!SPECIAL_COMMANDS.has(interaction.commandName)) return null;
  switch (interaction.commandName) {
    case 'wiki': return `/wiki ${interaction.options.getString('query', true)}`;
    case 'camp': return `/camp ${interaction.options.getString('item', true)}`;
    case 'minerva': return '/minerva';
    case 'nukecodes': return '/nukecodes';
    case 'serverstatus': return '/serverstatus';
    case 'giveaway': return `/giveaway ${interaction.options.getString('command', true)}`;
    case 'apply': return '/apply';
    default: return null;
  }
}

async function replyForCommand(interaction: ChatInputCommandInteraction, result: CommandResult): Promise<void> {
  if (!result.handled) {
    await interaction.reply({ content: 'Unknown command. Use `/fcm command:/help` for the available overlay commands.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (result.actionType === 'report') {
    await interaction.reply({ content: 'Use `/moderate` for staff actions or the overlay report form for player reports.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (result.actionType === 'relay') {
    await interaction.reply({ content: `Sent: ${clip(result.relayContent)}`, flags: MessageFlags.Ephemeral });
    return;
  }

  const card = result.metadata ? buildDiscordOverlayCard(result.metadata) : null;
  if (card) {
    const embed = new EmbedBuilder()
      .setTitle(card.title)
      .setColor(card.color)
      .setFooter({ text: card.footerText })
      .addFields(card.fields.slice(0, 25));
    if (card.description) embed.setDescription(card.description);
    if (card.url) embed.setURL(card.url);
    if (card.thumbnailUrl) embed.setThumbnail(card.thumbnailUrl);
    if (card.imageUrl) embed.setImage(card.imageUrl);
    await interaction.reply({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
    return;
  }
  const privateReply = ['apply', 'giveaway'].includes(interaction.commandName)
    || (interaction.commandName === COMMAND_NAME && commandText(interaction)?.toLowerCase().startsWith('/giveaway'));
  await interaction.reply({ content: clip(result.botMessage), ...(privateReply ? { flags: MessageFlags.Ephemeral } : {}) });
}

function buildKeybindsEmbed(): EmbedBuilder {
  return new EmbedBuilder().setTitle('Fallout Chat Mod Default Keybinds').setColor(0xf1c40f).addFields(
    { name: 'Overlay', value: '`Insert` Focus chat · `Delete` Show/hide · `End` Click-through\n`PageUp/PageDown` Previous/next channel · `Home` Settings\n`\\` Recent party · `/` Fallout 76 / General tab', inline: false },
    { name: 'HUD Mod (optional .ba2)', value: '`Insert` Open chat · `Enter` Send · `Escape` / `Tab` Cancel\n`PageUp/PageDown` Change FCM channel · `ArrowUp/ArrowDown` Scroll feed\n`F11` HUDModLoader menu', inline: false },
  ).setFooter({ text: 'All overlay binds can be changed in Settings.' });
}

async function handleOverlayCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === 'help') {
    await replyWithPrivatePages(interaction, buildHelpResponse(await getCommands(), { includeParty: false, discordUsage: true }));
    return;
  }
  if (interaction.commandName === 'appearance') {
    await interaction.reply({ content: 'Use `/name` to set your chat name and `/cosmetics` to manage your appearance.' });
    return;
  }
  if (interaction.commandName === 'keybinds') {
    await interaction.reply({ embeds: [buildKeybindsEmbed()] });
    return;
  }
  if (interaction.commandName === 'events') {
    await handleEventsCommand(interaction);
    return;
  }
  const raw = commandText(interaction);
  if (!raw?.startsWith('/')) return;
  const [user, mappedContext] = await Promise.all([requireLinkedUser(interaction), resolveContext(interaction.channelId)]);
  if (!user) return;
  const context = mappedContext ?? { channelId: interaction.channelId, channelName: 'Discord', parentChannelId: null, isLinked: false };
  const displayName = user.chatName ?? user.discordDisplayName ?? user.discordUsername ?? user.username;
  const result = await tryHandleCommand(raw, user.id, displayName, context.channelId, context.channelName, null, 0, context.parentChannelId);
  if (result.handled && result.actionType === 'relay') {
    await finalizeMessage({
      userId: user.id,
      channelId: result.targetChannelId,
      content: result.relayContent,
      displayName,
      source: 'discord',
      waitForPersistence: true,
    });
  }
  await replyForCommand(interaction, result);
  if (shouldMirrorDiscordCardToOverlay(context.isLinked, result)) {
    await finalizeMessage({
      userId: user.id,
      channelId: result.targetChannelId,
      content: result.botMessage,
      displayName: 'FCM',
      source: 'discord',
      metadata: result.metadata,
      suppressDiscordRelay: true,
      waitForPersistence: true,
    });
  }
}

async function handleGiveawayButton(interaction: ButtonInteraction): Promise<void> {
  const button = parseGiveawayButtonId(interaction.customId);
  if (!button) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = await getUserByDiscordId(interaction.user.id);
  if (!user) {
    await interaction.editReply(`Link your Discord account first: ${env.FCM_PUBLIC_BASE_URL}/link`);
    return;
  }
  const displayName = user.chatName ?? user.discordDisplayName ?? user.discordUsername ?? user.username;
  try {
    const isMod = button.action === 'stop' && isPrivilegedRole(await getEffectiveRole(user.id));
    const message = await executeGiveawayButton(button, { id: user.id, displayName, isMod }, giveawayService);
    await interaction.editReply(message);
  } catch (err) {
    await interaction.editReply(err instanceof GiveawayError ? err.message : 'Giveaway action failed. Please try again.');
  }
}

async function handleEventsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const eventCommands = (await getCommands()).filter((command) => command.actionType === 'announce');
  const requested = interaction.options.getString('command');
  if (!requested) {
    const lines = eventCommands.length === 0
      ? ['No event commands are configured right now.']
      : eventCommands.map((command) => `${command.trigger}${command.alias ? ` (${command.alias})` : ''} — ${command.description}`);
    await interaction.reply({ content: clip(`Event commands:\n${lines.join('\n')}`), flags: MessageFlags.Ephemeral });
    return;
  }
  await runEventCommand(interaction, requested.trim().toLowerCase(), eventCommands);
}

/**
 * Sends a Discord event interaction through the same command and finalization
 * pipeline used by overlay announcements, preserving the Event channel target.
 */
async function runEventCommand(
  interaction: ChatInputCommandInteraction,
  raw: string,
  eventCommands: ChatCommand[],
): Promise<void> {
  const trigger = raw.split(/\s+/, 1)[0];
  const configured = eventCommands.find((command) => command.trigger === trigger || command.alias === trigger);
  if (!configured) {
    await interaction.reply({ content: 'That is not an available event command. Run `/events` to see the list.', flags: MessageFlags.Ephemeral });
    return;
  }
  const [user, mappedContext] = await Promise.all([requireLinkedUser(interaction), resolveContext(interaction.channelId)]);
  if (!user) return;
  const context = mappedContext ?? { channelId: interaction.channelId, channelName: 'Discord', parentChannelId: null, isLinked: false };
  const displayName = user.chatName ?? user.discordDisplayName ?? user.discordUsername ?? user.username;
  const result = await tryHandleCommand(raw, user.id, displayName, context.channelId, context.channelName, null, 0, context.parentChannelId);
  if (!result.handled || result.actionType !== 'relay') {
    await interaction.reply({ content: 'That event command could not be run.', flags: MessageFlags.Ephemeral });
    return;
  }
  await finalizeMessage({
    userId: user.id,
    channelId: result.targetChannelId,
    content: result.relayContent,
    displayName,
    source: 'discord',
    waitForPersistence: true,
  });
  await interaction.reply({ content: 'Event announcement sent.', flags: MessageFlags.Ephemeral });
}

async function requireModerator(interaction: ChatInputCommandInteraction) {
  const actor = await requireLinkedUser(interaction);
  if (!actor) return null;
  const role = await getEffectiveRole(actor.id);
  if (!isPrivilegedRole(role)) {
    await interaction.reply({ content: 'Only Fallout Chat Mod moderators and admins can use this command.', flags: MessageFlags.Ephemeral });
    return null;
  }
  return actor;
}

async function requireTarget(interaction: ChatInputCommandInteraction) {
  const userId = interaction.options.getString('user', true);
  const target = await getUserById(userId);
  if (!target) {
    await interaction.reply({ content: 'That Discord member has no linked Fallout Chat Mod account.', flags: MessageFlags.Ephemeral });
    return null;
  }
  return target;
}

function moderationTargetLabel(user: { chatName: string | null; username: string; discordDisplayName: string | null; discordUsername: string | null; discordId: string | null; steamId: string | null; steamDisplayName: string | null }): string {
  const chatIdentity = user.chatName || user.username;
  const identities = [
    user.discordDisplayName || user.discordUsername || user.discordId,
    user.steamDisplayName || user.steamId,
  ].filter(Boolean).join(' · ');
  return `${chatIdentity}${identities ? ` — ${identities}` : ''}`.slice(0, 100);
}

async function handleModerationAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== MODERATION_COMMAND || interaction.options.getFocused(true).name !== 'user') return;
  try {
    const actor = await getUserByDiscordId(interaction.user.id);
    if (!actor || !isPrivilegedRole(await getEffectiveRole(actor.id))) {
      await interaction.respond([]);
      return;
    }
    const query = interaction.options.getFocused().trim();
    const users = await prisma.user.findMany({
      where: {
        ...(query ? {
          OR: [
            { discordId: { contains: query } },
            { steamId: { contains: query, mode: 'insensitive' } },
            { steamDisplayName: { contains: query, mode: 'insensitive' } },
            { fo76AccountName: { contains: query, mode: 'insensitive' } },
            { fo76CharacterName: { contains: query, mode: 'insensitive' } },
            { chatName: { contains: query, mode: 'insensitive' } },
            { username: { contains: query, mode: 'insensitive' } },
            { discordUsername: { contains: query, mode: 'insensitive' } },
            { discordDisplayName: { contains: query, mode: 'insensitive' } },
          ],
        } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 25,
      select: { id: true, chatName: true, username: true, discordDisplayName: true, discordUsername: true, discordId: true, steamId: true, steamDisplayName: true },
    });
    await interaction.respond(users.map((user) => ({ name: moderationTargetLabel(user), value: user.id })));
  } catch (err) {
    logger.warn({ err, discordUserId: interaction.user.id }, '[discord-overlay-commands] moderation target autocomplete failed');
    await interaction.respond([]).catch(() => {});
  }
}

async function handleLookupAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().trim();
  if (!focused) return void interaction.respond([]);
  try {
    if (interaction.commandName === 'wiki') {
      const matches = await searchEntries(focused, 25);
      await interaction.respond(matches.map((match) => ({
        name: `${match.name}${match.kind ? ` — ${match.kind}` : ''}`.slice(0, 100),
        value: match.name.slice(0, 100),
      })));
      return;
    }
    if (interaction.commandName === 'camp') {
      const matches = await searchCampItems(focused, 25);
      await interaction.respond(matches.map((match) => ({
        name: `${match.name} — ${match.category}`.slice(0, 100),
        value: match.name.slice(0, 100),
      })));
      return;
    }
  } catch (err) {
    logger.warn({ err, command: interaction.commandName }, '[discord-overlay-commands] lookup autocomplete failed');
  }
  await interaction.respond([]).catch(() => {});
}

async function handleReportAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== 'report' || interaction.options.getFocused(true).name !== 'user') return;
  try {
    const query = interaction.options.getFocused().trim();
    const users = await prisma.user.findMany({
      where: query ? { OR: [
        { discordId: { contains: query } }, { steamId: { contains: query, mode: 'insensitive' } },
        { steamDisplayName: { contains: query, mode: 'insensitive' } }, { chatName: { contains: query, mode: 'insensitive' } },
        { username: { contains: query, mode: 'insensitive' } }, { discordUsername: { contains: query, mode: 'insensitive' } },
        { discordDisplayName: { contains: query, mode: 'insensitive' } },
      ] } : {},
      orderBy: { updatedAt: 'desc' }, take: 25,
      select: { id: true, chatName: true, username: true, discordDisplayName: true, discordUsername: true, discordId: true, steamId: true, steamDisplayName: true },
    });
    await interaction.respond(users.map((user) => ({ name: moderationTargetLabel(user), value: user.id })));
  } catch (err) {
    logger.warn({ err, discordUserId: interaction.user.id }, '[discord-overlay-commands] report target autocomplete failed');
    await interaction.respond([]).catch(() => {});
  }
}

async function handleReportCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const reporter = await requireLinkedUser(interaction);
  if (!reporter) return;
  const type = interaction.options.getSubcommand(true) as 'bug' | 'player';
  const description = interaction.options.getString('description', true).trim();
  const target = type === 'player' ? await getUserById(interaction.options.getString('user', true)) : null;
  if (type === 'player' && !target) {
    await interaction.reply({ content: 'Choose a valid FCM player from the search results.', flags: MessageFlags.Ephemeral });
    return;
  }
  const involvedPlayers = target ? (target.chatName ?? target.discordDisplayName ?? target.discordUsername ?? target.username) : null;
  const content = target ? `${involvedPlayers}: ${description}` : description;
  const report = await prisma.playerReport.create({ data: { userId: reporter.id, content, reportType: type, involvedPlayers } });
  try {
    // Lazy import avoids the discordService -> command service initialization cycle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { postModAlert } = require('./discordService') as { postModAlert: (data: unknown) => Promise<unknown> };
    void postModAlert({ title: `${type === 'bug' ? 'Bug' : 'Player'} Report Submitted`, color: '#FF8C00', fields: [{ name: 'Reporter', value: reporter.chatName ?? reporter.username, inline: true }, { name: 'Content', value: content.slice(0, 1500) }], footerText: `Report ID: ${report.id}`, timestamp: true });
  } catch { /* bot alert is best-effort; the report is persisted first */ }
  await interaction.reply({ content: type === 'bug' ? 'Bug report submitted. Thank you.' : 'Player report submitted to the moderation team.', flags: MessageFlags.Ephemeral });
}

async function handleModeration(interaction: ChatInputCommandInteraction): Promise<void> {
  const actor = await requireModerator(interaction);
  if (!actor) return;
  const subcommand = interaction.options.getSubcommand(true);
  try {
    if (subcommand === 'unban') {
      await reverseBan(interaction.options.getString('ban-id', true), actor.id, interaction.options.getString('reason') ?? 'Reversed from Discord');
      await interaction.reply({ content: 'Ban reversed.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'delete-message') {
      await deleteMessageById(interaction.options.getString('message-id', true), actor.id, interaction.options.getString('reason') ?? 'Removed from Discord moderation command');
      await interaction.reply({ content: 'Message deleted.', flags: MessageFlags.Ephemeral });
      return;
    }

    const target = await requireTarget(interaction);
    if (!target) return;
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    if (subcommand === 'kick') {
      const result = await kickUser(target.id, actor.id, reason, { kickDiscord: true });
      await interaction.reply({
        content: result.discordKicked
          ? `Kicked ${target.chatName ?? target.username} from FCM and Discord.`
          : `Kicked ${target.chatName ?? target.username} from FCM. Discord kick was not applied: ${result.discordWarning ?? 'no linked Discord account'}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (subcommand === 'mute') {
      const minutes = interaction.options.getInteger('minutes', true);
      const category = interaction.options.getString('category') ?? 'Other';
      const result = await muteUser(target.id, actor.id, minutes * 60_000, category, reason);
      await interaction.reply({
        content: result.discordPropagated
          ? `Muted ${target.chatName ?? target.username} in FCM and Discord until ${result.until.toISOString()}.`
          : `Muted ${target.chatName ?? target.username} in FCM until ${result.until.toISOString()}, but the Discord timeout was not applied. Check bot permissions and role hierarchy.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (subcommand === 'unmute') {
      await unmuteUser(target.id, actor.id, reason);
      await interaction.reply({ content: `Unmuted ${target.chatName ?? target.username}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'ban') {
      const minutes = interaction.options.getInteger('minutes');
      const until = minutes ? new Date(Date.now() + minutes * 60_000) : null;
      const category = interaction.options.getString('category') ?? 'Other';
      const evidence = interaction.options.getString('evidence', true);
      const result = await createBan(target.id, actor.id, category, reason, until, [{ type: 'text', textContent: evidence }], { banDiscord: true });
      await interaction.reply({
        content: result.discordLockdown.guildBanApplied
          ? `Banned ${target.chatName ?? target.username} from FCM and Discord${until ? ` until ${until.toISOString()}` : ' permanently'}.`
          : `Banned ${target.chatName ?? target.username} from FCM, but Discord ban was not applied: ${result.discordLockdown.warnings.join(' ') || 'check Ban Members permission and role hierarchy'}.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    logger.warn({ err, command: subcommand, actorId: actor.id }, '[discord-overlay-commands] moderation action failed');
    await interaction.reply({ content: 'Moderation action failed. Check the target, permissions, and audit log.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

function buildOverlayCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription('Run an Fallout Chat Mod overlay command')
    .setDMPermission(false)
    .addStringOption((option) => option.setName('command').setDescription('For example: /help or /g hello').setRequired(true))
    .toJSON();
}

function buildSpecialCommand(name: string, description: string, option?: { name: string; description: string; autocomplete?: boolean }) {
  const command = new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
  if (option) command.addStringOption((input) => input.setName(option.name).setDescription(option.description).setRequired(true).setAutocomplete(option.autocomplete ?? false));
  return command.toJSON();
}

function buildReportCommand() {
  return new SlashCommandBuilder().setName('report').setDescription('Submit a bug or player report').setDMPermission(false)
    .addSubcommand((sub) => sub.setName('bug').setDescription('Report a bug').addStringOption((option) => option.setName('description').setDescription('What happened, steps, and expected result').setRequired(true)))
    .addSubcommand((sub) => sub.setName('player').setDescription('Report a player').addStringOption((option) => option.setName('user').setDescription('Search by FCM, Discord, Steam name, or ID').setAutocomplete(true).setRequired(true)).addStringOption((option) => option.setName('description').setDescription('Reason and details').setRequired(true)))
    .toJSON();
}

function buildEventsCommand() {
  return new SlashCommandBuilder()
    .setName('events')
    .setDescription('List or run Fallout Chat Mod event commands')
    .setDMPermission(false)
    .addStringOption((option) => option.setName('command').setDescription('Event command, for example /ss').setRequired(false))
    .toJSON();
}

function buildEventShortcutCommand(command: ChatCommand) {
  const name = discordEventShortcutName(command.trigger);
  if (!name) return null;
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(command.description.slice(0, 100))
    .setDMPermission(false)
    .toJSON();
}

function buildModerationCommand() {
  return new SlashCommandBuilder()
    .setName(MODERATION_COMMAND)
    .setDescription('Fallout Chat Mod moderation actions')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((sub) => sub.setName('kick').setDescription('Kick an FCM user for five minutes').addStringOption((opt) => opt.setName('user').setDescription('Search FCM, Discord, Steam name, or ID').setAutocomplete(true).setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand((sub) => sub.setName('mute').setDescription('Mute an FCM user').addStringOption((opt) => opt.setName('user').setDescription('Search FCM, Discord, Steam name, or ID').setAutocomplete(true).setRequired(true)).addIntegerOption((opt) => opt.setName('minutes').setDescription('1–40320 minutes').setMinValue(1).setMaxValue(40_320).setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(true)).addStringOption((opt) => opt.setName('category').setDescription('Category').addChoices(...moderationCategoryChoices())))
    .addSubcommand((sub) => sub.setName('unmute').setDescription('Unmute an FCM user').addStringOption((opt) => opt.setName('user').setDescription('Search FCM, Discord, Steam name, or ID').setAutocomplete(true).setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason')))
    .addSubcommand((sub) => sub.setName('ban').setDescription('Ban an FCM user').addStringOption((opt) => opt.setName('user').setDescription('Search FCM, Discord, Steam name, or ID').setAutocomplete(true).setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(true)).addStringOption((opt) => opt.setName('evidence').setDescription('Evidence summary for the audit record').setRequired(true)).addIntegerOption((opt) => opt.setName('minutes').setDescription('Leave blank for permanent').setMinValue(1).setMaxValue(43_200)).addStringOption((opt) => opt.setName('category').setDescription('Category').addChoices(...moderationCategoryChoices())))
    .addSubcommand((sub) => sub.setName('unban').setDescription('Reverse a ban by FCM ban ID').addStringOption((opt) => opt.setName('ban-id').setDescription('Ban UUID').setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason')))
    .addSubcommand((sub) => sub.setName('delete-message').setDescription('Delete an FCM chat message by ID').addStringOption((opt) => opt.setName('message-id').setDescription('Message UUID').setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason')))
    .toJSON();
}

async function registerCommands(client: Client): Promise<void> {
  if (!env.DISCORD_SERVER_ID) return;
  const eventShortcuts = [];
  for (const eventCommand of (await getCommands()).filter((command) => command.actionType === 'announce')) {
    const shortcut = buildEventShortcutCommand(eventCommand);
    if (shortcut) eventShortcuts.push(shortcut);
  }
  const commands = [
    buildOverlayCommand(),
    buildSpecialCommand('wiki', 'Look up Fallout 76 wiki data', { name: 'query', description: 'Item, creature, weapon, perk, or location', autocomplete: true }),
    buildSpecialCommand('camp', 'Look up a CAMP item', { name: 'item', description: 'CAMP item name', autocomplete: true }),
    buildSpecialCommand('minerva', "Show Minerva's current or next sale"),
    buildSpecialCommand('nukecodes', 'Show current nuke launch codes'),
    buildSpecialCommand('serverstatus', 'Show Fallout 76 server status'),
    buildSpecialCommand('help', 'Show the private FCM quick command guide'),
    buildSpecialCommand('appearance', 'Show chat-name and appearance commands'),
    buildSpecialCommand('apply', 'Open the Fallout Chat Mod staff application'),
    buildSpecialCommand('keybinds', 'Show default overlay and HUD-mod keybinds'),
    buildSpecialCommand('giveaway', 'Run a Fallout Chat Mod giveaway command', { name: 'command', description: 'For example: list, join <id>, or start <item>' }),
    buildReportCommand(),
    buildEventsCommand(),
    buildModerationCommand(),
    ...eventShortcuts,
  ];
  const manager = client.application?.commands;
  if (!manager) return;
  const existing = await manager.fetch({ guildId: env.DISCORD_SERVER_ID });
  for (const command of commands) {
    const current = existing.find((registered) => registered.name === command.name);
    // discord.js's edit overload is narrower than SlashCommandBuilder's valid
    // REST JSON output even though the API accepts the same command payload.
    if (current) await current.edit(command as unknown as Parameters<typeof current.edit>[0]);
    else await manager.create(command, env.DISCORD_SERVER_ID);
  }
  // `/newcodes` was an accidental public alias. Remove it from existing guilds
  // as registration otherwise only creates/edits commands.
  const staleNewCodes = existing.find((registered) => registered.name === 'newcodes');
  if (staleNewCodes) await staleNewCodes.delete();
  logger.info({ count: commands.length, guildId: env.DISCORD_SERVER_ID }, '[discord-overlay-commands] registered');
}

async function onInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('fcm:giveaway:')) {
      await handleGiveawayButton(interaction).catch((err) => logger.error({ err }, '[discord-overlay-commands] giveaway button failed'));
    }
    return;
  }
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === MODERATION_COMMAND) await handleModerationAutocomplete(interaction);
    else if (interaction.commandName === 'wiki' || interaction.commandName === 'camp') await handleLookupAutocomplete(interaction);
    else if (interaction.commandName === 'report') await handleReportAutocomplete(interaction);
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === MODERATION_COMMAND) await handleModeration(interaction);
    else if (interaction.commandName === 'report') await handleReportCommand(interaction);
    else if (interaction.commandName === COMMAND_NAME || SPECIAL_COMMANDS.has(interaction.commandName)) await handleOverlayCommand(interaction);
    else {
      const shortcut = discordEventShortcutName(`/${interaction.commandName}`);
      if (!shortcut) return;
      await runEventCommand(interaction, `/${shortcut}`, (await getCommands()).filter((command) => command.actionType === 'announce'));
    }
  } catch (err) {
    logger.error({ err, command: interaction.commandName }, '[discord-overlay-commands] interaction failed');
    if (!interaction.replied) await interaction.reply({ content: 'Command failed. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

export function register(client: Client): void {
  client.on('interactionCreate', (interaction) => { void onInteraction(interaction); });
  client.once('ready', () => { void registerCommands(client).catch((err) => logger.warn({ err }, '[discord-overlay-commands] registration failed')); });
}

export default { register };
