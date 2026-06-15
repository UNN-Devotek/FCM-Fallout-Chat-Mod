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
