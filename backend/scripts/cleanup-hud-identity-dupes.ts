/**
 * cleanup-hud-identity-dupes.ts
 *
 * One-shot cleanup for the duplicate HUD-provisioned users created before Priority-2b
 * (account-name auto-pair) was implemented.
 *
 * PROBLEM:
 *   The real Discord account (username "Devotek-") had fo76CharacterName = null, so
 *   Priority-2 (character-name match) never fired on HELLO. Two junk auto-provisioned
 *   users were created instead:
 *     - "Devotek"      (00765446-…) — older provision, identityHash = 8aa503c9…
 *     - "Devotek-cf73d7" (61ea65f2-…) — current provision, identityHash = cf73d7…
 *
 * WHAT THIS SCRIPT DOES:
 *   1. Validates the three expected users exist and the real account has no identityHash.
 *   2. Re-points any messages owned by junk users to the real account (safety; currently 0 rows).
 *   3. Attaches the CURRENT junk user's identityHash (cf73d7…) to the real account and
 *      sets fo76AccountName + fo76CharacterName on it.
 *   4. Removes both junk users.
 *
 * REVERSIBILITY:
 *   The script only proceeds when pre-conditions pass.  To undo manually:
 *     UPDATE users SET identity_hash=NULL, fo76_account_name=NULL, fo76_character_name=NULL
 *       WHERE id = '78558c1b-8f3b-48bb-91b7-aad0b95480d8';
 *     Re-provision users by just running the game again (HUD HELLO will re-provision).
 *
 * USAGE:
 *   # Dry run (no writes):
 *   DRY_RUN=1 npx ts-node --project tsconfig.json scripts/cleanup-hud-identity-dupes.ts
 *
 *   # Live run:
 *   npx ts-node --project tsconfig.json scripts/cleanup-hud-identity-dupes.ts
 */

import prisma from '../src/config/prisma';

const DRY_RUN = process.env.DRY_RUN === '1';

const REAL_USER_ID  = '78558c1b-8f3b-48bb-91b7-aad0b95480d8'; // Devotek-   (keep)
const JUNK_OLD_ID   = '00765446-0664-4ced-9287-71dca34fb25d'; // Devotek    (delete)
const JUNK_CURR_ID  = '61ea65f2-86d7-4b2d-9538-f0e4e454906f'; // Devotek-cf73d7 (delete, harvest hash)

const EXPECTED_REAL_USERNAME  = 'Devotek-';
const EXPECTED_JUNK_CHAR_NAME = 'Devotek';
const EXPECTED_ACCOUNT_NAME   = 'Devotek-';

function log(msg: string) { console.log(`[cleanup-hud-identity-dupes] ${DRY_RUN ? '[DRY-RUN] ' : ''}${msg}`); }
function fatal(msg: string): never { console.error(`[cleanup-hud-identity-dupes] FATAL: ${msg}`); process.exit(1); }

async function run() {
  log('Starting HUD identity duplicate cleanup.');
  log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE RUN'}`);

  // ── 1. Validate pre-conditions ─────────────────────────────────────────────

  const realUser = await prisma.user.findUnique({
    where: { id: REAL_USER_ID },
    select: { id: true, username: true, identityHash: true, fo76AccountName: true, fo76CharacterName: true },
  });
  if (!realUser) fatal(`Real user ${REAL_USER_ID} not found. Aborting.`);
  if (realUser.username !== EXPECTED_REAL_USERNAME)
    fatal(`Real user username mismatch: expected "${EXPECTED_REAL_USERNAME}", got "${realUser.username}". Aborting.`);
  if (realUser.identityHash !== null)
    fatal(`Real user already has identityHash "${realUser.identityHash}". Has this script already run? Aborting.`);

  const junkOld = await prisma.user.findUnique({
    where: { id: JUNK_OLD_ID },
    select: { id: true, username: true, identityHash: true, fo76CharacterName: true, fo76AccountName: true },
  });
  const junkCurr = await prisma.user.findUnique({
    where: { id: JUNK_CURR_ID },
    select: { id: true, username: true, identityHash: true, fo76CharacterName: true, fo76AccountName: true },
  });

  if (!junkOld)  fatal(`Junk user (old) ${JUNK_OLD_ID} not found. Aborting.`);
  if (!junkCurr) fatal(`Junk user (curr) ${JUNK_CURR_ID} not found. Aborting.`);
  if (!junkCurr.identityHash) fatal(`Junk user (curr) has no identityHash to harvest. Aborting.`);

  log(`Pre-conditions OK:`);
  log(`  Real:      id=${realUser.id}  username=${realUser.username}  identityHash=null`);
  log(`  Junk old:  id=${junkOld.id}   username=${junkOld.username}  identityHash=${junkOld.identityHash}`);
  log(`  Junk curr: id=${junkCurr.id}  username=${junkCurr.username} identityHash=${junkCurr.identityHash}`);

  // ── 2. Count messages under junk users ────────────────────────────────────

  const junkIds = [JUNK_OLD_ID, JUNK_CURR_ID];
  // Use raw query because message table may or may not be in Prisma schema
  const msgCount: { count: string }[] = await prisma.$queryRaw`
    SELECT COUNT(*)::text AS count FROM messages WHERE user_id = ANY(${junkIds}::uuid[])
  `;
  const affectedMessages = parseInt(msgCount[0].count, 10);
  log(`Messages owned by junk users: ${affectedMessages}`);

  // ── 3. Plan ────────────────────────────────────────────────────────────────

  const harvestedHash     = junkCurr.identityHash!;
  const harvestedAccount  = junkCurr.fo76AccountName ?? EXPECTED_ACCOUNT_NAME;
  const harvestedCharName = junkCurr.fo76CharacterName ?? EXPECTED_JUNK_CHAR_NAME;

  log(`Will:`);
  log(`  a) Re-point ${affectedMessages} messages from junk users → ${REAL_USER_ID}`);
  log(`  b) Attach identityHash=${harvestedHash} to real user`);
  log(`  c) Set fo76AccountName="${harvestedAccount}", fo76CharacterName="${harvestedCharName}" on real user`);
  log(`  d) Delete junk users: ${JUNK_OLD_ID}, ${JUNK_CURR_ID}`);

  if (DRY_RUN) {
    log('DRY RUN complete — no writes performed.');
    await prisma.$disconnect();
    return;
  }

  // ── 4. Apply ───────────────────────────────────────────────────────────────

  await prisma.$transaction(async (tx) => {
    // Re-point messages (idempotent — ok if 0 rows)
    if (affectedMessages > 0) {
      await tx.$executeRaw`
        UPDATE messages SET user_id = ${REAL_USER_ID}::uuid
        WHERE user_id = ANY(${junkIds}::uuid[])
      `;
      log(`  Re-pointed ${affectedMessages} messages.`);
    }

    // Delete junk users FIRST — the curr junk user holds the harvested
    // identityHash, and identity_hash is UNIQUE, so the real-user update below
    // would collide (P2002) if the junk row still existed. Order matters.
    await tx.user.delete({ where: { id: JUNK_OLD_ID } });
    log(`  Deleted junk user (old): ${JUNK_OLD_ID}`);
    await tx.user.delete({ where: { id: JUNK_CURR_ID } });
    log(`  Deleted junk user (curr): ${JUNK_CURR_ID}`);

    // Now attach hash + FO76 fields to real user (hash is free again).
    await tx.user.update({
      where: { id: REAL_USER_ID },
      data: {
        identityHash: harvestedHash,
        fo76AccountName: harvestedAccount,
        fo76CharacterName: harvestedCharName,
      },
    });
    log(`  Attached identityHash + fo76 fields to real user.`);
  });

  log('Cleanup complete.');
  await prisma.$disconnect();
}

run().catch((err) => {
  console.error('[cleanup-hud-identity-dupes] Unhandled error:', err);
  process.exit(1);
});
