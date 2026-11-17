import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { checkChatSlowmode, chatSlowmodeMessage } from './chatSlowmodeService';
import { checkPostingStanding, evaluateChatAutomod } from './chatPostingGate';
import { finalizeMessage } from './ingestMessage';

/** Human command relays share the same gates as typed Discord/HUD/overlay chat:
 * account standing (ban, kick cooldown, mute), the shared slowmode budget and
 * the automod engine, in the same order as the overlay `chat:send` path.
 * Private command responses and structured bot cards never enter this path.
 *
 * `rawInput` is the text the member typed (for example `/g hello`); automod
 * evaluates it like overlay chat does. It defaults to the relayed content.
 */
export async function publishDiscordCommandRelay(
  interaction: Pick<ChatInputCommandInteraction, 'reply'>,
  message: Parameters<typeof finalizeMessage>[0],
  discordId: string,
  options: { rawInput?: string } = {},
): Promise<boolean> {
  const refuse = async (content: string) => {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    return false;
  };
  const standing = await checkPostingStanding({ userId: message.userId });
  if (standing) return refuse(standing.message);
  const cooldown = await checkChatSlowmode({ id: message.userId, discordId });
  if (!cooldown.allowed) return refuse(chatSlowmodeMessage(cooldown.retryAfterMs));
  const automod = await evaluateChatAutomod(options.rawInput ?? message.content, message.channelId, {
    id: message.userId, username: message.displayName, discordId,
  });
  if (automod) return refuse(automod.message);
  await finalizeMessage(message);
  return true;
}
