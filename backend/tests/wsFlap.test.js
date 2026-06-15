'use strict';

jest.mock('../dist/config/prisma', () => ({
  __esModule: true,
  default: { user: { findMany: jest.fn(), update: jest.fn() }, serverMessage: { create: jest.fn() } },
}));
jest.mock('../dist/config/redis', () => ({
  __esModule: true,
  getRedisClient: jest.fn().mockResolvedValue({ get: jest.fn(), set: jest.fn(), del: jest.fn() }),
  client: { on: jest.fn() },
}));
jest.mock('../dist/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/**
 * WS-flap grace-window decision tests (Fix #2, v1.1.37).
 *
 *   • wsFlap_ReconnectWithin30s_SuppressesPeerLeave
 *   • wsFlap_ReconnectAfter30s_FiresPeerLeave
 *   • wsFlap_DifferentEndpointReconnect_FiresLeaveImmediately
 *
 * Validates the decideFlapHandoff() pure helper that gates whether a fresh
 * connection arriving while a pending-disconnect timer is in flight should:
 *  (a) suppress the deferred peer-leave + clearWelcomeKeys (same endpoint, flap), or
 *  (b) fire the OLD-endpoint leave immediately (endpoint changed = real transition), or
 *  (c) noop because no pending entry exists.
 *
 * Live trace 2026-05-01 18:18:10 → 18:18:37 (Vault-Tec "Abderaan left") →
 * 18:19:03 (Abderaan still chatting) → 18:20:08 (re-welcomed): proves the old
 * 60s leave-only grace was insufficient because welcome dedup was cleared
 * eagerly on close, so the reconnect re-fired welcome.
 */

const {
  decideFlapHandoff,
  WS_FLAP_GRACE_MS_EXPORT,
} = require('../dist/websocket/handlers');

describe('decideFlapHandoff', () => {
  test('wsFlap_ReconnectWithin30s_SuppressesPeerLeave (same endpoint)', () => {
    // Pending entry exists — user disconnected on ep A, reconnecting on same A.
    const decision = decideFlapHandoff({ endpoint: '3.80.99.165:3001' }, '3.80.99.165:3001');
    expect(decision).toEqual({ kind: 'suppress' });
  });

  test('wsFlap_ReconnectAfter30s_FiresPeerLeave (no pending entry left)', () => {
    // After 30s the close-timer fired and removed the pending entry; a fresh
    // connect therefore sees no pending entry and the welcome path on the new
    // socket fires normally (the leave already broadcast at t+30s).
    const decision = decideFlapHandoff(undefined, '3.80.99.165:3001');
    expect(decision).toEqual({ kind: 'no-pending' });
  });

  test('wsFlap_DifferentEndpointReconnect_FiresLeaveImmediately', () => {
    // User disconnected on ep A and reconnected on ep B before the 30s timer.
    // This is a real transition (server hop the user did during the WS drop),
    // so the OLD-endpoint leave must fire immediately rather than wait 30s.
    const decision = decideFlapHandoff(
      { endpoint: '3.80.99.165:3001' },
      '52.10.20.30:3007',
    );
    expect(decision).toEqual({ kind: 'fire-old-immediately' });
  });

  test('reconnect with null new endpoint while pending had endpoint = suppress (still grace)', () => {
    // Reconnects with no endpoint info yet (DB row still nulled / pre-presence).
    // Treat as "not yet a confirmed transition" — suppress, don't fire.  The
    // grace timer covers any genuine departure later.
    const decision = decideFlapHandoff({ endpoint: '3.80.99.165:3001' }, null);
    expect(decision).toEqual({ kind: 'suppress' });
  });

  test('grace window constant is 30s', () => {
    expect(WS_FLAP_GRACE_MS_EXPORT).toBe(30_000);
  });
});
