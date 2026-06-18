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
import playerReportService from './playerReportService';
import {
  buildPlayerReportThreadName,
  isAllowedDiscordAttachmentUrl,
  REPORT_IMAGE_MAX_BYTES,
} from './playerReportHelpers';
import {
  buildCustomId,
  parseCustomId,
  buildThreadName,
  buildIssueBody,
  labelForType,
  colorForType,
  BRAND_EMBED_COLOR,
  displayForType,
  isStaff,
  isTicketType,
  type TicketType,
} from './githubTicketHelpers';

const PANEL_COMMAND = 'ticket-panel';
const PANEL_CHANNEL_KEY = 'tickets.panel_channel_id';

let clientRef: Client | null = null;

/** Channel where /ticket-panel was last posted — where web-filed reports open their thread. */
async function getPanelChannelId(): Promise<string | null> {
  const row = await prisma.moderationSetting.findUnique({ where: { key: PANEL_CHANNEL_KEY } }).catch(() => null);
  return row?.value || null;
}
async function setPanelChannelId(channelId: string): Promise<void> {
  await prisma.moderationSetting
    .upsert({ where: { key: PANEL_CHANNEL_KEY }, update: { value: channelId }, create: { key: PANEL_CHANNEL_KEY, value: channelId } })
    .catch((err) => logger.warn({ err }, 'ticket: failed to persist panel channel'));
}

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
    .setTitle('🛠️ Report a Bug · Report a Player · Suggest a Feature')
    .setDescription(
      'Use the buttons below — a **private thread** is created for your report (you + the team).\n\n' +
        '🐞 **Report a Bug** — something is broken or behaving wrong.\n' +
        '🚩 **Report a Player** — report a player to the moderation team.\n' +
        '💡 **Suggestion** — an idea or feature request.\n\n' +
        'Drop screenshots and details in the thread. Bugs and suggestions are tracked on our project board.',
    )
    .addFields({
      name: '📋 Project Board',
      value: `[View all issues & features](${projectUrl(env.GITHUB_PROJECT_NUMBER)})`,
    })
    .setColor(BRAND_EMBED_COLOR);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(buildCustomId('open', 'bug')).setLabel('Report a Bug').setEmoji('🐞').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(buildCustomId('player')).setLabel('Report a Player').setEmoji('🚩').setStyle(ButtonStyle.Secondary),
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
  const supportRole = env.SUPPORT_ROLE_ID;
  const embed = new EmbedBuilder()
    .setTitle(`${displayForType(opts.type)} · #${opts.issue.number}`)
    .setURL(opts.issue.htmlUrl)
    .setDescription(
      `Thanks <@${opts.reporterId}>! Tracked on GitHub:\n**[Issue #${opts.issue.number} ↗](${opts.issue.htmlUrl})**\n\n` +
        '📎 **Drop any screenshots or files here** so we can see what you mean. ' +
        'Anything posted in this thread is part of the discussion.',
    )
    .setColor(colorForType(opts.type));

  const content = supportRole ? `<@${opts.reporterId}> · <@&${supportRole}>` : `<@${opts.reporterId}>`;
  return {
    content,
    embeds: [embed],
    components: await buildThreadComponents(opts.issue.number, opts.issue.htmlUrl),
    allowedMentions: { users: [opts.reporterId], roles: supportRole ? [supportRole] : [] },
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
  await setPanelChannelId(channel.id);
  return ephem(interaction, '✅ Ticket panel posted. New reports (Discord + website) open their threads here.');
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
    // keyed off the issue's labels — the bot does not write Projects v2 directly
    // (fine-grained PATs cannot write user-owned projects).

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
    // Angle-bracket the URL so Discord does NOT unfurl it into a link-preview embed.
    return ephem(interaction, `✅ Created **#${issue.number}** — track it in <#${thread.id}>.\n<${issue.htmlUrl}>`);
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
    // The `roadmap` label drives GitHub's Auto-add workflow on the Roadmap board.
    await githubService.addLabels(issueNumber, ['roadmap']);
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

  // 1) Lock the thread IMMEDIATELY and independently of the GitHub call — a GitHub
  // failure must never leave the thread open. Once locked, only members with the
  // Manage Threads permission (admins/devs/mods) can post; everyone else is
  // read-only. setLocked is awaited so a failure (e.g. missing bot permission)
  // surfaces to the closer instead of being silently swallowed.
  let lockMsg = '🔒 Thread locked';
  const thread = interaction.channel as any;
  if (thread?.isThread?.()) {
    try {
      await thread.send(`🔒 Ticket closed by <@${interaction.user.id}> — this thread is now locked.`).catch(() => {});
      await thread.setLocked(true);
      await thread.setArchived(true).catch(() => {});
    } catch (err) {
      logger.warn({ err, issueNumber, threadId: thread.id }, 'ticket: failed to lock thread on close');
      lockMsg = '⚠️ Could NOT lock the thread — the bot needs the **Manage Threads** permission';
    }
  }

  // 2) Close the GitHub issue (independent of the lock above).
  let ghMsg: string;
  try {
    await githubService.closeIssue(issueNumber);
    ghMsg = `GitHub issue #${issueNumber} closed`;
  } catch (err) {
    logger.error({ err, issueNumber }, 'ticket: close issue failed');
    ghMsg = `couldn't close GitHub issue #${issueNumber} (thread stays locked anyway)`;
  }

  logger.info({ issueNumber, by: interaction.user.id }, 'ticket: closed');
  return ephem(interaction, `${lockMsg}. ${ghMsg}.`);
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

// ---------------------------------------------------------------------------
// Report a Player (submits to the moderation portal, not GitHub)
// ---------------------------------------------------------------------------
function buildPlayerModal(): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(buildCustomId('psubmit')).setTitle('Report a Player');
  const content = new TextInputBuilder()
    .setCustomId('content')
    .setLabel('What happened?')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(2000)
    .setRequired(true)
    .setPlaceholder('Describe the incident — who, what, when, where.');
  const involved = new TextInputBuilder()
    .setCustomId('involvedPlayers')
    .setLabel('Player name(s) involved')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(500)
    .setRequired(false)
    .setPlaceholder('In-game name(s) / gamertag(s)');
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(content),
    new ActionRowBuilder<TextInputBuilder>().addComponents(involved),
  );
  return modal;
}

// Reporting a player is open to any member (same as the website form).
async function handlePlayerOpen(interaction: any): Promise<void> {
  await interaction.showModal(buildPlayerModal());
}

async function handlePlayerSubmit(interaction: any): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    return ephem(interaction, 'Player reports can only be opened from a standard text channel.');
  }
  const content = interaction.fields.getTextInputValue('content').trim();
  const involvedPlayers = interaction.fields.getTextInputValue('involvedPlayers')?.trim() || null;
  const reporter = interaction.user;

  try {
    const report = await playerReportService.createPlayerReport({
      discordId: reporter.id,
      username: reporter.username,
      displayName: interaction.member?.displayName || reporter.globalName || reporter.username,
      avatar: reporter.displayAvatarURL?.() ?? null,
      content,
      involvedPlayers,
    });
    const threadId = await openReportThread(
      {
        reportId: report.id,
        reportNumber: report.reportNumber,
        reporterName: report.reporterName,
        reporterDiscordId: report.reporterDiscordId,
        involvedPlayers: report.involvedPlayers,
        content,
      },
      channel as TextChannel,
    );
    return ephem(
      interaction,
      threadId
        ? `✅ Player report **#${report.reportNumber}** filed — the moderation team is on it in <#${threadId}>.`
        : `✅ Player report **#${report.reportNumber}** filed.`,
    );
  } catch (err) {
    logger.error({ err }, 'player-report: submit failed');
    return ephem(interaction, '⚠️ Something went wrong filing your report. Please try again or ping a mod.');
  }
}

export interface ReportThreadInfo {
  reportId: string;
  reportNumber: number;
  reporterName: string;
  reporterDiscordId?: string | null;
  involvedPlayers?: string | null;
  content?: string | null;
}

/** Staff controls under a player-report thread: Close / Lock / Delete. */
function buildReportThreadComponents() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(buildCustomId('rclose')).setLabel('Close').setEmoji('✅').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(buildCustomId('rlock')).setLabel('Lock').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(buildCustomId('rdelete')).setLabel('Delete').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    ),
  ];
}

/**
 * Create the private "lockdown" thread for a player report — used by the Discord
 * button flow AND web-filed reports (which pass no channel, so it resolves the
 * persisted /ticket-panel channel). Title: "<reporter> · <involved> · #<num>".
 * Returns the thread id, or null if no channel/client is available.
 */
export async function openReportThread(info: ReportThreadInfo, channel?: TextChannel): Promise<string | null> {
  let ch: TextChannel | null = channel ?? null;
  if (!ch) {
    const chId = await getPanelChannelId();
    if (!chId || !clientRef) {
      logger.warn({ reportNumber: info.reportNumber }, 'report-thread: no panel channel configured');
      return null;
    }
    const fetched = await clientRef.channels.fetch(chId).catch(() => null);
    if (!fetched || (fetched as any).type !== ChannelType.GuildText) {
      logger.warn('report-thread: panel channel missing or not a text channel');
      return null;
    }
    ch = fetched as TextChannel;
  }

  try {
    const thread = await ch.threads.create({
      name: buildPlayerReportThreadName(info.reporterName, info.involvedPlayers ?? null, info.reportNumber),
      type: ChannelType.PrivateThread,
      autoArchiveDuration: 10080,
      invitable: false,
      reason: `Player report #${info.reportNumber}`,
    });
    if (info.reporterDiscordId) await thread.members.add(info.reporterDiscordId).catch(() => {});
    await deleteThreadSystemMessage(ch, thread.id);

    const mod = env.MODERATOR_ROLE_ID;
    const overseer = env.OWNER_ROLE_ID; // "overseers" = owner role
    const pingUser = info.reporterDiscordId ? `<@${info.reporterDiscordId}>` : '';
    const pings = [pingUser, mod ? `<@&${mod}>` : '', overseer ? `<@&${overseer}>` : ''].filter(Boolean).join(' ');
    const embed = new EmbedBuilder()
      .setTitle(`Player Report #${info.reportNumber}`)
      .setColor(BRAND_EMBED_COLOR)
      .setDescription(
        `${pingUser ? `Filed by ${pingUser}. ` : ''}Moderators and overseers have been notified.\n\n` +
          '📎 **Drop up to 3 screenshots here** as evidence — they attach to the report automatically.',
      )
      .addFields(
        { name: 'What happened', value: (info.content || '').slice(0, 1024) || '_n/a_' },
        ...(info.involvedPlayers ? [{ name: 'Involved', value: info.involvedPlayers.slice(0, 1024) }] : []),
      );
    await thread
      .send({
        content: pings || undefined,
        embeds: [embed],
        components: buildReportThreadComponents(),
        allowedMentions: {
          users: info.reporterDiscordId ? [info.reporterDiscordId] : [],
          roles: [mod, overseer].filter(Boolean) as string[],
        },
      })
      .catch((err) => logger.warn({ err, threadId: thread.id }, 'report-thread: failed to post intro'));

    await playerReportService.setReportThreadId(info.reportId, thread.id);
    return thread.id;
  } catch (err) {
    logger.error({ err, reportNumber: info.reportNumber }, 'report-thread: creation failed');
    return null;
  }
}

// --- player-report thread staff controls (Close / Lock / Delete) ---
async function reportFromThread(interaction: any) {
  const ch = interaction.channel;
  if (!ch?.isThread?.()) return null;
  return playerReportService.findReportByThread(ch.id);
}

async function handleReportClose(interaction: any): Promise<void> {
  if (!isStaffInteraction(interaction)) return ephem(interaction, 'Only staff can close reports.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const report = await reportFromThread(interaction);
  if (!report) return ephem(interaction, 'No tracked report for this thread.');
  await playerReportService.setReportStatus(report.id, 'closed').catch(() => {});
  await interaction.channel.send(`✅ Report #${report.reportNumber} closed by <@${interaction.user.id}>.`).catch(() => {});
  logger.info({ reportNumber: report.reportNumber, by: interaction.user.id }, 'report: closed');
  return ephem(interaction, `✅ Report #${report.reportNumber} marked closed.`);
}

async function handleReportLock(interaction: any): Promise<void> {
  if (!isStaffInteraction(interaction)) return ephem(interaction, 'Only staff can lock reports.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const thread = interaction.channel as any;
  if (!thread?.isThread?.()) return ephem(interaction, 'This only works inside a report thread.');
  try {
    await thread.send(`🔒 Locked by <@${interaction.user.id}> — only staff can post now.`).catch(() => {});
    await thread.setLocked(true);
    await thread.setArchived(true).catch(() => {});
    return ephem(interaction, '🔒 Thread locked.');
  } catch (err) {
    logger.warn({ err }, 'report: lock failed');
    return ephem(interaction, '⚠️ Could not lock — the bot needs the Manage Threads permission.');
  }
}

async function handleReportDelete(interaction: any): Promise<void> {
  if (!isStaffInteraction(interaction)) return ephem(interaction, 'Only staff can delete reports.');
  const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('rdelconfirm'))
      .setLabel('Yes, delete report + thread')
      .setEmoji('🧨')
      .setStyle(ButtonStyle.Danger),
  );
  return ephem(interaction, '⚠️ This permanently **deletes the report and this thread**. This cannot be undone.', [confirm]);
}

async function handleReportDeleteConfirm(interaction: any): Promise<void> {
  if (!isStaffInteraction(interaction)) return ephem(interaction, 'Only staff can delete reports.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const report = await reportFromThread(interaction);
  if (report) await playerReportService.deleteReport(report.id).catch((err) => logger.warn({ err }, 'report: delete row failed'));
  logger.info({ reportNumber: report?.reportNumber, by: interaction.user.id }, 'report: deleted');
  await ephem(interaction, `🧨 ${report ? `Report #${report.reportNumber} ` : 'Report '}deleted. Removing thread…`);
  const thread = interaction.channel as any;
  if (thread?.isThread?.()) await thread.delete(`Report deleted by ${interaction.user.id}`).catch(() => {});
}

// Attach screenshots dropped in a player-report lockdown thread to the report.
async function onThreadMessage(message: any): Promise<void> {
  try {
    if (message.author?.bot) return;
    const ch = message.channel;
    if (!ch?.isThread?.() || !message.attachments || message.attachments.size === 0) return;
    const report = await playerReportService.findReportByThread(ch.id);
    if (!report) return;
    // Accept only real images, from Discord's CDN (SSRF guard), within the size cap.
    const candidates = [...message.attachments.values()].filter(
      (a: any) =>
        (a.contentType || '').startsWith('image/') &&
        isAllowedDiscordAttachmentUrl(a.url) &&
        (typeof a.size !== 'number' || a.size <= REPORT_IMAGE_MAX_BYTES),
    );
    if (!candidates.length) return;

    const buffers: Buffer[] = [];
    for (const a of candidates.slice(0, 3)) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 10_000);
        const res = await fetch(a.url, { signal: ac.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length <= REPORT_IMAGE_MAX_BYTES) buffers.push(buf); // post-download size guard
      } catch {
        /* skip a slow/oversized/failed attachment */
      }
    }
    if (!buffers.length) return;

    // Magic-byte validation + the 3-image total cap happen in attachImagesToReport.
    try {
      const r = await playerReportService.attachImagesToReport(report.id, buffers);
      if (r.accepted > 0) await message.react('✅').catch(() => {});
      else if (r.full) await message.reply('This report already has the maximum of 3 screenshots.').catch(() => {});
    } catch {
      await message
        .reply('Could not attach those — images only (JPEG/PNG/WebP/GIF), under 5 MB each.')
        .catch(() => {});
    }
  } catch (err) {
    logger.warn({ err }, 'player-report: evidence handler error');
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
      if (parsed.action === 'player') return handlePlayerOpen(anyI);
      if (parsed.action === 'roadmap') return handleRoadmapButton(anyI, parsed.arg);
      if (parsed.action === 'close') return handleCloseButton(anyI, parsed.arg);
      if (parsed.action === 'delete') return handleDeleteButton(anyI, parsed.arg);
      if (parsed.action === 'delconfirm') return handleDeleteConfirm(anyI, parsed.arg);
      if (parsed.action === 'rclose') return handleReportClose(anyI);
      if (parsed.action === 'rlock') return handleReportLock(anyI);
      if (parsed.action === 'rdelete') return handleReportDelete(anyI);
      if (parsed.action === 'rdelconfirm') return handleReportDeleteConfirm(anyI);
      return;
    }

    if (anyI.isStringSelectMenu?.()) {
      if (parsed.action === 'milestone') return handleMilestoneSelect(anyI, parsed.arg);
      return;
    }

    if (anyI.isModalSubmit?.()) {
      if (parsed.action === 'submit' && isTicketType(parsed.arg)) return handleModalSubmit(anyI, parsed.arg);
      if (parsed.action === 'psubmit') return handlePlayerSubmit(anyI);
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
  clientRef = client;
  client.on('interactionCreate', onInteraction);
  // Screenshots dropped in a player-report lockdown thread → attached to the report.
  client.on('messageCreate', onThreadMessage);
  client.once('ready', () => {
    void registerCommands(client);
  });
  logger.info('ticket: service registered');
}

export default { register, openReportThread };
module.exports = { register, openReportThread };
