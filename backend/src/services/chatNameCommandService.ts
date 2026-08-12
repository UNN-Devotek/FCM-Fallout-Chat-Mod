/**
 * Discord `/name` command — the bot surface for the free account chat name.
 *
 * This command intentionally registers independently of the supporter feature flag:
 * changing one's identity is a standard account action, not a paid cosmetic.
 */
import {
  ActionRowBuilder,
  Client,
  Interaction,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import env from '../config/environment';
import logger from '../config/logger';
import { CHAT_NAME_MAX_LENGTH } from '../utils/chatName';
import { getUserByDiscordId } from './userLookup';
import { setChatName } from './chatNameService';

const COMMAND_NAME = 'name';
const MODAL_ID = 'fcmname:set';
const INPUT_ID = 'chat-name';

async function ephem(interaction: any, content: string): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch {
    // Discord interactions expire quickly; never turn that into an unhandled error.
  }
}

function nameError(result: Exclude<Awaited<ReturnType<typeof setChatName>>, { ok: true }>): string {
  if (result.reason === 'not_found') return 'Link your Discord account to Fallout Chat Mod first.';
  return result.message;
}

async function showModal(interaction: any): Promise<void> {
  const modal = new ModalBuilder().setCustomId(MODAL_ID).setTitle('Set your FCM chat name');
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(INPUT_ID)
        .setLabel(`Chat name (up to ${CHAT_NAME_MAX_LENGTH} characters)`)
        .setPlaceholder('Leave empty to use your Fallout 76 / Discord name')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(CHAT_NAME_MAX_LENGTH)
        .setRequired(false),
    ),
  );
  await interaction.showModal(modal);
}

async function handleModal(interaction: any): Promise<void> {
  const user = await getUserByDiscordId(interaction.user.id);
  if (!user) return ephem(interaction, `Link your Discord account first: ${env.FCM_PUBLIC_BASE_URL}/link`);

  const raw = interaction.fields.getTextInputValue(INPUT_ID);
  const result = await setChatName({
    userId: user.id,
    chatName: raw.trim() ? raw : null,
    source: 'discord',
  });
  if (!result.ok) return ephem(interaction, nameError(result));

  await ephem(
    interaction,
    result.chatName
      ? `Your FCM chat name is now **${result.chatName}**.`
      : 'Your FCM chat name now follows your Fallout 76 / Discord name.',
  );
}

async function onInteraction(interaction: Interaction): Promise<void> {
  const i = interaction as any;
  try {
    if (i.isChatInputCommand?.() && i.commandName === COMMAND_NAME) {
      await showModal(i);
    } else if (i.isModalSubmit?.() && i.customId === MODAL_ID) {
      await handleModal(i);
    }
  } catch (err) {
    logger.error({ err }, '[chatName] Discord interaction failed');
  }
}

async function registerCommand(client: Client): Promise<void> {
  if (!env.DISCORD_SERVER_ID) {
    logger.warn('[chatName] DISCORD_SERVER_ID unset — /name not registered');
    return;
  }
  try {
    await client.application?.commands.create(
      new SlashCommandBuilder()
        .setName(COMMAND_NAME)
        .setDescription('Set your free Fallout Chat Mod chat name')
        .setDMPermission(false)
        .toJSON(),
      env.DISCORD_SERVER_ID,
    );
    logger.info('[chatName] /name registered');
  } catch (err) {
    logger.warn({ err }, '[chatName] failed to register /name');
  }
}

export function register(client: Client): void {
  client.on('interactionCreate', (interaction) => { void onInteraction(interaction); });
  client.once('ready', () => { void registerCommand(client); });
}

export default { register };
module.exports = { register };
module.exports.default = module.exports;
