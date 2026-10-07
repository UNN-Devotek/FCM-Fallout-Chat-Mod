import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { checkChatSlowmode, chatSlowmodeMessage } from './chatSlowmodeService';
import { finalizeMessage } from './ingestMessage';

/** Human command relays share the same budget as typed Discord/HUD/overlay chat.
 * Private command responses and structured bot cards never enter this path.
 */
export async function publishDiscordCommandRelay(
  interaction: Pick<ChatInputCommandInteraction, 'reply'>,
  message: Parameters<typeof finalizeMessage>[0],
  discordId: string,
): Promise<boolean> {
  const cooldown = await checkChatSlowmode({ id: message.userId, discordId });
  if (!cooldown.allowed) {
    await interaction.reply({
      content: chatSlowmodeMessage(cooldown.retryAfterMs),
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  await finalizeMessage(message);
  return true;
}
