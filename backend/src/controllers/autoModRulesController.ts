/**
 * AutoMod Rules + Violations REST controller.
 *
 * All routes require requireDiscordRole (owner/admin/moderator as appropriate).
 * Debug mirrors live at /admin/debug/automod-* (X-Admin-API-Key).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENDPOINT REFERENCE (for dashboard agent)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * GET /api/moderation/automod-rules
 *   Response: { data: AutoModRule[] }
 *   AutoModRule: {
 *     id: string (uuid),
 *     name: string,
 *     enabled: boolean,
 *     triggerType: 'KEYWORD'|'SPAM'|'KEYWORD_PRESET'|'MENTION_SPAM'|'LINK',
 *     triggerMetadata: {
 *       // KEYWORD:        keyword_filter?: string[], regex_patterns?: string[], allow_list?: string[]
 *       // KEYWORD_PRESET: presets?: ('PROFANITY'|'SEXUAL_CONTENT'|'SLURS')[], allow_list?: string[]
 *       // MENTION_SPAM:   mention_total_limit?: number
 *       // SPAM:           dupe_limit?: number, dupe_window_ms?: number, rate_limit?: number, rate_window_ms?: number
 *       // LINK:           allow_list?: string[]  (domain strings, e.g. "youtube.com")
 *     },
 *     actions: Array<{
 *       type: 'BLOCK'|'ALERT'|'TIMEOUT'|'MUTE_OVERLAY',
 *       metadata?: { customMessage?: string, durationSeconds?: number }
 *     }>,
 *     exemptChannelIds: string[],
 *     exemptRoles: string[],
 *     createdById: string|null,
 *     createdAt: string (ISO),
 *     updatedAt: string (ISO)
 *   }
 *
 * POST /api/moderation/automod-rules
 *   Body: Omit<AutoModRule, 'id'|'createdAt'|'updatedAt'|'createdById'>
 *   Response: { data: AutoModRule }
 *
 * PUT /api/moderation/automod-rules/:id
 *   Body: Partial<Omit<AutoModRule, 'id'|'createdAt'|'updatedAt'|'createdById'>>
 *   Response: { data: AutoModRule }
 *
 * DELETE /api/moderation/automod-rules/:id
 *   Response: { data: { deleted: true } }
 *
 * PATCH /api/moderation/automod-rules/:id/toggle
 *   Body: { enabled: boolean }
 *   Response: { data: { id, enabled } }
 *
 * GET /api/moderation/automod-violations
 *   Query: ?ruleId=&userId=&from=&to=&limit=50&offset=0
 *   Response: { data: AutoModViolation[], total: number }
 *   AutoModViolation: {
 *     id: string, ruleId: string, userId: string, channelId: string|null,
 *     messageContent: string, matchedKeyword: string|null, matchedSubstr: string|null,
 *     actionsTaken: Array<{ type, success, detail? }>,
 *     createdAt: string,
 *     rule: { name: string, triggerType: string }
 *   }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEBUG MIRRORS (X-Admin-API-Key)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * GET  /admin/debug/automod-rules       — same as GET /api/moderation/automod-rules
 * GET  /admin/debug/automod-violations  — same as GET /api/moderation/automod-violations
 * POST /admin/debug/automod-rules/invalidate-cache — bust the in-process rules cache
 */

import { Request, Response, NextFunction } from 'express';
import { paramsOf } from '../utils/reqParams';
import prisma from '../config/prisma';
import { createError } from '../middleware/errorHandler';
import { invalidateRulesCache } from '../services/autoModEngine';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TRIGGER_TYPES = new Set(['KEYWORD', 'SPAM', 'KEYWORD_PRESET', 'MENTION_SPAM', 'LINK']);
const VALID_ACTION_TYPES = new Set(['BLOCK', 'ALERT', 'TIMEOUT', 'MUTE_OVERLAY']);

function validateUuid(id: string): boolean { return UUID_RE.test(id); }

function validateActions(actions: unknown): string | null {
  if (!Array.isArray(actions) || actions.length === 0) return 'actions must be a non-empty array';
  for (const a of actions) {
    if (!a || typeof a !== 'object') return 'each action must be an object';
    if (!VALID_ACTION_TYPES.has((a as any).type)) {
      return `invalid action type "${(a as any).type}"; must be one of: ${[...VALID_ACTION_TYPES].join(', ')}`;
    }
  }
  return null;
}

// ── GET /api/moderation/automod-rules ─────────────────────────────────────────
export async function listAutoModRules(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rules = await prisma.autoModRule.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ data: rules });
  } catch (err) { next(err); }
}

// ── POST /api/moderation/automod-rules ────────────────────────────────────────
export async function createAutoModRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { name, enabled, triggerType, triggerMetadata, actions, exemptChannelIds, exemptRoles } = req.body;

  if (!name?.trim()) return next(createError(422, 'name is required'));
  if (!triggerType || !VALID_TRIGGER_TYPES.has(triggerType)) {
    return next(createError(422, `triggerType must be one of: ${[...VALID_TRIGGER_TYPES].join(', ')}`));
  }
  if (triggerMetadata === undefined || triggerMetadata === null || typeof triggerMetadata !== 'object') {
    return next(createError(422, 'triggerMetadata must be an object'));
  }
  const actionsErr = validateActions(actions);
  if (actionsErr) return next(createError(422, actionsErr));

  try {
    const actorId = (req as any).adminUser?.id ?? null;
    const rule = await prisma.autoModRule.create({
      data: {
        name: name.trim().slice(0, 100),
        enabled: typeof enabled === 'boolean' ? enabled : true,
        triggerType,
        triggerMetadata: triggerMetadata as any,
        actions: actions as any,
        exemptChannelIds: Array.isArray(exemptChannelIds) ? exemptChannelIds.filter((x: unknown) => typeof x === 'string') : [],
        exemptRoles: Array.isArray(exemptRoles) ? exemptRoles.filter((x: unknown) => typeof x === 'string') : [],
        createdById: actorId,
      },
    });
    invalidateRulesCache();
    await prisma.auditLog.create({
      data: {
        actorId,
        action: 'automod_rule_create',
        targetType: 'automod_rule',
        targetId: actorId,
        reason: `Created rule "${rule.name}" (${rule.triggerType})`,
        metadata: { ruleId: rule.id, triggerType: rule.triggerType },
      },
    }).catch(() => {});
    res.status(201).json({ data: rule });
  } catch (err) { next(err); }
}

// ── PUT /api/moderation/automod-rules/:id ─────────────────────────────────────
export async function updateAutoModRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { id } = paramsOf(req);
  if (!validateUuid(id)) return next(createError(400, 'Invalid rule ID'));

  const { name, enabled, triggerType, triggerMetadata, actions, exemptChannelIds, exemptRoles } = req.body;

  if (triggerType !== undefined && !VALID_TRIGGER_TYPES.has(triggerType)) {
    return next(createError(422, `triggerType must be one of: ${[...VALID_TRIGGER_TYPES].join(', ')}`));
  }
  if (actions !== undefined) {
    const actionsErr = validateActions(actions);
    if (actionsErr) return next(createError(422, actionsErr));
  }

  try {
    const existing = await prisma.autoModRule.findUnique({ where: { id } });
    if (!existing) return next(createError(404, 'Rule not found'));

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = String(name).trim().slice(0, 100);
    if (typeof enabled === 'boolean') data.enabled = enabled;
    if (triggerType !== undefined) data.triggerType = triggerType;
    if (triggerMetadata !== undefined) data.triggerMetadata = triggerMetadata;
    if (actions !== undefined) data.actions = actions;
    if (Array.isArray(exemptChannelIds)) data.exemptChannelIds = exemptChannelIds.filter((x: unknown) => typeof x === 'string');
    if (Array.isArray(exemptRoles)) data.exemptRoles = exemptRoles.filter((x: unknown) => typeof x === 'string');

    const rule = await prisma.autoModRule.update({ where: { id }, data: data as any });
    invalidateRulesCache();
    const actorId = (req as any).adminUser?.id ?? null;
    await prisma.auditLog.create({
      data: {
        actorId,
        action: 'automod_rule_update',
        targetType: 'automod_rule',
        targetId: actorId,
        reason: `Updated rule "${rule.name}"`,
        metadata: { ruleId: rule.id, changes: Object.keys(data) },
      },
    }).catch(() => {});
    res.json({ data: rule });
  } catch (err) { next(err); }
}

// ── DELETE /api/moderation/automod-rules/:id ──────────────────────────────────
export async function deleteAutoModRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { id } = paramsOf(req);
  if (!validateUuid(id)) return next(createError(400, 'Invalid rule ID'));
  try {
    const existing = await prisma.autoModRule.findUnique({ where: { id } });
    if (!existing) return next(createError(404, 'Rule not found'));
    await prisma.autoModRule.delete({ where: { id } });
    invalidateRulesCache();
    const actorId = (req as any).adminUser?.id ?? null;
    await prisma.auditLog.create({
      data: {
        actorId,
        action: 'automod_rule_delete',
        targetType: 'automod_rule',
        targetId: actorId,
        reason: `Deleted rule "${existing.name}" (${existing.triggerType})`,
        metadata: { ruleId: id },
      },
    }).catch(() => {});
    res.json({ data: { deleted: true } });
  } catch (err) { next(err); }
}

// ── PATCH /api/moderation/automod-rules/:id/toggle ────────────────────────────
export async function toggleAutoModRule(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { id } = paramsOf(req);
  if (!validateUuid(id)) return next(createError(400, 'Invalid rule ID'));
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return next(createError(422, 'enabled must be a boolean'));
  try {
    const rule = await prisma.autoModRule.update({ where: { id }, data: { enabled }, select: { id: true, enabled: true, name: true } });
    invalidateRulesCache();
    const actorId = (req as any).adminUser?.id ?? null;
    await prisma.auditLog.create({
      data: {
        actorId,
        action: enabled ? 'automod_rule_enable' : 'automod_rule_disable',
        targetType: 'automod_rule',
        targetId: actorId,
        reason: `${enabled ? 'Enabled' : 'Disabled'} rule "${rule.name}"`,
        metadata: { ruleId: id },
      },
    }).catch(() => {});
    res.json({ data: { id: rule.id, enabled: rule.enabled } });
  } catch (err: any) {
    if (err.code === 'P2025') return next(createError(404, 'Rule not found'));
    next(err);
  }
}

// ── GET /api/moderation/automod-violations ────────────────────────────────────
export async function listAutoModViolations(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ruleId = req.query.ruleId as string | undefined;
  const userId = req.query.userId as string | undefined;
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 200);
  const offset = Math.max(parseInt(req.query.offset as string || '0', 10), 0);

  if (ruleId && !validateUuid(ruleId)) return next(createError(400, 'Invalid ruleId'));
  if (userId && !validateUuid(userId)) return next(createError(400, 'Invalid userId'));

  try {
    const where: Record<string, unknown> = {};
    if (ruleId) where.ruleId = ruleId;
    if (userId) where.userId = userId;
    if (from || to) {
      where.createdAt = {};
      if (from) (where.createdAt as any).gte = new Date(from);
      if (to) (where.createdAt as any).lte = new Date(to);
    }

    const [violations, total] = await Promise.all([
      prisma.autoModViolation.findMany({
        where: where as any,
        include: { rule: { select: { name: true, triggerType: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.autoModViolation.count({ where: where as any }),
    ]);

    res.json({ data: violations, total });
  } catch (err) { next(err); }
}

// ── Cache invalidation (debug mirror support) ─────────────────────────────────
export function invalidateAutoModCacheHandler(_req: Request, res: Response): void {
  invalidateRulesCache();
  res.json({ data: { invalidated: true } });
}
