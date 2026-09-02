/**
 * Admin CRUD for the name blacklist.
 *
 * All routes require the admin Discord-OAuth session (same gate as other
 * /api/admin/* paths). On every write, refresh the in-process cache + emit
 * a Redis pub/sub broadcast so other backend instances also reload.
 */
import { Request, Response, NextFunction } from 'express';
import { paramsOf } from '../utils/reqParams';
import { z } from 'zod';
import prisma from '../config/prisma';
import { createError } from '../middleware/errorHandler';
import logger from '../config/logger';
import { refreshBlacklist } from '../services/nameBlacklistService';

const matchTypeEnum = z.enum(['exact', 'contains', 'regex']);

const createSchema = z.object({
  pattern: z.string().min(1).max(128),
  matchType: matchTypeEnum.default('exact'),
  enabled: z.boolean().default(true),
  note: z.string().max(512).nullish(),
});

const updateSchema = z.object({
  pattern: z.string().min(1).max(128).optional(),
  matchType: matchTypeEnum.optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(512).nullish(),
});

export async function listBlacklist(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const entries = await prisma.nameBlacklistEntry.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: entries });
  } catch (err) {
    next(err);
  }
}

export async function createBlacklistEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return next(createError(400, parsed.error.issues[0]?.message ?? 'Invalid body'));
    const { pattern, matchType, enabled, note } = parsed.data;
    // Validate regex compiles before persisting.
    if (matchType === 'regex') {
      try { new RegExp(pattern, 'i'); } catch { return next(createError(400, 'Invalid regex pattern')); }
    }
    const entry = await prisma.nameBlacklistEntry.create({
      data: {
        pattern,
        matchType,
        enabled,
        note: note ?? null,
        createdBy: req.adminUser?.id ?? null,
      },
    }).catch((err: any) => {
      if (err?.code === 'P2002') {
        next(createError(409, 'Pattern already exists'));
        return null;
      }
      throw err;
    });
    if (!entry) return;
    await refreshBlacklist();
    logger.info({ id: entry.id, pattern, matchType, createdBy: req.adminUser?.id }, '[nameBlacklist] entry created');
    res.status(201).json({ data: entry });
  } catch (err) {
    next(err);
  }
}

export async function updateBlacklistEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = paramsOf(req);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return next(createError(400, parsed.error.issues[0]?.message ?? 'Invalid body'));
    if (parsed.data.matchType === 'regex' && parsed.data.pattern) {
      try { new RegExp(parsed.data.pattern, 'i'); } catch { return next(createError(400, 'Invalid regex pattern')); }
    }
    const entry = await prisma.nameBlacklistEntry.update({
      where: { id },
      data: {
        ...(parsed.data.pattern !== undefined ? { pattern: parsed.data.pattern } : {}),
        ...(parsed.data.matchType !== undefined ? { matchType: parsed.data.matchType } : {}),
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        ...(parsed.data.note !== undefined ? { note: parsed.data.note ?? null } : {}),
      },
    }).catch((err: any) => {
      if (err?.code === 'P2025') {
        next(createError(404, 'Entry not found'));
        return null;
      }
      if (err?.code === 'P2002') {
        next(createError(409, 'Pattern already exists'));
        return null;
      }
      throw err;
    });
    if (!entry) return;
    await refreshBlacklist();
    logger.info({ id, updatedBy: req.adminUser?.id }, '[nameBlacklist] entry updated');
    res.json({ data: entry });
  } catch (err) {
    next(err);
  }
}

export async function deleteBlacklistEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = paramsOf(req);
    const deleted = await prisma.nameBlacklistEntry.deleteMany({ where: { id } });
    if (deleted.count === 0) return next(createError(404, 'Entry not found'));
    await refreshBlacklist();
    logger.info({ id, deletedBy: req.adminUser?.id }, '[nameBlacklist] entry deleted');
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
}
