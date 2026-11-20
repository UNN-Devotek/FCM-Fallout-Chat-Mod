/** Moderator-facing names for moderation embeds, Discord /mod labels and lookups. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlaceholderUsername, resolveFo76Name, resolveUserDisplayName } from '../userDisplayName';

// Shape of the 2026-11-12 ban target: Steam/HUD-linked, never Discord-linked.
const steamOnly = {
  username: 'pending-06b740fe', chatName: null, steamDisplayName: 'godagarah',
  fo76AccountName: 'godagarah5000', fo76CharacterName: null, discordDisplayName: null, discordUsername: null,
};

describe('resolveUserDisplayName', () => {
  test('uses the chat-visible Steam name instead of a pending-* placeholder', () => {
    assert.equal(resolveUserDisplayName(steamOnly), 'godagarah');
  });

  test('uses the Discord display name instead of a discord:<id> actor placeholder', () => {
    assert.equal(resolveUserDisplayName({ username: 'discord:185069913252167681', discordDisplayName: 'MouseyPaige', discordUsername: 'mouseypaige' }), 'MouseyPaige');
  });

  test('prefers the chosen chat name, then a real FO76 username', () => {
    assert.equal(resolveUserDisplayName({ ...steamOnly, chatName: '  Vault Dweller ' }), 'Vault Dweller');
    assert.equal(resolveUserDisplayName({ ...steamOnly, username: 'RealCharacter' }), 'RealCharacter');
  });

  test('falls back to stored FO76 names before exposing the placeholder', () => {
    assert.equal(resolveUserDisplayName({ ...steamOnly, steamDisplayName: null }), 'godagarah5000');
    assert.equal(resolveUserDisplayName({ username: 'pending-1' }), 'pending-1');
    assert.equal(resolveUserDisplayName(null), 'unknown');
  });
});

describe('resolveFo76Name / isPlaceholderUsername', () => {
  test('reports the stored FO76 name only when the username is a placeholder', () => {
    assert.equal(resolveFo76Name(steamOnly), 'godagarah5000');
    assert.equal(resolveFo76Name({ username: 'RealCharacter', fo76AccountName: 'other' }), 'RealCharacter');
    assert.equal(resolveFo76Name({ username: 'overlay2467' }), null);
  });

  test('treats every synthetic username form as a placeholder', () => {
    for (const value of [null, ' ', 'Wanderer', 'pending-x', 'discord:1', 'admin-discord-1', 'Overlay12', 'overlay12']) {
      assert.equal(isPlaceholderUsername(value), true, String(value));
    }
    assert.equal(isPlaceholderUsername('MothmanFan'), false);
  });
});
