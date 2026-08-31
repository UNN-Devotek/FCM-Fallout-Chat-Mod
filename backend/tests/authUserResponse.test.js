'use strict';

const { buildAuthUserResponse } = require('../src/utils/authUserResponse');

describe('buildAuthUserResponse', () => {
  it('exposes the internal UUID for message ownership while preserving Discord identity', () => {
    const result = buildAuthUserResponse(
      { id: 'discord-user-id', username: 'vaultdweller', role: 'member' },
      { id: 'user-uuid' },
      { fo76Name: 'Devotek-', discordDisplayName: 'Devotek', avatarUrl: '/avatars/discord-user-id' },
    );

    expect(result).toMatchObject({
      id: 'user-uuid',
      discordId: 'discord-user-id',
      fo76Name: 'Devotek-',
      discordDisplayName: 'Devotek',
    });
  });

  it('falls back to the session id when a database row is not available', () => {
    const result = buildAuthUserResponse(
      { id: 'dev-persona-id', username: 'Dev', role: 'member' },
      null,
      { fo76Name: null, discordDisplayName: 'Dev', avatarUrl: null },
    );

    expect(result.id).toBe('dev-persona-id');
    expect(result.discordId).toBe('dev-persona-id');
  });
});
