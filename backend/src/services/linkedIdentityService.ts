import prisma from '../config/prisma';
import logger from '../config/logger';

/** Check if a provider identity is on the deny-list. */
export async function isBannedIdentity(provider: string, providerUid: string): Promise<boolean> {
  const row = await prisma.bannedIdentity.findUnique({
    where: { provider_providerUid: { provider, providerUid } },
  });
  return row !== null;
}

/** Check whether a user has at least one linked provider (Discord inline or linked_identities row). */
export async function hasLinkedProvider(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { discordId: true },
  });
  if (user?.discordId) return true;

  const identity = await prisma.linkedIdentity.findFirst({
    where: { userId },
  });
  return identity !== null;
}

/** Link a Nexus (or other) provider identity to a user account. Upserts on (userId, provider). */
export async function linkProviderIdentity(opts: {
  userId: string;
  provider: string;
  providerUid: string;
  username?: string;
}): Promise<void> {
  await prisma.linkedIdentity.upsert({
    where: { userId_provider: { userId: opts.userId, provider: opts.provider } },
    update: {
      providerUid: opts.providerUid,
      username: opts.username ?? null,
      lastVerified: new Date(),
    },
    create: {
      userId: opts.userId,
      provider: opts.provider,
      providerUid: opts.providerUid,
      username: opts.username ?? null,
    },
  });
  logger.info({ userId: opts.userId, provider: opts.provider }, 'Provider identity linked');
}

/** Unlink a provider identity from a user. Refuses if it would leave the user with no providers. */
export async function unlinkProviderIdentity(
  userId: string,
  provider: string,
): Promise<{ ok: true } | { ok: false; reason: 'last_provider' | 'not_found' }> {
  const hasProvider = await hasLinkedProvider(userId);
  if (!hasProvider) return { ok: false, reason: 'not_found' };

  // Count remaining providers after removal
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { discordId: true } });
  const otherIdentities = await prisma.linkedIdentity.count({
    where: { userId, provider: { not: provider } },
  });

  const remainingAfterRemoval = (user?.discordId ? 1 : 0) + otherIdentities;
  if (remainingAfterRemoval < 1) return { ok: false, reason: 'last_provider' };

  const deleted = await prisma.linkedIdentity.deleteMany({
    where: { userId, provider },
  });

  if (deleted.count === 0) return { ok: false, reason: 'not_found' };
  return { ok: true };
}

/** Get all linked identities for a user (does not include inline Discord). */
export async function getLinkedIdentities(userId: string) {
  return prisma.linkedIdentity.findMany({
    where: { userId },
    select: {
      provider: true,
      providerUid: true,
      username: true,
      linkedAt: true,
      lastVerified: true,
    },
    orderBy: { linkedAt: 'asc' },
  });
}
