/**
 * Cosmetics service — THE shared contract.
 *
 * Every surface that can change a user's cosmetics goes through `applyCosmetics`:
 * the web Profile panel (PATCH /api/users/:id/cosmetics) and every Discord
 * `/cosmetics` interaction. All validation, tier-gating, cooldown, blacklist, cache
 * busting, live push and audit logging live HERE. The transports only marshal input
 * and translate the returned `reason` into their own idiom (RFC 7807 status vs
 * ephemeral Discord copy).
 *
 * That is deliberate: the two surfaces are then structurally incapable of drifting
 * apart, and the rules are unit-tested once rather than twice.
 */
import prisma from '../../config/prisma';
import { getRedisClient } from '../../config/redis';
import logger from '../../config/logger';
import env from '../../config/environment';
import { SupporterTier, nameCooldownRemainingMs, tierAtLeast } from '../../utils/supporterTier';
import { getSupporterTierByUserId } from '../supporterService';
import { findColorPreset, findEffectPreset, REDUCED_MOTION_FALLBACK } from './presets';
import {
  validateDisplayName,
  validateTag,
  validateColorPreset,
  validateEffect,
  validateCustomColor,
  CosmeticRejection,
} from './validation';

/** Resolved cosmetics as they appear on the wire and in the UI. */
export interface ResolvedCosmetics {
  userId: string;
  /** Null when the user has no custom name — callers fall back to the normal display name. */
  displayName: string | null;
  /** Final `#rrggbb`, or null for the default theme colour. */
  nameColor: string | null;
  /** Effect id, or null. Always null when the user is not entitled. */
  effectId: string | null;
  /** Overseer tag, or null. */
  tag: string | null;
  /** Badges rendered beside the name, e.g. ['supporter']. */
  badges: string[];
  tier: SupporterTier;
}

export const EMPTY_COSMETICS = (userId: string): ResolvedCosmetics => ({
  userId, displayName: null, nameColor: null, effectId: null, tag: null, badges: [], tier: 'none',
});

export type ApplyReason =
  | 'tier_locked' | 'cooldown' | 'blacklisted' | 'invalid_name'
  | 'invalid_color' | 'invalid_tag' | 'not_linked' | 'not_found' | 'rate_limited';

export type ApplyResult =
  | { ok: true; cosmetics: ResolvedCosmetics; changed: string[] }
  | {
      ok: false;
      reason: ApplyReason;
      detail: {
        field?: string;
        code?: string;
        requiredTier?: SupporterTier;
        /** Milliseconds until the next name change is allowed. */
        retryAfterMs?: number;
        /** Human-readable explanation safe to show the user. */
        message?: string;
      };
    };

export interface CosmeticPatch {
  displayName?: string | null;
  colorPresetId?: string | null;
  customColorHex?: string | null;
  effectId?: string | null;
  customTag?: string | null;
  cosmeticsEnabled?: boolean;
}

// ── Resolution cache (read path) ──────────────────────────────────────────────

/**
 * Short TTL, not because cosmetics change often but because they are read on EVERY
 * message. 60s bounds the staleness window; any deliberate change busts the key
 * immediately, so the TTL only matters for changes made out-of-band (e.g. a direct
 * DB edit or a tier lapse from the reconcile job).
 */
const RESOLVE_TTL = 60;
const resolveKey = (userId: string) => `cosmetics:resolved:${userId}`;

export async function bustCosmeticsCache(userId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    await redis.del(resolveKey(userId));
  } catch (err) {
    logger.warn({ err, userId }, '[cosmetics] cache bust failed (non-fatal)');
  }
}

/**
 * Resolve a user's effective cosmetics, applying the tier gate at READ time.
 *
 * Gating on read (not just on write) is what makes lapse-and-restore work: when a
 * supporter's entitlement lapses, their stored preset rows are left untouched but stop
 * being served, so re-subscribing brings their exact previous look back with no
 * re-configuration. It is also the backstop if a tier were ever downgraded without the
 * write path running.
 */
export async function resolveCosmetics(userId: string): Promise<ResolvedCosmetics> {
  if (!userId) return EMPTY_COSMETICS(userId);
  // Kill switch: return defaults without touching Redis or the DB, so the feature
  // costs literally nothing while it is off.
  if (!cosmeticsEnabled()) return EMPTY_COSMETICS(userId);

  try {
    const redis = await getRedisClient();
    const cached = await redis.get(resolveKey(userId));
    if (cached) return JSON.parse(cached) as ResolvedCosmetics;
  } catch {
    // fall through to the DB
  }

  let resolved = EMPTY_COSMETICS(userId);
  try {
    const [row, tier] = await Promise.all([
      prisma.userCosmetic.findUnique({ where: { userId } }),
      getSupporterTierByUserId(userId),
    ]);

    resolved = { ...EMPTY_COSMETICS(userId), tier };

    if (tier !== 'none') resolved.badges = [tier];

    if (row && row.cosmeticsEnabled) {
      resolved.displayName = row.customDisplayName ?? null;

      // Preset wins over a custom hex when both are stored.
      const preset = findColorPreset(row.colorPresetId);
      if (preset && tierAtLeast(tier, preset.tier)) {
        resolved.nameColor = preset.hex;
      } else if (!preset && row.customColorHex) {
        // Custom colours are free-tier — the picker is available to everyone.
        resolved.nameColor = row.customColorHex;
      }

      const effect = findEffectPreset(row.effectId);
      if (effect && effect.id !== 'none' && tierAtLeast(tier, effect.tier)) {
        resolved.effectId = effect.id;
      }

      if (row.customTag && tierAtLeast(tier, 'overseer')) {
        resolved.tag = row.customTag;
      }
    }
  } catch (err) {
    logger.warn({ err, userId }, '[cosmetics] resolve failed — falling back to defaults');
    return EMPTY_COSMETICS(userId);
  }

  try {
    const redis = await getRedisClient();
    await redis.set(resolveKey(userId), JSON.stringify(resolved), { EX: RESOLVE_TTL });
  } catch {
    // non-fatal
  }
  return resolved;
}

/**
 * MASTER KILL SWITCH for the entire cosmetics + supporter surface.
 *
 * When `SUPPORTER_TIER_ENABLED` is false — which is the DEFAULT, including in
 * production — the feature is fully inert:
 *   - no cosmetics are attached to any chat message (chat renders exactly as it did
 *     before this feature existed, byte for byte)
 *   - the cosmetics/supporter REST routes 404
 *   - the `/cosmetics` Discord command is not registered
 *   - the supporter role-sync listeners and reconcile job do not start
 *   - the Profile editor and pricing surfaces are hidden
 *
 * This is deliberately a whole-feature switch rather than a purchase-CTA switch, so
 * the branch can be merged and deployed to production with zero observable change and
 * the commercial launch is a separate, explicit act.
 *
 * Stored rows are never touched when the flag is off, so flipping it back on restores
 * everyone's previous look exactly.
 */
export function cosmeticsEnabled(): boolean {
  return env.SUPPORTER_TIER_ENABLED === true;
}

/** Static effect to substitute under reduced motion / viewer opt-out. */
export function reducedMotionEffect(effectId: string | null): string | null {
  if (!effectId) return null;
  return REDUCED_MOTION_FALLBACK[effectId] ?? effectId;
}

/**
 * Decorate an outgoing `chat:message` payload with the author's cosmetics.
 *
 * Every user-authored broadcast site routes through this ONE helper rather than each
 * building its own payload — there are ~9 `chat:message` emitters and hand-patching
 * them guarantees they drift. Bot, system, giveaway and sim emitters deliberately do
 * not call it: they have no authoring user, so there is nothing to resolve.
 *
 * Mutates and returns the payload for convenience at the call sites. Never throws:
 * a cosmetics failure must never stop a message from being delivered.
 */
export async function attachCosmetics(
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!cosmeticsEnabled()) return payload;
  const userId = typeof payload.userId === 'string' ? payload.userId : null;
  if (!userId) return payload;

  try {
    const c = await resolveCosmetics(userId);
    // Only set fields that are actually in play, so payloads for the overwhelming
    // majority of users (no cosmetics row at all) stay byte-identical to today.
    if (c.displayName) payload.username = c.displayName;
    if (c.nameColor) payload.nameColor = c.nameColor;
    if (c.effectId) payload.effectId = c.effectId;
    if (c.tag) payload.tag = c.tag;
    if (c.badges.length > 0) payload.badges = c.badges;
  } catch (err) {
    logger.warn({ err, userId }, '[cosmetics] attach failed (non-fatal, message still sent)');
  }
  return payload;
}

// ── Write path ────────────────────────────────────────────────────────────────

/** The `detail` payload carried by a failed ApplyResult. */
type ApplyDetail = Extract<ApplyResult, { ok: false }>['detail'];

function rejectionToResult(r: CosmeticRejection): ApplyResult {
  if (r.code === 'tier_locked') {
    return {
      ok: false,
      reason: 'tier_locked',
      detail: { field: r.field, code: r.code, requiredTier: (r as { requiredTier: SupporterTier }).requiredTier },
    };
  }
  if (r.field === 'customColorHex') {
    const detail: ApplyDetail = { field: r.field, code: r.code };
    if (r.code === 'low_contrast') detail.message = 'That colour is too dark to read in chat.';
    if (r.code === 'reserved') {
      detail.message = `That colour is reserved (${(r as { reserved?: { label: string } }).reserved?.label ?? 'reserved'}).`;
    }
    if (r.code === 'unparseable') detail.message = 'That is not a valid colour.';
    return { ok: false, reason: 'invalid_color', detail };
  }
  if (r.field === 'customTag') {
    return { ok: false, reason: 'invalid_tag', detail: { field: r.field, code: r.code } };
  }
  if (r.field === 'colorPresetId' || r.field === 'effectId') {
    return { ok: false, reason: 'invalid_color', detail: { field: r.field, code: r.code } };
  }
  return { ok: false, reason: 'invalid_name', detail: { field: r.field, code: r.code } };
}

/** Non-fatal audit write. */
function audit(action: string, userId: string, metadata: Record<string, string | number | boolean | null>): void {
  prisma.auditLog
    .create({ data: { action, targetType: 'user_cosmetic', reason: userId, metadata } })
    .catch((err: unknown) => logger.warn({ err, userId, action }, '[cosmetics] audit write failed'));
}

/**
 * Apply a cosmetics patch. The single write path for every surface.
 *
 * `actor.kind === 'moderator'` skips the cooldown (a moderator resetting an abusive
 * name must not be blocked by the offender's own cooldown) but NOT the tier gate — a
 * moderator cannot hand out paid cosmetics.
 */
export async function applyCosmetics(input: {
  userId: string;
  patch: CosmeticPatch;
  actor: { kind: 'self' | 'moderator'; discordId?: string | null };
  /** Injected for deterministic tests. */
  now?: number;
}): Promise<ApplyResult> {
  const { userId, patch, actor } = input;
  const now = input.now ?? Date.now();

  if (!cosmeticsEnabled()) {
    return { ok: false, reason: 'not_found', detail: { message: 'Chat appearance customisation is not enabled.' } };
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, discordId: true } });
  if (!user) return { ok: false, reason: 'not_found', detail: { message: 'No such user.' } };

  const tier = await getSupporterTierByUserId(userId);
  const existing = await prisma.userCosmetic.findUnique({ where: { userId } });

  const data: Record<string, unknown> = {};
  const changed: string[] = [];

  // ── Display name ────────────────────────────────────────────────────────────
  if (patch.displayName !== undefined) {
    if (patch.displayName === null) {
      data.customDisplayName = null;
      changed.push('displayName');
    } else {
      const result = validateDisplayName(patch.displayName);
      if (!result.ok) return rejectionToResult(result.rejection);

      // Only charge a cooldown when the name actually changes.
      if (result.value !== existing?.customDisplayName) {
        if (actor.kind !== 'moderator') {
          const remaining = nameCooldownRemainingMs(existing?.displayNameChangedAt ?? null, tier, now);
          if (remaining > 0) {
            return { ok: false, reason: 'cooldown', detail: { field: 'displayName', retryAfterMs: remaining } };
          }
        }

        const blocked = await isNameBlocked(result.value);
        if (blocked) {
          // Deliberately does NOT say which pattern matched. Echoing it would turn
          // this endpoint into an oracle for probing the blacklist.
          logger.warn({ userId, reason: blocked }, '[cosmetics] display name rejected by moderation');
          audit('cosmetic_name_rejected', userId, { reason: blocked });
          return {
            ok: false,
            reason: 'blacklisted',
            detail: { field: 'displayName', message: 'That name is not allowed. Please choose another.' },
          };
        }

        data.customDisplayName = result.value;
        data.displayNameChangedAt = new Date(now);
        changed.push('displayName');
      }
    }
  }

  // ── Colour ──────────────────────────────────────────────────────────────────
  if (patch.colorPresetId !== undefined) {
    if (patch.colorPresetId === null) {
      data.colorPresetId = null;
      changed.push('colorPresetId');
    } else {
      const result = validateColorPreset(patch.colorPresetId, tier);
      if (!result.ok) return rejectionToResult(result.rejection);
      data.colorPresetId = result.value;
      // A preset and a custom hex are mutually exclusive — clear the other.
      data.customColorHex = null;
      changed.push('colorPresetId');
    }
  }

  if (patch.customColorHex !== undefined) {
    if (patch.customColorHex === null) {
      data.customColorHex = null;
      changed.push('customColorHex');
    } else {
      const result = validateCustomColor(patch.customColorHex);
      if (!result.ok) return rejectionToResult(result.rejection);
      data.customColorHex = result.value;
      data.colorPresetId = null;
      changed.push('customColorHex');
    }
  }

  // ── Effect ──────────────────────────────────────────────────────────────────
  if (patch.effectId !== undefined) {
    if (patch.effectId === null || patch.effectId === 'none') {
      data.effectId = null;
      changed.push('effectId');
    } else {
      const result = validateEffect(patch.effectId, tier);
      if (!result.ok) return rejectionToResult(result.rejection);
      data.effectId = result.value;
      changed.push('effectId');
    }
  }

  // ── Tag ─────────────────────────────────────────────────────────────────────
  if (patch.customTag !== undefined) {
    if (patch.customTag === null) {
      data.customTag = null;
      changed.push('customTag');
    } else {
      const result = validateTag(patch.customTag, tier);
      if (!result.ok) return rejectionToResult(result.rejection);
      const blocked = await isNameBlocked(result.value);
      if (blocked) {
        return {
          ok: false,
          reason: 'blacklisted',
          detail: { field: 'customTag', message: 'That tag is not allowed. Please choose another.' },
        };
      }
      data.customTag = result.value;
      changed.push('customTag');
    }
  }

  if (patch.cosmeticsEnabled !== undefined) {
    data.cosmeticsEnabled = patch.cosmeticsEnabled;
    changed.push('cosmeticsEnabled');
  }

  if (changed.length === 0) {
    return { ok: true, cosmetics: await resolveCosmetics(userId), changed: [] };
  }

  await prisma.userCosmetic.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });

  await bustCosmeticsCache(userId);
  const cosmetics = await resolveCosmetics(userId);

  audit(actor.kind === 'moderator' ? 'cosmetic_reset_by_moderator' : 'cosmetic_updated', userId, {
    changed: changed.join(','),
    tier,
    actor: actor.discordId ?? null,
  });

  await pushCosmeticsUpdate(userId, cosmetics);

  return { ok: true, cosmetics, changed };
}

/**
 * Push the new identity to live sessions so already-rendered messages update without
 * a reconnect. Imported lazily: handlers.ts pulls in the whole WS layer, and this
 * module is also loaded by the Discord bot and the reconcile job.
 */
export async function pushCosmeticsUpdate(userId: string, cosmetics: ResolvedCosmetics): Promise<void> {
  try {
    const handlers = await import('../../websocket/handlers.js');
    const refresh = (handlers as { refreshClientCosmetics?: (u: string, c: ResolvedCosmetics) => void })
      .refreshClientCosmetics;
    if (typeof refresh === 'function') refresh(userId, cosmetics);
  } catch (err) {
    logger.warn({ err, userId }, '[cosmetics] live push failed (non-fatal)');
  }
}

/**
 * Run a candidate name through the same moderation the register path uses.
 * Returns a short machine reason, or null when the name is acceptable.
 * Fails OPEN on infrastructure errors — a broken filter must not lock everyone out of
 * renaming themselves — but the automod/blacklist services are themselves fail-safe.
 */
async function isNameBlocked(name: string): Promise<string | null> {
  try {
    const { findBlacklistMatch } = await import('../nameBlacklistService.js');
    const hit = findBlacklistMatch(name);
    if (hit) return 'blacklist';
  } catch (err) {
    logger.warn({ err }, '[cosmetics] name blacklist check failed (non-fatal)');
  }
  try {
    const { findProhibitedPhrase } = await import('../autoModService.js');
    const phrase = await findProhibitedPhrase(name);
    if (phrase) return 'prohibited_phrase';
  } catch (err) {
    logger.warn({ err }, '[cosmetics] prohibited-phrase check failed (non-fatal)');
  }
  return null;
}

/** Moderator action: wipe a user's cosmetics back to defaults (#232). */
export async function resetCosmetics(userId: string, actorDiscordId: string | null): Promise<ApplyResult> {
  return applyCosmetics({
    userId,
    patch: { displayName: null, colorPresetId: null, customColorHex: null, effectId: null, customTag: null },
    actor: { kind: 'moderator', discordId: actorDiscordId },
  });
}

export default {
  applyCosmetics,
  resolveCosmetics,
  resetCosmetics,
  attachCosmetics,
  cosmeticsEnabled,
  bustCosmeticsCache,
  pushCosmeticsUpdate,
  reducedMotionEffect,
  EMPTY_COSMETICS,
};
module.exports = {
  applyCosmetics,
  resolveCosmetics,
  resetCosmetics,
  attachCosmetics,
  cosmeticsEnabled,
  bustCosmeticsCache,
  pushCosmeticsUpdate,
  reducedMotionEffect,
  EMPTY_COSMETICS,
};
module.exports.default = module.exports;
