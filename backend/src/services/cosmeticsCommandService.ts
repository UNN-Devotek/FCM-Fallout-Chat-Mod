/**
 * Discord `/cosmetics` command.
 *
 * This layer ONLY marshals interactions. Every rule — validation, tier gating,
 * blacklist, cache busting, live push, audit — lives in
 * cosmeticsService.applyCosmetics, which the web PATCH endpoint calls too. That is
 * what makes the two surfaces structurally incapable of drifting; a change made here
 * appears instantly in the overlay and vice versa, through the same code.
 *
 * Follows the repo's existing bot conventions: a `register(client)` export attached in
 * discordService, a customId prefix guard so this listener ignores ticket and voice
 * interactions, and guild-scoped command registration on ready (instant, unlike global
 * which takes up to an hour to propagate).
 */
import {
  Client,
  Interaction,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import logger from '../config/logger';
import env from '../config/environment';
import { getUserByDiscordId } from './userLookup';
import { getSupporterStatus } from './supporterService';
import { applyCosmetics, resolveCosmetics, type CosmeticPatch } from './cosmetics/cosmeticsService';
import { COLOR_PRESETS, EFFECT_PRESETS, findColorPreset, findEffectPreset } from './cosmetics/presets';
import { TAG_MAX_LENGTH } from './cosmetics/validation';
import { tierLabel } from '../utils/supporterTier';
import {
  buildCosmeticId,
  parseCosmeticId,
  buildColorChoices,
  buildEffectChoices,
  reasonToMessage,
} from './cosmeticsCommandHelpers';

const COMMAND_NAME = 'cosmetics';
/** House brand colour used by every FCM embed. */
const BRAND_EMBED_COLOR = 0xf1c40f;

function shopUrl(): string | null {
  return env.SUPPORTER_TIER_ENABLED ? env.DISCORD_SERVER_SHOP_URL || null : null;
}

// ── Replies ───────────────────────────────────────────────────────────────────

/**
 * Ephemeral by default and without exception: these are personal settings, and a
 * public reply would spam the channel every time someone tweaks their colour.
 * Uses the modern MessageFlags.Ephemeral form, not the legacy `ephemeral: true`.
 */
async function ephem(interaction: any, content: string): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch {
    /* interaction expired — non-fatal */
  }
}

async function ephemEmbed(interaction: any, embed: EmbedBuilder): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [embed] });
    else await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  } catch {
    /* interaction expired — non-fatal */
  }
}

/** Resolve the caller's FCM account, replying with the link CTA when absent. */
async function requireLinkedUser(interaction: any): Promise<{ userId: string; discordId: string } | null> {
  const discordId: string = interaction.user?.id;
  const user = await getUserByDiscordId(discordId);
  if (!user) {
    await ephem(
      interaction,
      reasonToMessage('not_linked', {}, { linkUrl: `${env.FCM_PUBLIC_BASE_URL}/link` }),
    );
    return null;
  }
  return { userId: user.id, discordId };
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleShow(interaction: any): Promise<void> {
  const target = interaction.options.getUser?.('user') ?? interaction.user;
  const user = await getUserByDiscordId(target.id);
  if (!user) {
    await ephem(interaction, `${target.id === interaction.user.id ? 'You have' : 'That user has'} no linked Fallout Chat Mod account.`);
    return;
  }

  const [cosmetics, status] = await Promise.all([
    resolveCosmetics(user.id),
    getSupporterStatus(target.id),
  ]);

  const embed = new EmbedBuilder()
    .setTitle(`${user.chatName ?? user.username} — chat appearance`)
    // The embed's colour strip is a real swatch, so this doubles as a live preview.
    .setColor(cosmetics.nameColor ? Number.parseInt(cosmetics.nameColor.replace('#', ''), 16) : BRAND_EMBED_COLOR)
    .addFields(
      { name: 'Tier', value: tierLabel(status.tier), inline: true },
      { name: 'Chat name', value: user.chatName ?? '_default_', inline: true },
      { name: 'Colour', value: cosmetics.nameColor ?? '_default_', inline: true },
      { name: 'Effect', value: findEffectPreset(cosmetics.effectId)?.label ?? '_none_', inline: true },
      { name: 'Tag', value: cosmetics.tag ?? '_none_', inline: true },
    );

  if (status.hasEntitlement && !status.privilegesActive) {
    embed.setFooter({
      text: 'Your supporter perks are paused because you are not currently in the Discord. Rejoin and they come straight back — you do not need to buy anything again.',
    });
  } else if (cosmetics.effectId) {
    embed.setFooter({ text: 'Effects render on the desktop overlay and website. In-game shows your colour and tag only.' });
  }

  await ephemEmbed(interaction, embed);
}

async function handleColorOrEffect(interaction: any, kind: 'color' | 'effect'): Promise<void> {
  const caller = await requireLinkedUser(interaction);
  if (!caller) return;

  const presetId = interaction.options.getString('preset', true);
  const patch = kind === 'color' ? { colorPresetId: presetId } : { effectId: presetId };

  const result = await applyCosmetics({ userId: caller.userId, patch, actor: { kind: 'self', discordId: caller.discordId } });
  if (!result.ok) {
    await ephem(interaction, reasonToMessage(result.reason, result.detail, { shopUrl: shopUrl() }));
    return;
  }

  if (kind === 'color') {
    const preset = findColorPreset(presetId);
    await ephem(interaction, `Your name colour is now **${preset?.label ?? presetId}** (${preset?.hex ?? ''}).`);
  } else {
    const preset = findEffectPreset(presetId);
    const note = presetId === 'none' ? '' : ' It shows on the desktop overlay and website — in-game shows your colour only.';
    await ephem(interaction, `Your name effect is now **${preset?.label ?? presetId}**.${note}`);
  }
}

async function showTagModal(interaction: any): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(buildCosmeticId('tag'))
    .setTitle('Set your chat tag');
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('value')
        .setLabel(`Tag (up to ${TAG_MAX_LENGTH} characters)`)
        .setStyle(TextInputStyle.Short)
        .setMaxLength(TAG_MAX_LENGTH)
        .setRequired(true),
    ),
  );
  await interaction.showModal(modal);
}

async function handleTagModalSubmit(interaction: any): Promise<void> {
  const caller = await requireLinkedUser(interaction);
  if (!caller) return;

  const value = interaction.fields.getTextInputValue('value');
  const patch = { customTag: value };

  // Re-check the tier at SUBMIT, not just when the modal was opened — the tier could
  // have lapsed in between. Fail closed.
  const result = await applyCosmetics({ userId: caller.userId, patch, actor: { kind: 'self', discordId: caller.discordId } });
  if (!result.ok) {
    await ephem(interaction, reasonToMessage(result.reason, result.detail, { shopUrl: shopUrl() }));
    return;
  }

  await ephem(
    interaction,
    `Your chat tag is now **${result.cosmetics.tag}**.`,
  );
}

async function handleClear(interaction: any): Promise<void> {
  const caller = await requireLinkedUser(interaction);
  if (!caller) return;

  const field: string = interaction.options.getString('field') ?? 'all';
  const BY_FIELD: Record<string, CosmeticPatch> = {
    color: { colorPresetId: null, customColorHex: null },
    effect: { effectId: null },
    tag: { customTag: null },
  };
  const patch: CosmeticPatch =
    field === 'all'
      ? { colorPresetId: null, customColorHex: null, effectId: null, customTag: null }
      : BY_FIELD[field] ?? {};

  const result = await applyCosmetics({ userId: caller.userId, patch, actor: { kind: 'self', discordId: caller.discordId } });
  if (!result.ok) {
    await ephem(interaction, reasonToMessage(result.reason, result.detail, { shopUrl: shopUrl() }));
    return;
  }
  await ephem(interaction, field === 'all' ? 'Your chat appearance is back to default.' : `Your ${field} is back to default.`);
}

async function handleHelp(interaction: any): Promise<void> {
  const url = shopUrl();
  const embed = new EmbedBuilder()
    .setTitle('Chat appearance')
    .setColor(BRAND_EMBED_COLOR)
    .setDescription(
      [
        'Customise how your name looks in Fallout Chat Mod. You can do all of this here, or on your profile on the website — both use the same settings.',
        '',
        '**Everyone**',
        '`/name` — set your free chat name (also available on your website profile)',
        '`/cosmetics color` — pick a name colour',
        '`/cosmetics show` — see your current look',
        '`/cosmetics clear` — go back to default',
        '',
        '**Supporters**',
        '`/cosmetics effect` — glow and CRT effects',
        '',
        "**Overseer's Circle**",
        '`/cosmetics effect` — animated effects, including Glitch and Shimmer',
        '`/cosmetics tag` — a short tag beside your name',
        '',
        '**Where things show up**',
        'Your name and colour show everywhere: the website, the desktop overlay, and in-game.',
        'Effects show on the website and desktop overlay only — the game\'s UI engine cannot draw them.',
        '',
        'Every chat, moderation and overlay feature is free and always will be. Supporting only changes how your name looks.',
      ].join('\n'),
    );
  if (url) embed.addFields({ name: 'Support the project', value: url });
  await ephemEmbed(interaction, embed);
}

// ── Autocomplete ──────────────────────────────────────────────────────────────

async function handleAutocomplete(interaction: any): Promise<void> {
  try {
    const sub = interaction.options.getSubcommand(false);
    const focused = interaction.options.getFocused?.(true);
    const query: string = typeof focused === 'string' ? focused : focused?.value ?? '';

    const status = await getSupporterStatus(interaction.user?.id);
    const choices =
      sub === 'effect'
        ? buildEffectChoices(EFFECT_PRESETS, status.tier, query)
        : buildColorChoices(COLOR_PRESETS, status.tier, query);

    await interaction.respond(choices);
  } catch (err) {
    logger.warn({ err }, '[cosmetics] autocomplete failed (non-fatal)');
    try { await interaction.respond([]); } catch { /* expired */ }
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function onInteraction(interaction: Interaction): Promise<void> {
  const i = interaction as any;
  try {
    if (i.isAutocomplete?.()) {
      if (i.commandName !== COMMAND_NAME) return;
      return await handleAutocomplete(i);
    }

    if (i.isChatInputCommand?.()) {
      if (i.commandName !== COMMAND_NAME) return;
      const sub = i.options.getSubcommand();
      switch (sub) {
        case 'show': return await handleShow(i);
        case 'color': return await handleColorOrEffect(i, 'color');
        case 'effect': return await handleColorOrEffect(i, 'effect');
        case 'tag': return await showTagModal(i);
        case 'clear': return await handleClear(i);
        case 'help': return await handleHelp(i);
        default: return;
      }
    }

    // Prefix guard — ignore ticket/voice modals, which share this event.
    const parsed = parseCosmeticId(i.customId);
    if (!parsed.isOurs) return;

    if (i.isModalSubmit?.()) {
      if (parsed.action === 'tag') return await handleTagModalSubmit(i);
    }
  } catch (err) {
    logger.error({ err }, '[cosmetics] interaction handler error');
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

function buildCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription('Customise how your name looks in chat')
    // Personal settings only — no Discord permission gate. Access is by supporter
    // tier at runtime, which is a product decision, not a moderation one.
    .setDMPermission(false)
    .addSubcommand((s) => s
      .setName('show')
      .setDescription('Show your current chat appearance')
      .addUserOption((o) => o.setName('user').setDescription('Show someone else instead').setRequired(false)))
    .addSubcommand((s) => s
      .setName('color')
      .setDescription('Pick your name colour')
      .addStringOption((o) => o.setName('preset').setDescription('Colour').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s
      .setName('effect')
      .setDescription('Pick a name effect (supporters)')
      .addStringOption((o) => o.setName('preset').setDescription('Effect').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('tag').setDescription("Set a tag beside your name (Overseer's Circle)"))
    .addSubcommand((s) => s
      .setName('clear')
      .setDescription('Reset your appearance to default')
      .addStringOption((o) => o
        .setName('field')
        .setDescription('What to reset')
        .setRequired(false)
        .addChoices(
          { name: 'everything', value: 'all' },
          { name: 'colour', value: 'color' },
          { name: 'effect', value: 'effect' },
          { name: 'tag', value: 'tag' },
        )))
    .addSubcommand((s) => s.setName('help').setDescription('How chat appearance works'))
    .toJSON();
}

async function registerCommands(client: Client): Promise<void> {
  const guildId = env.DISCORD_SERVER_ID;
  if (!guildId) {
    logger.warn('[cosmetics] DISCORD_SERVER_ID unset — /cosmetics not registered');
    return;
  }
  try {
    // Guild-scoped: propagates instantly, unlike global commands (up to an hour).
    await client.application?.commands.create(buildCommand(), guildId);
    logger.info('[cosmetics] /cosmetics registered');
  } catch (err) {
    logger.warn({ err }, '[cosmetics] failed to register /cosmetics');
  }
}

export function register(client: Client): void {
  // Master kill switch. With the tier off (the default, including in production) the
  // command is never registered and the listener never attaches, so the feature is
  // completely invisible until it is deliberately switched on.
  if (!env.SUPPORTER_TIER_ENABLED) {
    logger.info('[cosmetics] SUPPORTER_TIER_ENABLED is false — /cosmetics not registered');
    return;
  }
  client.on('interactionCreate', (i) => void onInteraction(i));
  client.once('ready', () => { void registerCommands(client); });
}

export default { register };
module.exports = { register };
module.exports.default = module.exports;
