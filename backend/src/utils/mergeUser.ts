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
  if (canonicalId === placeholderId) return;

  // ── Simple re-point tables (no unique collision possible) ────────────────
  await tx.message.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } });
await tx.session.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } });
  await tx.auditLog.updateMany({ where: { actorId: placeholderId }, data: { actorId: canonicalId } });
  await tx.playerReport.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } });
  await tx.staffApplication.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } });
  await tx.ban.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } });
  // bannedById and reversedById reference the ISSUER / REVERSER — re-point those too
  await tx.ban.updateMany({ where: { bannedById: placeholderId }, data: { bannedById: canonicalId } });
  await tx.ban.updateMany({ where: { reversedById: placeholderId }, data: { reversedById: canonicalId } });
  await tx.report.updateMany({ where: { reporterUserId: placeholderId }, data: { reporterUserId: canonicalId } });
  await tx.report.updateMany({ where: { targetUserId: placeholderId }, data: { targetUserId: canonicalId } });
  await tx.report.updateMany({ where: { resolvedBy: placeholderId }, data: { resolvedBy: canonicalId } });
  // Party messages and ownership
  await tx.partyMessage.updateMany({ where: { userId: placeholderId }, data: { userId: canonicalId } });
  await tx.party.updateMany({ where: { ownerId: placeholderId }, data: { ownerId: canonicalId } });

  // ── Collision-safe re-points (@@unique constraints) ───────────────────────

  // party_members @@unique([partyId, userId])
  // For each membership row owned by the placeholder, upsert under canonical
  // (skip if canonical is already a member of that party).
  const placeholderMemberships = await tx.partyMember.findMany({ where: { userId: placeholderId } });
  for (const pm of placeholderMemberships) {
    const existing = await tx.partyMember.findUnique({ where: { partyId_userId: { partyId: pm.partyId, userId: canonicalId } } });
    if (existing) {
      await tx.partyMember.delete({ where: { id: pm.id } });
    } else {
      await tx.partyMember.update({ where: { id: pm.id }, data: { userId: canonicalId } });
    }
  }

  // party_invites @@unique([partyId, inviteeId])
  const placeholderInviteesOf = await tx.partyInvite.findMany({ where: { inviteeId: placeholderId } });
  for (const pi of placeholderInviteesOf) {
    const existing = await tx.partyInvite.findUnique({ where: { partyId_inviteeId: { partyId: pi.partyId, inviteeId: canonicalId } } });
    if (existing) {
      await tx.partyInvite.delete({ where: { id: pi.id } });
    } else {
      await tx.partyInvite.update({ where: { id: pi.id }, data: { inviteeId: canonicalId } });
    }
  }
  await tx.partyInvite.updateMany({ where: { inviterId: placeholderId }, data: { inviterId: canonicalId } });

  // blocks @@unique([blockerId, blockedId])
  const placeholderBlocksMade = await tx.block.findMany({ where: { blockerId: placeholderId } });
  for (const b of placeholderBlocksMade) {
    const existing = await tx.block.findFirst({ where: { blockerId: canonicalId, blockedId: b.blockedId } });
    if (existing) {
      await tx.block.delete({ where: { id: b.id } });
    } else {
      await tx.block.update({ where: { id: b.id }, data: { blockerId: canonicalId } });
    }
  }
  const placeholderBlocksAgainst = await tx.block.findMany({ where: { blockedId: placeholderId } });
  for (const b of placeholderBlocksAgainst) {
    const existing = await tx.block.findFirst({ where: { blockerId: b.blockerId, blockedId: canonicalId } });
    if (existing) {
      await tx.block.delete({ where: { id: b.id } });
    } else {
      await tx.block.update({ where: { id: b.id }, data: { blockedId: canonicalId } });
    }
  }

  // user_aliases @@unique([userId, alias])
  const placeholderAliases = await tx.userAlias.findMany({ where: { userId: placeholderId } });
  for (const a of placeholderAliases) {
    const existingAlias = await tx.userAlias.findUnique({ where: { userId_alias: { userId: canonicalId, alias: a.alias } } });
    if (existingAlias) {
      await tx.userAlias.delete({ where: { id: a.id } });
    } else {
      await tx.userAlias.update({ where: { id: a.id }, data: { userId: canonicalId } });
    }
  }

  // ── Finally delete the placeholder ───────────────────────────────────────
  await tx.user.delete({ where: { id: placeholderId } });
}
