'use strict';

/**
 * Unit tests for broadcastToPartyMembers logic.
 *
 * We test the filtering logic (Set-based member filter + excludeWs) independently
 * of the full WS stack. We replicate the local-delivery loop from the handler.
 */

const { WebSocket } = require('ws');

// Re-implement isPrivilegedRole as the pure helper under test (mirrors userRoleService.ts)
function isPrivilegedRole(role) {
  return role === 'owner' || role === 'admin' || role === 'moderator';
}

/**
 * Simulate the mod-observer fan-out that runs in the party:send handler and
 * the Redis pub/sub party-scope subscriber. Members receive the base payload;
 * privileged non-members receive it with `_modObserver: true`.
 */
function simulatePartyBroadcastWithModObservers(clientsMap, payload, memberUserIds) {
  const memberSet = new Set(memberUserIds);
  const data = JSON.stringify(payload);
  // _modObserver lives INSIDE payload (not at the frame top-level).
  const observerPayload = { ...payload, payload: { ...payload.payload, _modObserver: true } };
  const observerData = JSON.stringify(observerPayload);
  const delivered = [];

  for (const [, client] of clientsMap) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    if (memberSet.has(client.userId)) {
      client.ws.send(data);
      delivered.push({ userId: client.userId, observer: false });
    } else if (isPrivilegedRole(client.role)) {
      client.ws.send(observerData);
      delivered.push({ userId: client.userId, observer: true });
    }
  }
  return delivered;
}

// Simulate the local broadcast logic extracted from broadcastToPartyMembers
function simulateLocalBroadcast(clientsMap, payload, memberUserIds, excludeWs = null) {
  const memberSet = new Set(memberUserIds);
  const data = JSON.stringify(payload);
  const delivered = [];

  for (const [token, client] of clientsMap) {
    if (!memberSet.has(client.userId)) continue;
    if (client.ws === excludeWs) continue;
    if (client.ws.readyState !== WebSocket.OPEN) continue;
    client.ws.send(data);
    delivered.push(client.userId);
  }
  return delivered;
}

// Mock WebSocket
function makeMockWs(readyState = WebSocket.OPEN) {
  return {
    readyState,
    sentMessages: [],
    send(msg) { this.sentMessages.push(msg); },
  };
}

describe('broadcastToPartyMembers filtering', () => {
  it('delivers only to member userIds', () => {
    const ws1 = makeMockWs();
    const ws2 = makeMockWs();
    const wsNonMember = makeMockWs();

    const clients = new Map([
      ['token-1', { userId: 'user-1', ws: ws1 }],
      ['token-2', { userId: 'user-2', ws: ws2 }],
      ['token-3', { userId: 'user-3-nonmember', ws: wsNonMember }],
    ]);

    const payload = { type: 'chat:message', payload: { content: 'hi' } };
    const delivered = simulateLocalBroadcast(clients, payload, ['user-1', 'user-2']);

    expect(delivered).toContain('user-1');
    expect(delivered).toContain('user-2');
    expect(delivered).not.toContain('user-3-nonmember');
    expect(ws1.sentMessages).toHaveLength(1);
    expect(ws2.sentMessages).toHaveLength(1);
    expect(wsNonMember.sentMessages).toHaveLength(0);
  });

  it('excludes the excludeWs socket', () => {
    const ws1 = makeMockWs();
    const ws2 = makeMockWs();

    const clients = new Map([
      ['token-1', { userId: 'user-1', ws: ws1 }],
      ['token-2', { userId: 'user-2', ws: ws2 }],
    ]);

    const payload = { type: 'chat:message', payload: { content: 'hi' } };
    // Exclude ws1 (the sender)
    const delivered = simulateLocalBroadcast(clients, payload, ['user-1', 'user-2'], ws1);

    expect(delivered).not.toContain('user-1');
    expect(delivered).toContain('user-2');
    expect(ws1.sentMessages).toHaveLength(0);
    expect(ws2.sentMessages).toHaveLength(1);
  });

  it('skips CLOSED sockets', () => {
    const openWs = makeMockWs(WebSocket.OPEN);
    const closedWs = makeMockWs(WebSocket.CLOSED);

    const clients = new Map([
      ['token-1', { userId: 'user-1', ws: openWs }],
      ['token-2', { userId: 'user-2', ws: closedWs }],
    ]);

    const payload = { type: 'party:deleted', payload: { partyId: 'some-id' } };
    const delivered = simulateLocalBroadcast(clients, payload, ['user-1', 'user-2']);

    expect(delivered).toContain('user-1');
    expect(delivered).not.toContain('user-2');
    expect(openWs.sentMessages).toHaveLength(1);
    expect(closedWs.sentMessages).toHaveLength(0);
  });

  it('delivers nothing when memberUserIds is empty', () => {
    const ws1 = makeMockWs();
    const clients = new Map([['token-1', { userId: 'user-1', ws: ws1 }]]);

    const payload = { type: 'party:member-update', payload: {} };
    const delivered = simulateLocalBroadcast(clients, payload, []);

    expect(delivered).toHaveLength(0);
    expect(ws1.sentMessages).toHaveLength(0);
  });

  it('delivers nothing when no clients are in the members set', () => {
    const ws1 = makeMockWs();
    const clients = new Map([['token-1', { userId: 'user-not-in-party', ws: ws1 }]]);

    const payload = { type: 'chat:message', payload: {} };
    const delivered = simulateLocalBroadcast(clients, payload, ['user-1', 'user-2']);

    expect(delivered).toHaveLength(0);
  });
});

// ── isPrivilegedRole unit tests ────────────────────────────────────────────

describe('isPrivilegedRole', () => {
  it('returns true for owner', () => {
    expect(isPrivilegedRole('owner')).toBe(true);
  });

  it('returns true for admin', () => {
    expect(isPrivilegedRole('admin')).toBe(true);
  });

  it('returns true for moderator', () => {
    expect(isPrivilegedRole('moderator')).toBe(true);
  });

  it('returns false for supporter', () => {
    expect(isPrivilegedRole('supporter')).toBe(false);
  });

  it('returns false for user', () => {
    expect(isPrivilegedRole('user')).toBe(false);
  });
});

// ── Mod-observer party broadcast fan-out ──────────────────────────────────

describe('mod-observer party broadcast fan-out', () => {
  it('a moderator non-member receives the message with _modObserver:true', () => {
    const wsMember = makeMockWs();
    const wsMod = makeMockWs();

    const clients = new Map([
      ['token-member', { userId: 'user-member', ws: wsMember, role: 'user' }],
      ['token-mod',    { userId: 'user-mod',    ws: wsMod,    role: 'moderator' }],
    ]);

    const payload = { type: 'chat:message', payload: { content: 'hello' } };
    const delivered = simulatePartyBroadcastWithModObservers(clients, payload, ['user-member']);

    // Moderator should receive the message with _modObserver inside payload
    expect(wsMod.sentMessages).toHaveLength(1);
    const modMsg = JSON.parse(wsMod.sentMessages[0]);
    expect(modMsg.payload._modObserver).toBe(true);
    expect(modMsg._modObserver).toBeUndefined(); // not at top-level

    // Member receives without flag
    expect(wsMember.sentMessages).toHaveLength(1);
    const memberMsg = JSON.parse(wsMember.sentMessages[0]);
    expect(memberMsg.payload?._modObserver).toBeUndefined();

    // Observer entry has observer:true
    const modEntry = delivered.find(d => d.userId === 'user-mod');
    expect(modEntry).toBeDefined();
    expect(modEntry.observer).toBe(true);
  });

  it('a regular (user) non-member does NOT receive the message', () => {
    const wsNonMember = makeMockWs();

    const clients = new Map([
      ['token-nonmember', { userId: 'user-nonmember', ws: wsNonMember, role: 'user' }],
    ]);

    const payload = { type: 'chat:message', payload: { content: 'secret' } };
    simulatePartyBroadcastWithModObservers(clients, payload, ['user-member']);

    expect(wsNonMember.sentMessages).toHaveLength(0);
  });

  it('a moderator who IS a member receives it exactly once WITHOUT _modObserver', () => {
    const wsMod = makeMockWs();

    const clients = new Map([
      ['token-mod', { userId: 'user-mod', ws: wsMod, role: 'moderator' }],
    ]);

    const payload = { type: 'chat:message', payload: { content: 'hi' } };
    const delivered = simulatePartyBroadcastWithModObservers(clients, payload, ['user-mod']);

    // Should receive exactly once
    expect(wsMod.sentMessages).toHaveLength(1);
    const msg = JSON.parse(wsMod.sentMessages[0]);
    // Member path — no _modObserver flag anywhere
    expect(msg._modObserver).toBeUndefined();
    expect(msg.payload?._modObserver).toBeUndefined();

    // Delivered as member, not observer
    const entry = delivered.find(d => d.userId === 'user-mod');
    expect(entry.observer).toBe(false);
  });

  it('admin non-member receives with _modObserver:true', () => {
    const wsAdmin = makeMockWs();

    const clients = new Map([
      ['token-admin', { userId: 'user-admin', ws: wsAdmin, role: 'admin' }],
    ]);

    const payload = { type: 'chat:message', payload: { content: 'test' } };
    simulatePartyBroadcastWithModObservers(clients, payload, ['other-user']);

    expect(wsAdmin.sentMessages).toHaveLength(1);
    const adminMsg = JSON.parse(wsAdmin.sentMessages[0]);
    expect(adminMsg.payload._modObserver).toBe(true);
    expect(adminMsg._modObserver).toBeUndefined(); // not at top-level
  });

  it('observer is NOT added to party members (regression — no psMemberIds mutation)', () => {
    const wsMod = makeMockWs();

    const clients = new Map([
      ['token-mod', { userId: 'user-mod', ws: wsMod, role: 'moderator' }],
    ]);

    const originalMemberIds = ['user-member'];
    const memberIdsCopy = [...originalMemberIds];

    const payload = { type: 'chat:message', payload: { content: 'test' } };
    simulatePartyBroadcastWithModObservers(clients, payload, memberIdsCopy);

    // psMemberIds must not have been mutated — observer was never added
    expect(memberIdsCopy).toEqual(originalMemberIds);
    expect(memberIdsCopy).not.toContain('user-mod');
  });
});
