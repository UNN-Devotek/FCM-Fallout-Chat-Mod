import { Request, Response, NextFunction } from 'express';
import { paramStr } from '../utils/reqParams';
import prisma from '../config/prisma';
import { createError } from '../middleware/errorHandler';
import logger from '../config/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/channels -- public
 * Returns hierarchical channel tree: main channels with nested children.
 * If the requesting user has a serverEndpoint, injects a virtual "Server"
 * channel at sortOrder -1 that scopes to that endpoint only.
 */
async function listChannels(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const channels = await prisma.channel.findMany({
      where: { isArchived: false },
      select: {
        id: true, name: true, color: true, parentId: true, sortOrder: true,
        discordRelay: true, discordChannelId: true, allowGifs: true, allowEmojis: true,
        children: {
          where: { isArchived: false },
          select: { id: true, name: true, color: true, parentId: true, sortOrder: true, discordRelay: true, discordChannelId: true, allowGifs: true, allowEmojis: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });
    const tree = channels.filter(c => c.parentId === null);
    res.json({ data: tree });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/channels -- admin+
 * Body: { name, color?, parentId?, sortOrder?, discordRelay?, discordChannelId? }
 */
async function createChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { name, color, parentId, sortOrder, discordRelay, discordChannelId, allowGifs, allowEmojis } = req.body;
  try {
    // Validate parentId exists if provided
    if (parentId) {
      if (!UUID_RE.test(parentId)) return next(createError(400, 'Invalid parentId format'));
      const parent = await prisma.channel.findUnique({ where: { id: parentId } });
      if (!parent) return next(createError(404, 'Parent channel not found'));
      if (parent.parentId) return next(createError(400, 'Sub-channels cannot have sub-channels (max 2 levels)'));
    }

    const channel = await prisma.channel.create({
      data: {
        name,
        color,
        parentId: parentId || null,
        sortOrder: sortOrder ?? 0,
        discordRelay,
        discordChannelId: discordChannelId || null,
        allowGifs: allowGifs === true,            // GIFs default OFF
        allowEmojis: allowEmojis !== false,       // emojis default ON
      },
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || null,
        action: 'create_channel',
        targetId: channel.id,
        targetType: 'channel',
        metadata: { name, parentId: parentId || null },
      },
    });
    try {
      if ((global as any).broadcastChannelUpdate) (global as any).broadcastChannelUpdate('created', channel);
    } catch { /* non-fatal — channel is created; clients will re-sync on next poll */ }
    res.status(201).json({ data: channel });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/channels/:id -- admin+
 */
async function updateChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!UUID_RE.test(paramStr(req, 'id'))) return next(createError(400, 'Invalid channel ID format'));

  const data: any = {};
  if (req.body.name !== undefined) data.name = req.body.name;
  if (req.body.color !== undefined) data.color = req.body.color;
  if (req.body.parentId !== undefined) data.parentId = req.body.parentId || null;
  if (req.body.sortOrder !== undefined) data.sortOrder = req.body.sortOrder;
  if (req.body.discordRelay !== undefined) data.discordRelay = req.body.discordRelay;
  if (req.body.discordChannelId !== undefined) data.discordChannelId = req.body.discordChannelId;
  if (req.body.allowGifs !== undefined) data.allowGifs = req.body.allowGifs === true;
  if (req.body.allowEmojis !== undefined) data.allowEmojis = req.body.allowEmojis === true;

  if (Object.keys(data).length === 0) return next(createError(400, 'No fields to update'));

  try {
    const channel = await prisma.channel.updateMany({
      where: { id: paramStr(req, 'id'), isArchived: false },
      data,
    });
    if (channel.count === 0) return next(createError(404, 'Channel not found'));

    const updated = await prisma.channel.findUnique({ where: { id: paramStr(req, 'id') } });
    try {
      if ((global as any).broadcastChannelUpdate) (global as any).broadcastChannelUpdate('updated', updated);
    } catch { /* non-fatal */ }
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/channels/:id -- owner only
 * Archives the channel; preserves history.
 */
async function archiveChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!UUID_RE.test(paramStr(req, 'id'))) return next(createError(400, 'Invalid channel ID format'));
  try {
    const result = await prisma.channel.updateMany({
      where: { id: paramStr(req, 'id'), isArchived: false },
      data: { isArchived: true },
    });
    if (result.count === 0) return next(createError(404, 'Channel not found'));
    // Also archive children
    await prisma.channel.updateMany({
      where: { parentId: paramStr(req, 'id'), isArchived: false },
      data: { isArchived: true },
    });
    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || null,
        action: 'archive_channel',
        targetId: paramStr(req, 'id'),
        targetType: 'channel',
      },
    });
    try {
      if ((global as any).broadcastChannelUpdate) (global as any).broadcastChannelUpdate('archived', { id: paramStr(req, 'id') });
    } catch { /* non-fatal */ }
    res.json({ data: { archived: true } });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/channels/:id/permanent -- owner only
 * Hard-deletes the channel and all its messages. Irreversible.
 */
async function deleteChannelPermanently(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!UUID_RE.test(paramStr(req, 'id'))) return next(createError(400, 'Invalid channel ID format'));
  try {
    const channel = await prisma.channel.findUnique({ where: { id: paramStr(req, 'id') } });
    if (!channel) return next(createError(404, 'Channel not found'));

    // Collect IDs to delete: the channel itself plus any children
    const childIds = (await prisma.channel.findMany({
      where: { parentId: paramStr(req, 'id') },
      select: { id: true },
    })).map(c => c.id);
    const allIds = [paramStr(req, 'id'), ...childIds];

    await prisma.$transaction([
      // Messages have onDelete: Restrict — delete them first
      prisma.message.deleteMany({ where: { channelId: { in: allIds } } }),
      // Children (DiscordRelayMapping cascades automatically)
      prisma.channel.deleteMany({ where: { id: { in: childIds } } }),
      // Parent channel
      prisma.channel.delete({ where: { id: paramStr(req, 'id') } }),
    ]);

    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || null,
        action: 'delete_channel',
        targetId: paramStr(req, 'id'),
        targetType: 'channel',
        metadata: { name: channel.name, childCount: childIds.length },
      },
    });
    try {
      if ((global as any).broadcastChannelUpdate) (global as any).broadcastChannelUpdate('deleted', { id: paramStr(req, 'id') });
    } catch { /* non-fatal */ }
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
}

export { listChannels, createChannel, updateChannel, archiveChannel, deleteChannelPermanently };
module.exports = { listChannels, createChannel, updateChannel, archiveChannel, deleteChannelPermanently };
