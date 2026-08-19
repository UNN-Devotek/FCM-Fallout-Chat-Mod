import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DISCORD_NICKNAME_MAX_LENGTH,
  formatSupporterNickname,
  resolveSupporterNicknameBase,
  SUPPORTER_NICKNAME_STAR,
} from '../supporterNicknameService';

describe('formatSupporterNickname', () => {
  test('adds a Unicode star for an active Supporter', () => {
    assert.equal(
      formatSupporterNickname({ baseName: 'MothmanFan', tier: 'supporter', tag: null }),
      `${SUPPORTER_NICKNAME_STAR} MothmanFan`,
    );
  });

  test('adds the validated Overseer tag after the star', () => {
    assert.equal(
      formatSupporterNickname({ baseName: 'MothmanFan', tier: 'overseer', tag: 'ZAX' }),
      `${SUPPORTER_NICKNAME_STAR} [ZAX] MothmanFan`,
    );
  });

  test('removes the star and tag when the entitlement is inactive', () => {
    assert.equal(
      formatSupporterNickname({ baseName: 'MothmanFan', tier: 'none', tag: 'ZAX' }),
      'MothmanFan',
    );
  });

  test('preserves the star and tag when a long character name is shortened', () => {
    const result = formatSupporterNickname({
      baseName: 'A'.repeat(64),
      tier: 'overseer',
      tag: 'ZAX',
    });

    assert.ok(result.startsWith(`${SUPPORTER_NICKNAME_STAR} [ZAX] `));
    assert.equal(Array.from(result).length, DISCORD_NICKNAME_MAX_LENGTH);
  });

  test('does not split a Unicode character while enforcing Discords length limit', () => {
    const result = formatSupporterNickname({
      baseName: '😀'.repeat(40),
      tier: 'supporter',
      tag: null,
    });

    assert.equal(Array.from(result).length, DISCORD_NICKNAME_MAX_LENGTH);
    assert.ok(!result.includes('\uFFFD'));
  });
});

describe('resolveSupporterNicknameBase', () => {
  test('falls back to the Discord display name rather than exposing a synthetic username', () => {
    const baseName = resolveSupporterNicknameBase({
      id: 'user-1',
      username: 'discord:1181425135392129104',
      chatName: null,
      discordId: '1181425135392129104',
      discordUsername: 'devotekttv',
      discordDisplayName: 'Devotek TTV',
      isBanned: false,
      isMuted: false,
      hasRealFo76Name: false,
    });

    assert.equal(baseName, 'Devotek TTV');
  });
});
