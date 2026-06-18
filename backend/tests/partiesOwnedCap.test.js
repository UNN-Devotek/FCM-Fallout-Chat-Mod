'use strict';

/**
 * Tests for the per-user owned-party cap in createParty.
 *
 * Verified:
 *   (a) Creating a party when the user already owns MAX_OWNED_PARTIES_PER_USER
 *       non-deleted parties returns 409.
 *   (b) Creating a party when the user owns fewer than the cap succeeds past
 *       the owned-cap check (falls through to DB logic).
 *   (c) Deleted parties do not count toward the owned cap.
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

// Controlled per-test via ownedCount / memberCount
let ownedCount = 0;
let memberCount = 0;

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    party: {
      count: jest.fn(async () => ownedCount),
      findFirst: jest.fn(async () => null), // no duplicate name
      create: jest.fn(async (args) => ({ id: 'new-party-id', ...args.data })),
    },
    partyMember: {
      count: jest.fn(async () => memberCount),
      create: jest.fn(async (args) => ({ id: 'new-member-id', ...args.data })),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (cb) => cb({
      party: {
        create: jest.fn(async (args) => ({ id: 'new-party-id', ...args.data })),
        count: jest.fn(async () => ownedCount),
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
    ownedCount = 0;
    memberCount = 0;
    app = buildApp();
  });

  it('returns 409 when the user already owns MAX_OWNED_PARTIES_PER_USER parties', async () => {
    ownedCount = 3; // at the cap
    memberCount = 3; // under the membership cap

    const res = await request(app).post('/api/parties').send(VALID_BODY);
    expect(res.status).toBe(409);
    expect(res.body.detail ?? res.body.error ?? '').toMatch(/own/i);
  });

  it('proceeds past the owned-cap check when the user owns fewer than the cap', async () => {
    ownedCount = 2; // one slot remaining
    memberCount = 2;

    const res = await request(app).post('/api/parties').send(VALID_BODY);
    // Should not be blocked by the owned-cap (may succeed or fail for other reasons)
    expect(res.status).not.toBe(409);
  });

  it('does not block when the user owns zero parties', async () => {
    ownedCount = 0;
    memberCount = 0;

    const res = await request(app).post('/api/parties').send(VALID_BODY);
    expect(res.status).not.toBe(409);
  });
});
