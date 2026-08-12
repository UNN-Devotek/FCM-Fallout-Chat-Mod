/**
 * Pure supporter-tier logic — no Prisma, no Redis, no Discord.
 *
 * Extracted so the tier rules can be unit-tested directly (node:test via
 * src/testRunner.ts), the same way memberFetchRevoke.ts / roleVerificationSkip.ts
 * isolate the fail-safe decisions in roleVerificationService.
 *
 * IMPORTANT: SupporterTier is an axis ORTHOGONAL to EffectiveRole
 * (userRoleService.ts). A supporter is a paying customer, not a moderator —
 * isPrivilegedRole() must keep returning false for them. Never merge these two.
 */

export type SupporterTier = 'none' | 'supporter' | 'overseer';

/** Ordered lowest → highest. Index position is the comparison key. */
export const TIER_ORDER: readonly SupporterTier[] = ['none', 'supporter', 'overseer'] as const;

export const PAID_TIERS: readonly SupporterTier[] = ['supporter', 'overseer'] as const;

/** Entitlement row lifecycle. Lapsed rows are retained so privileges can restore. */
export type EntitlementStatus = 'active' | 'lapsed' | 'cancelled';

export interface TierRoleIds {
  supporterRoleId: string | undefined | null;
  overseerCircleRoleId: string | undefined | null;
}

/**
 * Derive the tier from the Discord role IDs a member currently holds.
 *
 * Highest match wins (overseer > supporter), mirroring resolveRole()'s
 * first-match-wins shape in roleVerificationService. An unset/empty role ID is
 * skipped rather than matched, so a half-configured environment degrades to 'none'
 * instead of granting the tier to everyone.
 */
export function resolveSupporterTier(
  discordRoles: readonly string[] | undefined | null,
  roleIds: TierRoleIds,
): SupporterTier {
  if (!Array.isArray(discordRoles) || discordRoles.length === 0) return 'none';
  if (roleIds.overseerCircleRoleId && discordRoles.includes(roleIds.overseerCircleRoleId)) {
    return 'overseer';
  }
  if (roleIds.supporterRoleId && discordRoles.includes(roleIds.supporterRoleId)) {
    return 'supporter';
  }
  return 'none';
}

/** Normalize an arbitrary string (DB column, API input) to a known tier. */
export function normalizeTier(value: string | null | undefined): SupporterTier {
  const v = (value ?? '').trim().toLowerCase();
  return (TIER_ORDER as readonly string[]).includes(v) ? (v as SupporterTier) : 'none';
}

/** True when `actual` meets or exceeds `required`. The gate used by every cosmetic. */
export function tierAtLeast(actual: SupporterTier, required: SupporterTier): boolean {
  return TIER_ORDER.indexOf(actual) >= TIER_ORDER.indexOf(required);
}

/** Human label for user-facing copy (Discord replies, the web UI, the guide). */
export function tierLabel(tier: SupporterTier): string {
  switch (tier) {
    case 'overseer': return "Overseer's Circle";
    case 'supporter': return 'Supporter';
    default: return 'Vault Dweller';
  }
}

/**
 * Whether privileges are currently ACTIVE, as distinct from whether an entitlement
 * EXISTS (issue #230's hard rule).
 *
 * The entitlement row survives the user leaving the Discord — they keep what they
 * paid for. Privileges, however, follow the live Discord role: the sync service and
 * the reconcile job flip `status` to 'lapsed' when the role disappears, so cosmetics
 * revert to default and restore on rejoin without a re-purchase.
 */
export function privilegesActive(status: EntitlementStatus | string | null | undefined): boolean {
  return status === 'active';
}

export default {
  TIER_ORDER,
  PAID_TIERS,
  resolveSupporterTier,
  normalizeTier,
  tierAtLeast,
  tierLabel,
  privilegesActive,
};
module.exports = {
  TIER_ORDER,
  PAID_TIERS,
  resolveSupporterTier,
  normalizeTier,
  tierAtLeast,
  tierLabel,
  privilegesActive,
};
module.exports.default = module.exports;
