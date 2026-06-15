/**
 * Temporary "Join-to-Create" voice channels.
 *
 * Mechanism (same as VoiceMaster / MEE6 / TempVoice):
 *  - Admin designates one lobby voice channel (+ optional category) via the dashboard.
 *  - When a member joins the lobby, the bot creates a personal voice channel under
 *    the category, moves the member into it, marks them owner, and posts a button
 *    control panel into the channel's built-in text chat.
 *  - The owner controls the channel via buttons (lock/limit/rename/hide/kick/permit/
 *    reject/transfer/claim/region). When the channel empties it is deleted.
 *
 * Requires the GuildVoiceStates gateway intent (added in discordService.ts) and these
 * guild permissions on the bot: Manage Channels, Move Members, Manage Roles, View
 * Channel, Connect. The service attaches its listeners to the shared discord.js client
 * (no second login) via register().
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
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  type VoiceState,
  type Interaction,
  type VoiceChannel,
  type GuildMember,
} from 'discord.js';
import prisma from '../config/prisma';
import logger from '../config/logger';

// ---------------------------------------------------------------------------
// Config (stored in moderation_settings key/value, 60s cache like discordService)
// ---------------------------------------------------------------------------
export interface VoiceConfig {
  enabled: boolean;
  lobbyChannelId: string | null;
  categoryId: string | null;
  nameTemplate: string;
}

const SETTING_KEYS = {
  enabled: 'voice.enabled',
  lobby: 'voice.lobby_channel_id',
  category: 'voice.category_id',
  template: 'voice.name_template',
} as const;

const DEFAULT_TEMPLATE = "{user}'s Channel";

let configCache: VoiceConfig | null = null;
let configLastLoaded = 0;
let configPromise: Promise<VoiceConfig> | null = null;

async function loadConfig(): Promise<VoiceConfig> {
  const now = Date.now();
  if (configCache && now - configLastLoaded < 60_000) return configCache;
  if (!configPromise) {
    configPromise = prisma.moderationSetting
      .findMany({ where: { key: { in: Object.values(SETTING_KEYS) } }, select: { key: true, value: true } })
      .then((rows) => {
        const m = new Map(rows.map((r) => [r.key, r.value]));
        const cfg: VoiceConfig = {
          enabled: m.get(SETTING_KEYS.enabled) === 'true',
          lobbyChannelId: m.get(SETTING_KEYS.lobby) || null,
          categoryId: m.get(SETTING_KEYS.category) || null,
          nameTemplate: m.get(SETTING_KEYS.template) || DEFAULT_TEMPLATE,
        };
        configCache = cfg;
        configLastLoaded = Date.now();
        return cfg;
      })
      .finally(() => { configPromise = null; });
  }
  return configPromise;
}

/** Bust the cache after a dashboard settings change. */
export function invalidateVoiceCache(): void {
  configCache = null;
  configLastLoaded = 0;
}

// ---------------------------------------------------------------------------
// State — in-memory owner map mirrored to voice_channels for restart safety
// ---------------------------------------------------------------------------
const owners = new Map<string, string>(); // channelId -> ownerId
const createCooldown = new Map<string, number>(); // userId -> last-create epoch ms
const CREATE_COOLDOWN_MS = 5_000;
const PANEL_PREFIX = 'tv:';

let clientRef: Client | null = null;

// ---------------------------------------------------------------------------
// Control panel
// ---------------------------------------------------------------------------
function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle('🔊 Voice Channel Controls')
    .setDescription(
      'You own this channel. Use the buttons below to manage it.\n' +
        '`Lock` blocks new joiners · `Hide` removes it from the channel list · ' +
        '`Permit`/`Reject` target specific users.',
    )
    .setColor(0x18ff62);

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}lock`).setLabel('Lock').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}unlock`).setLabel('Unlock').setEmoji('🔓').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}hide`).setLabel('Hide').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}show`).setLabel('Show').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}limit`).setLabel('Limit').setEmoji('👥').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}rename`).setLabel('Rename').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}permit`).setLabel('Permit').setEmoji('✅').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}reject`).setLabel('Reject').setEmoji('⛔').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}kick`).setLabel('Kick').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}transfer`).setLabel('Transfer Owner').setEmoji('👑').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}claim`).setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}region`).setLabel('Region').setEmoji('🌐').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PANEL_PREFIX}bitrate`).setLabel('Bitrate').setEmoji('🎚️').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row1, row2, row3] };
}

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------
async function persistOwner(channelId: string, guildId: string, ownerId: string): Promise<void> {
  await prisma.voiceChannel
    .upsert({
      where: { discordChannelId: channelId },
      update: { ownerId },
      create: { discordChannelId: channelId, guildId, ownerId },
    })
    .catch((err) => logger.error({ err, channelId }, 'voice: failed to persist owner'));
}

async function forgetChannel(channelId: string): Promise<void> {
  owners.delete(channelId);
  await prisma.voiceChannel
    .deleteMany({ where: { discordChannelId: channelId } })
    .catch(() => {});
}

async function deleteIfEmpty(channel: VoiceChannel | null | undefined): Promise<void> {
  if (!channel) return;
  if (!owners.has(channel.id)) return;
  if (channel.members.size > 0) return;
  try {
    await channel.delete('Voice channel empty');
  } catch (err) {
    logger.warn({ err, channelId: channel.id }, 'voice: failed to delete empty channel');
  }
  await forgetChannel(channel.id);
}

function renderName(template: string, member: GuildMember): string {
  return template.replace(/\{user\}/g, member.displayName).slice(0, 100) || `${member.displayName}'s Channel`;
}

// ---------------------------------------------------------------------------
// voiceStateUpdate
// ---------------------------------------------------------------------------
async function onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
  try {
    const cfg = await loadConfig();

    // Cleanup: member left / moved out of a tracked temp channel
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      const old = oldState.channel;
      if (old?.type === ChannelType.GuildVoice) await deleteIfEmpty(old as VoiceChannel);
    }

    // Create: member joined the configured lobby
    if (!cfg.enabled || !cfg.lobbyChannelId) return;
    if (newState.channelId !== cfg.lobbyChannelId) return;

    const member = newState.member;
    const lobby = newState.channel;
    if (!member || !lobby || lobby.type !== ChannelType.GuildVoice) return;
    await createTempChannelFor(member, lobby as VoiceChannel, cfg);
  } catch (err) {
    logger.error({ err }, 'voice: voiceStateUpdate handler error');
  }
}

// Create a temp voice channel for a member sitting in the lobby and move them in.
// Returns true if a channel was created. Shared by the voiceStateUpdate handler
// (event-driven) and reconcileLobby() (polling fallback) so a MISSED gateway
// event or a transient failure (e.g. a Missing-Permissions error that has since
// been fixed) still gets the member their channel on the next poll.
async function createTempChannelFor(
  member: GuildMember,
  lobby: VoiceChannel,
  cfg: VoiceConfig,
): Promise<boolean> {
  // Per-user create cooldown to stop spam join/leave loops (and to dedup the
  // event handler racing the reconcile poll for the same member).
  const last = createCooldown.get(member.id) ?? 0;
  if (Date.now() - last < CREATE_COOLDOWN_MS) return false;
  createCooldown.set(member.id, Date.now());

  const guild = member.guild;
  const parentId = cfg.categoryId || lobby.parentId || null;
  try {
    const temp = await guild.channels.create({
      name: renderName(cfg.nameTemplate, member),
      type: ChannelType.GuildVoice,
      parent: parentId ?? undefined,
      reason: `Voice channel for ${member.user.tag}`,
      permissionOverwrites: [
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MoveMembers,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.ViewChannel,
          ],
        },
      ],
    });

    owners.set(temp.id, member.id);
    await persistOwner(temp.id, guild.id, member.id);

    await member.voice.setChannel(temp).catch(async (err) => {
      // If the move fails (member already left), tear the channel back down.
      logger.warn({ err, memberId: member.id }, 'voice: move to temp channel failed');
      await deleteIfEmpty(temp as VoiceChannel);
    });

    // Voice channels have a built-in text chat — post the control panel there.
    await (temp as VoiceChannel).send({ content: `<@${member.id}>`, ...buildPanel() }).catch((err) =>
      logger.warn({ err, channelId: temp.id }, 'voice: failed to post control panel'),
    );
    return true;
  } catch (err) {
    // Clear the cooldown so the next gateway event OR reconcile poll retries
    // promptly (e.g. right after an admin grants the bot a missing permission)
    // instead of waiting out the cooldown on a failed attempt.
    createCooldown.delete(member.id);
    logger.error({ err, memberId: member.id }, 'voice: create temp channel failed');
    return false;
  }
}

// Reconcile the lobby: catch anyone left SITTING in the join-to-create lobby for
// whom no temp channel was made (missed voiceStateUpdate, bot offline at join
// time, or a create that failed before a permission was granted). Runs on
// startup and on a short poll. Normally a no-op — the lobby is empty because
// joiners are moved straight out into their own channel.
async function reconcileLobby(): Promise<void> {
  try {
    if (!clientRef) return;
    const cfg = await loadConfig();
    if (!cfg.enabled || !cfg.lobbyChannelId) return;
    const lobby = await clientRef.channels.fetch(cfg.lobbyChannelId).catch(() => null);
    if (!lobby || lobby.type !== ChannelType.GuildVoice) return;
    const vc = lobby as VoiceChannel;
    for (const [, member] of vc.members) {
      if (member.user.bot) continue;
      const created = await createTempChannelFor(member, vc, cfg);
      if (created) {
        logger.info({ memberId: member.id }, 'voice: reconcile created channel for stranded lobby member');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'voice: lobby reconcile failed');
  }
}

// ---------------------------------------------------------------------------
// interactionCreate (control panel)
// ---------------------------------------------------------------------------
function ownerOnly(channelId: string, userId: string): boolean {
  return owners.get(channelId) === userId;
}

async function ephem(interaction: any, content: string): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, ephemeral: true }).catch(() => {});
  } else {
    await interaction.reply({ content, ephemeral: true }).catch(() => {});
  }
}

async function onInteraction(interaction: Interaction): Promise<void> {
  try {
    const anyI = interaction as any;
    const customId: string | undefined = anyI.customId;
    if (!customId || !customId.startsWith(PANEL_PREFIX)) return;

    const action = customId.slice(PANEL_PREFIX.length).split(':')[0];
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      return ephem(interaction, 'These controls only work inside a voice channel.');
    }
    const vc = channel as VoiceChannel;

    if (!owners.has(vc.id)) {
      return ephem(interaction, 'This is not a managed voice channel.');
    }

    const userId = interaction.user.id;
    // claim is the only action available to non-owners (when owner has left).
    if (action !== 'claim' && !ownerOnly(vc.id, userId)) {
      return ephem(interaction, 'Only the channel owner can use these controls.');
    }

    const everyone = vc.guild.roles.everyone.id;

    // --- Modals (submit handlers) ---
    if (anyI.isModalSubmit?.()) {
      if (action === 'rename') {
        const name = anyI.fields.getTextInputValue('name').trim().slice(0, 100) || 'voice-channel';
        await vc.setName(name);
        return ephem(interaction, `Renamed to **${name}**.`);
      }
      if (action === 'limit') {
        const raw = parseInt(anyI.fields.getTextInputValue('limit').trim(), 10);
        const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 99) : 0;
        await vc.setUserLimit(limit);
        return ephem(interaction, limit === 0 ? 'User limit removed.' : `User limit set to ${limit}.`);
      }
      if (action === 'bitrate') {
        const kbps = parseInt(anyI.fields.getTextInputValue('bitrate').trim(), 10);
        const bps = Math.min(Math.max(Number.isFinite(kbps) ? kbps : 64, 8), 384) * 1000;
        await vc.setBitrate(bps);
        return ephem(interaction, `Bitrate set to ${Math.round(bps / 1000)} kbps.`);
      }
      return;
    }

    // --- User-select menus (submit) ---
    if (anyI.isUserSelectMenu?.()) {
      const targetId: string = anyI.values[0];
      if (action === 'kick') {
        const m = await vc.guild.members.fetch(targetId).catch(() => null);
        if (m?.voice.channelId === vc.id) await m.voice.disconnect('Kicked by voice-channel owner');
        return ephem(interaction, `Removed <@${targetId}> from the channel.`);
      }
      if (action === 'permit') {
        await vc.permissionOverwrites.edit(targetId, { Connect: true, ViewChannel: true });
        return ephem(interaction, `Permitted <@${targetId}>.`);
      }
      if (action === 'reject') {
        await vc.permissionOverwrites.edit(targetId, { Connect: false });
        const m = await vc.guild.members.fetch(targetId).catch(() => null);
        if (m?.voice.channelId === vc.id) await m.voice.disconnect('Rejected by voice-channel owner');
        return ephem(interaction, `Rejected <@${targetId}>.`);
      }
      if (action === 'transfer') {
        owners.set(vc.id, targetId);
        await persistOwner(vc.id, vc.guild.id, targetId);
        await vc.permissionOverwrites.edit(targetId, { ManageChannels: true, MoveMembers: true, Connect: true, ViewChannel: true });
        return ephem(interaction, `Ownership transferred to <@${targetId}>.`);
      }
      return;
    }

    // --- String-select menus (submit) ---
    if (anyI.isStringSelectMenu?.()) {
      if (action === 'region') {
        const region = anyI.values[0] === 'auto' ? null : anyI.values[0];
        await vc.setRTCRegion(region);
        return ephem(interaction, `Region set to **${region ?? 'Automatic'}**.`);
      }
      return;
    }

    // --- Buttons ---
    if (!anyI.isButton?.()) return;

    switch (action) {
      case 'lock':
        await vc.permissionOverwrites.edit(everyone, { Connect: false });
        return ephem(interaction, '🔒 Channel locked — no new members can join.');
      case 'unlock':
        await vc.permissionOverwrites.edit(everyone, { Connect: null });
        return ephem(interaction, '🔓 Channel unlocked.');
      case 'hide':
        await vc.permissionOverwrites.edit(everyone, { ViewChannel: false });
        return ephem(interaction, '👁️ Channel hidden from the channel list.');
      case 'show':
        await vc.permissionOverwrites.edit(everyone, { ViewChannel: null });
        return ephem(interaction, '👁️ Channel is visible again.');
      case 'claim': {
        const ownerId = owners.get(vc.id);
        const ownerInChannel = ownerId ? vc.members.has(ownerId) : false;
        if (ownerInChannel) return ephem(interaction, 'The owner is still here — you can only claim an abandoned channel.');
        owners.set(vc.id, userId);
        await persistOwner(vc.id, vc.guild.id, userId);
        await vc.permissionOverwrites.edit(userId, { ManageChannels: true, MoveMembers: true, Connect: true, ViewChannel: true });
        return ephem(interaction, '🙋 You are now the owner of this channel.');
      }
      case 'rename': {
        const modal = new ModalBuilder().setCustomId(`${PANEL_PREFIX}rename`).setTitle('Rename Channel');
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('name').setLabel('New channel name').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true),
          ),
        );
        return anyI.showModal(modal);
      }
      case 'limit': {
        const modal = new ModalBuilder().setCustomId(`${PANEL_PREFIX}limit`).setTitle('Set User Limit');
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('limit').setLabel('Max users (0 = unlimited)').setStyle(TextInputStyle.Short).setMaxLength(2).setRequired(true),
          ),
        );
        return anyI.showModal(modal);
      }
      case 'bitrate': {
        const modal = new ModalBuilder().setCustomId(`${PANEL_PREFIX}bitrate`).setTitle('Set Bitrate');
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId('bitrate').setLabel('Bitrate in kbps (8-384)').setStyle(TextInputStyle.Short).setMaxLength(3).setRequired(true),
          ),
        );
        return anyI.showModal(modal);
      }
      case 'kick':
      case 'permit':
      case 'reject':
      case 'transfer': {
        const labels: Record<string, string> = { kick: 'kick', permit: 'permit', reject: 'reject', transfer: 'transfer ownership to' };
        const select = new UserSelectMenuBuilder()
          .setCustomId(`${PANEL_PREFIX}${action}`)
          .setPlaceholder(`Select a user to ${labels[action]}`)
          .setMinValues(1)
          .setMaxValues(1);
        return anyI.reply({
          content: 'Choose a user:',
          ephemeral: true,
          components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select)],
        });
      }
      case 'region': {
        const select = new StringSelectMenuBuilder()
          .setCustomId(`${PANEL_PREFIX}region`)
          .setPlaceholder('Select a voice region')
          .addOptions(
            { label: 'Automatic', value: 'auto' },
            { label: 'US East', value: 'us-east' },
            { label: 'US West', value: 'us-west' },
            { label: 'US Central', value: 'us-central' },
            { label: 'Europe', value: 'rotterdam' },
            { label: 'Singapore', value: 'singapore' },
            { label: 'Sydney', value: 'sydney' },
            { label: 'Brazil', value: 'brazil' },
            { label: 'Japan', value: 'japan' },
          );
        return anyI.reply({
          content: 'Choose a region:',
          ephemeral: true,
          components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        });
      }
      default:
        return;
    }
  } catch (err) {
    logger.error({ err }, 'voice: interaction handler error');
    await ephem(interaction, 'Something went wrong handling that action.').catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------
async function startupSweep(client: Client): Promise<void> {
  try {
    const rows = await prisma.voiceChannel.findMany();
    for (const row of rows) {
      const ch = await client.channels.fetch(row.discordChannelId).catch(() => null);
      if (!ch || ch.type !== ChannelType.GuildVoice) {
        await forgetChannel(row.discordChannelId);
        continue;
      }
      owners.set(row.discordChannelId, row.ownerId);
      if ((ch as VoiceChannel).members.size === 0) await deleteIfEmpty(ch as VoiceChannel);
    }
    logger.info({ tracked: owners.size }, 'voice: startup sweep complete');
  } catch (err) {
    logger.warn({ err }, 'voice: startup sweep failed');
  }
}

function periodicSweep(): void {
  setInterval(() => {
    for (const channelId of [...owners.keys()]) {
      const ch = clientRef?.channels.cache.get(channelId);
      if (ch && ch.type === ChannelType.GuildVoice) {
        void deleteIfEmpty(ch as VoiceChannel);
      }
    }
  }, 60_000).unref?.();
}

// Poll the lobby for stranded members and (re)create their channels. This is the
// retry/recovery path for a missed join event or a previously-failed create.
function periodicLobbyReconcile(): void {
  setInterval(() => {
    void reconcileLobby();
  }, 15_000).unref?.();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function register(client: Client): void {
  clientRef = client;
  client.on('voiceStateUpdate', onVoiceStateUpdate);
  client.on('interactionCreate', onInteraction);
  client.once('ready', () => {
    void startupSweep(client);
    periodicSweep();
    // Catch anyone already sitting in the lobby at boot, then keep polling so a
    // missed event or a since-fixed permission error self-heals.
    void reconcileLobby();
    periodicLobbyReconcile();
  });
  logger.info('voice: service registered');
}

export default { register, invalidateVoiceCache };
module.exports = { register, invalidateVoiceCache };
