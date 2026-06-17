/**
 * Discord <-> GitHub ticketing.
 *
 * Increment 1 (outbound). A staff member posts a panel via /ticket-panel; members
 * click "Report a Bug" / "Suggestion" (public) or staff click "Private Bug"
 * (gated) -> a modal collects text -> the bot creates a GitHub issue, adds it to
 * the Bug & Suggestion board (Project v2 #2), opens a thread named
 * "#<num> · <title>" (public, or private for the private-bug flow), and posts a
 * summary with a staff-only "Add to Roadmap" button and an optional milestone
 * picker. GitHub issues are text-only — attachments live in the Discord thread.
 *
 * After creating a thread the bot deletes Discord's "started a thread" system
 * message in the parent channel so the panel embed stays at the bottom.
 *
 * Attaches to the shared discord.js client via register() (no second login).
 *
 * Bot guild permissions: Create Public/Private Threads, Send Messages in Threads,
 * Manage Threads, Manage Messages (to delete the system message), Embed Links.
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
  StringSelectMenuBuilder,
  SlashCommandBuilder,
  MessageFlags,
  MessageType,
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

function isStaffInteraction(interaction: any): boolean {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return isStaff(memberRoleIds(interaction), staffRoleIds());
}

/** GitHub Projects v2 board URL for a user-owned project. */
function projectUrl(projectNumber: number): string {
  return `https://github.com/users/${env.GITHUB_OWNER}/projects/${projectNumber}`;
}

async function ephem(interaction: any, content: string, components?: any[]): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, components: components ?? [] });
    } else {
      await interaction.reply({ content, components: components ?? [], flags: MessageFlags.Ephemeral });
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
        '💡 **Suggestion** — an idea or feature request.\n' +
        '🔒 **Private Bug** — staff-only; opens a private thread.\n\n' +
        'A thread is created for your ticket — drop screenshots and details there. ' +
        'Each ticket is tracked on our GitHub boards.',
    )
    .addFields({
      name: '📋 Boards',
      value: `[Bug & Suggestion Board](${projectUrl(env.GITHUB_PROJECT_BUGS_NUMBER)}) · [Roadmap](${projectUrl(
        env.GITHUB_PROJECT_ROADMAP_NUMBER,
      )})`,
    })
    .setColor(0x18ff62);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(buildCustomId('open', 'bug')).setLabel('Report a Bug').setEmoji('🐞').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(buildCustomId('open', 'suggestion')).setLabel('Suggestion').setEmoji('💡').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(buildCustomId('open', 'support')).setLabel('Private Bug').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

function buildModal(type: TicketType): ModalBuilder {
  const titleByType: Record<TicketType, string> = {
    bug: 'New Bug Report',
    suggestion: 'New Suggestion',
    support: 'New Private Bug Report',
  };
  const modal = new ModalBuilder().setCustomId(buildCustomId('submit', type)).setTitle(titleByType[type]);

  const title = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('Title')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(200)
    .setRequired(true)
    .setPlaceholder(type === 'suggestion' ? 'Short summary of your idea' : 'Short summary of the bug');

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

  // Bug + Private Bug capture reproduction steps; Suggestion does not.
  if (type === 'bug' || type === 'support') {
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

/** Labels applied per flow. Private bug = bug + private; others = their single label. */
function labelsForType(type: TicketType): string[] {
  return type === 'support' ? ['bug', 'private'] : [labelForType(type)];
}

async function buildThreadComponents(issueNumber: number) {
  const rows: any[] = [];
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildCustomId('roadmap', String(issueNumber)))
        .setLabel('Add to Roadmap')
        .setEmoji('🗺️')
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  // Optional milestone picker — only if the repo has open milestones.
  try {
    const milestones = await githubService.listOpenMilestones();
    if (milestones.length) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(buildCustomId('milestone', String(issueNumber)))
        .setPlaceholder('Optionally set a roadmap milestone')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          { label: 'None (clear milestone)', value: 'none' },
          ...milestones.slice(0, 24).map((m) => ({ label: m.title.slice(0, 100), value: String(m.number) })),
        );
      rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    }
  } catch (err) {
    logger.warn({ err }, 'ticket: failed to load milestones for picker');
  }
  return rows;
}

async function buildThreadIntro(opts: {
  type: TicketType;
  issue: { number: number; htmlUrl: string };
  reporterId: string;
}) {
  const embed = new EmbedBuilder()
    .setTitle(`${displayForType(opts.type)} · #${opts.issue.number}`)
    .setURL(opts.issue.htmlUrl)
    .setDescription(
      `Thanks <@${opts.reporterId}>! Tracked on GitHub as [#${opts.issue.number}](${opts.issue.htmlUrl}).\n\n` +
        '📎 **Drop any screenshots or files here** so we can see what you mean. ' +
        'Anything posted in this thread is part of the discussion.',
    )
    .setColor(colorForType(opts.type));

  return { content: `<@${opts.reporterId}>`, embeds: [embed], components: await buildThreadComponents(opts.issue.number) };
}

/**
 * Delete Discord's "started a thread" system message in the parent channel, so the
 * panel embed stays at the bottom. Best-effort.
 */
async function deleteThreadSystemMessage(channel: TextChannel, threadId: string): Promise<void> {
  try {
    const recent = await channel.messages.fetch({ limit: 8 });
    const sys = recent.find(
      (m: any) => m.type === MessageType.ThreadCreated && (m.thread?.id === threadId || m.id === threadId),
    );
    if (sys) await sys.delete();
  } catch (err) {
    logger.warn({ err, threadId }, 'ticket: could not delete thread-created system message');
  }
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------
async function handlePanelCommand(interaction: any): Promise<void> {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
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
  // Private Bug is staff-only.
  if (type === 'support' && !isStaffInteraction(interaction)) {
    return ephem(interaction, 'The Private Bug option is staff-only.');
  }
  await interaction.showModal(buildModal(type));
}

async function handleModalSubmit(interaction: any, type: TicketType): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    return ephem(interaction, 'Tickets can only be opened from a standard text channel.');
  }

  const isPrivate = type === 'support';
  const title = interaction.fields.getTextInputValue('title').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const steps = type === 'suggestion' ? undefined : interaction.fields.getTextInputValue('steps')?.trim();
  const reporterId = interaction.user.id;
  const reporterTag = interaction.user.tag || interaction.user.username;

  try {
    const issue = await githubService.createIssue({
      title,
      body: buildIssueBody({ type, description, steps, reporterTag, reporterId }),
      labels: labelsForType(type),
    });

    // Both bugs and suggestions (and private bugs) land on the Bug & Suggestion board (#2).
    await githubService
      .addIssueToProject(env.GITHUB_PROJECT_BUGS_NUMBER, issue.nodeId)
      .catch((err) => logger.warn({ err, issue: issue.number }, 'ticket: failed to add issue to bug board'));

    const thread = await (channel as TextChannel).threads.create({
      name: buildThreadName(issue.number, title),
      type: isPrivate ? ChannelType.PrivateThread : ChannelType.PublicThread,
      autoArchiveDuration: 10080,
      reason: `Ticket #${issue.number} (${type})`,
    });

    if (isPrivate) {
      await thread.members.add(reporterId).catch(() => {});
    }
    await deleteThreadSystemMessage(channel as TextChannel, thread.id);
    await thread.send(await buildThreadIntro({ type, issue, reporterId })).catch((err) =>
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
          isPrivate,
        },
      })
      .catch((err) => logger.error({ err, issue: issue.number }, 'ticket: failed to persist issue<->thread map'));

    logger.info({ issue: issue.number, type, threadId: thread.id }, 'ticket: created');
    return ephem(interaction, `✅ Created **#${issue.number}** — track it in <#${thread.id}>.\n${issue.htmlUrl}`);
  } catch (err) {
    logger.error({ err, type }, 'ticket: creation failed');
    return ephem(interaction, '⚠️ Something went wrong creating your ticket. Please try again or ping a mod.');
  }
}

async function handleRoadmapButton(interaction: any, issueNumberRaw: string): Promise<void> {
  if (!isStaffInteraction(interaction)) {
    return ephem(interaction, 'Only staff can add tickets to the roadmap.');
  }
  const issueNumber = parseInt(issueNumberRaw, 10);
  if (!Number.isFinite(issueNumber)) return ephem(interaction, 'Could not determine the issue number.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const map = await prisma.githubIssueThread.findUnique({ where: { issueNumber } });
    if (!map) return ephem(interaction, `No tracked ticket found for #${issueNumber}.`);

    await githubService.addIssueToProject(env.GITHUB_PROJECT_ROADMAP_NUMBER, map.issueNodeId);
    await githubService.addLabels(issueNumber, ['roadmap']).catch(() => {});
    logger.info({ issueNumber, by: interaction.user.id }, 'ticket: added to roadmap');
    return ephem(interaction, `🗺️ Added **#${issueNumber}** to the roadmap.`);
  } catch (err) {
    logger.error({ err, issueNumber }, 'ticket: roadmap add failed');
    return ephem(interaction, '⚠️ Failed to add to the roadmap. Check the GitHub token (needs Projects: write).');
  }
}

async function handleMilestoneSelect(interaction: any, issueNumberRaw: string): Promise<void> {
  const issueNumber = parseInt(issueNumberRaw, 10);
  if (!Number.isFinite(issueNumber)) return ephem(interaction, 'Could not determine the issue number.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const map = await prisma.githubIssueThread.findUnique({ where: { issueNumber } });
    if (!map) return ephem(interaction, `No tracked ticket found for #${issueNumber}.`);
    // The reporter or any staff member may set the milestone.
    if (interaction.user.id !== map.reporterId && !isStaffInteraction(interaction)) {
      return ephem(interaction, 'Only the reporter or staff can set the milestone.');
    }

    const value = interaction.values?.[0];
    const milestoneNumber = !value || value === 'none' ? null : parseInt(value, 10);
    await githubService.setIssueMilestone(issueNumber, Number.isFinite(milestoneNumber as number) ? (milestoneNumber as number) : null);
    logger.info({ issueNumber, milestoneNumber, by: interaction.user.id }, 'ticket: milestone set');
    return ephem(
      interaction,
      milestoneNumber === null ? `Cleared the milestone on #${issueNumber}.` : `🎯 Set milestone on #${issueNumber}.`,
    );
  } catch (err) {
    logger.error({ err, issueNumber }, 'ticket: milestone set failed');
    return ephem(interaction, '⚠️ Failed to set the milestone.');
  }
}

async function onInteraction(interaction: Interaction): Promise<void> {
  try {
    const anyI = interaction as any;

    if (anyI.isChatInputCommand?.()) {
      if (anyI.commandName === PANEL_COMMAND) await handlePanelCommand(anyI);
      return;
    }

    const parsed = parseCustomId(anyI.customId);
    if (!parsed.isOurs) return;

    if (anyI.isButton?.()) {
      if (parsed.action === 'open' && isTicketType(parsed.arg)) return handleOpenButton(anyI, parsed.arg);
      if (parsed.action === 'roadmap') return handleRoadmapButton(anyI, parsed.arg);
      return;
    }

    if (anyI.isStringSelectMenu?.()) {
      if (parsed.action === 'milestone') return handleMilestoneSelect(anyI, parsed.arg);
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
