'use strict';

/**
 * Concurrency tests for the per-party capacity guard in partiesController.
 *
 * These tests drive the REAL joinParty / acceptInvite handlers (not a hand-
 * copied reimplementation) against a prisma mock that models Postgres
 * row-lock + READ COMMITTED snapshot semantics:
 *
 *   - prisma.$transaction(cb) runs `cb(tx)` against the shared in-memory member
 *     store, but each transaction sees its own snapshot of the member count
 *     taken at the moment the transaction acquires the party row lock (mirroring
 *     READ COMMITTED: count() cannot see another tx's uncommitted insert).
 *   - tx.$queryRaw`... FOR UPDATE` acquires a per-party async mutex. While one
 *     transaction holds it, a second transaction for the SAME party blocks until
 *     the first commits — exactly like SELECT ... FOR UPDATE on the party row.
 *   - On commit, the holder's inserts become visible and its snapshot count is
 *     refreshed for the next lock holder.
 *
 * The decisive property: WITHOUT the `FOR UPDATE` row lock, two concurrent joins
 * both read the pre-insert snapshot count, both pass the capacity check, and both
 * insert — overfilling the party. The test asserts membership NEVER exceeds
 * maxMembers, so it FAILS if the row lock (the fix) is removed.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../src/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Keep parties enabled.
jest.mock('../src/config/features', () => ({ __esModule: true, PARTIES_ENABLED: true }));

// emitMemberUpdate / resolveDisplayName etc. all route through the WS handlers
// module via require(); stub it so the controller's broadcast is a no-op.
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
  findProhibitedPhrase: () => null,
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

// ── In-memory DB state + a prisma mock that models row-lock + snapshots ───────

const PARTY_ID = '11111111-1111-1111-1111-111111111111';

// Shared committed member store: array of { id, partyId, userId, role }.
let committedMembers = [];
// Per-party async mutex modeling SELECT ... FOR UPDATE on the party row.
let partyLocks = {};
// Spies so we can assert on lock ordering.
let queryRawCalls = [];

let partyRecord = null;
let inviteRecord = null;

function acquirePartyLock(partyId) {
  const prev = partyLocks[partyId] || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  partyLocks[partyId] = prev.then(() => next);
  // Wait until all previously-queued holders have released.
  return prev.then(() => release);
}

const prismaMock = {
  party: {
    findUnique: jest.fn(async ({ where }) => {
      if (partyRecord && (where.id === partyRecord.id)) {
        if (where.isDeleted === false && partyRecord.isDeleted) return null;
        return { ...partyRecord };
      }
      return null;
    }),
  },
  partyInvite: {
    findUnique: jest.fn(async () => (inviteRecord ? { ...inviteRecord, party: { ...partyRecord } } : null)),
  },
  user: {
    findUnique: jest.fn(async ({ where }) => ({ id: where.id, isBanned: false, isMuted: false, username: 'Tester' })),
  },
  partyMember: {
    // Per-user party cap check (atPartyCap) + idempotency reads — operate on the
    // committed store.
    count: jest.fn(async ({ where }) => committedMembers.filter((m) => matchMember(m, where)).length),
    findFirst: jest.fn(async ({ where }) => committedMembers.find((m) => matchMember(m, where)) || null),
    findMany: jest.fn(async ({ where }) =>
      committedMembers
        .filter((m) => matchMember(m, where))
        .map((m) => ({ ...m, user: { id: m.userId, username: 'Tester', discordId: null } }))),
  },
  auditLog: { create: jest.fn().mockResolvedValue({}) },

  // $transaction runs the callback with a `tx` that (1) blocks on the party row
  // lock when $queryRaw FOR UPDATE is issued, (2) reads the count from a
  // snapshot captured AT LOCK-ACQUIRE time, and (3) buffers inserts that only
  // become visible to other transactions on commit.
  $transaction: jest.fn(async (cb) => {
    let release = null;
    let snapshot = committedMembers.slice(); // READ COMMITTED snapshot if no lock taken
    const pendingInserts = [];

    const tx = {
      $queryRaw: jest.fn(async (strings, ...values) => {
        // Record the lock attempt.
        const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
        queryRawCalls.push({ sql, values });
        if (/FOR UPDATE/i.test(sql)) {
          release = await acquirePartyLock(PARTY_ID);
          // Re-snapshot AFTER acquiring the lock — now we can see members the
          // previous lock-holder committed.
          snapshot = committedMembers.slice();
        }
        return [{ id: PARTY_ID }];
      }),
      partyInvite: {
        update: jest.fn().mockResolvedValue({}),
      },
      party: {
        findUnique: jest.fn(async () => ({ ...partyRecord })),
      },
      partyMember: {
        count: jest.fn(async ({ where }) =>
          snapshot.concat(pendingInserts).filter((m) => matchMember(m, where)).length),
        findFirst: jest.fn(async ({ where }) =>
          snapshot.concat(pendingInserts).find((m) => matchMember(m, where)) || null),
        create: jest.fn(async ({ data }) => {
          pendingInserts.push({ ...data });
          return { ...data };
        }),
      },
    };

    try {
      const result = await cb(tx);
      // Commit: make buffered inserts visible.
      committedMembers.push(...pendingInserts);
      return result;
    } finally {
      if (release) release();
    }
  }),
};

function matchMember(m, where) {
  if (!where) return true;
  if (where.partyId != null && m.partyId !== where.partyId) return false;
  if (where.userId != null && m.userId !== where.userId) return false;
  if (where.party && where.party.isDeleted === false) {
    // join-cap query filters on non-deleted party; our single party is live.
    if (partyRecord && partyRecord.isDeleted) return false;
  }
  return true;
}

jest.mock('../src/config/prisma', () => ({ __esModule: true, default: prismaMock }));
// Defensive alias: if any module in the require chain resolves the compiled
// build (dist) rather than src, route it to the same mock (matches the
// convention in moderationActionsService.test.js).
jest.mock('../dist/config/prisma', () => jest.requireMock('../src/config/prisma'), { virtual: true });

// ── Import the REAL controller ────────────────────────────────────────────────
const { joinParty, acceptInvite } = require('../src/controllers/partiesController');

function makeReqRes(userId, params) {
  const req = { user: { id: userId }, params };
  let jsonBody;
  let statusCode = 200;
  const res = {
    status: jest.fn(function (c) { statusCode = c; return this; }),
    json: jest.fn(function (b) { jsonBody = b; return this; }),
  };
  const errors = [];
  const next = jest.fn((e) => { if (e) errors.push(e); });
  return { req, res, next, get body() { return jsonBody; }, get status() { return statusCode; }, errors };
}

beforeEach(() => {
  jest.clearAllMocks();
  committedMembers = [];
  partyLocks = {};
  queryRawCalls = [];
  partyRecord = {
    id: PARTY_ID,
    name: 'Race Party',
    isPrivate: false,
    isDeleted: false,
    maxMembers: 2,
    ownerId: 'owner-0',
  };
  inviteRecord = null;
});

// ── joinParty concurrency ─────────────────────────────────────────────────────

describe('joinParty per-party capacity race (real controller)', () => {
  test('takes a FOR UPDATE row lock on the party before counting + inserting', async () => {
    const ctx = makeReqRes('22222222-2222-2222-2222-222222222222', { id: PARTY_ID });
    await joinParty(ctx.req, ctx.res, ctx.next);

    expect(ctx.errors).toHaveLength(0);
    // The transactional path must have issued a FOR UPDATE lock on the party.
    const lockCalls = queryRawCalls.filter((c) => /FOR UPDATE/i.test(c.sql));
    expect(lockCalls.length).toBeGreaterThanOrEqual(1);
    expect(lockCalls[0].sql).toMatch(/from\s+parties/i);
    // The locked id must be the party being joined (parameterized value).
    expect(lockCalls[0].values).toContain(PARTY_ID);
    // One member committed.
    expect(committedMembers.filter((m) => m.partyId === PARTY_ID)).toHaveLength(1);
  });

  test('two concurrent joins for the last slot NEVER overfill the party', async () => {
    // maxMembers=2, one seat already taken → only ONE of two concurrent joins
    // may succeed. Without the row lock both would read count=1 and both insert.
    committedMembers.push({ id: 'm0', partyId: PARTY_ID, userId: 'seed-user', role: 'member' });

    const a = makeReqRes('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', { id: PARTY_ID });
    const b = makeReqRes('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', { id: PARTY_ID });

    // Fire both "simultaneously".
    await Promise.all([
      joinParty(a.req, a.res, a.next),
      joinParty(b.req, b.res, b.next),
    ]);

    const members = committedMembers.filter((m) => m.partyId === PARTY_ID);
    expect(members.length).toBe(2); // seed + exactly one new join — never 3
    expect(members.length).toBeLessThanOrEqual(partyRecord.maxMembers);

    // Exactly one caller got a 409 PARTY_FULL.
    const allErrors = [...a.errors, ...b.errors];
    expect(allErrors).toHaveLength(1);
    expect(allErrors[0].status).toBe(409);
    expect(allErrors[0].message).toBe('Party is full');
  });

  test('many concurrent joins respect maxMembers exactly', async () => {
    partyRecord.maxMembers = 3;
    const N = 8;
    const ctxs = Array.from({ length: N }, (_, i) =>
      makeReqRes(`cccccccc-cccc-cccc-cccc-${String(i).padStart(12, '0')}`, { id: PARTY_ID }));

    await Promise.all(ctxs.map((c) => joinParty(c.req, c.res, c.next)));

    const members = committedMembers.filter((m) => m.partyId === PARTY_ID);
    expect(members.length).toBe(3); // never exceeds the cap
    const fulls = ctxs.flatMap((c) => c.errors).filter((e) => e.status === 409);
    expect(fulls.length).toBe(N - 3);
  });

  test('unlimited party (maxMembers null) admits all concurrent joins', async () => {
    partyRecord.maxMembers = null;
    const N = 5;
    const ctxs = Array.from({ length: N }, (_, i) =>
      makeReqRes(`dddddddd-dddd-dddd-dddd-${String(i).padStart(12, '0')}`, { id: PARTY_ID }));
    await Promise.all(ctxs.map((c) => joinParty(c.req, c.res, c.next)));
    expect(committedMembers.filter((m) => m.partyId === PARTY_ID)).toHaveLength(N);
    expect(ctxs.flatMap((c) => c.errors)).toHaveLength(0);
  });
});

// ── acceptInvite shares the guarded pattern ───────────────────────────────────

describe('acceptInvite per-party capacity race (real controller)', () => {
  const INVITE_A = '33333333-3333-3333-3333-333333333333';
  const INVITE_B = '44444444-4444-4444-4444-444444444444';

  test('acceptInvite also takes a FOR UPDATE row lock on the party', async () => {
    partyRecord.maxMembers = 5;
    const inviteeId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    inviteRecord = { id: INVITE_A, inviteeId, partyId: PARTY_ID, status: 'pending' };
    // findUnique returns the invite matching the requested id.
    prismaMock.partyInvite.findUnique.mockImplementation(async ({ where }) =>
      where.id === inviteRecord.id ? { ...inviteRecord, party: { ...partyRecord } } : null);

    const ctx = makeReqRes(inviteeId, { id: INVITE_A });
    await acceptInvite(ctx.req, ctx.res, ctx.next);

    expect(ctx.errors).toHaveLength(0);
    const lockCalls = queryRawCalls.filter((c) => /FOR UPDATE/i.test(c.sql));
    expect(lockCalls.length).toBeGreaterThanOrEqual(1);
    expect(lockCalls[0].sql).toMatch(/from\s+parties/i);
    expect(committedMembers.filter((m) => m.partyId === PARTY_ID)).toHaveLength(1);
  });

  test('two concurrent invite accepts for the last slot NEVER overfill', async () => {
    partyRecord.maxMembers = 2;
    committedMembers.push({ id: 'm0', partyId: PARTY_ID, userId: 'seed-user', role: 'member' });

    const inviteeA = 'a1a1a1a1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const inviteeB = 'b1b1b1b1-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const invites = {
      [INVITE_A]: { id: INVITE_A, inviteeId: inviteeA, partyId: PARTY_ID, status: 'pending' },
      [INVITE_B]: { id: INVITE_B, inviteeId: inviteeB, partyId: PARTY_ID, status: 'pending' },
    };
    prismaMock.partyInvite.findUnique.mockImplementation(async ({ where }) => {
      const inv = invites[where.id];
      return inv ? { ...inv, party: { ...partyRecord } } : null;
    });

    const a = makeReqRes(inviteeA, { id: INVITE_A });
    const b = makeReqRes(inviteeB, { id: INVITE_B });
    await Promise.all([
      acceptInvite(a.req, a.res, a.next),
      acceptInvite(b.req, b.res, b.next),
    ]);

    const members = committedMembers.filter((m) => m.partyId === PARTY_ID);
    expect(members.length).toBe(2); // seed + one accept — never 3
    const allErrors = [...a.errors, ...b.errors];
    expect(allErrors).toHaveLength(1);
    expect(allErrors[0].status).toBe(409);
    expect(allErrors[0].message).toBe('Party is full');
  });

  test('idempotent re-accept of an existing membership is exempt from the cap', async () => {
    partyRecord.maxMembers = 1; // already full of exactly this member
    const inviteeId = 'f1f1f1f1-ffff-ffff-ffff-ffffffffffff';
    committedMembers.push({ id: 'm-existing', partyId: PARTY_ID, userId: inviteeId, role: 'member' });
    inviteRecord = { id: INVITE_A, inviteeId, partyId: PARTY_ID, status: 'pending' };
    prismaMock.partyInvite.findUnique.mockImplementation(async ({ where }) =>
      where.id === inviteRecord.id ? { ...inviteRecord, party: { ...partyRecord } } : null);

    const ctx = makeReqRes(inviteeId, { id: INVITE_A });
    await acceptInvite(ctx.req, ctx.res, ctx.next);

    // No PARTY_FULL error — re-accept does not grow the party.
    expect(ctx.errors.filter((e) => e.status === 409)).toHaveLength(0);
    expect(committedMembers.filter((m) => m.partyId === PARTY_ID)).toHaveLength(1);
  });
});
