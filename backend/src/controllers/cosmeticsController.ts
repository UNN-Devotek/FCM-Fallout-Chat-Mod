/**
 * Cosmetics REST surface.
 *
 * These handlers deliberately contain NO business logic. Every rule — validation,
 * tier gating, cooldown, blacklist, cache busting, live push, audit — lives in
 * cosmeticsService.applyCosmetics, which the Discord `/cosmetics` commands call too.
 * All this layer does is marshal HTTP and translate the service's `reason` into an
 * RFC 7807 status. That is what keeps the web and Discord surfaces from drifting.
 */
import { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import logger from '../config/logger';
import env from '../config/environment';
import createError from 'http-errors';
import { paramStr } from '../utils/reqParams';
import {
  applyCosmetics,
  resolveCosmetics,
  resetCosmetics,
  ApplyResult,
  CosmeticPatch,
} from '../services/cosmetics/cosmeticsService';
import { COLOR_PRESETS, EFFECT_PRESETS, REDUCED_MOTION_FALLBACK, CUSTOM_COLOR_BOUNDS } from '../services/cosmetics/presets';
import { RESERVED_COLORS, RESERVED_MIN_DISTANCE } from '../services/cosmetics/reservedColors';
import { MIN_CONTRAST, CONTRAST_BACKGROUNDS } from '../utils/colorContrast';
import { NAME_MIN_LENGTH, NAME_MAX_LENGTH, TAG_MAX_LENGTH } from '../services/cosmetics/validation';
import { getSupporterStatus } from '../services/supporterService';
import { tierLabel, nameCooldownMs } from '../utils/supporterTier';

/** Map a service rejection onto an HTTP status. */
function statusForReason(reason: Extract<ApplyResult, { ok: false }>['reason']): number {
  switch (reason) {
    case 'tier_locked': return 403;
    case 'cooldown': return 429;
    case 'rate_limited': return 429;
    case 'not_found': return 404;
    case 'not_linked': return 409;
    default: return 400; // invalid_name | invalid_color | invalid_tag | blacklisted
  }
}

/** Resolve the dashboard caller's FCM user id. */
async function callerUserId(req: Request): Promise<{ userId: string; discordId: string } | null> {
  const discordId = (req as unknown as { dashboardUser?: { discordId?: string } }).dashboardUser?.discordId;
  if (!discordId) return null;
  const user = await prisma.user.findFirst({ where: { discordId }, select: { id: true } });
  return user ? { userId: user.id, discordId } : null;
}

/**
 * GET /api/cosmetics/catalog
 *
 * The single source of truth for every surface: the web picker, the Discord
 * autocomplete, and the user guide all render from this rather than re-declaring the
 * lists. Includes the reserved colours and picker bounds so the client can give live
 * feedback that matches what the server will actually accept.
 */
export async function getCatalog(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({
      data: {
        colors: COLOR_PRESETS,
        effects: EFFECT_PRESETS,
        reducedMotionFallback: REDUCED_MOTION_FALLBACK,
        customColorBounds: CUSTOM_COLOR_BOUNDS,
        reservedColors: RESERVED_COLORS,
        reservedMinDistance: RESERVED_MIN_DISTANCE,
        contrast: { min: MIN_CONTRAST, backgrounds: CONTRAST_BACKGROUNDS },
        nameRules: { minLength: NAME_MIN_LENGTH, maxLength: NAME_MAX_LENGTH, tagMaxLength: TAG_MAX_LENGTH },
        cooldownMs: {
          none: nameCooldownMs('none'),
          supporter: nameCooldownMs('supporter'),
          overseer: nameCooldownMs('overseer'),
        },
        // Effects never render in-game (Scaleform bans filters). Surfaced so the UI can
        // label them honestly rather than selling a cosmetic that does nothing in game.
        inGameSupports: { colors: true, tag: true, effects: false },
      },
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/users/:id/cosmetics — self, or any moderator+ (route-gated). */
export async function getUserCosmetics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const targetId = paramStr(req, 'id');
    if (!targetId) return next(createError(400, 'Missing user id'));

    const caller = await callerUserId(req);
    if (!caller) return next(createError(401, 'No linked account'));

    // requireDashboardAuth does NOT enforce ownership, so scope it here.
    if (caller.userId !== targetId) {
      const isStaff = await callerIsStaff(caller.discordId);
      if (!isStaff) return next(createError(403, 'You can only view your own cosmetics'));
    }

    const [cosmetics, row] = await Promise.all([
      resolveCosmetics(targetId),
      prisma.userCosmetic.findUnique({ where: { userId: targetId } }),
    ]);

    res.json({
      data: {
        ...cosmetics,
        // Stored (as opposed to resolved) values, so the editor shows what the user
        // actually chose even while a preset is gated off by a lapsed entitlement.
        stored: row
          ? {
              customDisplayName: row.customDisplayName,
              colorPresetId: row.colorPresetId,
              customColorHex: row.customColorHex,
              effectId: row.effectId,
              customTag: row.customTag,
              cosmeticsEnabled: row.cosmeticsEnabled,
              displayNameChangedAt: row.displayNameChangedAt,
            }
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
}

/** PATCH /api/users/:id/cosmetics — self only. */
export async function patchUserCosmetics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const targetId = paramStr(req, 'id');
    if (!targetId) return next(createError(400, 'Missing user id'));

    const caller = await callerUserId(req);
    if (!caller) return next(createError(401, 'No linked account'));
    if (caller.userId !== targetId) {
      return next(createError(403, 'You can only change your own cosmetics'));
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: CosmeticPatch = {};
    // Only forward keys that were actually present — `undefined` means "leave alone"
    // while an explicit `null` means "clear", and the service relies on that distinction.
    if ('displayName' in body) patch.displayName = body.displayName as string | null;
    if ('colorPresetId' in body) patch.colorPresetId = body.colorPresetId as string | null;
    if ('customColorHex' in body) patch.customColorHex = body.customColorHex as string | null;
    if ('effectId' in body) patch.effectId = body.effectId as string | null;
    if ('customTag' in body) patch.customTag = body.customTag as string | null;
    if ('cosmeticsEnabled' in body) patch.cosmeticsEnabled = Boolean(body.cosmeticsEnabled);

    const result = await applyCosmetics({
      userId: targetId,
      patch,
      actor: { kind: 'self', discordId: caller.discordId },
    });

    if (!result.ok) {
      const status = statusForReason(result.reason);
      if (result.detail.retryAfterMs) {
        res.setHeader('Retry-After', String(Math.ceil(result.detail.retryAfterMs / 1000)));
      }
      return next(createError(status, result.detail.message ?? result.reason, {
        code: result.reason,
        detail: result.detail,
      }));
    }

    res.json({ data: { ...result.cosmetics, changed: result.changed } });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/users/:id/cosmetics/reset — moderator+ (#232). */
export async function adminResetCosmetics(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const targetId = paramStr(req, 'id');
    if (!targetId) return next(createError(400, 'Missing user id'));

    const actorDiscordId =
      (req as unknown as { adminUser?: { id?: string } }).adminUser?.id ??
      (req as unknown as { session?: { discordUser?: { id?: string } } }).session?.discordUser?.id ??
      null;

    const result = await resetCosmetics(targetId, actorDiscordId);
    if (!result.ok) return next(createError(statusForReason(result.reason), result.reason));

    logger.info({ targetId, actorDiscordId }, '[cosmetics] moderator reset');
    res.json({ data: result.cosmetics });
  } catch (err) {
    next(err);
  }
}

/** GET /api/supporter/status — the caller's own tier and privilege state. */
export async function getSupporterStatusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const discordId = (req as unknown as { dashboardUser?: { discordId?: string } }).dashboardUser?.discordId;
    if (!discordId) return next(createError(401, 'No linked account'));

    const status = await getSupporterStatus(discordId);
    res.json({
      data: {
        ...status,
        tierLabel: tierLabel(status.tier),
        entitledTierLabel: tierLabel(status.entitledTier),
        // True when the user is entitled but privileges are suspended — the UI uses
        // this to prompt them to rejoin the Discord rather than to re-purchase.
        needsDiscordRejoin: status.hasEntitlement && !status.privilegesActive,
        shopUrl: env.SUPPORTER_TIER_ENABLED ? env.DISCORD_SERVER_SHOP_URL || null : null,
        tierEnabled: env.SUPPORTER_TIER_ENABLED,
      },
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/supporter/tiers — public pricing data for the marketing page. */
export async function getSupporterTiers(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({
      data: {
        enabled: env.SUPPORTER_TIER_ENABLED,
        shopUrl: env.SUPPORTER_TIER_ENABLED ? env.DISCORD_SERVER_SHOP_URL || null : null,
        tiers: [
          {
            id: 'none', label: tierLabel('none'), priceUsdMonthly: 0,
            colors: COLOR_PRESETS.filter((c) => c.tier === 'none').length,
            effects: EFFECT_PRESETS.filter((e) => e.tier === 'none').length,
          },
          {
            id: 'supporter', label: tierLabel('supporter'), priceUsdMonthly: 4,
            colors: COLOR_PRESETS.filter((c) => c.tier === 'supporter').length,
            effects: EFFECT_PRESETS.filter((e) => e.tier === 'supporter').length,
          },
          {
            id: 'overseer', label: tierLabel('overseer'), priceUsdMonthly: 10,
            colors: COLOR_PRESETS.filter((c) => c.tier === 'overseer').length,
            effects: EFFECT_PRESETS.filter((e) => e.tier === 'overseer').length,
          },
        ],
      },
    });
  } catch (err) {
    next(err);
  }
}

/** Is this Discord account a moderator or above? */
async function callerIsStaff(discordId: string): Promise<boolean> {
  try {
    const admin = await prisma.adminUser.findUnique({ where: { discordId }, select: { role: true } });
    return !!admin && ['owner', 'admin', 'moderator'].includes(admin.role);
  } catch {
    return false;
  }
}

export default {
  getCatalog,
  getUserCosmetics,
  patchUserCosmetics,
  adminResetCosmetics,
  getSupporterStatusHandler,
  getSupporterTiers,
};
module.exports = {
  getCatalog,
  getUserCosmetics,
  patchUserCosmetics,
  adminResetCosmetics,
  getSupporterStatusHandler,
  getSupporterTiers,
};
module.exports.default = module.exports;
