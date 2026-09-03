/**
 * Supporter entitlement service — the paid cosmetics tier (epic #223).
 *
 * ENTITLEMENT vs PRIVILEGES (issue #230's hard rule):
 *   - The `supporter_entitlements` row is the ENTITLEMENT. It survives the user
 *     leaving the Discord — they keep what they paid for.
 *   - PRIVILEGES follow the live Discord role. supporterSyncService flips `status`
 *     to 'lapsed' when the role disappears (cancelled, or left the guild), so
 *     cosmetics revert to default; re-adding the role restores them with no
 *     re-purchase.
 * Because the sync service keeps `status` in lockstep with the role, `status ===
 * 'active'` IS the "currently holds the role" signal, and nothing on the hot path
 * ever has to call the Discord API.
 *
 * Deliberately NOT stored in admin_users: that table is reserved for elevated staff
 * identities, and isPrivilegedRole() must keep returning false for supporters.
 * SupporterTier is orthogonal to EffectiveRole.
 * When enabled, ADMIN_ROLE_ID is resolved as the Overseer cosmetics tier; that
 * bypass is still kept on this entitlement path so all surfaces share one source
 * of truth, without changing the user's EffectiveRole.
 */
import prisma from '../config/prisma';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';
import env from '../config/environment';
import {
  SupporterTier,
  EntitlementStatus,
  resolveSupporterTier,
  isSupporterBenefitsAdminRole,
  normalizeTier,
  privilegesActive,
} from '../utils/supporterTier';

/** Matches the `role:verified:<discordId>` TTL so both caches age out together. */
const REDIS_TIER_TTL = 300; // 5 minutes
const tierKey = (discordId: string) => `supporter:tier:${discordId}`;

export type EntitlementSource = 'discord_sub' | 'patreon' | 'stripe' | 'manual';

export interface SupporterStatus {
  /** Tier whose privileges are currently ACTIVE ('none' when suspended). */
  tier: SupporterTier;
  /** Tier the user is entitled to, even if privileges are suspended. */
  entitledTier: SupporterTier;
  /** False when an entitlement exists but the Discord role is currently absent. */
  privilegesActive: boolean;
  /** True when any entitlement row exists (active, lapsed or cancelled). */
  hasEntitlement: boolean;
  status: EntitlementStatus | null;
  source: EntitlementSource | null;
  /** True when owner/admin staff access is granting the tier without payment. */
  isAdminBypass: boolean;
}

const NO_ENTITLEMENT: SupporterStatus = {
  tier: 'none',
  entitledTier: 'none',
  privilegesActive: false,
  hasEntitlement: false,
  status: null,
  source: null,
  isAdminBypass: false,
};

const ADMIN_BYPASS_STATUS: SupporterStatus = {
  tier: 'overseer',
  entitledTier: 'overseer',
  privilegesActive: true,
  hasEntitlement: false,
  status: null,
  source: null,
  isAdminBypass: true,
};

/** Re-export so callers need only one import. */
export { resolveSupporterTier };

/** Role IDs from config, in the shape the pure resolver expects. */
export function tierRoleIds() {
  return {
    supporterRoleId: env.SUPPORTER_ROLE_ID,
    overseerCircleRoleId: env.OVERSEER_CIRCLE_ROLE_ID,
    adminRoleId: env.ADMIN_ROLE_ID,
  };
}

/** Resolve the tier a member's live Discord roles grant. */
export function tierFromDiscordRoles(discordRoles: readonly string[] | null | undefined): SupporterTier {
  return resolveSupporterTier(discordRoles, tierRoleIds());
}

// ── Cache ─────────────────────────────────────────────────────────────────────

async function getCachedStatus(discordId: string): Promise<SupporterStatus | null> {
  try {
    const redis = await getRedisClient();
    const raw = await redis.get(tierKey(discordId));
    return raw ? (JSON.parse(raw) as SupporterStatus) : null;
  } catch {
    // Cache is an optimization, never a source of truth — fall through to the DB.
    return null;
  }
}

async function cacheStatus(discordId: string, status: SupporterStatus): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.set(tierKey(discordId), JSON.stringify(status), { EX: REDIS_TIER_TTL });
  } catch (err) {
    logger.warn({ err, discordId }, '[supporter] failed to cache tier (non-fatal)');
  }
}

/**
 * Synthetic Dev personas do not hold a real Discord role ID. Their already
 * authenticated `admin_users.role` is still an authoritative staff identity,
 * so resolve it as the same cosmetics-only Overseer bypass as ADMIN_ROLE_ID.
 */
async function hasAdminCosmeticsBypass(discordId: string): Promise<boolean> {
  try {
    const admin = await prisma.adminUser.findUnique({ where: { discordId }, select: { role: true } });
    return isSupporterBenefitsAdminRole(admin?.role);
  } catch (err) {
    logger.warn({ err, discordId }, '[supporter] admin cosmetics bypass lookup failed (non-fatal)');
    return false;
  }
}

/** Drop the cached tier so the next read reflects a just-applied change. */
export async function bustTierCache(discordId: string): Promise<void> {
  if (!discordId) return;
  try {
    const redis = await getRedisClient();
    await redis.del(tierKey(discordId));
  } catch (err) {
    logger.warn({ err, discordId }, '[supporter] failed to bust tier cache (non-fatal)');
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Full supporter status for a Discord account. Redis-cached (5 min).
 * Fails safe to "no entitlement" on any error — a paid feature must never be
 * granted because a lookup broke.
 */
export async function getSupporterStatus(discordId: string | null | undefined): Promise<SupporterStatus> {
  if (!discordId) return NO_ENTITLEMENT;

  // Check the staff identity before the tier cache. This keeps a newly-created
  // synthetic System Admin session from being stuck behind a cached "none" tier.
  const [cached, adminBypass] = await Promise.all([
    getCachedStatus(discordId),
    hasAdminCosmeticsBypass(discordId),
  ]);
  if (adminBypass) {
    await cacheStatus(discordId, ADMIN_BYPASS_STATUS);
    return ADMIN_BYPASS_STATUS;
  }
  if (cached) return cached;

  try {
    const row = await prisma.supporterEntitlement.findUnique({
      where: { discordId },
      select: { tier: true, status: true, source: true },
    });

    let status: SupporterStatus;
    if (!row) {
      status = NO_ENTITLEMENT;
    } else {
      const entitledTier = normalizeTier(row.tier);
      const active = privilegesActive(row.status);
      status = {
        tier: active ? entitledTier : 'none',
        entitledTier,
        privilegesActive: active,
        hasEntitlement: true,
        status: row.status as EntitlementStatus,
        source: row.source as EntitlementSource,
        isAdminBypass: false,
      };
    }

    await cacheStatus(discordId, status);
    return status;
  } catch (err) {
    logger.warn({ err, discordId }, '[supporter] status lookup failed — defaulting to none');
    return NO_ENTITLEMENT;
  }
}

/** Convenience: the tier whose privileges are currently active. */
export async function getSupporterTier(discordId: string | null | undefined): Promise<SupporterTier> {
  return (await getSupporterStatus(discordId)).tier;
}

/** Same, by internal user id. Returns 'none' for users with no linked Discord. */
export async function getSupporterTierByUserId(userId: string): Promise<SupporterTier> {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { discordId: true } });
    if (!u?.discordId) return 'none';
    return await getSupporterTier(u.discordId);
  } catch (err) {
    logger.warn({ err, userId }, '[supporter] tier-by-user lookup failed — defaulting to none');
    return 'none';
  }
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Non-fatal audit write — never let logging break an entitlement transition.
 * Metadata is constrained to JSON scalars so it satisfies Prisma's InputJsonValue
 * (a bare Record<string, unknown> is too wide for the generated type).
 */
type AuditMetadata = Record<string, string | number | boolean | null>;

function audit(action: string, discordId: string, metadata: AuditMetadata): void {
  prisma.auditLog
    .create({ data: { action, targetType: 'supporter_entitlement', reason: discordId, metadata } })
    .catch((err: unknown) => logger.warn({ err, discordId, action }, '[supporter] audit write failed'));
}

/**
 * Grant or upgrade an entitlement. Idempotent — safe to call on every reconcile
 * pass. Re-activates a previously lapsed row rather than creating a duplicate,
 * which is what makes "leave the Discord, come back later" work.
 */
export async function grantEntitlement(opts: {
  discordId: string;
  tier: SupporterTier;
  source?: EntitlementSource;
  externalId?: string | null;
  notes?: string | null;
  /** Internal optimization for frequent authoritative Discord role checks. */
  skipUnchanged?: boolean;
}): Promise<boolean> {
  const tier = normalizeTier(opts.tier);
  if (tier === 'none') return lapseEntitlement({ discordId: opts.discordId, reason: 'tier resolved to none' });

  const source = opts.source ?? 'discord_sub';
  const now = new Date();

  const existing = await prisma.supporterEntitlement.findUnique({
    where: { discordId: opts.discordId },
    select: { tier: true, status: true },
  });

  if (
    opts.skipUnchanged &&
    existing &&
    normalizeTier(existing.tier) === tier &&
    existing.status === 'active'
  ) {
    return false;
  }

  await prisma.supporterEntitlement.upsert({
    where: { discordId: opts.discordId },
    create: {
      discordId: opts.discordId,
      tier,
      source,
      externalId: opts.externalId ?? null,
      status: 'active',
      grantedAt: now,
      lastVerifiedAt: now,
      notes: opts.notes ?? null,
    },
    update: {
      tier,
      source,
      status: 'active',
      lastVerifiedAt: now,
      ...(opts.externalId !== undefined ? { externalId: opts.externalId } : {}),
      ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
    },
  });

  await bustTierCache(opts.discordId);

  // Only audit real transitions — the reconcile job re-confirms every active row on
  // each pass, and logging those would bury the meaningful events.
  const changed = !existing || existing.tier !== tier || existing.status !== 'active';
  if (changed) {
    audit('supporter_entitlement_granted', opts.discordId, {
      tier, source, previousTier: existing?.tier ?? null, previousStatus: existing?.status ?? null,
    });
    logger.info({ discordId: opts.discordId, tier, source }, '[supporter] entitlement granted');
  }
  return changed;
}

/**
 * Suspend privileges while RETAINING the entitlement (the #230 rule). Called when
 * the Discord role disappears — cancellation, or simply leaving the guild.
 */
export async function lapseEntitlement(opts: {
  discordId: string;
  reason?: string;
  /** 'cancelled' marks a deliberate end; default 'lapsed' is recoverable. */
  status?: Extract<EntitlementStatus, 'lapsed' | 'cancelled'>;
}): Promise<boolean> {
  const nextStatus = opts.status ?? 'lapsed';
  const existing = await prisma.supporterEntitlement.findUnique({
    where: { discordId: opts.discordId },
    select: { tier: true, status: true },
  });
  if (!existing) return false;
  if (existing.status === nextStatus) return false;

  await prisma.supporterEntitlement.update({
    where: { discordId: opts.discordId },
    data: { status: nextStatus, lastVerifiedAt: new Date() },
  });

  await bustTierCache(opts.discordId);

  audit('supporter_entitlement_lapsed', opts.discordId, {
    tier: existing.tier, previousStatus: existing.status, newStatus: nextStatus, reason: opts.reason ?? null,
  });
  logger.info(
    { discordId: opts.discordId, tier: existing.tier, status: nextStatus, reason: opts.reason },
    '[supporter] entitlement privileges suspended (entitlement retained)',
  );
  return true;
}

export interface DiscordRoleSyncResult {
  tier: SupporterTier;
  changed: boolean;
}

export interface DiscordRoleSyncOptions {
  /**
   * Skip the idempotent write when the effective Discord tier is unchanged.
   * The HUD send refresh uses this because it may run once per minute; periodic
   * reconcile keeps the default write/timestamp behavior for its audit trail.
   */
  skipUnchanged?: boolean;
}

/**
 * Reconcile a member's Discord roles and report whether the effective entitlement
 * changed. Consumers that update downstream presentation should use this variant so
 * a 15-minute reconcile does not make needless Discord nickname API calls.
 */
export async function syncFromDiscordRolesWithResult(
  discordId: string,
  discordRoles: readonly string[] | null | undefined,
  source: EntitlementSource = 'discord_sub',
  options: DiscordRoleSyncOptions = {},
): Promise<DiscordRoleSyncResult> {
  const tier = tierFromDiscordRoles(discordRoles);
  const changed = tier === 'none'
    ? await lapseEntitlement({ discordId, reason: 'tier role no longer held' })
    : await grantEntitlement({
      discordId,
      tier,
      source,
      // `grantEntitlement` is deliberately kept as the single write funnel;
      // this flag lets high-frequency role checks avoid an unchanged upsert.
      ...(options.skipUnchanged ? { skipUnchanged: true } : {}),
    });
  return { tier, changed };
}

/**
 * Reconcile one member against their live Discord roles. The single funnel used by
 * both the GuildMemberUpdate listener and the periodic reconcile job, so the two
 * paths cannot diverge. Returns the tier now in effect.
 */
export async function syncFromDiscordRoles(
  discordId: string,
  discordRoles: readonly string[] | null | undefined,
  source: EntitlementSource = 'discord_sub',
): Promise<SupporterTier> {
  return (await syncFromDiscordRolesWithResult(discordId, discordRoles, source)).tier;
}

export default {
  getSupporterStatus,
  getSupporterTier,
  getSupporterTierByUserId,
  grantEntitlement,
  lapseEntitlement,
  syncFromDiscordRoles,
  syncFromDiscordRolesWithResult,
  bustTierCache,
  tierFromDiscordRoles,
  tierRoleIds,
  resolveSupporterTier,
};
module.exports = {
  getSupporterStatus,
  getSupporterTier,
  getSupporterTierByUserId,
  grantEntitlement,
  lapseEntitlement,
  syncFromDiscordRoles,
  syncFromDiscordRolesWithResult,
  bustTierCache,
  tierFromDiscordRoles,
  tierRoleIds,
  resolveSupporterTier,
};
module.exports.default = module.exports;
