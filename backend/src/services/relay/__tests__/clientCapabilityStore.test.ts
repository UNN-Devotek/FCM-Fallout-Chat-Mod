/** Redis-backed capability handoff tests. Uses injected Redis doubles. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  rememberTokenClientVersionDurable,
  tokenCapabilityKey,
  tokenSupportsCosmeticsDurable,
  tokenSupportsHudCosmeticsTransportDurable,
} from '../clientCapabilityStore';

type FakeRedis = {
  values: Map<string, string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<string>;
};

function fakeRedis(): FakeRedis {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    async set(key, value, options) {
      assert.equal(options.EX, 86_400);
      values.set(key, value);
      return 'OK';
    },
  };
}

describe('durable relay client capability handoff', () => {
  test('writes only a digest-keyed version with a bounded TTL', async () => {
    const redis = fakeRedis();
    const token = 'durable-write-token';

    await rememberTokenClientVersionDurable(token, '2.10.9', async () => redis);

    assert.equal(redis.values.get(tokenCapabilityKey(token)), '2.10.9');
    assert.equal(redis.values.has(token), false);
  });

  test('recovers a capable version when the local registry is empty', async () => {
    const redis = fakeRedis();
    const token = 'durable-read-token';
    redis.values.set(tokenCapabilityKey(token), '2.10.9');

    assert.equal(
      await tokenSupportsCosmeticsDurable(token, async () => redis),
      true,
    );
  });

  test('recovers native HUD transport capability from the durable record', async () => {
    const redis = fakeRedis();
    const token = 'native-carrier-durable-token';
    redis.values.set(tokenCapabilityKey(token), '2.10.16');

    assert.equal(
      await tokenSupportsHudCosmeticsTransportDurable(token, async () => redis),
      true,
    );
  });

  test('fails closed for a missing Redis record or Redis error', async () => {
    const redis = fakeRedis();
    assert.equal(
      await tokenSupportsCosmeticsDurable('missing-durable-token', async () => redis),
      false,
    );
    assert.equal(
      await tokenSupportsCosmeticsDurable(
        'error-durable-token',
        async () => ({
          get: async () => { throw new Error('offline'); },
          set: async () => 'OK',
        }),
      ),
      false,
    );
  });
});
