const { giveawayDiscordChannelId } = require('../src/services/giveawayDiscordRoute');

test('giveaway card uses the originating channel mapping', () => {
  const mappings = new Map([['discord-general', 'fcm-general'], ['discord-events', 'fcm-events']]);
  expect(giveawayDiscordChannelId(mappings, 'fcm-general')).toBe('discord-general');
  expect(giveawayDiscordChannelId(mappings, 'fcm-events')).toBe('discord-events');
});

test('unmapped giveaway does not fall back to an unrelated Discord channel', () => {
  expect(giveawayDiscordChannelId(new Map([['discord-events', 'fcm-events']]), 'fcm-unmapped')).toBeNull();
});

test('result remains beside its original Discord card when mappings change', () => {
  expect(giveawayDiscordChannelId(new Map(), 'fcm-general', 'original-discord-channel'))
    .toBe('original-discord-channel');
});
