import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageCreateOptions } from 'discord.js';

export type GiveawayCard = {
  shortId: string;
  itemName: string;
  creatorName: string;
  endsAt: Date;
  entryCount: number;
  status: string;
  winnerName?: string | null;
};

/** Discord presentation only; giveawayService remains the authority for every button action. */
export function giveawayDiscordCard(giveaway: GiveawayCard): MessageCreateOptions {
  const active = giveaway.status === 'active';
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(active ? `🎁 Giveaway: ${giveaway.itemName}` : `🎉 Giveaway ended: ${giveaway.itemName}`)
    .addFields(
      { name: 'Host', value: giveaway.creatorName, inline: true },
      { name: 'Entries', value: String(giveaway.entryCount), inline: true },
      { name: active ? 'Ends' : 'Ended', value: `<t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>`, inline: true },
    )
    .setFooter({ text: `Giveaway ID: ${giveaway.shortId}` });
  if (!active) embed.setDescription(giveaway.status === 'cancelled'
    ? 'This giveaway was cancelled.'
    : giveaway.winnerName ? `Winner: **${giveaway.winnerName}**` : 'No one entered.');
  return {
    embeds: [embed],
    components: active ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`fcm:giveaway:join:${giveaway.shortId}`).setLabel('Join').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`fcm:giveaway:leave:${giveaway.shortId}`).setLabel('Leave').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`fcm:giveaway:stop:${giveaway.shortId}`).setLabel('Stop').setStyle(ButtonStyle.Danger),
    )] : [],
    allowedMentions: { parse: [] },
  };
}

export function giveawayWinnerDiscordCard(giveaway: GiveawayCard): MessageCreateOptions {
  const description = giveaway.status === 'cancelled'
    ? `Giveaway **${giveaway.shortId}** for **${giveaway.itemName}** was cancelled.`
    : giveaway.winnerName
      ? `**${giveaway.winnerName}** won **${giveaway.itemName}**!`
      : `Giveaway **${giveaway.shortId}** for **${giveaway.itemName}** ended with no entries.`;
  return {
    embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle('🎉 Giveaway result')
      .setDescription(description).setFooter({ text: `Giveaway ID: ${giveaway.shortId}` })],
    allowedMentions: { parse: [] },
  };
}
