import { isPrismaAtomicRefusal, isRowCountNoChange, runRequiredBundle, runRequiredMutation } from '../lib/requiredEffects';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { isValidSteamId } from './steamAuthService';

/** Check if a provider identity is on the deny-list. */
export async function isBannedIdentity(provider: string, providerUid: string): Promise<boolean> {
  const row = await prisma.bannedIdentity.findUnique({
    where: { provider_providerUid: { provider, providerUid } },
  });
  return row !== null;
}

/** Check whether a user has at least one linked provider (Discord/Steam inline or linked_identities row). */
export async function hasLinkedProvider(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { discordId: true, steamId: true },
  });
  if (user?.discordId || isValidSteamId(user?.steamId)) return true;

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
  return runRequiredBundle('identity', 'linkedIdentityService:751b0628f35a', async () => {
  await runRequiredMutation('identity', 'c1a4b2b7513da040805c9df2', { stage: 'primary-write-unconfirmed', userId: opts.userId }, () => prisma.linkedIdentity.upsert({
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
  }), isPrismaAtomicRefusal, undefined, undefined);
  logger.info({ userId: opts.userId, provider: opts.provider }, 'Provider identity linked');

  });
}

/** Unlink a provider identity from a user. Refuses if it would leave the user with no providers. */
export async function unlinkProviderIdentity(
  userId: string,
  provider: string,
): Promise<{ ok: true } | { ok: false; reason: 'last_provider' | 'not_found' }> {
  return runRequiredBundle('identity', 'linkedIdentityService:b2b8036c6232', async () => {
  const hasProvider = await hasLinkedProvider(userId);
  if (!hasProvider) return { ok: false, reason: 'not_found' };

  // Count remaining providers after removal
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { discordId: true, steamId: true } });
  const otherIdentities = await prisma.linkedIdentity.count({
    where: { userId, provider: { not: provider } },
  });

  const remainingAfterRemoval = (user?.discordId ? 1 : 0) + (isValidSteamId(user?.steamId) ? 1 : 0) + otherIdentities;
  if (remainingAfterRemoval < 1) return { ok: false, reason: 'last_provider' };

  const deleted = await runRequiredMutation('identity', '65a71f825c956eb57c2bccd9', { stage: 'primary-write-unconfirmed', userId: userId }, () => prisma.linkedIdentity.deleteMany({
    where: { userId, provider },
  }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);

  if (deleted.count === 0) return { ok: false, reason: 'not_found' };
  return { ok: true };

  });
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
