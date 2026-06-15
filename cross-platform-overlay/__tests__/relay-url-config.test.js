// Unit tests for relay URL selection (RELAY_HTTP / RELAY_WS env overrides).
//
// main.js picks the relay URL with:
//   const RELAY_HTTP = process.env.RELAY_HTTP || 'https://falloutchatmod.com';
//   const RELAY_WS   = process.env.RELAY_WS   || 'wss://falloutchatmod.com/ws';
//
// This test exercises that logic via overlay-core's resolveRelayUrls() helper so the
// pure function can be unit-tested without requiring Electron. The helper is a thin
// wrapper around the same two-line pattern — keeping the single source of truth in
// overlay-core.js and allowing CI to catch regressions in URL resolution.
//
// Path A (cloud dev — dev:cloud script):
//   RELAY_HTTP=https://dev.falloutchatmod.com
//   RELAY_WS=wss://dev.falloutchatmod.com/ws
//   The dev backend is on a non-CF-Access path; only install-token/session auth needed.
//
// Path B (local — dev:local script):
//   RELAY_HTTP=http://localhost:7177
//   RELAY_WS=ws://localhost:7177/ws

import core from '../overlay-core.js';

const { resolveRelayUrls } = core;

describe('resolveRelayUrls', () => {
  it('returns production defaults when no env vars are set', () => {
    const { relayHttp, relayWs } = resolveRelayUrls({});
    expect(relayHttp).toBe('https://falloutchatmod.com');
    expect(relayWs).toBe('wss://falloutchatmod.com/ws');
  });

  it('Path A (dev:cloud) — honours RELAY_HTTP / RELAY_WS pointing at cloud dev backend', () => {
    const env = {
      RELAY_HTTP: 'https://dev.falloutchatmod.com',
      RELAY_WS: 'wss://dev.falloutchatmod.com/ws',
    };
    const { relayHttp, relayWs } = resolveRelayUrls(env);
    expect(relayHttp).toBe('https://dev.falloutchatmod.com');
    expect(relayWs).toBe('wss://dev.falloutchatmod.com/ws');
  });

  it('Path B (dev:local) — honours RELAY_HTTP / RELAY_WS pointing at local backend', () => {
    const env = {
      RELAY_HTTP: 'http://localhost:7177',
      RELAY_WS: 'ws://localhost:7177/ws',
    };
    const { relayHttp, relayWs } = resolveRelayUrls(env);
    expect(relayHttp).toBe('http://localhost:7177');
    expect(relayWs).toBe('ws://localhost:7177/ws');
  });

  it('only RELAY_HTTP set — RELAY_WS falls back to production default', () => {
    const { relayHttp, relayWs } = resolveRelayUrls({ RELAY_HTTP: 'https://dev.falloutchatmod.com' });
    expect(relayHttp).toBe('https://dev.falloutchatmod.com');
    expect(relayWs).toBe('wss://falloutchatmod.com/ws');
  });
});
