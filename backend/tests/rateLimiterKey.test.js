'use strict';

// Guards the security invariant behind the fix in this branch: rate-limit bucket
// keys are derived from the client IP ONLY, never the client-supplied (and, on the
// unauthenticated limiter paths, un-validated) `x-auth-token` header. Keying on that
// header let a caller mint a fresh bucket per request by rotating a random token,
// defeating every limiter mounted ahead of auth. See rateLimiter.ts `ipKey`.

// Mock the module's side-effecting imports so requiring it never touches Redis.
jest.mock('../src/config/redis', () => ({
  // sendCommand resolves a string so the limiters' RedisStore.init() (SCRIPT LOAD)
  // doesn't log a spurious async error at import; we never exercise the store here.
  getRedisClient: jest.fn().mockResolvedValue({ sendCommand: jest.fn().mockResolvedValue('sha') }),
}));

jest.mock('../src/config/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
  return { __esModule: true, default: log, ...log };
});

const { ipKey } = require('../src/middleware/rateLimiter');

// Minimal express-like req. No proxy headers, so clientIp() resolves to the TCP
// peer (socket.remoteAddress) regardless of the TRUST_PROXY setting.
function makeReq({ token, ip } = {}) {
  return {
    headers: token ? { 'x-auth-token': token } : {},
    socket: { remoteAddress: ip },
  };
}

describe('rate limiter bucket key (ipKey) — anti-spoof invariant', () => {
  it('keys on the client IP, not the x-auth-token header', () => {
    expect(ipKey(makeReq({ token: 'attacker-supplied', ip: '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('yields the SAME bucket for one IP even when x-auth-token differs (no fresh bucket per token)', () => {
    const withTokenA = ipKey(makeReq({ token: 'token-one', ip: '203.0.113.7' }));
    const withTokenB = ipKey(makeReq({ token: 'token-two', ip: '203.0.113.7' }));
    const withNoToken = ipKey(makeReq({ ip: '203.0.113.7' }));
    expect(withTokenA).toBe(withTokenB);
    expect(withTokenB).toBe(withNoToken);
  });

  it('yields DIFFERENT buckets for different client IPs', () => {
    expect(ipKey(makeReq({ ip: '203.0.113.7' }))).not.toBe(ipKey(makeReq({ ip: '198.51.100.4' })));
  });

  it('collapses a rotating attacker token (the pre-fix bypass) into a single IP bucket', () => {
    const keys = new Set(
      ['r1', 'r2', 'r3', 'r4', 'r5'].map((t) => ipKey(makeReq({ token: t, ip: '203.0.113.7' }))),
    );
    expect(keys.size).toBe(1);
  });
});
