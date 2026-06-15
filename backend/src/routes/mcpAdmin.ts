/**
 * /api/mcp-admin — OWNER-ONLY production MCP router.
 *
 * Auth: requireMcpToken('prod') — rejects all dev-env tokens.
 * All endpoints return { data: ... } or RFC 7807 errors.
 *
 * EXCLUDED (never exposed here — too catastrophic for an agent loop):
 *   • /admin/nuke-users
 *   • /admin/migration/* (raw SQL / dump / restore)
 *   • /api/game/* (game bridge)
 *   • sim/* routes
 */

import express, { Request, Response, NextFunction } from 'express';
import { requireMcpToken, mcpLimiter } from '../middleware/requireMcpToken';
import { createError } from '../middleware/errorHandler';
import { ingestMessage } from '../services/ingestMessage';
import prisma from '../config/prisma';
import logger from '../config/logger';

const router = express.Router();

router.use(mcpLimiter);
router.use(requireMcpToken('prod'));

// ─────────────────────────────────────────────────────────────────────────────
// READS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/mcp-admin/health
router.get('/health', (_req, res) => {
  res.json({ data: { status: 'ok', timestamp: new Date().toISOString() } });
});

// GET /api/mcp-admin/version
router.get('/version', (_req, res) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../../package.json') as { version: string };
    res.json({ data: { version: pkg.version } });
  } catch {
    res.json({ data: { version: 'unknown' } });
  }
});

// GET /api/mcp-admin/channels
router.get('/channels', async (_req, res, next) => {
  try {
    const channels = await prisma.channel.findMany({
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true, name: true, color: true, parentId: true, sortOrder: true,
        discordRelay: true, allowGifs: true, allowEmojis: true, isArchived: true,
      },
    });
    res.json({ data: channels });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp-admin/channels
router.post('/channels', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, color, parentId, sortOrder, discordRelay, allowGifs, allowEmojis } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0)
      return next(createError(400, 'name is required'));
    const channel = await prisma.channel.create({
      data: {
        name: name.trim(),
        color: color ?? '#ecbb51',
        parentId: parentId ?? null,
        sortOrder: typeof sortOrder === 'number' ? sortOrder : 0,
        discordRelay: discordRelay ?? false,
        allowGifs: allowGifs ?? true,
        allowEmojis: allowEmojis ?? true,
      },
      select: { id: true, name: true, color: true, sortOrder: true, isArchived: true },
    });
    res.status(201).json({ data: channel });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/mcp-admin/channels/:id
router.patch('/channels/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, color, sortOrder, discordRelay, allowGifs, allowEmojis, isArchived } = req.body || {};
    const channel = await prisma.channel.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(color !== undefined && { color }),
        ...(sortOrder !== undefined && { sortOrder }),
        ...(discordRelay !== undefined && { discordRelay }),
        ...(allowGifs !== undefined && { allowGifs }),
        ...(allowEmojis !== undefined && { allowEmojis }),
        ...(isArchived !== undefined && { isArchived }),
      },
      select: { id: true, name: true, color: true, sortOrder: true, isArchived: true },
    });
    res.json({ data: channel });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mcp-admin/channels/:id  (archive)
router.delete('/channels/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    await prisma.channel.update({ where: { id }, data: { isArchived: true } });
    res.json({ data: { archived: true } });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/commands
router.get('/commands', async (_req, res, next) => {
  try {
    const commands = await prisma.chatCommand.findMany({
      orderBy: { trigger: 'asc' },
      select: {
        id: true, trigger: true, description: true, actionType: true,
        cooldownSec: true, requiresArgs: true, alias: true, enabled: true,
      },
    });
    res.json({ data: commands });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp-admin/commands
router.post('/commands', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { trigger, description, actionType, cooldownSec, requiresArgs, alias } = req.body || {};
    if (!trigger || typeof trigger !== 'string')
      return next(createError(400, 'trigger is required'));
    const cmd = await prisma.chatCommand.create({
      data: {
        trigger: trigger.trim(),
        description: description ?? '',
        actionType: actionType ?? 'info',
        cooldownSec: typeof cooldownSec === 'number' ? cooldownSec : 0,
        requiresArgs: requiresArgs ?? false,
        alias: alias ?? null,
        enabled: true,
      },
      select: { id: true, trigger: true, description: true, actionType: true, enabled: true },
    });
    res.status(201).json({ data: cmd });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/mcp-admin/commands/:id
router.patch('/commands/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idNum = parseInt(req.params.id, 10);
    if (isNaN(idNum)) return next(createError(400, 'id must be a number'));
    const { trigger, description, actionType, cooldownSec, requiresArgs, alias, enabled } = req.body || {};
    const cmd = await prisma.chatCommand.update({
      where: { id: idNum },
      data: {
        ...(trigger !== undefined && { trigger }),
        ...(description !== undefined && { description }),
        ...(actionType !== undefined && { actionType }),
        ...(cooldownSec !== undefined && { cooldownSec: Number(cooldownSec) }),
        ...(requiresArgs !== undefined && { requiresArgs }),
        ...(alias !== undefined && { alias }),
        ...(enabled !== undefined && { enabled }),
      },
      select: { id: true, trigger: true, description: true, actionType: true, enabled: true },
    });
    res.json({ data: cmd });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mcp-admin/commands/:id
router.delete('/commands/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const delId = parseInt(req.params.id, 10);
    if (isNaN(delId)) return next(createError(400, 'id must be a number'));
    await prisma.chatCommand.delete({ where: { id: delId } });
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/users?limit=50&offset=0
router.get('/users', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const users = await prisma.user.findMany({
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, username: true, discordUsername: true, discordDisplayName: true,
        isBanned: true, isMuted: true, bannedUntil: true, createdAt: true,
      },
    });
    res.json({ data: users });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/users/:id
router.get('/users/:id', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, username: true, discordUsername: true, discordDisplayName: true,
        isBanned: true, isMuted: true, bannedUntil: true, mutedUntil: true, createdAt: true,
      },
    });
    if (!user) return next(createError(404, 'User not found'));
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/users/search?q=
router.get('/users/search', async (req, res, next) => {
  try {
    const q = (req.query.q as string || '').trim().slice(0, 64);
    if (!q) return next(createError(400, 'q query param is required'));
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { discordUsername: { contains: q, mode: 'insensitive' } },
          { discordDisplayName: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true, username: true, discordUsername: true, discordDisplayName: true,
        isBanned: true, isMuted: true,
      },
      take: 20,
    });
    res.json({ data: users });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/messages?channelId=&limit=50
router.get('/messages', async (req, res, next) => {
  try {
    const channelId = req.query.channelId as string;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!channelId) return next(createError(400, 'channelId is required'));
    if (!UUID_RE.test(channelId)) return next(createError(400, 'channelId must be a valid UUID'));
    const messages = await prisma.message.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, content: true, userId: true, channelId: true, source: true, createdAt: true, isDeleted: true },
    });
    res.json({ data: messages.reverse() });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/messages/search?q=&channelId=&limit=50
router.get('/messages/search', async (req, res, next) => {
  try {
    const q = (req.query.q as string || '').trim().slice(0, 200);
    const channelId = req.query.channelId as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    if (!q) return next(createError(400, 'q query param is required'));
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const messages = await prisma.message.findMany({
      where: {
        content: { contains: q, mode: 'insensitive' },
        ...(channelId && UUID_RE.test(channelId) ? { channelId } : {}),
        isDeleted: false,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, content: true, userId: true, channelId: true, source: true, createdAt: true },
    });
    res.json({ data: messages });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/parties
router.get('/parties', async (_req, res, next) => {
  try {
    const parties = await prisma.party.findMany({
      where: { isDeleted: false },
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
      select: {
        id: true, name: true, color: true, isPrivate: true, category: true,
        description: true, maxMembers: true, lastMessageAt: true, createdAt: true,
      },
    });
    res.json({ data: parties });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/releases
router.get('/releases', async (_req, res, next) => {
  try {
    const releases = await prisma.release.findMany({
      orderBy: { publishedAt: 'desc' },
      take: 20,
      select: { id: true, version: true, downloadUrl: true, releaseNotes: true, publishedAt: true, downloadCount: true },
    });
    res.json({ data: releases });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/audit-log?actor=&action=&from=&to=&limit=50
router.get('/audit-log', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const actor = req.query.actor as string | undefined;
    const action = req.query.action as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const logs = await prisma.auditLog.findMany({
      where: {
        ...(actor ? { actorId: actor } : {}),
        ...(action ? { action: { contains: action, mode: 'insensitive' } } : {}),
        ...(from || to ? {
          createdAt: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          },
        } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, action: true, actorId: true, targetId: true, detail: true, createdAt: true },
    });
    res.json({ data: logs });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/reports?status=&limit=50
router.get('/reports', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const status = req.query.status as string | undefined;
    const reports = await prisma.report.findMany({
      where: { ...(status ? { status: status as any } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, reporterUserId: true, targetUserId: true, reason: true, status: true, createdAt: true, resolvedAt: true },
    });
    res.json({ data: reports });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/bans?limit=50
router.get('/bans', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const bans = await prisma.ban.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, userId: true, bannedById: true, reasonText: true, reasonCategory: true,
        bannedUntil: true, createdAt: true, reversedAt: true,
      },
    });
    res.json({ data: bans });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/moderation-settings
router.get('/moderation-settings', async (_req, res, next) => {
  try {
    const settings = await prisma.moderationSetting.findMany({
      select: { key: true, value: true, updatedAt: true },
    });
    res.json({ data: settings });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/name-blacklist
router.get('/name-blacklist', async (_req, res, next) => {
  try {
    const entries = await prisma.nameBlacklistEntry.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, pattern: true, matchType: true, enabled: true, note: true, createdAt: true },
    });
    res.json({ data: entries });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/community-stats?range=90d
router.get('/community-stats', async (req, res, next) => {
  try {
    const { getCommunityStats } = require('../services/communityStatsService');
    const VALID_RANGES = ['all', '90d', '60d', '30d', '7d', '1d'];
    const range = VALID_RANGES.includes(req.query.range as string)
      ? (req.query.range as string)
      : '90d';
    const stats = await getCommunityStats(range);
    res.json({ data: stats });
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/ws/snapshot
router.get('/ws/snapshot', (_req, res) => {
  try {
    const { snapshotActiveClients } = require('../websocket/handlers');
    res.json({ data: snapshotActiveClients() });
  } catch {
    res.json({ data: { totalClients: 0, totalAdminObservers: 0, clients: [] } });
  }
});

// GET /api/mcp-admin/ws/count
router.get('/ws/count', (_req, res) => {
  try {
    const { getClientCount } = require('../websocket/handlers');
    res.json({ data: { count: getClientCount() } });
  } catch {
    res.json({ data: { count: 0 } });
  }
});

// GET /api/mcp-admin/wiki/search?q=
router.get('/wiki/search', async (req, res, next) => {
  try {
    const { searchWiki } = require('../controllers/wikiController');
    return searchWiki(req, res, next);
  } catch (err) {
    next(err);
  }
});

// GET /api/mcp-admin/camp/search?q=
router.get('/camp/search', async (req, res, next) => {
  try {
    const { searchCamp } = require('../controllers/campController');
    return searchCamp(req, res, next);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATIONS — all require confirm: true in the request body
// ─────────────────────────────────────────────────────────────────────────────

function requireConfirm(req: Request, next: NextFunction): boolean {
  if (req.body?.confirm !== true) {
    next(createError(400, 'confirm: true is required for mutating operations. Show the user what will happen and receive explicit approval before setting confirm: true.'));
    return false;
  }
  return true;
}

// POST /api/mcp-admin/messages/send
router.post('/messages/send', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireConfirm(req, next)) return;
  try {
    const { channelId, content } = req.body || {};
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!content || typeof content !== 'string' || content.trim().length === 0)
      return next(createError(400, 'content is required'));
    if (content.length > 500)
      return next(createError(400, 'Message too long (max 500 chars)'));
    if (!channelId || !UUID_RE.test(channelId))
      return next(createError(400, 'channelId must be a valid UUID'));

    const user = req.user as any;
    if (!user) return next(createError(401, 'MCP user not resolved'));

    // Route through the full governance pipeline (mute, rate-limit, automod, channel validation).
    const result = await ingestMessage({
      userId: user.id,
      channelId,
      rawContent: content.trim(),
      source: 'mcp',
    });

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        muted: 403,
        'rate-limited': 429,
        automod: 403,
        'invalid-content': 400,
        'invalid-channel': 400,
        'channel-not-found': 404,
        'slash-command-dropped': 400,
      };
      const status = statusMap[result.reason ?? ''] ?? 400;
      return next(createError(status, `Message rejected: ${result.reason ?? 'unknown'}`));
    }

    logger.info({ userId: user.id, channelId, messageId: result.messageId }, 'MCP admin message sent');
    res.json({ data: { id: result.messageId, content: content.trim(), channelId } });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mcp-admin/messages/:id
router.delete('/messages/:id', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireConfirm(req, next)) return;
  try {
    const { id } = req.params;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) return next(createError(400, 'id must be a valid UUID'));
    await prisma.message.updateMany({ where: { id }, data: { isDeleted: true } });
    try {
      const { broadcastMessageDeletion } = require('../websocket/handlers');
      broadcastMessageDeletion(id);
    } catch {
      // non-fatal
    }
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp-admin/bans — create ban (no evidence files via MCP — text reason only)
router.post('/bans', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireConfirm(req, next)) return;
  try {
    const { userId, reason, category, expiresAt } = req.body || {};
    if (!userId || typeof userId !== 'string') return next(createError(400, 'userId is required'));
    if (!reason || typeof reason !== 'string') return next(createError(400, 'reason is required'));

    const actor = req.user as any;
    if (!actor) return next(createError(401, 'MCP user not resolved'));

    // Direct write — no evidence required for MCP-issued bans.
    const ban = await prisma.ban.create({
      data: {
        userId,
        bannedById: actor.id,
        reasonCategory: category ?? 'Other',
        reasonText: reason,
        bannedUntil: expiresAt ? new Date(expiresAt) : null,
      },
      select: { id: true, userId: true, reasonCategory: true, reasonText: true, bannedUntil: true, createdAt: true },
    });
    // Reflect isBanned on the user row
    await prisma.user.update({ where: { id: userId }, data: { isBanned: true, bannedUntil: expiresAt ? new Date(expiresAt) : null } });
    res.status(201).json({ data: ban });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp-admin/bans/:id/reverse
router.post('/bans/:id/reverse', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireConfirm(req, next)) return;
  try {
    const { reverseReason } = req.body || {};
    const actor = req.user as any;
    if (!actor) return next(createError(401, 'MCP user not resolved'));
    const { reverseBan } = require('../services/moderationActionsService');
    await reverseBan(req.params.id, actor.id, reverseReason ?? 'Reversed via MCP');
    res.json({ data: { reversed: true } });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp-admin/mutes
router.post('/mutes', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireConfirm(req, next)) return;
  try {
    const { userId, reason, category, durationMinutes } = req.body || {};
    if (!userId || typeof userId !== 'string') return next(createError(400, 'userId is required'));
    if (!reason || typeof reason !== 'string') return next(createError(400, 'reason is required'));
    const actor = req.user as any;
    if (!actor) return next(createError(401, 'MCP user not resolved'));
    const durationMs = typeof durationMinutes === 'number' ? durationMinutes * 60 * 1000 : 60 * 60 * 1000; // default 1h
    const { muteUser } = require('../services/moderationActionsService');
    const result = await muteUser(userId, actor.id, durationMs, category ?? 'Other', reason);
    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mcp-admin/mutes/:userId
router.delete('/mutes/:userId', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireConfirm(req, next)) return;
  try {
    const actor = req.user as any;
    if (!actor) return next(createError(401, 'MCP user not resolved'));
    const { unmuteUser } = require('../services/moderationActionsService');
    await unmuteUser(req.params.userId, actor.id, 'Unmuted via MCP');
    res.json({ data: { unmuted: true } });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp-admin/kicks
router.post('/kicks', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireConfirm(req, next)) return;
  try {
    const { userId, reason } = req.body || {};
    if (!userId || typeof userId !== 'string') return next(createError(400, 'userId is required'));
    if (!reason || typeof reason !== 'string') return next(createError(400, 'reason is required'));
    const actor = req.user as any;
    if (!actor) return next(createError(401, 'MCP user not resolved'));
    const { kickUser } = require('../services/moderationActionsService');
    const result = await kickUser(userId, actor.id, reason);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/mcp-admin/reports/:id — resolve a report
router.patch('/reports/:id', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireConfirm(req, next)) return;
  try {
    const { status, resolution } = req.body || {};
    if (!status || typeof status !== 'string') return next(createError(400, 'status is required'));
    const actor = req.user as any;
    if (!actor) return next(createError(401, 'MCP user not resolved'));
    const report = await prisma.report.update({
      where: { id: req.params.id },
      data: {
        status: status as any,
        notes: resolution ?? undefined,
        resolvedAt: new Date(),
        resolvedBy: actor.id,
      },
      select: { id: true, status: true, notes: true, resolvedAt: true },
    });
    res.json({ data: report });
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp-admin/releases
router.post('/releases', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireConfirm(req, next)) return;
  try {
    const { publishRelease } = require('../controllers/releasesController');
    return publishRelease(req, res, next);
  } catch (err) {
    next(err);
  }
});

// POST /api/mcp-admin/name-blacklist
router.post('/name-blacklist', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireConfirm(req, next)) return;
  try {
    const { pattern, matchType } = req.body || {};
    if (!pattern || typeof pattern !== 'string') return next(createError(400, 'pattern is required'));
    const entry = await prisma.nameBlacklistEntry.create({
      data: { pattern: pattern.trim(), matchType: matchType ?? 'exact' },
      select: { id: true, pattern: true, matchType: true, createdAt: true },
    });
    const { refreshBlacklist } = require('../services/nameBlacklistService');
    await refreshBlacklist().catch((e: unknown) => logger.warn({ e }, 'blacklist refresh failed'));
    res.status(201).json({ data: entry });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/mcp-admin/name-blacklist/:id
router.delete('/name-blacklist/:id', async (req: Request, res: Response, next: NextFunction) => {
  if (!requireConfirm(req, next)) return;
  try {
    await prisma.nameBlacklistEntry.delete({ where: { id: req.params.id } });
    const { refreshBlacklist } = require('../services/nameBlacklistService');
    await refreshBlacklist().catch((e: unknown) => logger.warn({ e }, 'blacklist refresh failed'));
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
module.exports = router;
