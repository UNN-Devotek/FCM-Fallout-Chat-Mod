/**
 * In-game client capability gating. Runs under node:test via src/testRunner.ts.
 *
 * The behaviour that matters here is FAILING CLOSED. The `.ba2` is distributed as a
 * manual file copy with no auto-update, so old widgets stay in circulation forever. If
 * the relay ever mistakes an old client for a new one, every player on that build sees
 * raw wire data inside other users' usernames, permanently, with no way to push a fix.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_COSMETICS_VERSION,
  parseClientVersion,
  compareVersions,
  versionAtLeast,
  supportsCosmetics,
  rememberClientVersion,
  getClientVersion,
  connectionSupportsCosmetics,
} from '../clientCapability';

describe('parseClientVersion', () => {
  test('parses plain and v-prefixed versions', () => {
    assert.deepEqual(parseClientVersion('2.10.0'), { major: 2, minor: 10, patch: 0 });
    assert.deepEqual(parseClientVersion('v2.10.0'), { major: 2, minor: 10, patch: 0 });
    assert.deepEqual(parseClientVersion(' 2.10.0 '), { major: 2, minor: 10, patch: 0 });
  });

  test('tolerates a suffix', () => {
    assert.deepEqual(parseClientVersion('2.10.0-dev'), { major: 2, minor: 10, patch: 0 });
    assert.deepEqual(parseClientVersion('2.10.0+build7'), { major: 2, minor: 10, patch: 0 });
  });

  test('returns null for anything unparseable — including absence', () => {
    // An old widget reports NO version. That must never be mistaken for a new one.
    for (const bad of [undefined, null, '', '2.10', 'abc', 42, {}, [], 'v'] as unknown[]) {
      assert.equal(parseClientVersion(bad), null, `${JSON.stringify(bad)} should not parse`);
    }
  });
});

describe('compareVersions', () => {
  test('orders by major, then minor, then patch', () => {
    const v = (s: string) => parseClientVersion(s)!;
    assert.equal(compareVersions(v('1.0.0'), v('2.0.0')), -1);
    assert.equal(compareVersions(v('2.9.4'), v('2.10.0')), -1); // NOT string comparison
    assert.equal(compareVersions(v('2.10.0'), v('2.10.1')), -1);
    assert.equal(compareVersions(v('2.10.0'), v('2.10.0')), 0);
    assert.equal(compareVersions(v('3.0.0'), v('2.99.99')), 1);
  });

  test('2.10 sorts above 2.9 (the string-compare trap)', () => {
    // '2.10.0' < '2.9.4' lexicographically. Getting this wrong would lock every
    // updated client OUT of cosmetics while letting nothing in — silent and confusing.
    assert.ok('2.10.0' < '2.9.4', 'precondition: string compare really is misleading here');
    assert.equal(compareVersions(parseClientVersion('2.10.0')!, parseClientVersion('2.9.4')!), 1);
  });
});

describe('supportsCosmetics — fails closed', () => {
  test('accepts the minimum version and anything newer', () => {
    assert.equal(supportsCosmetics(MIN_COSMETICS_VERSION), true);
    assert.equal(supportsCosmetics('2.10.1'), true);
    assert.equal(supportsCosmetics('3.0.0'), true);
  });

  test('rejects every older build', () => {
    for (const old of ['2.9.4', '2.9.3', '2.8.7', '1.0.0']) {
      assert.equal(supportsCosmetics(old), false, `${old} must not be treated as capable`);
    }
  });

  test('rejects a client that reports NOTHING — the actual old-build case', () => {
    for (const missing of [undefined, null, '', 'unknown', 0, false] as unknown[]) {
      assert.equal(supportsCosmetics(missing), false, `${JSON.stringify(missing)} must fail closed`);
    }
  });
});

describe('versionAtLeast', () => {
  test('returns false when the floor itself is unparseable rather than defaulting to true', () => {
    assert.equal(versionAtLeast('9.9.9', 'not-a-version'), false);
  });
});

describe('per-connection registry', () => {
  test('remembers and reads back a reported version', () => {
    const ws = {};
    assert.equal(getClientVersion(ws), null);
    rememberClientVersion(ws, '2.10.0');
    assert.equal(getClientVersion(ws), '2.10.0');
    assert.equal(connectionSupportsCosmetics(ws), true);
  });

  test('a connection that reported nothing is not capable', () => {
    const ws = {};
    rememberClientVersion(ws, undefined);
    assert.equal(getClientVersion(ws), null);
    assert.equal(connectionSupportsCosmetics(ws), false);
  });

  test('ignores blank and non-string values rather than storing junk', () => {
    const ws = {};
    rememberClientVersion(ws, '   ');
    rememberClientVersion(ws, 123 as unknown as string);
    assert.equal(getClientVersion(ws), null);
  });

  test('connections are tracked independently', () => {
    const oldClient = {};
    const newClient = {};
    rememberClientVersion(oldClient, '2.9.4');
    rememberClientVersion(newClient, '2.10.0');
    assert.equal(connectionSupportsCosmetics(oldClient), false);
    assert.equal(connectionSupportsCosmetics(newClient), true);
  });

  test('a later hello can upgrade the recorded version', () => {
    const ws = {};
    rememberClientVersion(ws, '2.9.4');
    rememberClientVersion(ws, '2.10.0');
    assert.equal(connectionSupportsCosmetics(ws), true);
  });
});
