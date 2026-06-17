/**
 * Discord <-> GitHub ticketing.
 *
 * Increment 1 (outbound). A staff member posts a panel via /ticket-panel; members
 * click "Report a Bug" / "Suggestion" -> a modal collects text -> the bot creates
 * a GitHub issue, adds it to the Bug & Suggestion board (Project v2 #2), and opens
 * a **private thread** named "#<num> · <title>" (reporter + staff via Manage
 * Threads). The thread embed carries: a "View on GitHub" link, a staff-only
 * "Add to Roadmap" button, "Close" and "Delete" (full teardown), and an optional
 * milestone picker. The developer role is @-tagged when the thread opens. GitHub
 * issues are text-only — attachments live in the thread.
 *
 * After creating a thread the bot deletes Discord's "started a thread" system
 * message in the parent channel so the panel embed stays at the bottom.
 *
 * Attaches to the shared discord.js client via register() (no second login).
 *
 * Bot guild permissions: Create Private Threads, Send Messages in Threads,
 * Manage Threads, Manage Messages, Embed Links, Mention All Roles.
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
        '💡 **Suggestion** — an idea or feature request.\n\n' +
        'A **private thread** is created for your ticket (you + the team) — drop screenshots ' +
        'and details there. Each ticket is tracked on our GitHub boards.',
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
  );
  return { embeds: [embed], components: [row] };
}

function buildModal(type: TicketType): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(buildCustomId('submit', type))
    .setTitle(type === 'suggestion' ? 'New Suggestion' : 'New Bug Report');

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

async function buildThreadComponents(issueNumber: number, issueUrl: string) {
  const rows: any[] = [];
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel('View on GitHub').setEmoji('🔗').setStyle(ButtonStyle.Link).setURL(issueUrl),
      new ButtonBuilder()
        .setCustomId(buildCustomId('roadmap', String(issueNumber)))
        .setLabel('Add to Roadmap')
        .setEmoji('🗺️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildCustomId('close', String(issueNumber)))
        .setLabel('Close')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(buildCustomId('delete', String(issueNumber)))
        .setLabel('Delete')
        .setEmoji('🗑️')
        .setStyle(ButtonStyle.Danger),
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

async function buildThreadIntro(opts: { type: TicketType; issue: { number: number; htmlUrl: string }; reporterId: string }) {
  const devRole = env.DEVELOPER_ROLE_ID;
  const embed = new EmbedBuilder()
    .setTitle(`${displayForType(opts.type)} · #${opts.issue.number}`)
    .setURL(opts.issue.htmlUrl)
    .setDescription(
      `Thanks <@${opts.reporterId}>! Tracked on GitHub:\n**[Issue #${opts.issue.number} ↗](${opts.issue.htmlUrl})**\n\n` +
        '📎 **Drop any screenshots or files here** so we can see what you mean. ' +
        'Anything posted in this thread is part of the discussion.',
    )
    .setColor(colorForType(opts.type));

  const content = devRole ? `<@${opts.reporterId}> · <@&${devRole}>` : `<@${opts.reporterId}>`;
  return {
    content,
    embeds: [embed],
    components: await buildThreadComponents(opts.issue.number, opts.issue.htmlUrl),
    allowedMentions: { users: [opts.reporterId], roles: devRole ? [devRole] : [] },
  };
}

/** Delete Discord's "started a thread" system message so the panel stays at the bottom. */
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
  await interaction.showModal(buildModal(type));
}

async function handleModalSubmit(interaction: any, type: TicketType): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

    // Boards are populated by GitHub's built-in "Auto-add to project" workflow,
    // keyed off the issue's labels (`bug` / `suggestion`) — fine-grained PATs
    // cannot write user-owned Projects v2. The direct add is best-effort and only
    // succeeds if a classic `project`-scope token is configured; failures expected.
    void githubService.addIssueToProject(env.GITHUB_PROJECT_BUGS_NUMBER, issue.nodeId).catch(() => {});

    // All threads are private by default (reporter + staff via Manage Threads).
    const thread = await (channel as TextChannel).threads.create({
      name: buildThreadName(issue.number, title),
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 10080,
      invitable: false,
      reason: `Ticket #${issue.number} (${type})`,
    });
    await thread.members.add(reporterId).catch(() => {});
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
          isPrivate: true,
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
  if (!isStaffInteraction(interaction)) return ephem(interaction, 'Only staff can add tickets to the roadmap.');
  const issueNumber = parseInt(issueNumberRaw, 10);
  if (!Number.isFinite(issueNumber)) return ephem(interaction, 'Could not determine the issue number.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const map = await prisma.githubIssueThread.findUnique({ where: { issueNumber } });
    if (!map) return ephem(interaction, `No tracked ticket found for #${issueNumber}.`);
    // The `roadmap` label is the primary mechanism — GitHub's Auto-add workflow on
    // the Roadmap board picks it up. Direct project add is best-effort (classic token).
    await githubService.addLabels(issueNumber, ['roadmap']);
    void githubService.addIssueToProject(env.GITHUB_PROJECT_ROADMAP_NUMBER, map.issueNodeId).catch(() => {});
    logger.info({ issueNumber, by: interaction.user.id }, 'ticket: roadmap label applied');
    return ephem(interaction, `🗺️ Tagged **#${issueNumber}** with \`roadmap\` — it'll appear on the Roadmap board.`);
  } catch (err) {
    logger.error({ err, issueNumber }, 'ticket: roadmap label failed');
    return ephem(interaction, '⚠️ Failed to apply the roadmap label.');
  }
}

async function handleMilestoneSelect(interaction: any, issueNumberRaw: string): Promise<void> {
  const issueNumber = parseInt(issueNumberRaw, 10);
  if (!Number.isFinite(issueNumber)) return ephem(interaction, 'Could not determine the issue number.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const map = await prisma.githubIssueThread.findUnique({ where: { issueNumber } });
    if (!map) return ephem(interaction, `No tracked ticket found for #${issueNumber}.`);
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

async function handleCloseButton(interaction: any, issueNumberRaw: string): Promise<void> {
  if (!isStaffInteraction(interaction)) return ephem(interaction, 'Only staff can close tickets.');
  const issueNumber = parseInt(issueNumberRaw, 10);
  if (!Number.isFinite(issueNumber)) return ephem(interaction, 'Could not determine the issue number.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await githubService.closeIssue(issueNumber);
    const thread = interaction.channel;
    if (thread?.isThread?.()) {
      await thread.send(`✅ Ticket closed by <@${interaction.user.id}>. GitHub issue #${issueNumber} closed.`).catch(() => {});
      await thread.setLocked(true).catch(() => {});
      await thread.setArchived(true).catch(() => {});
    }
    logger.info({ issueNumber, by: interaction.user.id }, 'ticket: closed');
    return ephem(interaction, `✅ Closed **#${issueNumber}** and locked the thread.`);
  } catch (err) {
    logger.error({ err, issueNumber }, 'ticket: close failed');
    return ephem(interaction, '⚠️ Failed to close the issue.');
  }
}

async function handleDeleteButton(interaction: any, issueNumberRaw: string): Promise<void> {
  if (!isStaffInteraction(interaction)) return ephem(interaction, 'Only staff can delete tickets.');
  const issueNumber = parseInt(issueNumberRaw, 10);
  if (!Number.isFinite(issueNumber)) return ephem(interaction, 'Could not determine the issue number.');

  const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('delconfirm', String(issueNumber)))
      .setLabel('Yes, delete everything')
      .setEmoji('🧨')
      .setStyle(ButtonStyle.Danger),
  );
  return ephem(
    interaction,
    `⚠️ This permanently **deletes this thread and GitHub issue #${issueNumber}** (and removes it from the boards). This cannot be undone.`,
    [confirm],
  );
}

async function handleDeleteConfirm(interaction: any, issueNumberRaw: string): Promise<void> {
  if (!isStaffInteraction(interaction)) return ephem(interaction, 'Only staff can delete tickets.');
  const issueNumber = parseInt(issueNumberRaw, 10);
  if (!Number.isFinite(issueNumber)) return ephem(interaction, 'Could not determine the issue number.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const map = await prisma.githubIssueThread.findUnique({ where: { issueNumber } }).catch(() => null);

  let ghResult: string;
  try {
    if (map) {
      await githubService.deleteIssue(map.issueNodeId);
      ghResult = `deleted GitHub issue #${issueNumber}`;
    } else {
      ghResult = `no tracked record for #${issueNumber}`;
    }
  } catch {
    try {
      await githubService.closeIssue(issueNumber);
      ghResult = `couldn't delete issue #${issueNumber} (token lacks delete perms) — closed it instead`;
    } catch {
      ghResult = `couldn't delete or close issue #${issueNumber}`;
    }
  }

  await prisma.githubIssueThread.deleteMany({ where: { issueNumber } }).catch(() => {});
  logger.info({ issueNumber, by: interaction.user.id, ghResult }, 'ticket: deleted');
  await ephem(interaction, `🧨 Teardown: ${ghResult}. Deleting this thread…`);

  const thread = interaction.channel;
  if (thread?.isThread?.()) {
    await thread.delete(`Ticket #${issueNumber} deleted by ${interaction.user.id}`).catch(() => {});
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
      if (parsed.action === 'close') return handleCloseButton(anyI, parsed.arg);
      if (parsed.action === 'delete') return handleDeleteButton(anyI, parsed.arg);
      if (parsed.action === 'delconfirm') return handleDeleteConfirm(anyI, parsed.arg);
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
