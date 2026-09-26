import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { giveawayDiscordCard, giveawayWinnerDiscordCard } from '../giveawayDiscordCard';

const active = {
  shortId: 'ABC234', itemName: 'Flux x10', creatorName: 'Vault Dweller',
  endsAt: new Date('2026-09-25T17:00:00Z'), entryCount: 2, status: 'active',
};

describe('Discord giveaway cards', () => {
  test('active card has ID-bound join, leave, and stop buttons and no mentions', () => {
    const card = giveawayDiscordCard(active);
    assert.equal(card.embeds?.length, 1);
    assert.equal(card.components?.length, 1);
    const components = JSON.stringify(card.components);
    assert.match(components, /fcm:giveaway:join:ABC234/);
    assert.match(components, /fcm:giveaway:leave:ABC234/);
    assert.match(components, /fcm:giveaway:stop:ABC234/);
    assert.deepEqual(card.allowedMentions, { parse: [] });
  });

  test('completed card removes actions and winner post names the winner', () => {
    const done = { ...active, status: 'completed', winnerName: 'Wastelander' };
    assert.deepEqual(giveawayDiscordCard(done).components, []);
    assert.match(JSON.stringify(giveawayWinnerDiscordCard(done).embeds), /Wastelander/);
  });
});
