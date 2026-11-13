import { describe, expect, it } from 'vitest';
import { fo76NameOf, userDisplayName } from '../userDisplayName';

// Shape of the 2026-11-12 ban target: Steam/HUD-linked, never Discord-linked.
const steamOnly = {
  username: 'pending-06b740fe', chatName: null, steamDisplayName: 'godagarah',
  fo76AccountName: 'godagarah5000', fo76CharacterName: null, discordDisplayName: null, discordUsername: null,
};

describe('userDisplayName', () => {
  it('shows the chat-visible Steam name instead of a pending-* placeholder', () => {
    expect(userDisplayName(steamOnly)).toBe('godagarah');
  });

  it('shows the Discord display name instead of a discord:<id> placeholder', () => {
    expect(userDisplayName({ username: 'discord:185069913252167681', discordDisplayName: 'MouseyPaige', discordUsername: 'mouseypaige' }))
      .toBe('MouseyPaige');
  });

  it('prefers the chosen chat name, then a real FO76 username', () => {
    expect(userDisplayName({ ...steamOnly, chatName: 'Vault Dweller' })).toBe('Vault Dweller');
    expect(userDisplayName({ ...steamOnly, username: 'RealCharacter' })).toBe('RealCharacter');
  });

  it('falls back to the stored FO76 name, then the placeholder, then the caller fallback', () => {
    expect(userDisplayName({ ...steamOnly, steamDisplayName: null })).toBe('godagarah5000');
    expect(userDisplayName({ username: 'pending-1' })).toBe('pending-1');
    expect(userDisplayName(null, '(none)')).toBe('(none)');
  });
});

describe('fo76NameOf', () => {
  it('reports the stored FO76 name for a placeholder account and null when none exists', () => {
    expect(fo76NameOf(steamOnly)).toBe('godagarah5000');
    expect(fo76NameOf({ username: 'Overlay1234' })).toBeNull();
    expect(fo76NameOf({ username: 'RealCharacter', fo76AccountName: 'other' })).toBe('RealCharacter');
  });
});
