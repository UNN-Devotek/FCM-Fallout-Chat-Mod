'use strict';
/**
 * SUPPORTER_TIER_ENABLED is a MASTER KILL SWITCH, not a purchase-CTA toggle.
 *
 * It defaults to false — including in production — so the branch can be merged and
 * deployed with zero observable change, and the commercial launch is a separate,
 * deliberate act. These tests assert the feature is genuinely inert when off, because
 * "the flag exists" and "the flag actually turns everything off" are different claims
 * and only the second one is useful.
 *
 * With the flag off:
 *   - no cosmetics are attached to chat messages (chat renders exactly as before)
 *   - resolveCosmetics returns defaults without touching Redis or Postgres
 *   - applyCosmetics refuses writes
 *   - the cosmetics/supporter REST routes 404
 *
 * Stored rows are never touched while off, so flipping it back on restores everyone's
 * previous look exactly.
 */

const prismaMock = {
  user: { findUnique: jest.fn(), findFirst: jest.fn() },
  userCosmetic: { findUnique: jest.fn(), upsert: jest.fn() },
  supporterEntitlement: { findUnique: jest.fn() },
  auditLog: { create: jest.fn().mockResolvedValue({}) },
};
const redisMock = { get: jest.fn(), set: jest.fn(), del: jest.fn() };

jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../dist/config/prisma', () => jest.requireMock('../src/config/prisma'), { virtual: true });
jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue(redisMock),
}));
jest.mock('../src/websocket/handlers', () => ({
  broadcast: jest.fn(),
  refreshClientCosmetics: jest.fn(),
}));

const env = require('../src/config/environment');
// Require ONCE and flip the flag on the shared env object between tests.
// jest.isolateModules() would hand the service a fresh copy of config/environment,
// so mutations to this `env` reference would not reach it — cosmeticsEnabled() reads
// the flag at call time precisely so it can be toggled at runtime like this.
const svc = require('../src/services/cosmetics/cosmeticsService');
const ORIGINAL_FLAG = env.SUPPORTER_TIER_ENABLED;

describe('SUPPORTER_TIER_ENABLED — default', () => {
  it('is OFF unless explicitly enabled', () => {
    // The whole point: shipping to production without setting anything must not
    // silently turn on a paid feature.
    expect(process.env.SUPPORTER_TIER_ENABLED === 'true').toBe(false);
    expect(env.SUPPORTER_TIER_ENABLED).toBe(false);
  });
});

describe('kill switch OFF — the feature is inert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    env.SUPPORTER_TIER_ENABLED = false;
  });
  afterAll(() => { env.SUPPORTER_TIER_ENABLED = ORIGINAL_FLAG; });

  it('cosmeticsEnabled() reports false', () => {
    expect(svc.cosmeticsEnabled()).toBe(false);
  });

  it('resolveCosmetics returns defaults', async () => {
    const result = await svc.resolveCosmetics('user-1');
    expect(result).toMatchObject({ nameColor: null, effectId: null, tag: null, tier: 'none' });
    expect(result.badges).toEqual([]);
  });

  it('resolveCosmetics touches NEITHER Redis nor Postgres — zero cost while off', () => {
    return svc.resolveCosmetics('user-1').then(() => {
      expect(redisMock.get).not.toHaveBeenCalled();
      expect(prismaMock.userCosmetic.findUnique).not.toHaveBeenCalled();
    });
  });

  it('attachCosmetics leaves a chat payload byte-identical', async () => {
    const payload = { id: 'm1', content: 'hi', username: 'Wanderer', userId: 'user-1', channelId: 'c1' };
    const before = JSON.stringify(payload);
    const after = await svc.attachCosmetics(payload);
    expect(JSON.stringify(after)).toBe(before);
    // No nameColor/effectId/tag/badges keys added at all.
    expect(Object.keys(after)).toEqual(['id', 'content', 'username', 'userId', 'channelId']);
  });

  it('applyCosmetics refuses to write', async () => {
    const result = await svc.applyCosmetics({
      userId: 'user-1',
      patch: { colorPresetId: 'cryo' },
      actor: { kind: 'self', discordId: '123' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
    expect(prismaMock.userCosmetic.upsert).not.toHaveBeenCalled();
  });

  it('does not delete or modify stored rows, so enabling restores prior looks', async () => {
    await svc.resolveCosmetics('user-1');
    await svc.applyCosmetics({ userId: 'user-1', patch: { colorPresetId: 'cryo' }, actor: { kind: 'self' } });
    expect(prismaMock.userCosmetic.upsert).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });
});

describe('kill switch ON — the feature works', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    env.SUPPORTER_TIER_ENABLED = true;
    redisMock.get.mockResolvedValue(null);
    prismaMock.userCosmetic.findUnique.mockResolvedValue({
      userId: 'user-1',
      colorPresetId: 'cryo',
      customColorHex: null,
      effectId: null,
      customTag: null,
      cosmeticsEnabled: true,
    });
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', discordId: '123' });
    prismaMock.supporterEntitlement.findUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    env.SUPPORTER_TIER_ENABLED = ORIGINAL_FLAG;
  });

  it('cosmeticsEnabled() reports true', () => {
    expect(svc.cosmeticsEnabled()).toBe(true);
  });

  it('resolveCosmetics reads stored values', async () => {
    const result = await svc.resolveCosmetics('user-1');
    // 'cryo' is a FREE preset, so it resolves even at tier 'none'.
    expect(result.nameColor).toBe('#57DBDB');
  });

  it('attachCosmetics decorates the payload', async () => {
    const payload = { id: 'm1', content: 'hi', username: 'Wanderer', userId: 'user-1', channelId: 'c1' };
    const after = await svc.attachCosmetics(payload);
    expect(after.username).toBe('Wanderer');
    expect(after.nameColor).toBe('#57DBDB');
  });

  it('decorates all history rows while resolving a repeated author only once', async () => {
    const rows = [
      { id: 'm1', user_id: 'user-1' },
      { id: 'm2', user_id: 'user-1' },
    ];
    await svc.attachCosmeticsToHistory(rows);
    expect(rows).toEqual([
      { id: 'm1', user_id: 'user-1', nameColor: '#57DBDB' },
      { id: 'm2', user_id: 'user-1', nameColor: '#57DBDB' },
    ]);
    // First resolve populates the cache; both history rows then share it.
    expect(prismaMock.userCosmetic.findUnique).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression: the kill switch must not take the rest of the API down with it.
 *
 * The cosmetics router is mounted at `/api` because it owns several unrelated
 * sub-paths (/cosmetics/*, /supporter/*, /users/:id/cosmetics,
 * /admin/users/:id/cosmetics/reset). The first version of the guard used
 * `router.use()`, which under that mount runs for EVERY request under /api — so with
 * the tier switched off it 404'd the entire API. The integration suites caught it
 * (23 failures across health, mcp, wiki and more). The guard is now per-route.
 */
describe('kill switch does not intercept unrelated /api routes', () => {
  it('is applied per-route, never as router-level middleware', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/cosmetics.ts'), 'utf8');

    // A bare router.use(fn) here would re-introduce the outage.
    const bareRouterUse = /router\.use\(\s*(?:function|\(|async)/.test(src);
    expect(bareRouterUse).toBe(false);

    // Every route in this file must carry the guard explicitly.
    const routeLines = src.split('\n').filter((l) => /^router\.(get|post|patch|put|delete)\(/.test(l.trim()));
    expect(routeLines.length).toBeGreaterThan(0);
    for (const line of routeLines) {
      // Multi-line route definitions put the guard on a following line; match the
      // whole statement instead.
      const idx = src.indexOf(line);
      const statement = src.slice(idx, src.indexOf(');', idx));
      expect(statement).toContain('requireTierEnabled');
    }
  });
});
