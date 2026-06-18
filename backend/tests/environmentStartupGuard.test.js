'use strict';
/**
 * Unit tests for the production startup guard that fails the backend closed when
 * the inbound HUD chat path is enabled with an insecure HUD_IDENTITY_SECRET.
 *
 * SR-003: HUD_IDENTITY_SECRET is the HMAC key behind every in-game HUD
 * identityHash. With the public dev default (or empty) those identities are
 * forgeable, so when NODE_ENV=production AND HUD_PUSH_TCP_ENABLED=true the
 * backend must refuse to boot rather than start the inbound path with a known
 * key. These tests exercise the REAL exported predicate
 * (hudIdentitySecretGuardFails in src/config/environment.ts) — the same function
 * the module-load startup block calls before process.exit(1) — so reverting the
 * guard makes them fail. They also assert the guard's dev-default sentinel stays
 * byte-for-byte in sync with services/hudIdentityService.ts.
 *
 * Coverage:
 *  - empty secret is flagged in production+TCP-enabled
 *  - dev-default secret is flagged in production+TCP-enabled
 *  - a strong secret is accepted (guard does not fire)
 *  - the guard fires ONLY when HUD_PUSH_TCP_ENABLED=true
 *  - the guard fires ONLY when NODE_ENV=production
 *  - the environment sentinel matches hudIdentityService's sentinel + predicate
 */

// ── Mock heavy deps so requiring environment / hudIdentityService is cheap ─────

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

// ── Imports ───────────────────────────────────────────────────────────────────

// environment.ts ends with `module.exports = env`; the guard helper + sentinel
// are re-attached onto env so they survive that clobber and are reachable here.
const env = require('../src/config/environment');
const { hudIdentitySecretGuardFails, DEV_DEFAULT_HUD_IDENTITY_SECRET } = env;
const { DEV_DEFAULT_IDENTITY_SECRET, isInsecureHudSecret } =
  require('../src/services/hudIdentityService');

const STRONG_SECRET = 'b1946ac92492d2347c6235b4d2611184c0ffee0badc0ffee0badc0ffee0badc0';

// Sanity: the production code actually exported the guard we are testing. If this
// throws, the guard was removed/renamed (i.e. the fix was reverted).
describe('hudIdentitySecretGuardFails (export presence)', () => {
  it('is exported as a function from config/environment', () => {
    expect(typeof hudIdentitySecretGuardFails).toBe('function');
  });
});

describe('hudIdentitySecretGuardFails — production + HUD_PUSH_TCP_ENABLED', () => {
  it('flags an empty secret (refuses to boot)', () => {
    expect(
      hudIdentitySecretGuardFails({
        nodeEnv: 'production',
        hudPushTcpEnabled: true,
        hudIdentitySecret: '',
      }),
    ).toBe(true);
  });

  it('flags an undefined secret (refuses to boot)', () => {
    expect(
      hudIdentitySecretGuardFails({
        nodeEnv: 'production',
        hudPushTcpEnabled: true,
        hudIdentitySecret: undefined,
      }),
    ).toBe(true);
  });

  it('flags the public dev-default secret (refuses to boot)', () => {
    expect(
      hudIdentitySecretGuardFails({
        nodeEnv: 'production',
        hudPushTcpEnabled: true,
        hudIdentitySecret: DEV_DEFAULT_HUD_IDENTITY_SECRET,
      }),
    ).toBe(true);
  });

  it('accepts a strong, non-default secret (boots normally)', () => {
    expect(
      hudIdentitySecretGuardFails({
        nodeEnv: 'production',
        hudPushTcpEnabled: true,
        hudIdentitySecret: STRONG_SECRET,
      }),
    ).toBe(false);
  });
});

describe('hudIdentitySecretGuardFails — gating', () => {
  it('does NOT fire when HUD_PUSH_TCP_ENABLED=false, even with an insecure secret', () => {
    expect(
      hudIdentitySecretGuardFails({
        nodeEnv: 'production',
        hudPushTcpEnabled: false,
        hudIdentitySecret: DEV_DEFAULT_HUD_IDENTITY_SECRET,
      }),
    ).toBe(false);
    expect(
      hudIdentitySecretGuardFails({
        nodeEnv: 'production',
        hudPushTcpEnabled: false,
        hudIdentitySecret: '',
      }),
    ).toBe(false);
  });

  it('does NOT fire outside production, even with TCP enabled + insecure secret', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(
        hudIdentitySecretGuardFails({
          nodeEnv,
          hudPushTcpEnabled: true,
          hudIdentitySecret: DEV_DEFAULT_HUD_IDENTITY_SECRET,
        }),
      ).toBe(false);
      expect(
        hudIdentitySecretGuardFails({
          nodeEnv,
          hudPushTcpEnabled: true,
          hudIdentitySecret: '',
        }),
      ).toBe(false);
    }
  });

  it('requires BOTH production AND TCP enabled to ever fire (truth table)', () => {
    const insecure = '';
    expect(hudIdentitySecretGuardFails({ nodeEnv: 'production', hudPushTcpEnabled: true, hudIdentitySecret: insecure })).toBe(true);
    expect(hudIdentitySecretGuardFails({ nodeEnv: 'production', hudPushTcpEnabled: false, hudIdentitySecret: insecure })).toBe(false);
    expect(hudIdentitySecretGuardFails({ nodeEnv: 'development', hudPushTcpEnabled: true, hudIdentitySecret: insecure })).toBe(false);
    expect(hudIdentitySecretGuardFails({ nodeEnv: 'development', hudPushTcpEnabled: false, hudIdentitySecret: insecure })).toBe(false);
  });
});

describe('sentinel + predicate stay in sync with hudIdentityService', () => {
  it('environment sentinel equals hudIdentityService DEV_DEFAULT_IDENTITY_SECRET', () => {
    // If this fails, one default literal drifted from the other and a forged-key
    // build could slip past one of the two guards.
    expect(DEV_DEFAULT_HUD_IDENTITY_SECRET).toBe(DEV_DEFAULT_IDENTITY_SECRET);
  });

  it('both sentinels equal the canonical dev-default literal', () => {
    expect(DEV_DEFAULT_HUD_IDENTITY_SECRET).toBe('dev-hud-identity-secret-change-me');
  });

  it('environment default for HUD_IDENTITY_SECRET matches the sentinel', () => {
    // The env module's compiled default value (when no real secret is supplied
    // in the test process) is the dev default the guard treats as insecure.
    expect(env.HUD_IDENTITY_SECRET).toBe(DEV_DEFAULT_HUD_IDENTITY_SECRET);
  });

  it('guard verdict agrees with hudIdentityService.isInsecureHudSecret on the secret', () => {
    // Both guards must classify the same secret identically.
    for (const secret of ['', DEV_DEFAULT_HUD_IDENTITY_SECRET, STRONG_SECRET]) {
      const guard = hudIdentitySecretGuardFails({
        nodeEnv: 'production',
        hudPushTcpEnabled: true,
        hudIdentitySecret: secret,
      });
      expect(guard).toBe(isInsecureHudSecret(secret));
    }
  });
});
