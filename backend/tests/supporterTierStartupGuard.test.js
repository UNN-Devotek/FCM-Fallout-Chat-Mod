'use strict';
/**
 * Unit tests for the production startup guard that fails the backend closed when the
 * supporter tier is switched on without the config it needs to actually work.
 *
 * The supporter tier is a PAID product. If SUPPORTER_TIER_ENABLED is true but the tier
 * role IDs are missing, Discord will happily take a subscriber's money while
 * resolveSupporterTier can never match a role — the buyer pays and receives nothing,
 * silently and indefinitely. Same for the shop URL: without it the purchase CTA has
 * nowhere to send anyone. Refuse to boot instead.
 *
 * These exercise the REAL exported predicate (collectSupporterTierProductionErrors in
 * src/config/environment.ts) — the same function the module-load startup block calls
 * before process.exit(1) — so reverting the guard makes them fail.
 *
 * Coverage:
 *  - each missing var is reported, individually and together
 *  - a fully configured production tier is accepted
 *  - the guard fires ONLY when SUPPORTER_TIER_ENABLED=true
 *  - the guard fires ONLY when NODE_ENV=production
 */

// ── Mock heavy deps so requiring environment is cheap ─────────────────────────

jest.mock('../src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [] }),
  pool: { on: jest.fn() },
}));

jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue({ ping: jest.fn().mockResolvedValue('PONG'), on: jest.fn() }),
  healthCheck: jest.fn().mockResolvedValue(true),
  client: { on: jest.fn(), isOpen: false },
  subscriberClient: { on: jest.fn(), isOpen: false },
}));

jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));

// environment.ts ends with `module.exports = env`; the guard helper is re-attached
// onto env so it survives that clobber and is reachable here.
const env = require('../src/config/environment');
const { collectSupporterTierProductionErrors } = env;

const FULLY_CONFIGURED = {
  nodeEnv: 'production',
  supporterTierEnabled: true,
  supporterRoleId: '111111111111111111',
  overseerCircleRoleId: '222222222222222222',
  discordServerShopUrl: 'https://discord.com/servers/example/shop',
};

describe('collectSupporterTierProductionErrors (export presence)', () => {
  it('is exported as a function from config/environment', () => {
    expect(typeof collectSupporterTierProductionErrors).toBe('function');
  });
});

describe('collectSupporterTierProductionErrors — production + tier enabled', () => {
  it('accepts a fully configured tier', () => {
    expect(collectSupporterTierProductionErrors(FULLY_CONFIGURED)).toEqual([]);
  });

  it.each([
    ['supporterRoleId', 'SUPPORTER_ROLE_ID'],
    ['overseerCircleRoleId', 'OVERSEER_CIRCLE_ROLE_ID'],
    ['discordServerShopUrl', 'DISCORD_SERVER_SHOP_URL'],
  ])('flags a missing %s', (field, expectedName) => {
    expect(
      collectSupporterTierProductionErrors({ ...FULLY_CONFIGURED, [field]: '' }),
    ).toEqual([expectedName]);
  });

  it.each([[undefined], [null], ['']])('treats %p as missing', (value) => {
    expect(
      collectSupporterTierProductionErrors({ ...FULLY_CONFIGURED, supporterRoleId: value }),
    ).toContain('SUPPORTER_ROLE_ID');
  });

  it('reports every missing var at once so one boot surfaces them all', () => {
    expect(
      collectSupporterTierProductionErrors({
        nodeEnv: 'production',
        supporterTierEnabled: true,
        supporterRoleId: '',
        overseerCircleRoleId: '',
        discordServerShopUrl: '',
      }),
    ).toEqual(['SUPPORTER_ROLE_ID', 'OVERSEER_CIRCLE_ROLE_ID', 'DISCORD_SERVER_SHOP_URL']);
  });
});

describe('collectSupporterTierProductionErrors — guard scoping', () => {
  it('does NOT fire when the tier is disabled, even with nothing configured', () => {
    // This is the whole point of the flag: the code ships to production long before
    // the roles exist or Discord monetization is approved.
    expect(
      collectSupporterTierProductionErrors({
        nodeEnv: 'production',
        supporterTierEnabled: false,
        supporterRoleId: '',
        overseerCircleRoleId: '',
        discordServerShopUrl: '',
      }),
    ).toEqual([]);
  });

  it.each([['development'], ['test']])('does NOT fire outside production (%s)', (nodeEnv) => {
    expect(
      collectSupporterTierProductionErrors({
        nodeEnv,
        supporterTierEnabled: true,
        supporterRoleId: '',
        overseerCircleRoleId: '',
        discordServerShopUrl: '',
      }),
    ).toEqual([]);
  });
});
