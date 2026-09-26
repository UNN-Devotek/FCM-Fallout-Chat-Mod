import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hudGiveawayCommand, hudGiveawayFeedback } from '../hudGiveawayCommand';

describe('HUD giveaway command boundary', () => {
  test('accepts giveaway only, including native slash-stripped input', () => {
    assert.equal(hudGiveawayCommand('/giveaway start Flux 5'), '/giveaway start Flux 5');
    assert.equal(hudGiveawayCommand('giveaway leave ABC234'), '/giveaway leave ABC234');
    assert.equal(hudGiveawayCommand('/ban someone'), null);
    assert.equal(hudGiveawayCommand('giveaways are fun'), null);
  });

  test('compacts list rows into a bounded HUD receipt', () => {
    const text = hudGiveawayFeedback({ handled: true, actionType: 'private', targetChannelId: 'events',
      botMessage: '2 active giveaways', metadata: { type: 'giveaway_list', giveaways: [
        { shortId: 'ABC234', itemName: 'Flux' }, { shortId: 'DEF567', itemName: 'Plans' },
      ] } });
    assert.match(text, /ABC234 Flux.*DEF567 Plans/);
    assert.ok(text.length <= 180);
  });

  test('preserves private join and own-giveaway replies for the HUD receipt', () => {
    for (const message of [
      "✅ You've entered giveaway [ABC123]! Total entries: 1.",
      "You can't enter your own giveaway.",
    ]) {
      assert.equal(hudGiveawayFeedback({ handled: true, actionType: 'private',
        targetChannelId: 'global', botMessage: message }), message);
    }
  });
});
