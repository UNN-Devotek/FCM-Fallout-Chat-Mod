'use strict';

/**
 * Unit tests for broadcastToSession cross-instance Redis pub/sub logic (fix #4).
 *
 * Mirrors the broadcastToPartyMembers.test.js style — tests the local-delivery
 * and pub/sub subscriber path independently of the full WS stack.
 */

const { WebSocket } = require('ws');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockWs(readyState = WebSocket.OPEN) {
  return {
    readyState,
    bufferedAmount: 0,
    sentMessages: [],
    send(msg) { this.sentMessages.push(msg); },
  };
}

/**
 * Simulate the local-delivery loop from broadcastToSession.
 * Returns count of delivered messages.
 */
function simulateLocalSessionBroadcast(clientsMap, payload, sessionId, excludeWs = null) {
  const data = JSON.stringify(payload);
  let delivered = 0;
  for (const [, client] of clientsMap) {
    if (client.ws === excludeWs || client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.worldSessionId !== sessionId) continue;
    client.ws.send(data);
    delivered++;
  }
  return delivered;
}

/**
 * Simulate the subscriber path for scope:'session' envelopes.
 * Delivers to local clients whose worldSessionId matches the envelope.
 */
function simulateSessionSubscriberDelivery(clientsMap, envelope, localInstanceId) {
  if (envelope.instanceId === localInstanceId) return 0; // echo-suppress
  if (envelope.scope !== 'session' || typeof envelope.sessionId !== 'string') return 0;
  const data = JSON.stringify(envelope.payload);
  let delivered = 0;
  for (const [, client] of clientsMap) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (client.worldSessionId !== envelope.sessionId) continue;
    client.ws.send(data);
    delivered++;
  }
  return delivered;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('broadcastToSession local delivery', () => {
  it('delivers only to clients on the matching worldSessionId', () => {
    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    const wsOther = makeMockWs();

    const clients = new Map([
      ['t1', { userId: 'u1', ws: ws1, worldSessionId: 'sess-abc' }],
      ['t2', { userId: 'u2', ws: ws2, worldSessionId: 'sess-abc' }],
      ['t3', { userId: 'u3', ws: wsOther, worldSessionId: 'sess-xyz' }],
    ]);

    const delivered = simulateLocalSessionBroadcast(clients, { type: 'chat:message', payload: { content: 'hi' } }, 'sess-abc');

    expect(delivered).toBe(2);
    expect(ws1.sentMessages).toHaveLength(1);
    expect(ws2.sentMessages).toHaveLength(1);
    expect(wsOther.sentMessages).toHaveLength(0);
  });

  it('respects excludeWs', () => {
    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    const clients = new Map([
      ['t1', { userId: 'u1', ws: ws1, worldSessionId: 'sess-abc' }],
      ['t2', { userId: 'u2', ws: ws2, worldSessionId: 'sess-abc' }],
    ]);
    const delivered = simulateLocalSessionBroadcast(clients, { type: 'chat:message', payload: {} }, 'sess-abc', ws1);
    expect(delivered).toBe(1);
    expect(ws1.sentMessages).toHaveLength(0);
    expect(ws2.sentMessages).toHaveLength(1);
  });

  it('returns 0 when sessionId is null', () => {
    const ws1 = makeMockWs();
    const clients = new Map([['t1', { userId: 'u1', ws: ws1, worldSessionId: 'sess-abc' }]]);
    const delivered = simulateLocalSessionBroadcast(clients, {}, null);
    expect(delivered).toBe(0);
    expect(ws1.sentMessages).toHaveLength(0);
  });
});

describe('broadcastToSession cross-instance subscriber (scope:session)', () => {
  const INSTANCE_A = 'instance-a';
  const INSTANCE_B = 'instance-b';

  it('delivers to local clients on the matching session from a remote instance', () => {
    const ws1 = makeMockWs();
    const clients = new Map([
      ['t1', { userId: 'u1', ws: ws1, worldSessionId: 'sess-abc' }],
    ]);
    const envelope = {
      instanceId: INSTANCE_A,   // remote instance
      scope: 'session',
      sessionId: 'sess-abc',
      payload: { type: 'chat:message', payload: { content: 'cross-instance' } },
    };
    const delivered = simulateSessionSubscriberDelivery(clients, envelope, INSTANCE_B);
    expect(delivered).toBe(1);
    expect(ws1.sentMessages).toHaveLength(1);
  });

  it('echo-suppresses messages from the same instance', () => {
    const ws1 = makeMockWs();
    const clients = new Map([
      ['t1', { userId: 'u1', ws: ws1, worldSessionId: 'sess-abc' }],
    ]);
    const envelope = {
      instanceId: INSTANCE_A,
      scope: 'session',
      sessionId: 'sess-abc',
      payload: { type: 'chat:message', payload: {} },
    };
    // Same instance — should suppress
    const delivered = simulateSessionSubscriberDelivery(clients, envelope, INSTANCE_A);
    expect(delivered).toBe(0);
    expect(ws1.sentMessages).toHaveLength(0);
  });

  it('ignores envelopes for a different session', () => {
    const ws1 = makeMockWs();
    const clients = new Map([
      ['t1', { userId: 'u1', ws: ws1, worldSessionId: 'sess-abc' }],
    ]);
    const envelope = {
      instanceId: INSTANCE_A,
      scope: 'session',
      sessionId: 'sess-different',
      payload: { type: 'chat:message', payload: {} },
    };
    const delivered = simulateSessionSubscriberDelivery(clients, envelope, INSTANCE_B);
    expect(delivered).toBe(0);
    expect(ws1.sentMessages).toHaveLength(0);
  });

  it('does not handle envelopes without scope:session', () => {
    const ws1 = makeMockWs();
    const clients = new Map([
      ['t1', { userId: 'u1', ws: ws1, worldSessionId: 'sess-abc' }],
    ]);
    const envelope = {
      instanceId: INSTANCE_A,
      // no scope field
      sessionId: 'sess-abc',
      payload: { type: 'chat:message', payload: {} },
    };
    const delivered = simulateSessionSubscriberDelivery(clients, envelope, INSTANCE_B);
    expect(delivered).toBe(0);
  });
});
