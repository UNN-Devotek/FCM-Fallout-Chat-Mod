import { isPrismaAtomicRefusal, runRequiredBundle, runRequiredMutation } from '../lib/requiredEffects';
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
import { buildHelpResponse, getCommands, isStaffAccount, tryHandleCommand, type ChatCommand, type CommandResult } from './commandService';
import { buildDiscordOverlayCard } from './discordOverlayCommandEmbeds';
import * as giveawayService from './giveawayService';
import { GiveawayError } from './giveawayService';
import { executeGiveawayButton, parseGiveawayButtonId } from './giveawayButtonAction';
import { splitDiscordResponse } from '../lib/discordResponsePagination';
import { searchEntries } from './wikiCatalogService';
import { searchCampItems } from './campService';
import { finalizeMessage } from './ingestMessage';
import { publishDiscordCommandRelay } from './discordCommandPublication';
import { getUserByDiscordId, getUserById } from './userLookup';
import { DISPLAY_NAME_SELECT, isPlaceholderUsername, resolveUserDisplayName } from '../utils/userDisplayName';
import { createReportRateLimiter, REPORT_RATE_LIMIT } from './playerReportHelpers';
import {
  REASON_CATEGORIES,
  createBan,
  deleteMessageById,
  kickUser,
  muteUser,
  reverseBan,
  unbanUser,
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

type Responder = (content: string) => Promise<unknown>;

/** Private reply that works before or after `deferReply`. */
function ephemeralResponder(interaction: ChatInputCommandInteraction): Responder {
  return (content) => (interaction.deferred || interaction.replied
    ? interaction.editReply({ content })
    : interaction.reply({ content, flags: MessageFlags.Ephemeral }));
}

async function requireLinkedUser(interaction: ChatInputCommandInteraction, respond: Responder = ephemeralResponder(interaction)) {
  const user = await getUserByDiscordId(interaction.user.id);
  if (!user) {
    await respond(`Link your Discord account to Fallout Chat Mod first: ${env.FCM_PUBLIC_BASE_URL}/link`);
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
    if (!(await publishDiscordCommandRelay(interaction, {
      userId: user.id,
      channelId: result.targetChannelId,
      content: result.relayContent,
      displayName,
      source: 'discord',
      waitForPersistence: true,
    }, interaction.user.id, { rawInput: raw }))) {
      result.cancelCooldown?.();
      return;
    }
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
    const isMod = button.action === 'stop' && await isStaffAccount(user.id);
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
  if (!(await publishDiscordCommandRelay(interaction, {
    userId: user.id,
    channelId: result.targetChannelId,
    content: result.relayContent,
    displayName,
    source: 'discord',
    waitForPersistence: true,
  }, interaction.user.id, { rawInput: raw }))) {
    result.cancelCooldown?.();
    return;
  }
  await interaction.reply({ content: 'Event announcement sent.', flags: MessageFlags.Ephemeral });
}

async function requireModerator(interaction: ChatInputCommandInteraction, respond: Responder) {
  const actor = await requireLinkedUser(interaction, respond);
  if (!actor) return null;
  if (!(await isStaffAccount(actor.id))) {
    await respond('Only Fallout Chat Mod moderators and admins can use this command.');
    return null;
  }
  return actor;
}

const MODERATION_TARGET_SELECT = {
  id: true, chatName: true, username: true, discordDisplayName: true, discordUsername: true, discordId: true,
  steamId: true, steamDisplayName: true, fo76AccountName: true, fo76CharacterName: true,
} as const;

/** Searchable identity columns shared by the target autocomplete and typed-name fallback. */
function moderationTargetSearch(query: string, mode: 'contains' | 'equals') {
  const text = (field: string) => ({ [field]: { [mode]: query, mode: 'insensitive' as const } });
  return [
    { discordId: { [mode]: query } }, text('steamId'), text('steamDisplayName'), text('fo76AccountName'),
    text('fo76CharacterName'), text('chatName'), text('username'), text('discordUsername'), text('discordDisplayName'),
  ];
}

/** Name columns that can become the public chat display name (no IDs). */
function publicNameSearch(query: string) {
  return ['chatName', 'username', 'steamDisplayName', 'discordDisplayName', 'discordUsername', 'fo76CharacterName', 'fo76AccountName']
    .map((field) => ({ [field]: { contains: query, mode: 'insensitive' as const } }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISCORD_MESSAGE_LINK_RE = /^<?https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(?:\d{17,20}|@me)\/(\d{17,20})\/(\d{17,20})\/?>?$/i;
const SNOWFLAKE_RE = /^\d{17,20}$/;

/** `/moderate delete-message` input: an FCM message UUID, a Discord message link, or a Discord message ID. */
export function parseModerationMessageReference(raw: string):
  | { kind: 'fcm'; messageId: string }
  | { kind: 'discord'; discordMessageId: string; discordChannelId: string | null }
  | null {
  const value = raw.trim();
  if (UUID_RE.test(value)) return { kind: 'fcm', messageId: value.toLowerCase() };
  const link = value.match(DISCORD_MESSAGE_LINK_RE);
  if (link) return { kind: 'discord', discordChannelId: link[1], discordMessageId: link[2] };
  if (SNOWFLAKE_RE.test(value)) return { kind: 'discord', discordMessageId: value, discordChannelId: null };
  return null;
}

/**
 * Specific, private reply text for a failed moderation action. Service errors
 * carry a `code` (moderationErrors.ts) or `name`; older ones only a message.
 * Unknown failures keep the generic text (the caller logs the underlying error).
 */
export function moderationFailureMessage(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; name?: unknown; message?: unknown; status?: unknown };
  const tokens = [e.code, e.name].filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, ''));
  const message = typeof e.message === 'string' ? e.message : '';
  const lower = message.toLowerCase();
  const has = (...keys: string[]) => tokens.some((token) => keys.some((key) => token === key || token === `${key}error`));
  if (has('protectedtarget') || lower.includes('protected role')) {
    return 'That player holds a protected staff role. Remove the staff role in Discord before taking this action.';
  }
  if (has('protectioncheckfailed')) return 'Could not verify that the target is not staff, so nothing was changed. Try again shortly.';
  if (has('alreadybanned') || lower.includes('already banned')) return 'That player is already banned. Use `/moderate unban` first to change the ban.';
  if (has('notbanned')) return 'That player has no active FCM ban.';
  if (has('banalreadyreversed') || lower.includes('already reversed')) return 'That ban has already been reversed.';
  if (has('bannotfound') || lower.includes('ban not found')) return 'No FCM ban matches that ban ID.';
  if (has('messagenotfound') || lower.includes('message not found')) return 'That message was not found or was already deleted.';
  if (has('targetnotfound', 'usernotfound', 'p2025') || lower.includes('not found')) return 'That player or record was not found. Pick the player from the search list.';
  if (has('invalidinput') && message) return message.slice(0, 300);
  if (has('missingpermissions', '50013') || e.status === 403 || lower.includes('missing permissions')) {
    return 'The action was refused because the bot is missing a Discord permission or sits below the target in the role hierarchy.';
  }
  return 'Moderation action failed. Check the target, permissions, and audit log.';
}

async function requireTarget(interaction: ChatInputCommandInteraction, respond: Responder) {
  const raw = interaction.options.getString('user', true).trim();
  let target = UUID_RE.test(raw) ? await getUserById(raw) : null;
  if (!target && raw && !UUID_RE.test(raw)) {
    // Enter pressed before Discord delivered the autocomplete choice: the option
    // carries the typed text, not an FCM id. Accept it only when it names one player.
    const matches = await prisma.user.findMany({ where: { OR: moderationTargetSearch(raw, 'equals') }, select: { id: true }, take: 2 });
    if (matches.length === 1) target = await getUserById(matches[0].id);
    else {
      await respond(matches.length > 1
        ? `More than one FCM player matches "${raw.slice(0, 60)}". Pick the player from the search list.`
        : `No FCM player is named "${raw.slice(0, 60)}". Type part of their chat, Steam, FO76, or Discord name and pick them from the search list.`);
      return null;
    }
  }
  if (!target) {
    await respond('That player was not found. Pick the player from the search list.');
    return null;
  }
  return target;
}

type ModerationTargetLabelFields = Parameters<typeof resolveUserDisplayName>[0] & {
  discordId?: string | null; steamId?: string | null;
};

/** Autocomplete label: the name shown in chat, then the identities a moderator may recognise. */
export function moderationTargetLabel(user: ModerationTargetLabelFields): string {
  const shown = resolveUserDisplayName(user);
  const identities = [
    user.discordDisplayName || user.discordUsername || user.discordId,
    user.steamDisplayName || user.steamId,
    user.fo76CharacterName || user.fo76AccountName ? `FO76 ${user.fo76CharacterName || user.fo76AccountName}` : null,
  ].filter((value): value is string => !!value && value !== shown);
  return `${shown}${identities.length ? ` — ${identities.join(' · ')}` : ''}`.slice(0, 100);
}

async function isDiscordStaff(discordUserId: string): Promise<boolean> {
  const actor = await getUserByDiscordId(discordUserId);
  return !!actor && isStaffAccount(actor.id);
}

async function handleModerationAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== MODERATION_COMMAND || interaction.options.getFocused(true).name !== 'user') return;
  try {
    if (!(await isDiscordStaff(interaction.user.id))) {
      await interaction.respond([]);
      return;
    }
    const query = interaction.options.getFocused().trim();
    const users = await prisma.user.findMany({
      where: query ? { OR: moderationTargetSearch(query, 'contains') } : {},
      orderBy: { updatedAt: 'desc' },
      take: 25,
      select: MODERATION_TARGET_SELECT,
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

export const REPORT_SEARCH_MIN_LENGTH = 2;

/**
 * `/report player` search. Any guild member can run it, so it never lists
 * players without a query and, for non-staff, matches and shows only the
 * public chat display name (no Discord/Steam IDs or linked identities).
 * Staff keep the richer moderation label.
 */
async function handleReportAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== 'report' || interaction.options.getFocused(true).name !== 'user') return;
  try {
    const query = interaction.options.getFocused().trim();
    if (query.length < REPORT_SEARCH_MIN_LENGTH) {
      await interaction.respond([]);
      return;
    }
    if (await isDiscordStaff(interaction.user.id)) {
      const users = await prisma.user.findMany({
        where: { OR: moderationTargetSearch(query, 'contains') },
        orderBy: { updatedAt: 'desc' }, take: 25,
        select: MODERATION_TARGET_SELECT,
      });
      await interaction.respond(users.map((user) => ({ name: moderationTargetLabel(user), value: user.id })));
      return;
    }
    const users = await prisma.user.findMany({
      where: { OR: publicNameSearch(query) },
      orderBy: { updatedAt: 'desc' }, take: 50,
      select: { id: true, ...DISPLAY_NAME_SELECT },
    });
    const needle = query.toLowerCase();
    const choices = users
      .map((user) => ({ name: resolveUserDisplayName(user).slice(0, 100), value: user.id }))
      .filter((choice) => choice.name !== 'unknown' && !isPlaceholderUsername(choice.name) && choice.name.toLowerCase().includes(needle))
      .slice(0, 25);
    await interaction.respond(choices);
  } catch (err) {
    logger.warn({ err, discordUserId: interaction.user.id }, '[discord-overlay-commands] report target autocomplete failed');
    await interaction.respond([]).catch(() => {});
  }
}

const reportRateLimiter = createReportRateLimiter();

async function handleReportCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  // Acknowledge before any lookup so Discord never times the interaction out.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const respond = ephemeralResponder(interaction);
  return runRequiredBundle('domain', 'discordOverlayCommandService:4af3c7a2ceeb', async () => {
  const reporter = await requireLinkedUser(interaction, respond);
  if (!reporter) return;
  const type = interaction.options.getSubcommand(true) as 'bug' | 'player';
  const description = interaction.options.getString('description', true).trim();
  const target = type === 'player' ? await getUserById(interaction.options.getString('user', true)) : null;
  if (type === 'player' && !target) {
    await respond('Choose a valid FCM player from the search results.');
    return;
  }
  const limit = reportRateLimiter.take(interaction.user.id);
  if (!limit.allowed) {
    const minutes = Math.max(1, Math.ceil(limit.retryAfterMs / 60_000));
    await respond(`You have sent ${REPORT_RATE_LIMIT} reports in the last 10 minutes. Please wait ${minutes} minute${minutes === 1 ? '' : 's'} before sending another.`);
    return;
  }
  const involvedPlayers = target ? resolveUserDisplayName(target) : null;
  const content = target ? `${involvedPlayers}: ${description}` : description;
  const report = await runRequiredMutation('domain', '87b8a5ee8b1ffe62f2f2b09d', { stage: 'primary-write-unconfirmed', userId: reporter.id }, () => prisma.playerReport.create({ data: { userId: reporter.id, content, reportType: type, involvedPlayers } }), isPrismaAtomicRefusal, undefined, undefined);
  try {
    // Lazy import avoids the discordService -> command service initialization cycle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { postModAlert } = require('./discordService') as { postModAlert: (data: unknown) => Promise<unknown> };
    void postModAlert({ title: `${type === 'bug' ? 'Bug' : 'Player'} Report Submitted`, color: '#FF8C00', fields: [{ name: 'Reporter', value: resolveUserDisplayName(reporter), inline: true }, { name: 'Content', value: content.slice(0, 1500) }], footerText: `Report ID: ${report.id}`, timestamp: true });
  } catch { /* bot alert is best-effort; the report is persisted first */ }
  await respond(type === 'bug' ? 'Bug report submitted. Thank you.' : 'Player report submitted to the moderation team.');

  });
}

async function resolveModeratedMessageId(raw: string, respond: Responder): Promise<string | null> {
  const ref = parseModerationMessageReference(raw);
  if (!ref) {
    await respond('Paste an FCM message ID, a Discord message link, or a Discord message ID. (Right-click the bridged message in Discord and choose Copy Message Link.)');
    return null;
  }
  if (ref.kind === 'fcm') return ref.messageId;
  const link = await prisma.discordMessageLink.findFirst({
    where: { discordMessageId: ref.discordMessageId, ...(ref.discordChannelId ? { discordChannelId: ref.discordChannelId } : {}) },
    select: { messageId: true },
  });
  if (!link) {
    await respond('That Discord message is not linked to an FCM chat message. Only messages bridged between Discord and FCM can be deleted this way.');
    return null;
  }
  return link.messageId;
}

async function handleModeration(interaction: ChatInputCommandInteraction): Promise<void> {
  // Acknowledge before any database lookup: role, target and Discord
  // propagation can exceed Discord's 3-second reply window.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const respond = ephemeralResponder(interaction);
  const actor = await requireModerator(interaction, respond);
  if (!actor) return;
  const subcommand = interaction.options.getSubcommand(true);
  try {
    if (subcommand === 'unban') {
      const reason = interaction.options.getString('reason') ?? 'Reversed from Discord';
      const banIdRaw = interaction.options.getString('ban-id')?.trim() || null;
      const userRaw = interaction.options.getString('user')?.trim() || null;
      if (banIdRaw) {
        if (!UUID_RE.test(banIdRaw)) {
          await respond('That is not a valid FCM ban ID. Pick the banned player in the `user` option instead, or paste the ban ID from the dashboard or the Ban mod-log footer.');
          return;
        }
        await reverseBan(banIdRaw, actor.id, reason);
        await respond('Ban reversed.');
        return;
      }
      if (!userRaw) {
        await respond('Pick the banned player in the `user` option, or paste an FCM ban ID.');
        return;
      }
      const target = await requireTarget(interaction, respond);
      if (!target) return;
      // Reverses every active ban row (and a legacy flag-only ban) for the player.
      await unbanUser(target.id, actor.id, reason);
      await respond(`Ban on ${resolveUserDisplayName(target)} reversed.`);
      return;
    }
    if (subcommand === 'delete-message') {
      const messageId = await resolveModeratedMessageId(interaction.options.getString('message-id', true), respond);
      if (!messageId) return;
      await deleteMessageById(messageId, actor.id, interaction.options.getString('reason') ?? 'Removed from Discord moderation command');
      await respond('Message deleted.');
      return;
    }

    const target = await requireTarget(interaction, respond);
    if (!target) return;
    const reason = interaction.options.getString('reason') ?? 'No reason provided';
    const targetName = resolveUserDisplayName(target);
    if (subcommand === 'kick') {
      const result = await kickUser(target.id, actor.id, reason, { kickDiscord: true });
      await respond(result.discordKicked
          ? `Kicked ${targetName} from FCM and Discord.`
          : `Kicked ${targetName} from FCM. Discord kick was not applied: ${result.discordWarning ?? 'no linked Discord account'}.`);
      return;
    }
    if (subcommand === 'mute') {
      const minutes = interaction.options.getInteger('minutes', true);
      const category = interaction.options.getString('category') ?? 'Other';
      const result = await muteUser(target.id, actor.id, minutes * 60_000, category, reason);
      const until = result.until.toISOString();
      await respond(muteReplyText(targetName, until, result.discordPropagated, !!target.discordId));
      return;
    }
    if (subcommand === 'unmute') {
      await unmuteUser(target.id, actor.id, reason);
      await respond(`Unmuted ${targetName}.`);
      return;
    }
    if (subcommand === 'ban') {
      const minutes = interaction.options.getInteger('minutes');
      const until = minutes ? new Date(Date.now() + minutes * 60_000) : null;
      const category = interaction.options.getString('category') ?? 'Other';
      const evidence = interaction.options.getString('evidence', true);
      const result = await createBan(target.id, actor.id, category, reason, until, [{ type: 'text', textContent: evidence }], { banDiscord: true });
      await respond(banReplyText(targetName, until, result.discordLockdown, !!target.discordId));
    }
  } catch (err) {
    logger.warn({ err, command: subcommand, actorId: actor.id }, '[discord-overlay-commands] moderation action failed');
    await respond(moderationFailureMessage(err)).catch(() => {});
  }
}

/**
 * Ban result text. Permanent bans also guild-ban; temporary bans only strip
 * Discord roles (restored on expiry), so a missing guild ban is expected there.
 */
export function banReplyText(
  targetName: string,
  until: Date | null,
  lockdown: { guildBanApplied: boolean | null; warnings: string[] },
  hasLinkedDiscord: boolean,
): string {
  const warnings = lockdown.warnings.join(' ');
  if (!hasLinkedDiscord) {
    return `Banned ${targetName} from FCM${until ? ` until ${until.toISOString()}` : ' permanently'}. No Discord action was applied because this player has no linked Discord account.`;
  }
  if (until) {
    return `Banned ${targetName} from FCM until ${until.toISOString()}. Their Discord roles were removed for the ban (temporary bans do not ban from the server)${warnings ? `. Discord warnings: ${warnings}` : ''}.`;
  }
  return lockdown.guildBanApplied
    ? `Banned ${targetName} from FCM and Discord permanently.`
    : `Banned ${targetName} from FCM permanently, but the Discord ban was not applied: ${warnings || 'check Ban Members permission and role hierarchy'}.`;
}

/** Mute result text; an account without a linked Discord id cannot receive a Discord timeout. */
export function muteReplyText(targetName: string, untilIso: string, discordPropagated: boolean, hasLinkedDiscord: boolean): string {
  if (discordPropagated) return `Muted ${targetName} in FCM and Discord until ${untilIso}.`;
  if (!hasLinkedDiscord) return `Muted ${targetName} in FCM until ${untilIso}. No Discord timeout was applied because this player has no linked Discord account.`;
  return `Muted ${targetName} in FCM until ${untilIso}, but the Discord timeout was not applied. Check bot permissions and role hierarchy.`;
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
    // Visibility only: Manage Messages is held by the moderator role; FCM staff status is checked on every use.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) => sub.setName('kick').setDescription('Kick an FCM user for five minutes').addStringOption((opt) => opt.setName('user').setDescription('Search FCM, Discord, Steam name, or ID').setAutocomplete(true).setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(true)))
    .addSubcommand((sub) => sub.setName('mute').setDescription('Mute an FCM user').addStringOption((opt) => opt.setName('user').setDescription('Search FCM, Discord, Steam name, or ID').setAutocomplete(true).setRequired(true)).addIntegerOption((opt) => opt.setName('minutes').setDescription('1–40320 minutes').setMinValue(1).setMaxValue(40_320).setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(true)).addStringOption((opt) => opt.setName('category').setDescription('Category').addChoices(...moderationCategoryChoices())))
    .addSubcommand((sub) => sub.setName('unmute').setDescription('Unmute an FCM user').addStringOption((opt) => opt.setName('user').setDescription('Search FCM, Discord, Steam name, or ID').setAutocomplete(true).setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason')))
    .addSubcommand((sub) => sub.setName('ban').setDescription('Ban an FCM user').addStringOption((opt) => opt.setName('user').setDescription('Search FCM, Discord, Steam name, or ID').setAutocomplete(true).setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(true)).addStringOption((opt) => opt.setName('evidence').setDescription('Evidence summary for the audit record').setRequired(true)).addIntegerOption((opt) => opt.setName('minutes').setDescription('Leave blank for permanent').setMinValue(1).setMaxValue(43_200)).addStringOption((opt) => opt.setName('category').setDescription('Category').addChoices(...moderationCategoryChoices())))
    .addSubcommand((sub) => sub.setName('unban').setDescription("Reverse a player's active FCM ban").addStringOption((opt) => opt.setName('user').setDescription('Search FCM, Discord, Steam name, or ID').setAutocomplete(true)).addStringOption((opt) => opt.setName('ban-id').setDescription('Or an FCM ban ID from the dashboard or mod log')).addStringOption((opt) => opt.setName('reason').setDescription('Reason')))
    .addSubcommand((sub) => sub.setName('delete-message').setDescription('Delete a bridged FCM chat message').addStringOption((opt) => opt.setName('message-id').setDescription('Discord message link, Discord message ID, or FCM message ID').setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason')))
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
    if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: 'Command failed. Please try again.' }).catch(() => {});
    else if (!interaction.replied) await interaction.reply({ content: 'Command failed. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

export function register(client: Client): void {
  client.on('interactionCreate', (interaction) => { void onInteraction(interaction); });
  client.once('ready', () => { void registerCommands(client).catch((err) => logger.warn({ err }, '[discord-overlay-commands] registration failed')); });
}

export default { register };
