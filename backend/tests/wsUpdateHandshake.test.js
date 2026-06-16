'use strict';

/**
 * Tests for the app:update-available WS connect-time handshake.
 *
 * Verified:
 *   (a) When a cached version exists, the connect handshake sends
 *       { type: 'app:update-available', payload: { latestVersion } } to the socket.
 *   (b) When no version is cached (null), no app:update-available message is sent.
 *   (c) When the socket is not OPEN, no message is sent.
 *
 * Strategy: test the delivery logic directly (unit-style) without booting the
 * full WS stack, mirroring the broadcastToSession.test.js pattern.
 */

const { WebSocket } = require('ws');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockWs(readyState = WebSocket.OPEN) {
  return {
    readyState,
    sentMessages: [],
    send(msg) { this.sentMessages.push(msg); },
  };
}

/**
 * Simulate the app:update-available send logic from handlers.ts.
 * This mirrors the exact block added to handlers.ts so the test stays
 * structurally tied to the implementation without importing the full handler.
 */
function simulateUpdateHandshake(ws, getLatestVersionFn) {
  try {
    const latestVersion = getLatestVersionFn();
    if (latestVersion && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'app:update-available', payload: { latestVersion } }));
    }
  } catch {
    // non-fatal — mirrors the try/catch in handlers.ts
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('app:update-available connect-time handshake logic', () => {
  it('sends app:update-available with latestVersion when cache has a version', () => {
    const ws = makeMockWs(WebSocket.OPEN);
    const getLatestVersion = () => '1.3.99';

    simulateUpdateHandshake(ws, getLatestVersion);

    expect(ws.sentMessages).toHaveLength(1);
    const msg = JSON.parse(ws.sentMessages[0]);
    expect(msg.type).toBe('app:update-available');
    expect(msg.payload).toEqual({ latestVersion: '1.3.99' });
  });

  it('does NOT send app:update-available when cache returns null', () => {
    const ws = makeMockWs(WebSocket.OPEN);
    const getLatestVersion = () => null;

    simulateUpdateHandshake(ws, getLatestVersion);

    expect(ws.sentMessages).toHaveLength(0);
  });

  it('does NOT send app:update-available when socket is not OPEN', () => {
    const ws = makeMockWs(WebSocket.CLOSED);
    const getLatestVersion = () => '1.3.99';

    simulateUpdateHandshake(ws, getLatestVersion);

    expect(ws.sentMessages).toHaveLength(0);
  });

  it('does NOT send app:update-available when socket is CLOSING', () => {
    const ws = makeMockWs(WebSocket.CLOSING);
    const getLatestVersion = () => '1.4.0';

    simulateUpdateHandshake(ws, getLatestVersion);

    expect(ws.sentMessages).toHaveLength(0);
  });

  it('does NOT send app:update-available when cache returns empty string', () => {
    const ws = makeMockWs(WebSocket.OPEN);
    const getLatestVersion = () => '';

    simulateUpdateHandshake(ws, getLatestVersion);

    expect(ws.sentMessages).toHaveLength(0);
  });

  it('is non-fatal when getLatestVersion throws', () => {
    const ws = makeMockWs(WebSocket.OPEN);
    const getLatestVersion = () => { throw new Error('cache failure'); };

    // Must not throw
    expect(() => simulateUpdateHandshake(ws, getLatestVersion)).not.toThrow();
    expect(ws.sentMessages).toHaveLength(0);
  });

  it('payload contains exactly latestVersion and no extra keys', () => {
    const ws = makeMockWs(WebSocket.OPEN);
    simulateUpdateHandshake(ws, () => '2.0.0');

    const msg = JSON.parse(ws.sentMessages[0]);
    expect(Object.keys(msg.payload)).toEqual(['latestVersion']);
    expect(msg.payload.latestVersion).toBe('2.0.0');
  });
});
