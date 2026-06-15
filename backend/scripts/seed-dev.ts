/**
 * seed-dev.ts — MAINTAINER-RUN sanitizing seed for the hosted dev environment.
 *
 * See docs/deployment/hosted-dev-environment.md ("Seed pipeline", "Data
 * classification"). This script is the ONE-WAY bridge from prod → dev. It must
 * only ever be run by the maintainer.
 *
 * What it does, in order:
 *   1. Copies ONLY public reference tables from a SOURCE database to the DEV
 *      database, verbatim (wiki_entries, wiki_images, wiki_aliases, camp_items,
 *      channels, releases, chat_commands). Nothing else is ever read from source.
 *   2. GENERATES fake users / chat messages / parties + memberships into the dev
 *      database. Fake content is SYNTHESIZED only (SR-004) — never sampled,
 *      copied, or derived from real prod usernames or message text.
 *   3. Emits a portable `dev-seed.dump` (pg_dump -Fc) that contributors can
 *      `pg_restore` into a fully-local stack.
 *
 * Security requirements honoured:
 *   - SR-002: the SOURCE connection (SOURCE_DATABASE_URL) MUST be a dedicated
 *     READ-ONLY Postgres role with SELECT on the reference tables only. Prod
 *     credentials live only on the maintainer's machine for the duration of the
 *     extract — never in the dev stack, the repo, or Dokploy env. This script
 *     issues only SELECTs against the source (via pg_dump --table allowlist).
 *   - SR-004: see generators in src/utils/devSeedHelpers.ts.
 *
 * Idempotent: re-runnable. Reference copy is replace-on-conflict; fake data is
 * upserted by deterministic keys.
 *
 * Env:
 *   SOURCE_DATABASE_URL   read-only source (prod read-only role, or existing dev)
 *   DATABASE_URL          the DEV database to populate (target)
 *   SEED_USER_COUNT       optional, default 60 (capped at SIM_NAMES length)
 *   SEED_MSG_PER_CHANNEL  optional, default 40
 *   SEED_PARTY_COUNT      optional, default 8
 *   SEED_RNG_SEED         optional, default 1337 (reproducible dataset)
 *   SKIP_DUMP=true        optional, skip the pg_dump artifact step
 *
 * Usage:
 *   SOURCE_DATABASE_URL=postgres://ro_user:***@prod-ro/fo76_chat \
 *   DATABASE_URL=postgres://dev_user:***@localhost:5432/fo76_chat_dev \
 *   node --import tsx scripts/seed-dev.ts
 */

import { execFileSync } from 'child_process';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import {
  generateFakeUsers,
  generateFakeMessage,
  generateFakeParty,
  makeRng,
  pick,
} from '../src/utils/devSeedHelpers';

// Reference tables copied verbatim from source. ALLOWLIST — anything not here is
// never read from the source DB. Order matters: parents before children (FKs).
const REFERENCE_TABLES = [
  'channels',
  'wiki_entries',
  'wiki_images',
  'wiki_aliases',
  'camp_items',
  'releases',
  'chat_commands',
] as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[seed-dev] FATAL: missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/**
 * Copy the reference-table allowlist from source → dev using pg_dump piped into
 * psql. `--data-only` + a per-table `--table` allowlist guarantees ONLY those
 * tables are read; `--on-conflict-do-nothing` keeps re-runs idempotent.
 */
function copyReferenceTables(sourceUrl: string, devUrl: string): void {
  const tableArgs = REFERENCE_TABLES.flatMap((t) => ['--table', t]);
  console.log(`[seed-dev] copying reference tables: ${REFERENCE_TABLES.join(', ')}`);

  const dump = execFileSync(
    'pg_dump',
    [
      '--data-only',
      '--no-owner',
      '--no-privileges',
      '--column-inserts',
      '--on-conflict-do-nothing',
      ...tableArgs,
      sourceUrl,
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 512 },
  );

  execFileSync('psql', ['--quiet', '--single-transaction', devUrl], {
    input: dump,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log('[seed-dev] reference tables copied.');
}

async function seedFakeData(prisma: PrismaClient): Promise<{
  users: number;
  messages: number;
  parties: number;
  members: number;
}> {
  const rng = makeRng(num('SEED_RNG_SEED', 1337));
  const userCount = num('SEED_USER_COUNT', 60);
  const msgPerChannel = num('SEED_MSG_PER_CHANNEL', 40);
  const partyCount = num('SEED_PARTY_COUNT', 8);

  // --- Users (upsert by username; deterministic sim- token) ---
  const fakeUsers = generateFakeUsers(userCount);
  const userIds: string[] = [];
  for (const u of fakeUsers) {
    const row = await prisma.user.upsert({
      where: { username: u.username },
      create: { username: u.username, installToken: u.installToken },
      update: { installToken: u.installToken },
      select: { id: true },
    });
    userIds.push(row.id);
  }
  console.log(`[seed-dev] users upserted: ${userIds.length}`);

  if (userIds.length === 0) {
    console.warn('[seed-dev] no fake users — skipping messages/parties.');
    return { users: 0, messages: 0, parties: 0, members: 0 };
  }

  // --- Messages across all non-archived channels (idempotent: clear sim msgs first) ---
  const channels = await prisma.channel.findMany({
    where: { isArchived: false },
    select: { id: true, parentId: true },
  });

  // Re-runnable: remove prior fake messages authored by our sim users so counts
  // don't grow unbounded across runs.
  await prisma.message.deleteMany({ where: { userId: { in: userIds } } });

  let messageCount = 0;
  for (const ch of channels) {
    const rows = Array.from({ length: msgPerChannel }, () => ({
      content: generateFakeMessage(rng),
      userId: pick(userIds, rng),
      channelId: ch.id,
      parentChannelId: ch.parentId ?? null,
      source: 'game',
    }));
    if (rows.length > 0) {
      const res = await prisma.message.createMany({ data: rows });
      messageCount += res.count;
    }
  }
  console.log(`[seed-dev] messages created: ${messageCount} across ${channels.length} channels`);

  // --- Parties + memberships (idempotent: drop sim-owned parties first) ---
  await prisma.party.deleteMany({ where: { ownerId: { in: userIds } } });

  let partyCreated = 0;
  let memberCreated = 0;
  for (let i = 0; i < partyCount; i++) {
    const def = generateFakeParty(rng);
    const ownerId = pick(userIds, rng);
    const party = await prisma.party.create({
      data: {
        name: def.name,
        category: def.category,
        isPrivate: def.isPrivate,
        ownerId,
        members: { create: { userId: ownerId, role: 'owner' } },
      },
      select: { id: true },
    });
    partyCreated++;
    memberCreated++;

    // 1–5 additional distinct members
    const extra = 1 + Math.floor(rng() * 5);
    const added = new Set<string>([ownerId]);
    for (let m = 0; m < extra; m++) {
      const uid = pick(userIds, rng);
      if (added.has(uid)) continue;
      added.add(uid);
      await prisma.partyMember.create({
        data: { partyId: party.id, userId: uid, role: 'member' },
      });
      memberCreated++;
    }
  }
  console.log(`[seed-dev] parties created: ${partyCreated}, memberships: ${memberCreated}`);

  return { users: userIds.length, messages: messageCount, parties: partyCreated, members: memberCreated };
}

function emitDumpArtifact(devUrl: string): string {
  const out = path.resolve(__dirname, '..', 'dev-seed.dump');
  console.log(`[seed-dev] writing portable artifact → ${out}`);
  execFileSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', out, devUrl], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return out;
}

async function main(): Promise<void> {
  const sourceUrl = requireEnv('SOURCE_DATABASE_URL');
  const devUrl = requireEnv('DATABASE_URL');

  if (sourceUrl === devUrl) {
    console.error('[seed-dev] FATAL: SOURCE_DATABASE_URL must differ from DATABASE_URL.');
    process.exit(1);
  }

  console.log('[seed-dev] === Fallout Chat Mod dev seed (maintainer-run) ===');
  console.log('[seed-dev] SR-002: SOURCE must be a READ-ONLY role; this script only SELECTs from it.');

  copyReferenceTables(sourceUrl, devUrl);

  const prisma = new PrismaClient({ datasources: { db: { url: devUrl } } });
  let summary;
  try {
    summary = await seedFakeData(prisma);
  } finally {
    await prisma.$disconnect();
  }

  let artifact = '(skipped)';
  if (process.env.SKIP_DUMP !== 'true') {
    artifact = emitDumpArtifact(devUrl);
  }

  console.log('\n[seed-dev] ===================== SUMMARY =====================');
  console.log(`[seed-dev] reference tables copied : ${REFERENCE_TABLES.length}`);
  console.log(`[seed-dev] fake users              : ${summary.users}`);
  console.log(`[seed-dev] fake messages           : ${summary.messages}`);
  console.log(`[seed-dev] fake parties            : ${summary.parties}`);
  console.log(`[seed-dev] fake memberships        : ${summary.members}`);
  console.log(`[seed-dev] portable artifact       : ${artifact}`);
  console.log('[seed-dev] ====================================================');
  console.log('[seed-dev] restore locally: pg_restore --clean --if-exists -d <local_db> dev-seed.dump');
}

main().catch((err) => {
  console.error('[seed-dev] FAILED:', err);
  process.exit(1);
});
