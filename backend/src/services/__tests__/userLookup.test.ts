import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isRealFo76Name } from '../userLookup';

describe('isRealFo76Name', () => {
  test('rejects every generated identity placeholder', () => {
    for (const value of [null, '', 'Wanderer', 'pending-moderation', 'discord:1181425135392129104', 'Overlay1234']) {
      assert.equal(isRealFo76Name(value), false, `${value} must not be used as a displayed Fallout name`);
    }
  });

  test('keeps a genuine Fallout character name', () => {
    assert.equal(isRealFo76Name('MothmanFan'), true);
  });
});
