import { isPrismaAtomicRefusal, isRowCountNoChange, runRequiredBundle, runRequiredMutation } from '../lib/requiredEffects';
/**
 * mergeUser.ts — canonical user-merge helper
 *
 * Problem: `installToken`-keyed registration produces duplicate rows whenever a
 * user links Discord from a new install.  After the fix, `discordId` is the
 * primary identity anchor.  When we see a discordId that already belongs to an
 * existing row we must MERGE all foreign-key data into that canonical row before
 * deleting the placeholder, otherwise we hit onDelete:Restrict / P2003 errors or
 * silently orphan history.
 *
 * `mergeUserInto(canonicalId, placeholderId, tx)` is called inside a Prisma
 * interactive-transaction block.  It:
 *   1. Re-points ALL FK tables from placeholder → canonical.
 *   2. Handles @@unique collision tables (party_members, party_invites, blocks,
 *      user_aliases) with ON CONFLICT skip so we never violate a unique constraint.
 *   3. Deletes the placeholder row.
 *
 * Safe to re-run: if canonical === placeholder it's a no-op.
 */

import { Prisma } from '@prisma/client';

/**
 * Merge all data from `placeholderId` into `canonicalId` then delete the
 * placeholder.  Must be called inside a Prisma $transaction callback.
 * Idempotent: if the two IDs are equal this is a no-op.
 */
export async function mergeUserInto(
  canonicalId: string,
  placeholderId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  return runRequiredBundle('identity', 'mergeUser:703008724cb7', async () => {
  if (canonicalId === placeholderId) return;

  // ── Simple re-point tables (no unique collision possible) ────────────────
  await runRequiredMutation('identity', 'e4600a5fe1b667099ba0aaf2', { stage: 'primary-write-unconfirmed', userId: canonicalId }, () => tx.message.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  await runRequiredMutation('identity', '442d20bbbc112b34742b3ef6', { stage: 'primary-write-unconfirmed', userId: canonicalId }, () => tx.session.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  // Keep every HUD device bound to the canonical account. Without this update,
  // deleting the placeholder sets linked_user_id to NULL and the device falls
  // back to a limited/anonymous identity on its next relay message.
  await runRequiredMutation('identity', '8d5e58559f983854455c3ee1', { stage: 'primary-write-unconfirmed' }, () => tx.hudPairingToken.updateMany({
    where: { linkedUserId: placeholderId },
    data: { linkedUserId: canonicalId },
  }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  await runRequiredMutation('identity', '92d57ff7af15298b5001a9cb', { stage: 'primary-write-unconfirmed', actorId: canonicalId }, () => tx.auditLog.updateMany({ where: { actorId: placeholderId }, data: { actorId: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  await runRequiredMutation('identity', 'b9be3f1d571c86a8c301ab08', { stage: 'primary-write-unconfirmed', userId: canonicalId }, () => tx.playerReport.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  await runRequiredMutation('identity', '2884925ed27b04a1814369fe', { stage: 'primary-write-unconfirmed', userId: canonicalId }, () => tx.staffApplication.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  await runRequiredMutation('identity', 'b36aec1c87bfb377816027e6', { stage: 'primary-write-unconfirmed', userId: canonicalId }, () => tx.ban.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  // bannedById and reversedById reference the ISSUER / REVERSER — re-point those too
  await runRequiredMutation('identity', '3a187e747928748c4088913a', { stage: 'primary-write-unconfirmed' }, () => tx.ban.updateMany({ where: { bannedById: placeholderId }, data: { bannedById: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  await runRequiredMutation('identity', 'c8f7087f45398d2633021bdc', { stage: 'primary-write-unconfirmed' }, () => tx.ban.updateMany({ where: { reversedById: placeholderId }, data: { reversedById: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  await runRequiredMutation('identity', 'd02572ec778de86c684b0f30', { stage: 'primary-write-unconfirmed' }, () => tx.report.updateMany({ where: { reporterUserId: placeholderId }, data: { reporterUserId: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  await runRequiredMutation('identity', 'dde99632407f78ab0bb61f49', { stage: 'primary-write-unconfirmed' }, () => tx.report.updateMany({ where: { targetUserId: placeholderId }, data: { targetUserId: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  await runRequiredMutation('identity', 'c234abbe688971232a23d7f9', { stage: 'primary-write-unconfirmed' }, () => tx.report.updateMany({ where: { resolvedBy: placeholderId }, data: { resolvedBy: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  // Party messages and ownership
  await runRequiredMutation('identity', 'c7624c3d457c111e0c4020c5', { stage: 'primary-write-unconfirmed', userId: canonicalId }, () => tx.partyMessage.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);
  await runRequiredMutation('identity', '99722485f1686039d5ac5311', { stage: 'primary-write-unconfirmed' }, () => tx.party.updateMany({ where: { ownerId: placeholderId }, data: { ownerId: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);

  // ── Collision-safe re-points (@@unique constraints) ───────────────────────

  // party_members @@unique([partyId, userId])
  // For each membership row owned by the placeholder, upsert under canonical
  // (skip if canonical is already a member of that party).
  const placeholderMemberships = await tx.partyMember.findMany({ where: { userId: placeholderId } });
  for (const pm of placeholderMemberships) {
    const existing = await tx.partyMember.findUnique({ where: { partyId_userId: { partyId: pm.partyId, userId: canonicalId } } });
    if (existing) {
      await runRequiredMutation('identity', '3d9f8fcb3ec17b199a41825c', { stage: 'primary-write-unconfirmed', rowId: pm.id }, () => tx.partyMember.delete({ where: { id: pm.id } }), isPrismaAtomicRefusal, tx, undefined);
    } else {
      await runRequiredMutation('identity', 'bf18d984c2aa96886c7f9294', { stage: 'primary-write-unconfirmed', rowId: pm.id, userId: canonicalId }, () => tx.partyMember.update({ where: { id: pm.id }, data: { userId: canonicalId } }), isPrismaAtomicRefusal, tx, undefined);
    }
  }

  // party_invites @@unique([partyId, inviteeId])
  const placeholderInviteesOf = await tx.partyInvite.findMany({ where: { inviteeId: placeholderId } });
  for (const pi of placeholderInviteesOf) {
    const existing = await tx.partyInvite.findUnique({ where: { partyId_inviteeId: { partyId: pi.partyId, inviteeId: canonicalId } } });
    if (existing) {
      await runRequiredMutation('identity', '5bcff5eea17c9264fbd8d80b', { stage: 'primary-write-unconfirmed', rowId: pi.id }, () => tx.partyInvite.delete({ where: { id: pi.id } }), isPrismaAtomicRefusal, tx, undefined);
    } else {
      await runRequiredMutation('identity', '2e28cea8bce5d681aefa0257', { stage: 'primary-write-unconfirmed', rowId: pi.id }, () => tx.partyInvite.update({ where: { id: pi.id }, data: { inviteeId: canonicalId } }), isPrismaAtomicRefusal, tx, undefined);
    }
  }
  await runRequiredMutation('identity', 'e5a72c69f51afe525cbb17ed', { stage: 'primary-write-unconfirmed' }, () => tx.partyInvite.updateMany({ where: { inviterId: placeholderId }, data: { inviterId: canonicalId } }), isPrismaAtomicRefusal, tx, isRowCountNoChange);

  // blocks @@unique([blockerId, blockedId])
  const placeholderBlocksMade = await tx.block.findMany({ where: { blockerId: placeholderId } });
  for (const b of placeholderBlocksMade) {
    const existing = await tx.block.findFirst({ where: { blockerId: canonicalId, blockedId: b.blockedId } });
    if (existing) {
      await runRequiredMutation('identity', '51a01c46cb0fb55cf268f5f2', { stage: 'primary-write-unconfirmed', rowId: b.id }, () => tx.block.delete({ where: { id: b.id } }), isPrismaAtomicRefusal, tx, undefined);
    } else {
      await runRequiredMutation('identity', 'a5befd931f099c0efdc1bc95', { stage: 'primary-write-unconfirmed', rowId: b.id }, () => tx.block.update({ where: { id: b.id }, data: { blockerId: canonicalId } }), isPrismaAtomicRefusal, tx, undefined);
    }
  }
  const placeholderBlocksAgainst = await tx.block.findMany({ where: { blockedId: placeholderId } });
  for (const b of placeholderBlocksAgainst) {
    const existing = await tx.block.findFirst({ where: { blockerId: b.blockerId, blockedId: canonicalId } });
    if (existing) {
      await runRequiredMutation('identity', '5d9aa3ffebc7c028c7bea25a', { stage: 'primary-write-unconfirmed', rowId: b.id }, () => tx.block.delete({ where: { id: b.id } }), isPrismaAtomicRefusal, tx, undefined);
    } else {
      await runRequiredMutation('identity', '333ca9731c2ae97ab87f5b46', { stage: 'primary-write-unconfirmed', rowId: b.id }, () => tx.block.update({ where: { id: b.id }, data: { blockedId: canonicalId } }), isPrismaAtomicRefusal, tx, undefined);
    }
  }

  // user_aliases @@unique([userId, alias])
  const placeholderAliases = await tx.userAlias.findMany({ where: { userId: placeholderId } });
  for (const a of placeholderAliases) {
    const existingAlias = await tx.userAlias.findUnique({ where: { userId_alias: { userId: canonicalId, alias: a.alias } } });
    if (existingAlias) {
      await runRequiredMutation('identity', '02a7b48411063586bfa88e92', { stage: 'primary-write-unconfirmed', rowId: a.id }, () => tx.userAlias.delete({ where: { id: a.id } }), isPrismaAtomicRefusal, tx, undefined);
    } else {
      await runRequiredMutation('identity', '3abc2803fb763a63a7f6dca6', { stage: 'primary-write-unconfirmed', rowId: a.id, userId: canonicalId }, () => tx.userAlias.update({ where: { id: a.id }, data: { userId: canonicalId } }), isPrismaAtomicRefusal, tx, undefined);
    }
  }

  // ── Finally delete the placeholder ───────────────────────────────────────
  await runRequiredMutation('identity', '599a510c2ba262d6af4c4197', { stage: 'primary-write-unconfirmed', rowId: placeholderId }, () => tx.user.delete({ where: { id: placeholderId } }), isPrismaAtomicRefusal, tx, undefined);

  });
}
