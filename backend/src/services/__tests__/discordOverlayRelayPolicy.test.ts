import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CommandResult } from '../commandService';
import { shouldMirrorDiscordCardToOverlay, shouldRelayDiscordResultToOverlay } from '../discordOverlayCommandService';

const cardResult = {
  handled: true,
  actionType: 'private',
  botMessage: 'Card response',
  targetChannelId: 'general',
  metadata: { type: 'minerva' },
} satisfies CommandResult;

describe('Discord-to-overlay relay policy', () => {
  test('keeps Minerva and other Discord cards out of FCM General when their channel is not linked', () => {
    assert.equal(shouldMirrorDiscordCardToOverlay(false, cardResult), false);
    assert.equal(shouldRelayDiscordResultToOverlay('/minerva', cardResult), false);
    assert.equal(shouldRelayDiscordResultToOverlay('/wiki toilet paper', cardResult), false);
    assert.equal(shouldRelayDiscordResultToOverlay('/camp table', cardResult), false);
  });

  test('mirrors a card only from a linked Discord channel to its paired FCM channel', () => {
    assert.equal(shouldMirrorDiscordCardToOverlay(true, cardResult), true);
  });

  test('giveaways publish through the canonical Events card path', () => {
    assert.equal(shouldRelayDiscordResultToOverlay('/giveaway start Flux x10', cardResult), false);
    assert.equal(shouldRelayDiscordResultToOverlay('/giveaway list', cardResult), false);
  });
});
