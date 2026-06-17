/**
 * Discord <-> GitHub ticketing.
 *
 * Increment 1 (outbound): an admin posts a panel embed via /ticket-panel; members
 * click "Report a Bug" / "Suggestion" -> a modal collects text -> the bot creates
 * a GitHub issue, adds it to the Bug & Suggestion board (Project v2 #2), opens a
 * public thread named "#<num> · <title>", and posts a summary with a staff-only
 * "Add to Roadmap" button. GitHub issues are text-only by design — attachments
 * live in the Discord thread.
 *
 * Attaches to the shared discord.js client via register() (no second login), the
 * same pattern as voiceService / reactionRoleService.
 *
 * Bot guild permissions required: Create Public Threads, Send Messages in Threads,
 * Manage Threads, Embed Links, Read Message History.
 */
import {
  Client,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  type Interaction,
  type TextChannel,
} from 'discord.js';
import env from '../config/environment';
import prisma from '../config/prisma';
import logger from '../config/logger';
import githubService from './githubService';
import {
  buildCustomId,
  parseCustomId,
  buildThreadName,
  buildIssueBody,
  labelForType,
  colorForType,
  displayForType,
  isStaff,
  isTicketType,
  type TicketType,
} from './githubTicketHelpers';

const PANEL_COMMAND = 'ticket-panel';

function staffRoleIds() {
  return {
    ownerRoleId: env.OWNER_ROLE_ID,
    adminRoleId: env.ADMIN_ROLE_ID,
    moderatorRoleId: env.MODERATOR_ROLE_ID,
    developerRoleId: env.DEVELOPER_ROLE_ID,
  };
}

/** Pull role ids off an interaction's member, tolerant of GuildMember vs raw API shapes. */
function memberRoleIds(interaction: any): string[] {
  const m = interaction.member;
  if (!m) return [];
  const roles = m.roles;
  if (roles?.cache) return [...roles.cache.keys()] as string[];
  if (Array.isArray(roles)) return roles as string[];
  return [];
}

async function ephem(interaction: any, content: string): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch {
    /* interaction expired — non-fatal */
  }
}

// ---------------------------------------------------------------------------
// UI builders
// ---------------------------------------------------------------------------
function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle('🛠️ Report a Bug or Suggest a Feature')
    .setDescription(
      'Found a problem or have an idea? Open a ticket below.\n\n' +
        '🐞 **Report a Bug** — something is broken or behaving wrong.\n' +
        '💡 **Suggestion** — an idea or feature request.\n\n' +
        'A public thread is created for your ticket — drop screenshots and details there. ' +
        'Each ticket is tracked on our GitHub board.',
    )
    .setColor(0x18ff62);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(buildCustomId('open', 'bug')).setLabel('Report a Bug').setEmoji('🐞').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(buildCustomId('open', 'suggestion')).setLabel('Suggestion').setEmoji('💡').setStyle(ButtonStyle.Primary),
  );
  return { embeds: [embed], components: [row] };
}

function buildModal(type: TicketType): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(buildCustomId('submit', type))
    .setTitle(type === 'bug' ? 'New Bug Report' : 'New Suggestion');

  const title = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('Title')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(200)
    .setRequired(true)
    .setPlaceholder(type === 'bug' ? 'Short summary of the bug' : 'Short summary of your idea');

  const description = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('Description')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(3800)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(title),
    new ActionRowBuilder<TextInputBuilder>().addComponents(description),
  );

  if (type === 'bug') {
    const steps = new TextInputBuilder()
      .setCustomId('steps')
      .setLabel('Steps to reproduce')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(3800)
      .setRequired(false);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(steps));
  }
  return modal;
}

function buildThreadIntro(opts: { type: TicketType; issue: { number: number; htmlUrl: string }; reporterId: string }) {
  const embed = new EmbedBuilder()
    .setTitle(`${displayForType(opts.type)} · #${opts.issue.number}`)
    .setURL(opts.issue.htmlUrl)
    .setDescription(
      `Thanks <@${opts.reporterId}>! This ticket is tracked on GitHub as [#${opts.issue.number}](${opts.issue.htmlUrl}).\n\n` +
        '📎 **Drop any screenshots or files here** so we can see what you mean. ' +
        'Anything you post in this thread is part of the discussion.',
    )
    .setColor(colorForType(opts.type));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('roadmap', String(opts.issue.number)))
      .setLabel('Add to Roadmap')
      .setEmoji('🗺️')
      .setStyle(ButtonStyle.Secondary),
  );
  return { content: `<@${opts.reporterId}>`, embeds: [embed], components: [row] };
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------
async function handlePanelCommand(interaction: any): Promise<void> {
  const perms = interaction.memberPermissions;
  if (!perms || !perms.has(PermissionFlagsBits.ManageGuild)) {
    return ephem(interaction, 'You need the Manage Server permission to post the ticket panel.');
  }
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    return ephem(interaction, 'Run this in a standard text channel.');
  }
  await (channel as TextChannel).send(buildPanel());
  return ephem(interaction, '✅ Ticket panel posted.');
}

async function handleOpenButton(interaction: any, type: TicketType): Promise<void> {
  if (!githubService.isConfigured()) {
    return ephem(interaction, 'GitHub integration is not configured yet — please tell an admin.');
  }
  await interaction.showModal(buildModal(type));
}

async function handleModalSubmit(interaction: any, type: TicketType): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    return ephem(interaction, 'Tickets can only be opened from a standard text channel.');
  }

  const title = interaction.fields.getTextInputValue('title').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const steps = type === 'bug' ? interaction.fields.getTextInputValue('steps')?.trim() : undefined;
  const reporterId = interaction.user.id;
  const reporterTag = interaction.user.tag || interaction.user.username;

  try {
    const issue = await githubService.createIssue({
      title,
      body: buildIssueBody({ type, description, steps, reporterTag, reporterId }),
      labels: [labelForType(type)],
    });

    // Both bugs and suggestions land on the Bug & Suggestion board (#2).
    await githubService
      .addIssueToProject(env.GITHUB_PROJECT_BUGS_NUMBER, issue.nodeId)
      .catch((err) => logger.warn({ err, issue: issue.number }, 'ticket: failed to add issue to bug board'));

    const thread = await (channel as TextChannel).threads.create({
      name: buildThreadName(issue.number, title),
      type: ChannelType.PublicThread,
      autoArchiveDuration: 10080,
      reason: `Ticket #${issue.number} (${type})`,
    });

    await thread.send(buildThreadIntro({ type, issue, reporterId })).catch((err) =>
      logger.warn({ err, threadId: thread.id }, 'ticket: failed to post thread intro'),
    );

    await prisma.githubIssueThread
      .create({
        data: {
          issueNumber: issue.number,
          issueNodeId: issue.nodeId,
          issueUrl: issue.htmlUrl,
          type,
          discordThreadId: thread.id,
          discordChannelId: channel.id,
          reporterId,
          isPrivate: false,
        },
      })
      .catch((err) => logger.error({ err, issue: issue.number }, 'ticket: failed to persist issue<->thread map'));

    logger.info({ issue: issue.number, type, threadId: thread.id }, 'ticket: created');
    return ephem(
      interaction,
      `✅ Created **#${issue.number}** — track it in <#${thread.id}>.\n${issue.htmlUrl}`,
    );
  } catch (err) {
    logger.error({ err, type }, 'ticket: creation failed');
    return ephem(interaction, '⚠️ Something went wrong creating your ticket. Please try again or ping a mod.');
  }
}

async function handleRoadmapButton(interaction: any, issueNumberRaw: string): Promise<void> {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!isAdmin && !isStaff(memberRoleIds(interaction), staffRoleIds())) {
    return ephem(interaction, 'Only staff can add tickets to the roadmap.');
  }
  const issueNumber = parseInt(issueNumberRaw, 10);
  if (!Number.isFinite(issueNumber)) return ephem(interaction, 'Could not determine the issue number.');

  await interaction.deferReply({ ephemeral: true });
  try {
    const map = await prisma.githubIssueThread.findUnique({ where: { issueNumber } });
    if (!map) return ephem(interaction, `No tracked ticket found for #${issueNumber}.`);

    await githubService.addIssueToProject(env.GITHUB_PROJECT_ROADMAP_NUMBER, map.issueNodeId);
    await githubService.addLabels(issueNumber, ['roadmap']).catch(() => {});
    logger.info({ issueNumber, by: interaction.user.id }, 'ticket: added to roadmap');
    return ephem(interaction, `🗺️ Added **#${issueNumber}** to the roadmap.`);
  } catch (err) {
    logger.error({ err, issueNumber }, 'ticket: roadmap add failed');
    return ephem(interaction, '⚠️ Failed to add to the roadmap. Check the GitHub token permissions.');
  }
}

async function onInteraction(interaction: Interaction): Promise<void> {
  try {
    const anyI = interaction as any;

    // Slash command
    if (anyI.isChatInputCommand?.()) {
      if (anyI.commandName === PANEL_COMMAND) await handlePanelCommand(anyI);
      return;
    }

    // Components / modals — only ours (ght: namespace)
    const parsed = parseCustomId(anyI.customId);
    if (!parsed.isOurs) return;

    if (anyI.isButton?.()) {
      if (parsed.action === 'open' && isTicketType(parsed.arg)) return handleOpenButton(anyI, parsed.arg);
      if (parsed.action === 'roadmap') return handleRoadmapButton(anyI, parsed.arg);
      return;
    }

    if (anyI.isModalSubmit?.()) {
      if (parsed.action === 'submit' && isTicketType(parsed.arg)) return handleModalSubmit(anyI, parsed.arg);
      return;
    }
  } catch (err) {
    logger.error({ err }, 'ticket: interaction handler error');
  }
}

// ---------------------------------------------------------------------------
// Slash command registration (guild-scoped, upsert-by-name on ready)
// ---------------------------------------------------------------------------
async function registerCommands(client: Client): Promise<void> {
  const guildId = env.DISCORD_SERVER_ID;
  if (!guildId) {
    logger.warn('ticket: DISCORD_SERVER_ID unset — slash commands not registered');
    return;
  }
  try {
    const panel = new SlashCommandBuilder()
      .setName(PANEL_COMMAND)
      .setDescription('Post the bug/suggestion ticket panel in this channel (staff only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .toJSON();
    // create() upserts by name — safe to call every boot, no duplicates.
    await client.application?.commands.create(panel, guildId);
    logger.info('ticket: slash commands registered');
  } catch (err) {
    logger.warn({ err }, 'ticket: failed to register slash commands');
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function register(client: Client): void {
  client.on('interactionCreate', onInteraction);
  client.once('ready', () => {
    void registerCommands(client);
  });
  logger.info('ticket: service registered');
}

export default { register };
module.exports = { register };
