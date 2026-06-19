'use strict';

/**
 * Tests for the per-user owned-party cap in createParty.
 *
 * Verified:
 *   (a) Creating a party when the user already owns MAX_OWNED_PARTIES_PER_USER
 *       non-deleted parties returns 409.
 *   (b) Creating a party when the user owns fewer than the cap succeeds (201).
 *   (c) Deleted parties do not count toward the owned cap (the `isDeleted: false`
 *       filter is exercised, not assumed).
 *   (d) The in-transaction FOR UPDATE re-count catches a concurrent create that
 *       filled the last slot after the pre-check passed (TOCTOU guard) → 409.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../src/config/features', () => ({ __esModule: true, PARTIES_ENABLED: true }));

jest.mock('../src/websocket/handlers', () => ({
  __esModule: true,
  isUserConnected: () => false,
  isUserInGame: () => false,
  resolveDisplayName: (u) => (u && u.username) || 'Wanderer',
  broadcastToPartyMembers: jest.fn().mockResolvedValue(undefined),
  broadcast: jest.fn(),
  getOnlinePartyCounts: () => new Map(),
}));

jest.mock('../src/services/avatarService', () => ({
  __esModule: true,
  buildAvatarUrl: () => null,
}));

jest.mock('../src/services/autoModService', () => ({
  __esModule: true,
  findProhibitedPhrase: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/services/blockService', () => ({
  __esModule: true,
  getBlockedIds: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/services/messageService', () => ({
  __esModule: true,
  persistMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/userRoleService', () => ({
  __esModule: true,
  getEffectiveRole: jest.fn().mockResolvedValue('user'),
  isPrivilegedRole: () => false,
}));

// ── Prisma mock ───────────────────────────────────────────────────────────────

// Controlled per-test. ownedActiveCount / ownedDeletedCount model the owner's
// non-deleted vs soft-deleted parties so the `isDeleted: false` filter is actually
// exercised (a regression dropping it would leak deleted parties into the count).
// txOwnedActiveOverride simulates a concurrent create landing between the pre-check
// and the in-transaction FOR UPDATE re-count — the TOCTOU the lock closes.
let ownedActiveCount = 0;
let ownedDeletedCount = 0;
let txOwnedActiveOverride = null;
let memberCount = 0;

function countOwned(where, inTx) {
  const active = inTx && txOwnedActiveOverride != null ? txOwnedActiveOverride : ownedActiveCount;
  // The controller scopes the owned-cap count to non-deleted parties; if `isDeleted:
  // false` is missing from the where clause, soft-deleted parties leak into the count.
  return where && where.isDeleted === false ? active : active + ownedDeletedCount;
}

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    party: {
      count: jest.fn(async (args) => countOwned(args && args.where, false)),
      findFirst: jest.fn(async () => null), // no duplicate name
      create: jest.fn(async (args) => ({ id: 'new-party-id', ...args.data })),
    },
    partyMember: {
      count: jest.fn(async () => memberCount),
      create: jest.fn(async (args) => ({ id: 'new-member-id', ...args.data })),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (cb) => cb({
      // Owner-row lock (SELECT id FROM users ... FOR UPDATE) — returns a row.
      $queryRaw: jest.fn(async () => [{ id: 'owner-row' }]),
      party: {
        create: jest.fn(async (args) => ({ id: 'new-party-id', ...args.data })),
        count: jest.fn(async (args) => countOwned(args && args.where, true)),
        findFirst: jest.fn(async () => null),
      },
      partyMember: {
        count: jest.fn(async () => memberCount),
        create: jest.fn(async (args) => ({ id: 'new-member-id', ...args.data })),
      },
    })),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');

const CALLER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

const VALID_BODY = {
  name: 'Test Party',
  reapPolicy: 'persistent',
  maxMembers: 10,
  category: 'General',
};

function buildApp() {
  const { createParty } = require('../src/controllers/partiesController');
  const { errorHandler } = require('../src/middleware/errorHandler');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: CALLER_ID }; next(); });
  app.post('/api/parties', createParty);
  app.use(errorHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createParty owned-party cap', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();
    ownedActiveCount = 0;
    ownedDeletedCount = 0;
    txOwnedActiveOverride = null;
    memberCount = 0;
    app = buildApp();
  });

  it('returns 409 when the user already owns MAX_OWNED_PARTIES_PER_USER parties', async () => {
    ownedActiveCount = 3; // at the cap
    memberCount = 3; // under the membership cap

    const res = await request(app).post('/api/parties').send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.detail ?? res.body.error ?? '').toMatch(/own/i);
  });

  it('creates the party (201) when the user owns fewer than the cap', async () => {
    ownedActiveCount = 2; // one slot remaining
    memberCount = 2;

    const res = await request(app).post('/api/parties').send(VALID_BODY);
    expect(res.status).toBe(201);
  });

  it('does not block when the user owns zero parties', async () => {
    ownedActiveCount = 0;
    memberCount = 0;

    const res = await request(app).post('/api/parties').send(VALID_BODY);
    expect(res.status).toBe(201);
  });

  it('does not count soft-deleted parties toward the owned cap', async () => {
    // Owner is at the cap only if deleted parties are (wrongly) counted: 2 active + 5
    // deleted. The `isDeleted: false` filter must keep the effective count at 2 → 201.
    ownedActiveCount = 2;
    ownedDeletedCount = 5;
    memberCount = 2;

    const res = await request(app).post('/api/parties').send(VALID_BODY);
    expect(res.status).toBe(201);
  });

  it('rejects with 409 when a concurrent create fills the last slot before the FOR UPDATE re-count', async () => {
    // Pre-check sees 2 (a slot free), but by the time the owner-row lock is held the
    // in-transaction count is 3 — the authoritative guard must still return 409.
    ownedActiveCount = 2;
    txOwnedActiveOverride = 3;
    memberCount = 2;

    const res = await request(app).post('/api/parties').send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.detail ?? res.body.error ?? '').toMatch(/own/i);
  });
});
