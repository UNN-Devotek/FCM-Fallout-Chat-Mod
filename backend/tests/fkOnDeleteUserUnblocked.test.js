'use strict';

/**
 * Contract tests for issue #80: FK onDelete policies that blocked user deletion.
 *
 * These assert the REAL schema source (backend/prisma/schema.prisma) — which is
 * authoritative because baseline-migrations.sh runs `prisma db push` from the
 * schema before `migrate deploy` — rather than re-implementing the predicate or
 * only regex-matching the migration's own SQL. A regression that drops an
 * onDelete (reverting a relation to Prisma's default Restrict) flips the parsed
 * value and fails the suite.
 *
 * The cascade chain that must hold for `prisma.user.delete()` to succeed:
 *   messages.user_id        → Cascade
 *   party_messages.user_id  → Cascade
 *   party_messages.party_id → Cascade   (the gap the original PR missed: an owner
 *                                         delete cascades to their parties, which
 *                                         must cascade to those parties' messages —
 *                                         including messages authored by OTHER members)
 *   parties.owner_id        → Cascade
 *   bans.banned_by_id       → SetNull   (+ nullable: the issuing mod can be deleted)
 */

const fs = require('fs');
const path = require('path');

const SCHEMA = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf-8');
const MIGRATION_PATH = path.join(
  __dirname,
  '../prisma/migrations/20260619000000_fk_on_delete_user_unblocked/migration.sql',
);

// Extract a `model <Name> { ... }` block body from the schema.
function modelBlock(name) {
  const m = SCHEMA.match(new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm'));
  if (!m) throw new Error(`model ${name} not found in schema.prisma`);
  return m[1];
}

// Resolve the onDelete action for a relation field. A relation with no explicit
// onDelete falls back to Prisma's default for a REQUIRED relation: Restrict —
// which is exactly the regression we are guarding against.
function onDeleteOf(blockName, fieldRegex) {
  const block = modelBlock(blockName);
  const line = block.split('\n').find((l) => l.includes('@relation') && fieldRegex.test(l));
  if (!line) throw new Error(`relation field ${fieldRegex} not found in model ${blockName}`);
  const m = line.match(/onDelete:\s*(\w+)/);
  return m ? m[1] : 'Restrict';
}

describe('schema.prisma — user-deletion cascade chain (issue #80)', () => {
  it('Message.user is Cascade', () => {
    expect(onDeleteOf('Message', /\buser\s+User\b/)).toBe('Cascade');
  });

  it('PartyMessage.user is Cascade', () => {
    expect(onDeleteOf('PartyMessage', /\buser\s+User\b/)).toBe('Cascade');
  });

  it('PartyMessage.party is Cascade (closes the owner-delete FK-violation gap)', () => {
    // The defect the original PR shipped: this relation had no onDelete, so it
    // defaulted to Restrict and an owner delete threw when another member had posted.
    expect(onDeleteOf('PartyMessage', /\bParty\s+Party\b/)).toBe('Cascade');
  });

  it('Party.owner is Cascade', () => {
    expect(onDeleteOf('Party', /@relation\("PartyOwner"/)).toBe('Cascade');
  });

  it('Ban.bannedBy is SetNull and bannedById is nullable', () => {
    expect(onDeleteOf('Ban', /@relation\("BanIssuer"/)).toBe('SetNull');
    expect(modelBlock('Ban')).toMatch(/bannedById\s+String\?/);
  });

  it('no relation in the cascade chain is left as Restrict', () => {
    const chain = [
      ['Message', /\buser\s+User\b/],
      ['PartyMessage', /\buser\s+User\b/],
      ['PartyMessage', /\bParty\s+Party\b/],
      ['Party', /@relation\("PartyOwner"/],
    ];
    for (const [model, re] of chain) {
      expect(onDeleteOf(model, re)).not.toBe('Restrict');
    }
  });
});

describe('migration SQL — fk_on_delete_user_unblocked', () => {
  let sql;
  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  });

  it('migration file exists at the de-collided 20260619 timestamp', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it.each([
    ['messages', 'messages_user_id_fkey', 'ON DELETE CASCADE'],
    ['party_messages', 'party_messages_user_id_fkey', 'ON DELETE CASCADE'],
    ['party_messages', 'party_messages_party_id_fkey', 'ON DELETE CASCADE'],
    ['parties', 'parties_owner_id_fkey', 'ON DELETE CASCADE'],
    ['bans', 'bans_banned_by_id_fkey', 'ON DELETE SET NULL'],
  ])('%s.%s is re-added with %s', (_table, fkey, action) => {
    expect(sql).toContain(fkey);
    expect(sql).toMatch(new RegExp(`ADD CONSTRAINT\\s+${fkey}[\\s\\S]*?${action}`));
  });

  it('bans.banned_by_id column is made nullable (required for SET NULL)', () => {
    expect(sql).toContain('ALTER TABLE bans ALTER COLUMN banned_by_id DROP NOT NULL');
  });

  it('every DROP CONSTRAINT is guarded by an IF EXISTS check (idempotent)', () => {
    const drops = sql.match(/DROP CONSTRAINT \w+_fkey/g) || [];
    const guards = sql.match(/constraint_name = '\w+_fkey'/g) || [];
    expect(drops.length).toBeGreaterThan(0);
    expect(guards.length).toBe(drops.length);
  });

  it('migration and schema agree that party_messages.party_id cascades (drift guard)', () => {
    // If schema says Cascade but the migration omits the FK (or vice versa), fresh
    // (db push) and migrated (migrate deploy) databases would diverge.
    expect(onDeleteOf('PartyMessage', /\bParty\s+Party\b/)).toBe('Cascade');
    expect(sql).toMatch(/ADD CONSTRAINT\s+party_messages_party_id_fkey[\s\S]*?ON DELETE CASCADE/);
  });
});
