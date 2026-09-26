/** Keep a giveaway in its mapped Discord channel, including its final result. */
export function giveawayDiscordChannelId(
  mappings: Map<string, string>,
  fcmChannelId: string,
  preferredDiscordChannelId?: string,
): string | null {
  if (preferredDiscordChannelId) return preferredDiscordChannelId;
  for (const [discordChannelId, mappedFcmChannelId] of mappings) {
    if (mappedFcmChannelId === fcmChannelId) return discordChannelId;
  }
  return null;
}
