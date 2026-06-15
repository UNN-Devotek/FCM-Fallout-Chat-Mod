/**
 * Tests for backend/src/utils/devSeedHelpers.ts — the pure, side-effect-free
 * logic shared by scripts/seed-dev.ts and scripts/clone-discord-layout.ts.
 *
 * Covers the SR-004 guarantee (synthesized content only), deterministic
 * generation, and the Discord role → env-var mapping/formatter.
 */

const {
  SIM_NAMES,
  makeRng,
  pick,
  generateFakeUsers,
  generateFakeMessage,
  generateFakeParty,
  roleNameToEnvKey,
  formatRoleEnvLines,
  PARTY_CATEGORIES,
} = require('../src/utils/devSeedHelpers');

describe('SIM_NAMES', () => {
  test('is a non-trivial set of unique names', () => {
    expect(SIM_NAMES.length).toBeGreaterThan(150);
    expect(new Set(SIM_NAMES).size).toBe(SIM_NAMES.length);
  });
});

describe('makeRng', () => {
  test('is deterministic for the same seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  test('different seeds produce different sequences', () => {
    const a = makeRng(1);
    const b = makeRng(2);
    expect(a()).not.toBe(b());
  });

  test('outputs are in [0, 1)', () => {
    const r = makeRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('pick', () => {
  test('returns an element of the array', () => {
    const rng = makeRng(5);
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) {
      expect(arr).toContain(pick(arr, rng));
    }
  });
});

describe('generateFakeUsers', () => {
  test('produces N users with deterministic sim- tokens', () => {
    const users = generateFakeUsers(10);
    expect(users).toHaveLength(10);
    expect(users[0].username).toBe(SIM_NAMES[0]);
    expect(users[0].installToken).toBe('sim-seed-0000');
    expect(users[9].installToken).toBe('sim-seed-0009');
  });

  test('all tokens start with sim- so the cleanup path catches them', () => {
    for (const u of generateFakeUsers(200)) {
      expect(u.installToken.startsWith('sim-')).toBe(true);
    }
  });

  test('usernames are all drawn from SIM_NAMES (SR-004: no real names)', () => {
    const set = new Set(SIM_NAMES);
    for (const u of generateFakeUsers(50)) {
      expect(set.has(u.username)).toBe(true);
    }
  });

  test('caps at SIM_NAMES length and never duplicates usernames', () => {
    const users = generateFakeUsers(500);
    expect(users.length).toBe(SIM_NAMES.length);
    expect(new Set(users.map((u) => u.username)).size).toBe(users.length);
  });

  test('count <= 0 yields no users', () => {
    expect(generateFakeUsers(0)).toEqual([]);
    expect(generateFakeUsers(-5)).toEqual([]);
  });
});

describe('generateFakeMessage', () => {
  test('is non-empty and deterministic for a given rng sequence', () => {
    const a = makeRng(99);
    const b = makeRng(99);
    expect(generateFakeMessage(a)).toBe(generateFakeMessage(b));
    expect(generateFakeMessage(makeRng(1)).length).toBeGreaterThan(0);
  });
});

describe('generateFakeParty', () => {
  test('returns a valid category and a two-word name', () => {
    const rng = makeRng(3);
    for (let i = 0; i < 20; i++) {
      const p = generateFakeParty(rng);
      expect(PARTY_CATEGORIES).toContain(p.category);
      expect(p.name.split(' ')).toHaveLength(2);
      expect(typeof p.isPrivate).toBe('boolean');
    }
  });
});

describe('roleNameToEnvKey', () => {
  test('maps known role names case-insensitively and tolerates separators', () => {
    expect(roleNameToEnvKey('Owner')).toBe('OWNER_ROLE_ID');
    expect(roleNameToEnvKey('admin')).toBe('ADMIN_ROLE_ID');
    expect(roleNameToEnvKey('Moderator')).toBe('MODERATOR_ROLE_ID');
    expect(roleNameToEnvKey('Mod Team')).toBe('MODERATOR_ROLE_ID');
    expect(roleNameToEnvKey('Mod')).toBe('MODERATOR_ROLE_ID');
    expect(roleNameToEnvKey('Developer')).toBe('DEVELOPER_ROLE_ID');
    expect(roleNameToEnvKey('Dev')).toBe('DEVELOPER_ROLE_ID');
  });

  test('returns null for unrelated roles', () => {
    expect(roleNameToEnvKey('Verified')).toBeNull();
    expect(roleNameToEnvKey('Nuka Fan')).toBeNull();
  });
});

describe('formatRoleEnvLines', () => {
  test('emits sorted ready-to-paste env lines, first match per key wins', () => {
    const lines = formatRoleEnvLines([
      { name: 'Owner', id: '111' },
      { name: 'Admin', id: '222' },
      { name: 'Moderator', id: '333' },
      { name: 'Developer', id: '444' },
      { name: 'Admin', id: '999' }, // duplicate — ignored
      { name: 'Member', id: '555' }, // unmapped — ignored
    ]);
    expect(lines).toEqual([
      'ADMIN_ROLE_ID=222',
      'DEVELOPER_ROLE_ID=444',
      'MODERATOR_ROLE_ID=333',
      'OWNER_ROLE_ID=111',
    ]);
  });

  test('returns empty array when no roles map', () => {
    expect(formatRoleEnvLines([{ name: 'Verified', id: '1' }])).toEqual([]);
  });
});
