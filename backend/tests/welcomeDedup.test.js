'use strict';
/**
 * welcomeDedup — cross-path welcome deduplication unit tests.
 *
 * Tests the tryClaimWelcome / isWelcomeClaimed / clearWelcomeKeys helpers
 * and the three-path interaction contract (world:joined, inferred 60s, playerList).
 *
 * Uses a real in-memory Redis mock (no actual Redis server required).
 */

// ── In-memory Redis stub ─────────────────────────────────────────────────────
//
// Supports: get, set (EX, NX), del, multi().exec(), scanIterator.
// The multi() pipeline returns results in order; NX set returns 'OK' on win,
// null on collision — matches node-redis behaviour.

function makeRedisStub() {
  const store = new Map();    // key → { value, expiresAt }
  const now = () => Date.now();

  function isAlive(entry) {
    return !entry.expiresAt || entry.expiresAt > now();
  }

  function get(key) {
    const e = store.get(key);
    if (!e || !isAlive(e)) { store.delete(key); return null; }
    return e.value;
  }

  function set(key, value, opts = {}) {
    const existing = store.get(key);
    const alreadyLive = existing && isAlive(existing);

    if (opts.NX && alreadyLive) return null;  // NX: fail if exists

    const expiresAt = opts.EX ? now() + opts.EX * 1000 : null;
    store.set(key, { value, expiresAt });
    return 'OK';
  }

  function del(key) {
    return store.delete(key) ? 1 : 0;
  }

  // multi() collects ops and executes them one by one; returns results array.
  function multi() {
    const ops = [];
    const pipe = {
      set(key, value, opts) { ops.push(() => set(key, value, opts)); return pipe; },
      del(key)              { ops.push(() => del(key));              return pipe; },
      async exec()          { return ops.map(op => op()); },
    };
    return pipe;
  }

  // scanIterator: yields matching keys (alive only).
  async function* scanIterator({ MATCH }) {
    const re = new RegExp('^' + MATCH.replace(/\*/g, '.*') + '$');
    for (const [k, e] of store.entries()) {
      if (isAlive(e) && re.test(k)) yield k;
    }
  }

  return { get, set, del, multi, scanIterator, _store: store };
}

// ── Mock redis module so welcomeDedup uses our stub ──────────────────────────
// Jest mock factory cannot close over outer vars unless they're named "mock*".
// We set a fresh stub per test via beforeEach by updating the mock's implementation.
let mockRedisStub = makeRedisStub(); // initial value satisfies the factory constraint

// dist/services/welcomeDedup.js requires '../config/redis' from its own location,
// which resolves to dist/config/redis.js.  Mock that path so getRedisClient is
// intercepted without a real Redis connection.
jest.mock('../dist/config/redis', () => ({
  __esModule: true,
  getRedisClient: jest.fn().mockImplementation(() => Promise.resolve(mockRedisStub)),
  client: { on: jest.fn() },
}));

jest.mock('../dist/config/logger', () => {
  const fn = () => {};
  return { __esModule: true, default: { info: fn, warn: fn, error: fn, debug: fn } };
});

// Load once — the mock wires through a closure so per-test stub swaps work.
const redisMock = require('../dist/config/redis');
const welcomeDedup = require('../dist/services/welcomeDedup');

beforeEach(() => {
  mockRedisStub = makeRedisStub();
  // Update the mock so future getRedisClient() calls use the fresh stub.
  redisMock.getRedisClient.mockImplementation(() => Promise.resolve(mockRedisStub));
});

// ── tryClaimWelcome ──────────────────────────────────────────────────────────

describe('tryClaimWelcome: basic claim semantics', () => {
  test('first call wins, returns true', async () => {
    const won = await welcomeDedup.tryClaimWelcome('user-1', 1, '1.2.3.4:3001');
    expect(won).toBe(true);
  });

  test('same (userId, gen) → second call returns false (duplicate blocked)', async () => {
    await welcomeDedup.tryClaimWelcome('user-1', 1, '1.2.3.4:3001');
    const second = await welcomeDedup.tryClaimWelcome('user-1', 1, '1.2.3.4:3001');
    expect(second).toBe(false);
  });

  test('same userId, different gen → both win (new world join)', async () => {
    const first = await welcomeDedup.tryClaimWelcome('user-1', 1, '1.2.3.4:3001');
    // clear so gen=2 is a clean new join
    await welcomeDedup.clearWelcomeKeys('user-1');
    const second = await welcomeDedup.tryClaimWelcome('user-1', 2, '1.2.3.4:3001');
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  test('different users, same gen → independent, both win', async () => {
    const a = await welcomeDedup.tryClaimWelcome('user-A', 1, '1.2.3.4:3001');
    const b = await welcomeDedup.tryClaimWelcome('user-B', 1, '1.2.3.4:3001');
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});

describe('tryClaimWelcome: sets cross-path keys atomically', () => {
  test('after claim, sv:welcomed bare key is set (blocks playerList virtual check)', async () => {
    await welcomeDedup.tryClaimWelcome('user-1', 1, '1.2.3.4:3001');
    const val = mockRedisStub.get('sv:welcomed:user-1');
    expect(val).not.toBeNull();
  });

  test('after claim, sv:welcomed:<ep> key is set (blocks inferred path)', async () => {
    await welcomeDedup.tryClaimWelcome('user-1', 1, '1.2.3.4:3001');
    const val = mockRedisStub.get('sv:welcomed:user-1:1.2.3.4:3001');
    expect(val).not.toBeNull();
  });

  test('after claim, pl:summary key is set (blocks playerList summary path)', async () => {
    await welcomeDedup.tryClaimWelcome('user-1', 1, '1.2.3.4:3001');
    const val = mockRedisStub.get('pl:summary:user-1');
    expect(val).not.toBeNull();
  });

  test('after claim, wj:latestGen key is updated', async () => {
    await welcomeDedup.tryClaimWelcome('user-1', 5, '1.2.3.4:3001');
    const val = mockRedisStub.get('wj:latestGen:user-1');
    expect(val).toBe('5');
  });
});

// ── isWelcomeClaimed ─────────────────────────────────────────────────────────

describe('isWelcomeClaimed: cross-namespace visibility', () => {
  test('returns false when no keys set', async () => {
    const claimed = await welcomeDedup.isWelcomeClaimed('user-1', 1);
    expect(claimed).toBe(false);
  });

  test('returns true after tryClaimWelcome (sv:welcomed bare present)', async () => {
    await welcomeDedup.tryClaimWelcome('user-1', 1, '1.2.3.4:3001');
    const claimed = await welcomeDedup.isWelcomeClaimed('user-1', null);
    expect(claimed).toBe(true);
  });

  test('returns true if only wj:welcomed key is set (via latestGen lookup)', async () => {
    // Simulate: world:joined handler set wj:welcomed directly in Redis
    mockRedisStub.set('wj:welcomed:user-1:3', '1', { EX: 1800 });
    const claimed = await welcomeDedup.isWelcomeClaimed('user-1', 3);
    expect(claimed).toBe(true);
  });

  test('latestGen null → only checks sv:welcomed bare key', async () => {
    mockRedisStub.set('sv:welcomed:user-1', 'some-ep', { EX: 1800 });
    const claimed = await welcomeDedup.isWelcomeClaimed('user-1', null);
    expect(claimed).toBe(true);
  });
});

// ── clearWelcomeKeys ─────────────────────────────────────────────────────────

describe('clearWelcomeKeys: full namespace purge', () => {
  test('after clear, tryClaimWelcome wins again (next join fires welcome)', async () => {
    await welcomeDedup.tryClaimWelcome('user-1', 1, '1.2.3.4:3001');
    await welcomeDedup.clearWelcomeKeys('user-1');
    const won = await welcomeDedup.tryClaimWelcome('user-1', 1, '1.2.3.4:3001');
    expect(won).toBe(true);
  });

  test('after clear, isWelcomeClaimed returns false', async () => {
    await welcomeDedup.tryClaimWelcome('user-1', 2, '5.6.7.8:3001');
    await welcomeDedup.clearWelcomeKeys('user-1');
    const claimed = await welcomeDedup.isWelcomeClaimed('user-1', 2);
    expect(claimed).toBe(false);
  });

  test('clear does not affect a different user', async () => {
    await welcomeDedup.tryClaimWelcome('user-A', 1, '1.2.3.4:3001');
    await welcomeDedup.tryClaimWelcome('user-B', 1, '1.2.3.4:3001');
    await welcomeDedup.clearWelcomeKeys('user-A');
    // user-B's keys should still be set
    const claimedB = await welcomeDedup.isWelcomeClaimed('user-B', 1);
    expect(claimedB).toBe(true);
  });
});

// ── Three-path interaction contract ──────────────────────────────────────────
//
// These tests simulate the real ordering scenarios that caused the four
// duplicate messages observed in production.

describe('Three-path dedup: world:joined fires first → playerList blocked', () => {
  test('world:joined path wins → subsequent playerList call sees claim, skips', async () => {
    // Path A (world:joined) fires with gen=1
    const wjWon = await welcomeDedup.tryClaimWelcome('user-1', 1, '3.238.90.36:3001');
    expect(wjWon).toBe(true);

    // Path C (playerList) fires shortly after — checks isWelcomeClaimed
    const latestGen = 1;
    const alreadyClaimed = await welcomeDedup.isWelcomeClaimed('user-1', latestGen);
    expect(alreadyClaimed).toBe(true);
    // playerList skips → no duplicate
  });
});

describe('Three-path dedup: playerList fires first → world:joined blocked', () => {
  test('playerList wins (gen=0 fallback) → world:joined arrival returns false', async () => {
    // Path C fires first (no world:joined gen known yet → gen=0)
    const plWon = await welcomeDedup.tryClaimWelcome('user-1', 0, '3.238.90.36:3001');
    expect(plWon).toBe(true);

    // Path A (world:joined) arrives with gen=1, different gen → wins a NEW slot
    // (This is the gen=1 vs gen=0 mismatch — the intent is: leave clears keys between joins)
    // Within the SAME join session, world:joined would have fired first or same gen.
    // Verify: if gen=0 was claimed and world:joined also sends gen=0 → blocked.
    const wjWon = await welcomeDedup.tryClaimWelcome('user-1', 0, '3.238.90.36:3001');
    expect(wjWon).toBe(false);
  });
});

describe('Three-path dedup: two world:joined frames same gen → only one welcome', () => {
  test('retransmit same gen → second call blocked', async () => {
    const first  = await welcomeDedup.tryClaimWelcome('user-1', 7, '3.238.90.36:3001');
    const second = await welcomeDedup.tryClaimWelcome('user-1', 7, '3.238.90.36:3001');
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

describe('Three-path dedup: leave then rejoin fires fresh welcome', () => {
  test('gen=1 join, clearWelcomeKeys, gen=2 join → both fire', async () => {
    const first = await welcomeDedup.tryClaimWelcome('user-1', 1, '3.238.90.36:3001');
    expect(first).toBe(true);

    await welcomeDedup.clearWelcomeKeys('user-1');

    const second = await welcomeDedup.tryClaimWelcome('user-1', 2, '3.238.90.36:3001');
    expect(second).toBe(true);
  });
});

describe('Three-path dedup: inferred fallback fires then world:joined arrives', () => {
  test('inferred path (sv:welcomed bare set) blocks late world:joined same gen', async () => {
    // Path B (inferred 60s) fires — uses tryClaimWelcome with gen=1
    const inferredWon = await welcomeDedup.tryClaimWelcome('user-1', 1, '3.238.90.36:3001');
    expect(inferredWon).toBe(true);

    // world:joined arrives 90s later with same gen=1 → blocked
    const wjWon = await welcomeDedup.tryClaimWelcome('user-1', 1, '3.238.90.36:3001');
    expect(wjWon).toBe(false);
  });
});
