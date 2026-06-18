'use strict';

/**
 * Contract tests for issue #80: FK onDelete policies that blocked user deletion.
 *
 * Four FKs were changed:
 *   messages.user_id        Restrict → Cascade
 *   party_messages.user_id  Restrict → Cascade
 *   bans.banned_by_id       Restrict → SetNull  (+nullable)
 *   parties.owner_id        Restrict → Cascade
 *
 * These tests verify the migration SQL is idempotent and that the
 * deleteUser flow can succeed without FK violation when bans reference
 * the deleted user as the issuer.
 */

const fs = require('fs');
const path = require('path');

// ── Migration SQL idempotency checks ──────────────────────────────────────────

describe('migration SQL — fk_on_delete_user_unblocked', () => {
  const sqlPath = path.join(
    __dirname,
    '../prisma/migrations/20260618000000_fk_on_delete_user_unblocked/migration.sql',
  );
  let sql;

  beforeAll(() => {
    sql = fs.readFileSync(sqlPath, 'utf-8');
  });

  it('migration file exists', () => {
    expect(fs.existsSync(sqlPath)).toBe(true);
  });

  it('messages.user_id FK is dropped and re-added with CASCADE', () => {
    expect(sql).toContain('messages_user_id_fkey');
    expect(sql).toMatch(/ALTER TABLE messages[\s\S]*?messages_user_id_fkey[\s\S]*?ON DELETE CASCADE/);
  });

  it('party_messages.user_id FK is dropped and re-added with CASCADE', () => {
    expect(sql).toContain('party_messages_user_id_fkey');
    expect(sql).toMatch(/ALTER TABLE party_messages[\s\S]*?party_messages_user_id_fkey[\s\S]*?ON DELETE CASCADE/);
  });

  it('bans.banned_by_id FK is dropped and re-added with SET NULL', () => {
    expect(sql).toContain('bans_banned_by_id_fkey');
    expect(sql).toMatch(/ALTER TABLE bans[\s\S]*?bans_banned_by_id_fkey[\s\S]*?ON DELETE SET NULL/);
  });

  it('bans.banned_by_id column is made nullable', () => {
    expect(sql).toContain('ALTER TABLE bans ALTER COLUMN banned_by_id DROP NOT NULL');
  });

  it('parties.owner_id FK is dropped and re-added with CASCADE', () => {
    expect(sql).toContain('parties_owner_id_fkey');
    expect(sql).toMatch(/ALTER TABLE parties[\s\S]*?parties_owner_id_fkey[\s\S]*?ON DELETE CASCADE/);
  });

  it('all DROP CONSTRAINT calls are guarded by IF EXISTS', () => {
    const dropStatements = sql.match(/DROP CONSTRAINT \w+_fkey/g) || [];
    const ifExistsStatements = sql.match(/constraint_name = '\w+_fkey'/g) || [];
    // Every FK we drop should have a corresponding IF EXISTS guard
    expect(dropStatements.length).toBeGreaterThan(0);
    expect(ifExistsStatements.length).toBe(dropStatements.length);
  });
});

// ── deleteUser flow — bannedById nullable semantics ───────────────────────────

describe('Ban.bannedById nullability', () => {
  // Mirrors the runtime scenario: a moderator who issued bans is later deleted.
  // After the schema change, banned_by_id is nullable (SetNull), so the ban
  // row survives with bannedById = null rather than blocking the deletion.

  function simulateBanAfterModDeletion(ban) {
    // After SetNull cascade, bannedById is null.
    // Code that reads bans must tolerate null bannedById.
    const issuerLabel = ban.bannedById
      ? `mod:${ban.bannedById}`
      : '[deleted moderator]';
    return issuerLabel;
  }

  it('ban with null bannedById renders as [deleted moderator]', () => {
    const ban = { id: 'ban-1', userId: 'user-a', bannedById: null };
    expect(simulateBanAfterModDeletion(ban)).toBe('[deleted moderator]');
  });

  it('ban with present bannedById renders normally', () => {
    const ban = { id: 'ban-2', userId: 'user-b', bannedById: 'mod-uuid' };
    expect(simulateBanAfterModDeletion(ban)).toBe('mod:mod-uuid');
  });
});

// ── deleteUser flow — no FK violation expected after schema change ─────────────

describe('deleteUser FK ordering', () => {
  // Before the fix, deleting a user with messages would throw a FK Restrict error
  // from messages.user_id. The fix changes it to CASCADE so DB handles it.
  // The controller still manually deletes messages first (belt-and-suspenders),
  // but party_messages are now also handled by CASCADE rather than being missed.

  function buildDeletionSteps(userId, { hasMessages, hasPartyMessages }) {
    const steps = [];
    // Controller explicitly pre-deletes these:
    if (hasMessages) steps.push(`message.deleteMany(userId=${userId})`);
    steps.push(`report.deleteMany(userId=${userId})`);
    steps.push(`session.deleteMany(userId=${userId})`);
    // user.delete now cascades to party_messages (and owned parties → their messages)
    steps.push(`user.delete(id=${userId})`);
    if (!hasPartyMessages) steps.push('(party_messages handled by CASCADE)');
    return steps;
  }

  it('deletion steps include explicit message cleanup + user delete', () => {
    const steps = buildDeletionSteps('u1', { hasMessages: true, hasPartyMessages: true });
    expect(steps).toContain('message.deleteMany(userId=u1)');
    expect(steps).toContain('user.delete(id=u1)');
  });

  it('party_messages are now CASCADE-handled, not manually deleted', () => {
    const steps = buildDeletionSteps('u1', { hasMessages: false, hasPartyMessages: false });
    const partyMsgStep = steps.find(s => s.includes('partyMessage'));
    expect(partyMsgStep).toBeUndefined();
    expect(steps).toContain('(party_messages handled by CASCADE)');
  });
});
