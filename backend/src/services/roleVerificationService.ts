import { discardRuntimeResponse } from '../runtime/nativeFetch';
import { isPrismaAtomicRefusal, isRowCountNoChange, runRequiredBundle, runRequiredMutation } from '../lib/requiredEffects';
import { cancelProducerTimer, runtime, producerInterval, producerTimeout } from '../runtime';
import env from '../config/environment';
import { shouldSkipRoleVerification } from '../utils/roleVerificationSkip';
import { shouldRevokeOnMemberFetchStatus } from '../utils/memberFetchRevoke';
import prisma from '../config/prisma';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';

const VERIFICATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REDIS_ROLE_TTL = 300; // 5 minutes in seconds
let intervalHandle: ReturnType<typeof setInterval> | null = null;

function recordRoleEffect(discordId: string, stage: string): void {
  runtime.recordFailure('role-verification:effect', new Error('Required admin authorization effect was not confirmed'),
    { discordId, stage });
}

/**
 * Derive the admin role label from the Discord role IDs the user holds.
 * Returns the highest-privilege match: owner > admin > moderator.
 */
function resolveRole(discordRoles: string[]): string | null {
  if (env.OWNER_ROLE_ID && discordRoles.includes(env.OWNER_ROLE_ID)) return 'owner';
  if (env.ADMIN_ROLE_ID && discordRoles.includes(env.ADMIN_ROLE_ID)) return 'admin';
  if (env.MODERATOR_ROLE_ID && discordRoles.includes(env.MODERATOR_ROLE_ID)) return 'moderator';
  return null;
}

/**
 * Check Redis cache for a verified role.
 * Returns the cached role string, or null if not cached.
 */
async function getCachedRole(discordId: string): Promise<string | null> {
  try {
    const redis = await getRedisClient();
    return await redis.get(`role:verified:${discordId}`);
  } catch {
    return null;
  }
}

/**
 * Cache a verified role in Redis with 5-minute TTL.
 */
async function cacheRole(discordId: string, role: string): Promise<void> {
  return runRequiredBundle('authority', 'roleVerificationService:476fc1b75fcb', async () => {
  try {
    const redis = await getRedisClient();
    await runRequiredMutation('authority', 'a37aabcf2ccdea5b85be5430', { stage: 'primary-write-unconfirmed' }, () => redis.set(`role:verified:${discordId}`, role, { EX: REDIS_ROLE_TTL }), undefined, undefined, undefined);
  } catch (err) {
    recordRoleEffect(discordId, 'role-cache-set-unconfirmed');
    logger.warn({ err, discordId }, 'Failed to cache verified role (non-fatal)');
  }

  });
}

/**
 * Destroy all Express sessions for a given Discord user ID.
 * Express-session stores are keyed by session ID in Redis with prefix "sess:".
 * We scan for sessions containing the discord user ID and delete them.
 */
async function destroyAdminSessions(discordId: string): Promise<void> {
  return runRequiredBundle('authority', 'roleVerificationService:d47c8005c60f', async () => {
  let stage = 'session-enumeration-incomplete';
  try {
    const redis = await getRedisClient();
    // Scan for session keys -- connect-redis uses prefix "sess:"
    // node-redis v5+ uses STRING cursors for SCAN (both the argument and the
    // returned `cursor`). Start at '0' and terminate on '0' — a numeric cursor
    // would both mistype redis.scan() and make `cursor !== 0` loop forever.
    let cursor = '0';
    const toDelete: string[] = [];
    do {
      const result = await redis.scan(cursor, { MATCH: 'sess:*', COUNT: 100 });
      cursor = result.cursor;
      for (const key of result.keys) {
        let data: string | null;
        try { data = await redis.get(key); }
        catch { recordRoleEffect(discordId, 'session-enumeration-incomplete'); continue; }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed?.discordUser?.id === discordId) toDelete.push(key);
        } catch { /* unrelated malformed session JSON is not a confirmed grant */ }
      }
    } while (cursor !== '0');

    if (toDelete.length > 0) {
      stage = 'session-delete-unconfirmed';
      await runRequiredMutation('authority', 'dee7fedd514679c921c33f0a', { stage: 'primary-write-unconfirmed' }, () => redis.del(toDelete), undefined, undefined, isRowCountNoChange);
      logger.info({ discordId, sessionsDestroyed: toDelete.length }, 'Destroyed admin sessions after role revocation');
    }
  } catch (err) {
    recordRoleEffect(discordId, stage);
    logger.warn({ err, discordId }, 'Failed to destroy admin sessions (non-fatal)');
  }

  });
}

/**
 * Clear the Redis role cache for a given Discord user ID.
 */
async function clearCachedRole(discordId: string): Promise<void> {
  return runRequiredBundle('authority', 'roleVerificationService:8047ffb5f5a3', async () => {
  try {
    const redis = await getRedisClient();
    await runRequiredMutation('authority', '1f6f10ed53c4a120f2929ffd', { stage: 'primary-write-unconfirmed' }, () => redis.del(`role:verified:${discordId}`), undefined, undefined, isRowCountNoChange);
  } catch { recordRoleEffect(discordId, 'role-cache-delete-unconfirmed'); }

  });
}

/**
 * Verify a single admin user still has a qualifying Discord role.
 * Uses the Discord bot token (not user OAuth token) to check guild membership.
 * Returns true if the user is still valid, false if revoked.
 */
async function verifyAdminUser(adminUser: { discord_id: string; role: string; username: string }): Promise<boolean> {
  return runRequiredBundle('authority', 'roleVerificationService:50286129c1bd', async () => {
  let stage = 'member-role-read';
  try {
    const memberRes = await fetch(
      `https://discord.com/api/v10/guilds/${env.DISCORD_SERVER_ID}/members/${adminUser.discord_id}`,
      { headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` } }
    );

    if (!memberRes.ok) {
      await discardRuntimeResponse(memberRes);
      if (shouldRevokeOnMemberFetchStatus(memberRes.status)) {
        // 404 — the member is genuinely gone from the guild; safe to revoke.
        logger.info({ discordId: adminUser.discord_id }, 'Admin user no longer in guild (404) -- revoking');
        return false;
      }
      // 429 / 5xx / 401 / 403 etc. are transient or bot-side, NOT a reliable
      // signal the user lost their role. Revoking on these previously wiped valid
      // moderators/admins during a Discord blip. Keep the row, retry next cycle.
      logger.warn({ discordId: adminUser.discord_id, status: memberRes.status }, 'Role verification got non-OK status (transient) -- skipping, will retry next cycle');
      return true;
    }

    const member = await memberRes.json() as { roles?: string[] };
    const userRoles = member.roles || [];
    const role = resolveRole(userRoles);

    if (!role) {
      // No qualifying role -- revoke
      logger.info({ discordId: adminUser.discord_id }, 'Admin user lost qualifying Discord role -- revoking');
      return false;
    }

    // Update role if it changed (e.g. promoted from moderator to admin)
    if (role !== adminUser.role) {
      stage = 'admin-role-update-unconfirmed';
      await runRequiredMutation('authority', 'fcfa5efd710a838f368f3f0e', { stage: 'primary-write-unconfirmed', discordId: adminUser.discord_id }, () => prisma.adminUser.update({
        where: { discordId: adminUser.discord_id },
        data: { role },
      }), isPrismaAtomicRefusal, undefined, undefined);
      logger.info({ discordId: adminUser.discord_id, oldRole: adminUser.role, newRole: role }, 'Admin user role updated');
    }

    // Cache the verified role
    stage = 'role-cache-set-unconfirmed';
    await cacheRole(adminUser.discord_id, role);
    return true;
  } catch (err) {
    // Only a failed member read is an optional fetch fallback. Once trusted
    // roles are observed, a failed mutation must survive the availability path.
    if (stage !== 'member-role-read') recordRoleEffect(adminUser.discord_id, stage);
    logger.warn({ err, discordId: adminUser.discord_id, stage }, 'Role verification incomplete -- retry next cycle');
    return true;
  }

  });
}

/**
 * Run a full verification cycle for all admin users.
 * Rate-limited: 1 request per admin user, spaced by 1 second to respect Discord limits.
 */
async function runVerificationCycle(): Promise<void> {
  return runRequiredBundle('authority', 'roleVerificationService:15dffdb3df6a', async () => {
  if (!env.DISCORD_TOKEN || !env.DISCORD_SERVER_ID) {
    return; // Can't verify without bot token and server ID
  }

  try {
    const adminUsers = await prisma.adminUser.findMany({
      select: { id: true, discordId: true, username: true, role: true },
    });

    if (adminUsers.length === 0) return;

    const devLoginEnabled = env.NODE_ENV === 'development' && !!env.ENABLE_DEV_LOGIN;
    logger.debug({ count: adminUsers.length }, 'Starting role verification cycle');

    for (let i = 0; i < adminUsers.length; i++) {
      const au = adminUsers[i];
      if (shouldSkipRoleVerification(au.discordId, { devLoginEnabled })) {
        continue; // synthetic dev-login persona — never guild-verifiable
      }
      const isValid = await verifyAdminUser({ discord_id: au.discordId, role: au.role, username: au.username });

      if (!isValid) {
        // Revoke: delete from admin_users, destroy sessions, clear cache
        try { await runRequiredMutation('authority', '57f289f0d747d27b0e7dd8b6', { stage: 'primary-write-unconfirmed', discordId: au.discordId }, () => prisma.adminUser.delete({ where: { discordId: au.discordId } }), isPrismaAtomicRefusal, undefined, undefined); }
        catch (err) { recordRoleEffect(au.discordId, 'admin-delete-unconfirmed'); throw err; }
        await destroyAdminSessions(au.discordId);
        await clearCachedRole(au.discordId);

        // Audit log (actor is system)
        await runRequiredMutation('audit', 'fac31980e48fcbb501a86297', { stage: 'primary-write-unconfirmed' }, () => prisma.auditLog.create({
          data: {
            action: 'admin_role_revoked',
            targetType: 'admin_user',
            reason: 'Discord role verification failed',
            metadata: { discordId: au.discordId, username: au.username, previousRole: au.role },
          },
        }), undefined, undefined, undefined).catch(() => { recordRoleEffect(au.discordId, 'revocation-audit-unconfirmed'); });
      }

      // Rate limit: wait 1 second between Discord API calls (except after the last one)
      if (i < adminUsers.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } catch (err) {
    runtime.recordFailure('role-verification:cycle', new Error('Role verification cycle was incomplete'), { stage: 'cycle-incomplete' });
    logger.warn({ err }, 'Role verification cycle failed (non-fatal)');
  }

  });
}

/**
 * Start the background role verification interval.
 * Safe to call multiple times -- subsequent calls are no-ops.
 */
function start(): void {
  if (intervalHandle) return;

  if (!env.DISCORD_TOKEN || !env.DISCORD_SERVER_ID) {
    logger.warn('Role verification disabled -- DISCORD_TOKEN or DISCORD_SERVER_ID not set');
    return;
  }

  // Run first cycle after a short delay (30s) to let startup complete
  producerTimeout('role-first-verification', () => {
    runVerificationCycle().catch((err) =>
      logger.warn({ err }, 'Initial role verification cycle failed (non-fatal)')
    );
  }, 30_000);

  intervalHandle = producerInterval('role-verification', () => {
    runVerificationCycle().catch((err) =>
      logger.warn({ err }, 'Role verification cycle failed (non-fatal)')
    );
  }, VERIFICATION_INTERVAL_MS);

  logger.info({ intervalMs: VERIFICATION_INTERVAL_MS }, 'Background role verification started');
}

/**
 * Stop the background role verification interval.
 */
function stop(): void {
  if (intervalHandle) {
    cancelProducerTimer(intervalHandle);
    intervalHandle = null;
  }
}

export { start, stop, resolveRole, getCachedRole, cacheRole, runVerificationCycle, destroyAdminSessions };
module.exports = { start, stop, resolveRole, getCachedRole, cacheRole, runVerificationCycle, destroyAdminSessions };
