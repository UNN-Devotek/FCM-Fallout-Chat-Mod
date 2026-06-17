// Unit tests for the DEV-ONLY local-backend Discord-gate bypass helpers
// (overlay-core.js: isLocalRelay, syntheticDevDiscordId). These let a local dev
// overlay register against a localhost backend without Discord OAuth; they must
// NEVER engage for a non-local relay (prod / hosted dev).
// vitest globals (describe/it/expect) are enabled via vitest.config.ts (globals: true)
const core = require('../overlay-core.js');

describe('isLocalRelay', () => {
  it('is true for loopback hosts', () => {
    expect(core.isLocalRelay('http://localhost:7076')).toBe(true);
    expect(core.isLocalRelay('http://localhost:7177')).toBe(true);
    expect(core.isLocalRelay('http://127.0.0.1:7076')).toBe(true);
    expect(core.isLocalRelay('ws://localhost:7076/ws')).toBe(true);
    expect(core.isLocalRelay('http://[::1]:7076')).toBe(true);
  });

  it('is FALSE for prod / hosted-dev / any non-loopback host (safety)', () => {
    expect(core.isLocalRelay('https://falloutchatmod.com')).toBe(false);
    expect(core.isLocalRelay('https://dev.falloutchatmod.com')).toBe(false);
    expect(core.isLocalRelay('https://localhost.falloutchatmod.com')).toBe(false);
    expect(core.isLocalRelay('http://192.168.1.10:7076')).toBe(false);
  });

  it('is false for malformed input', () => {
    expect(core.isLocalRelay('')).toBe(false);
    expect(core.isLocalRelay(undefined)).toBe(false);
    expect(core.isLocalRelay('not a url')).toBe(false);
  });
});

describe('syntheticDevDiscordId', () => {
  const RE = /^\d{15,22}$/; // backend gate (usersController register)

  it('produces an 18-digit string that satisfies the backend discordId regex', () => {
    const id = core.syntheticDevDiscordId('11111111-2222-3333-4444-555555555555');
    expect(id).toMatch(RE);
    expect(id).toHaveLength(18);
  });

  it('is deterministic for the same installToken', () => {
    const t = require('crypto').randomUUID();
    expect(core.syntheticDevDiscordId(t)).toBe(core.syntheticDevDiscordId(t));
  });

  it('differs across installTokens (discordId is @unique in the DB)', () => {
    const a = core.syntheticDevDiscordId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    const b = core.syntheticDevDiscordId('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(a).not.toBe(b);
  });

  it('handles empty / malformed input and still matches the regex', () => {
    expect(core.syntheticDevDiscordId('')).toMatch(RE);
    expect(core.syntheticDevDiscordId(undefined)).toMatch(RE);
    expect(core.syntheticDevDiscordId('zzzz')).toMatch(RE);
  });
});
