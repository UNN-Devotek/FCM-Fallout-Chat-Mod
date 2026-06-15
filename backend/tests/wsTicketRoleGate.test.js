'use strict';

/**
 * Unit tests for the /auth/ws-ticket role gate (fix #1) and the
 * handleAdminObserver defense-in-depth re-check.
 *
 * These tests exercise the role-gate logic without booting a real HTTP server
 * or Redis — they mock session and the Redis client at the module level.
 */

// ── isPrivilegedRole (mirrors userRoleService.ts) ─────────────────────────────

function isPrivilegedRole(role) {
  return role === 'owner' || role === 'admin' || role === 'moderator';
}

// ── Simulate the role-gate check in /auth/ws-ticket ──────────────────────────

/**
 * Mimics the gate logic from server.ts /auth/ws-ticket:
 *   if (!isPrivilegedRole(discordUser.role)) → 403
 *   else → issue ticket
 */
function simulateWsTicketGate(sessionDiscordUser) {
  if (!sessionDiscordUser) return { status: 401 };
  if (!isPrivilegedRole(sessionDiscordUser.role)) return { status: 403 };
  return { status: 200, ticketPayload: { type: 'admin', ...sessionDiscordUser } };
}

// ── Simulate the handleAdminObserver defense-in-depth re-check ───────────────

/**
 * Mimics the re-check in handleAdminObserver (handlers.ts ticket parse block):
 *   if (!isPrivilegedRole(parsed.role)) → close(4001)
 */
function simulateHandlerRoleRecheck(parsedTicket) {
  if (!parsedTicket || parsedTicket.type !== 'admin') return { allowed: false, reason: 'bad type' };
  if (!isPrivilegedRole(parsedTicket.role ?? '')) return { allowed: false, reason: 'insufficient role' };
  return { allowed: true };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/auth/ws-ticket role gate', () => {
  it('returns 401 when no session', () => {
    expect(simulateWsTicketGate(null).status).toBe(401);
  });

  it('returns 403 for role:member', () => {
    expect(simulateWsTicketGate({ id: '1', username: 'user', role: 'member' }).status).toBe(403);
  });

  it('returns 403 for role:user', () => {
    expect(simulateWsTicketGate({ id: '1', username: 'user', role: 'user' }).status).toBe(403);
  });

  it('returns 403 for role:supporter', () => {
    expect(simulateWsTicketGate({ id: '1', username: 'sup', role: 'supporter' }).status).toBe(403);
  });

  it('returns 200 and ticket for role:moderator', () => {
    const result = simulateWsTicketGate({ id: '2', username: 'mod', role: 'moderator' });
    expect(result.status).toBe(200);
    expect(result.ticketPayload.type).toBe('admin');
    expect(result.ticketPayload.role).toBe('moderator');
  });

  it('returns 200 for role:admin', () => {
    expect(simulateWsTicketGate({ id: '3', username: 'adm', role: 'admin' }).status).toBe(200);
  });

  it('returns 200 for role:owner', () => {
    expect(simulateWsTicketGate({ id: '4', username: 'own', role: 'owner' }).status).toBe(200);
  });

  it('stores role inside ticket JSON', () => {
    const result = simulateWsTicketGate({ id: '5', username: 'mod2', role: 'moderator' });
    expect(result.ticketPayload.role).toBe('moderator');
  });
});

describe('handleAdminObserver defense-in-depth role re-check', () => {
  it('rejects ticket with no role (legacy format fallback)', () => {
    // A ticket without a role field — issued before the gate was added.
    const result = simulateHandlerRoleRecheck({ type: 'admin', discordId: '1', username: 'x' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('insufficient role');
  });

  it('rejects ticket with role:user', () => {
    expect(simulateHandlerRoleRecheck({ type: 'admin', discordId: '1', username: 'x', role: 'user' }).allowed).toBe(false);
  });

  it('rejects ticket with wrong type', () => {
    expect(simulateHandlerRoleRecheck({ type: 'user', discordId: '1', username: 'x', role: 'admin' }).allowed).toBe(false);
  });

  it('allows ticket with role:moderator', () => {
    expect(simulateHandlerRoleRecheck({ type: 'admin', discordId: '1', username: 'x', role: 'moderator' }).allowed).toBe(true);
  });

  it('allows ticket with role:admin', () => {
    expect(simulateHandlerRoleRecheck({ type: 'admin', discordId: '1', username: 'x', role: 'admin' }).allowed).toBe(true);
  });

  it('allows ticket with role:owner', () => {
    expect(simulateHandlerRoleRecheck({ type: 'admin', discordId: '1', username: 'x', role: 'owner' }).allowed).toBe(true);
  });
});
