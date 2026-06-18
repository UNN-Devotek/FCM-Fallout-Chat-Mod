'use strict';

jest.mock('../dist/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { runPartyReap } = require('../dist/jobs/partyReap');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeParty(id, reapPolicy, isDeleted = false) {
  return { id, reapPolicy, isDeleted };
}

function makeDeps({
  parties = [],
  membersByParty = {},
  countByParty = {},
  inviteUpdateResult = { count: 0 },
  onlineUserIds = new Set(),
  now = () => new Date(),
} = {}) {
  const auditLogs = [];
  const updates = [];
  const broadcasts = [];

  return {
    deps: {
      prisma: {
        party: {
          findMany: jest.fn(async ({ where } = {}) => {
            return parties.filter(p => {
              if (where.isDeleted !== undefined && p.isDeleted !== where.isDeleted) return false;
              if (where.reapPolicy && p.reapPolicy !== where.reapPolicy) return false;
              return true;
            });
          }),
          update: jest.fn(async ({ where, data }) => {
            updates.push({ id: where.id, ...data });
            return { id: where.id };
          }),
        },
        partyMember: {
          findMany: jest.fn(async ({ where } = {}) => {
            const members = membersByParty[where.partyId] ?? [];
            return members.map(userId => ({ userId }));
          }),
          count: jest.fn(async ({ where } = {}) => {
            return countByParty[where.partyId] ?? 0;
          }),
        },
        partyInvite: {
          updateMany: jest.fn(async () => inviteUpdateResult),
        },
        auditLog: {
          create: jest.fn(async (data) => {
            auditLogs.push(data);
            return data;
          }),
        },
      },
      getOnlineUserIds: jest.fn(() => onlineUserIds),
      broadcastToPartyMembers: jest.fn(async (payload, memberIds) => {
        broadcasts.push({ payload, memberIds });
        return memberIds.length;
      }),
      now,
    },
    updates,
    auditLogs,
    broadcasts,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('partyReap', () => {
  describe('ephemeral party with 0 online members', () => {
    it('should be soft-deleted and party:deleted broadcast', async () => {
      const partyId = 'aaa-ephemeral-1';
      const memberId1 = 'user-1';
      const memberId2 = 'user-2';

      const { deps, updates, auditLogs, broadcasts } = makeDeps({
        parties: [makeParty(partyId, 'ephemeral')],
        membersByParty: { [partyId]: [memberId1, memberId2] },
        // Both members offline
        onlineUserIds: new Set(),
      });

      const result = await runPartyReap(deps);

      expect(result.ephemeralReaped).toContain(partyId);
      expect(result.persistentGCd).toHaveLength(0);
      expect(updates.some(u => u.id === partyId && u.isDeleted === true)).toBe(true);
      expect(auditLogs.some(a => a.data?.action === 'party_reap' && a.data?.targetId === partyId)).toBe(true);
      expect(broadcasts.some(b => b.payload?.type === 'party:deleted' && b.memberIds.includes(memberId1))).toBe(true);
    });

    it('should NOT reap ephemeral party when at least 1 member is online', async () => {
      const partyId = 'aaa-ephemeral-2';
      const memberId1 = 'user-1';
      const memberId2 = 'user-2';

      const { deps, updates } = makeDeps({
        parties: [makeParty(partyId, 'ephemeral')],
        membersByParty: { [partyId]: [memberId1, memberId2] },
        onlineUserIds: new Set([memberId1]),
      });

      const result = await runPartyReap(deps);

      expect(result.ephemeralReaped).not.toContain(partyId);
      expect(updates.some(u => u.id === partyId)).toBe(false);
    });
  });

  describe('persistent party', () => {
    it('should NOT reap persistent party even if all members offline', async () => {
      const partyId = 'bbb-persistent-1';
      const memberId1 = 'user-1';

      const { deps, updates } = makeDeps({
        parties: [makeParty(partyId, 'persistent')],
        membersByParty: { [partyId]: [memberId1] },
        countByParty: { [partyId]: 1 },
        onlineUserIds: new Set(),
      });

      const result = await runPartyReap(deps);

      expect(result.ephemeralReaped).not.toContain(partyId);
      expect(result.persistentGCd).not.toContain(partyId);
      expect(updates.some(u => u.id === partyId)).toBe(false);
    });

    it('should GC a persistent party with 0 members (defensive)', async () => {
      const partyId = 'bbb-persistent-empty';

      const { deps, updates, auditLogs } = makeDeps({
        parties: [makeParty(partyId, 'persistent')],
        membersByParty: { [partyId]: [] },
        countByParty: { [partyId]: 0 },
        onlineUserIds: new Set(),
      });

      const result = await runPartyReap(deps);

      expect(result.persistentGCd).toContain(partyId);
      expect(updates.some(u => u.id === partyId && u.isDeleted === true)).toBe(true);
      expect(auditLogs.some(a => a.data?.action === 'party_reap' && a.data?.targetId === partyId)).toBe(true);
    });
  });

  describe('stale invite expiry', () => {
    it('should expire invites older than 7 days', async () => {
      const { deps } = makeDeps({
        inviteUpdateResult: { count: 3 },
      });

      const result = await runPartyReap(deps);

      expect(result.invitesExpired).toBe(3);
      expect(deps.prisma.partyInvite.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'pending' }),
          data: { status: 'expired' },
        }),
      );

      // Verify the cutoff is ~7 days ago
      const call = deps.prisma.partyInvite.updateMany.mock.calls[0][0];
      const cutoffDate = call.where.createdAt.lt;
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoffDate.getTime() - sevenDaysAgo)).toBeLessThan(5000);
    });
  });
});

// ── startPartyReapJob overlap guard ───────────────────────────────────────
//
// This suite genuinely exercises the production overlap guard in
// startPartyReapJob: it injects a prisma.party.findMany whose FIRST call hangs
// on a controlled pending promise, holding the whole reap pass open. While that
// pass is pending we fire another interval tick and assert the guard skips it
// (the reap entry runs exactly once and logger.warn reports the previous tick
// still running). Then we resolve the held promise and confirm a subsequent
// tick runs. Removing the `running` guard from startPartyReapJob makes this fail.

const logger = require('../dist/config/logger').default;

// runPartyReap awaits several sequential prisma calls per pass, so a single
// microtask turn is not enough to drain a pass (and clear the `running` flag).
// Flush a generous number of turns to let a completed pass settle.
async function flushMicrotasks(turns = 20) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

describe('startPartyReapJob overlap guard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    logger.warn.mockClear();
    logger.info.mockClear();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /**
   * Builds DI deps whose party.findMany blocks on the FIRST call until the
   * returned `release()` is invoked. Subsequent calls resolve immediately.
   * `entryCalls` counts how many times the reap pass actually began (entered
   * the very first prisma query), which is the observable proof of how many
   * passes ran.
   */
  function makeGatedDeps() {
    let releaseFirst;
    let firstPassSeen = false;
    // Each runPartyReap invocation opens with an ephemeral party.findMany; we
    // count those to observe exactly how many reap PASSES started (party.findMany
    // is also called a second time per pass for the persistent scan, so we must
    // discriminate on the ephemeral filter, not on total findMany calls).
    const passStarts = { count: 0 };

    const partyFindMany = jest.fn(({ where } = {}) => {
      if (where && where.reapPolicy === 'ephemeral') {
        passStarts.count++;
        if (!firstPassSeen) {
          firstPassSeen = true;
          // First pass: hang here until released, holding the whole tick open.
          return new Promise((resolve) => {
            releaseFirst = () => resolve([]);
          });
        }
      }
      // Persistent scan and any later ephemeral scan resolve immediately.
      return Promise.resolve([]);
    });

    const deps = {
      prisma: {
        party: { findMany: partyFindMany, update: jest.fn().mockResolvedValue({}) },
        partyMember: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
        partyInvite: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      },
      getOnlineUserIds: () => new Set(),
      broadcastToPartyMembers: jest.fn().mockResolvedValue(0),
    };

    return { deps, partyFindMany, passStarts, release: () => releaseFirst && releaseFirst() };
  }

  it('starts only one reap pass while the first is still pending and warns on the skipped tick', async () => {
    const { startPartyReapJob, REAP_INTERVAL_MS } = require('../dist/jobs/partyReap');
    const { deps, passStarts, release } = makeGatedDeps();

    // startPartyReapJob runs a startup reconcile immediately, under the guard.
    const stop = startPartyReapJob(deps);
    await Promise.resolve(); // let the startup pass enter findMany

    // The startup reconcile started exactly one reap pass and is now blocked on
    // the gated findMany (running === true).
    expect(passStarts.count).toBe(1);

    // Fire an interval tick while the first pass is still pending → must be
    // skipped by the running guard, NOT start a second concurrent pass.
    jest.advanceTimersByTime(REAP_INTERVAL_MS);
    await Promise.resolve();

    expect(passStarts.count).toBe(1); // still exactly one pass started
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('previous tick still running'),
    );

    // Release the first pass and let it fully drain (clears the running flag).
    release();
    await flushMicrotasks();

    // A subsequent interval tick now runs because the guard is clear.
    jest.advanceTimersByTime(REAP_INTERVAL_MS);
    await flushMicrotasks();

    expect(passStarts.count).toBe(2);

    stop();
  });

  it('runs back-to-back ticks when each completes before the next interval', async () => {
    const { startPartyReapJob, REAP_INTERVAL_MS } = require('../dist/jobs/partyReap');

    // Count ephemeral-scan calls = number of reap passes that started
    // (party.findMany is also called for the persistent scan, so total calls
    // would be 2× the pass count).
    let passStarts = 0;
    const partyFindMany = jest.fn(({ where } = {}) => {
      if (where && where.reapPolicy === 'ephemeral') passStarts++;
      return Promise.resolve([]);
    });
    const deps = {
      prisma: {
        party: { findMany: partyFindMany, update: jest.fn().mockResolvedValue({}) },
        partyMember: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
        partyInvite: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
      },
      getOnlineUserIds: () => new Set(),
      broadcastToPartyMembers: jest.fn().mockResolvedValue(0),
    };

    const stop = startPartyReapJob(deps);
    await flushMicrotasks(); // startup reconcile completes (non-blocking)

    jest.advanceTimersByTime(REAP_INTERVAL_MS);
    await flushMicrotasks();
    jest.advanceTimersByTime(REAP_INTERVAL_MS);
    await flushMicrotasks();

    // startup + 2 ticks, none overlapping → 3 passes, no skip warning.
    expect(passStarts).toBe(3);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('previous tick still running'),
    );

    stop();
  });
});
