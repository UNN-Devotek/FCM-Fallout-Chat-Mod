import { resolveInternalActorId } from '../utils/resolveActorId';
import { isPrismaAtomicRefusal, isRowCountNoChange, runRequiredBundle, runRequiredMutation, runRequiredTransaction } from '../lib/requiredEffects';
import { Request, Response, NextFunction } from 'express';
import { paramStr } from '../utils/reqParams';
import prisma from '../config/prisma';
import { createError } from '../middleware/errorHandler';
import logger from '../config/logger';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/channels -- public
 * Returns hierarchical channel tree: main channels with nested children.
 * Returns only static channels. Desktop world detection/virtual Server injection
 * was removed; native relay rooms do not enter this public channel tree.
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
  return runRequiredBundle('domain', 'channelsController:e85eb1f13035', async () => {
  const { name, color, parentId, sortOrder, discordRelay, discordChannelId, allowGifs, allowEmojis } = req.body;
  try {
    const actorId = await resolveInternalActorId(req.adminUser?.id);
    // Validate parentId exists if provided
    if (parentId) {
      if (!UUID_RE.test(parentId)) return next(createError(400, 'Invalid parentId format'));
      const parent = await prisma.channel.findUnique({ where: { id: parentId } });
      if (!parent) return next(createError(404, 'Parent channel not found'));
      if (parent.parentId) return next(createError(400, 'Sub-channels cannot have sub-channels (max 2 levels)'));
    }

    const channel = await runRequiredMutation('domain', '734f87352544bfcd5f18cd90', { stage: 'primary-write-unconfirmed' }, () => prisma.channel.create({
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
    }), isPrismaAtomicRefusal, undefined, undefined);
    await runRequiredMutation('audit', '1487cd7b5abc26b480afd1a2', { stage: 'primary-write-unconfirmed', targetId: channel.id }, () => prisma.auditLog.create({
      data: {
        actorId,
        action: 'create_channel',
        targetId: channel.id,
        targetType: 'channel',
        metadata: { name, parentId: parentId || null },
      },
    }), undefined, undefined, undefined);
    try {
      if ((global as any).broadcastChannelUpdate) (global as any).broadcastChannelUpdate('created', channel);
    } catch { /* non-fatal — channel is created; clients will re-sync on next poll */ }
    res.status(201).json({ data: channel });
  } catch (err) {
    next(err);
  }

  });
}

/**
 * PATCH /api/channels/:id -- admin+
 */
async function updateChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
  return runRequiredBundle('domain', 'channelsController:92840f6cd162', async () => {
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
    const channel = await runRequiredMutation('domain', '85effc6afe89342c7bca7ea1', { stage: 'primary-write-unconfirmed' }, () => prisma.channel.updateMany({
      where: { id: paramStr(req, 'id'), isArchived: false },
      data,
    }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);
    if (channel.count === 0) return next(createError(404, 'Channel not found'));

    const updated = await prisma.channel.findUnique({ where: { id: paramStr(req, 'id') } });
    try {
      if ((global as any).broadcastChannelUpdate) (global as any).broadcastChannelUpdate('updated', updated);
    } catch { /* non-fatal */ }
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }

  });
}

/**
 * DELETE /api/channels/:id -- owner only
 * Archives the channel; preserves history.
 */
async function archiveChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
  return runRequiredBundle('domain', 'channelsController:d3f7499688d0', async () => {
  if (!UUID_RE.test(paramStr(req, 'id'))) return next(createError(400, 'Invalid channel ID format'));
  try {
    const actorId = await resolveInternalActorId(req.adminUser?.id);
    const result = await runRequiredMutation('domain', 'd699e491a2e4e4cc9a957d80', { stage: 'primary-write-unconfirmed' }, () => prisma.channel.updateMany({
      where: { id: paramStr(req, 'id'), isArchived: false },
      data: { isArchived: true },
    }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);
    if (result.count === 0) return next(createError(404, 'Channel not found'));
    // Also archive children
    await runRequiredMutation('domain', 'bd33a2b1fc680e6c2ff0ca05', { stage: 'primary-write-unconfirmed' }, () => prisma.channel.updateMany({
      where: { parentId: paramStr(req, 'id'), isArchived: false },
      data: { isArchived: true },
    }), isPrismaAtomicRefusal, undefined, isRowCountNoChange);
    await runRequiredMutation('audit', '97e81050be6489c8dcbc3b64', { stage: 'primary-write-unconfirmed' }, () => prisma.auditLog.create({
      data: {
        actorId,
        action: 'archive_channel',
        targetId: paramStr(req, 'id'),
        targetType: 'channel',
      },
    }), undefined, undefined, undefined);
    try {
      if ((global as any).broadcastChannelUpdate) (global as any).broadcastChannelUpdate('archived', { id: paramStr(req, 'id') });
    } catch { /* non-fatal */ }
    res.json({ data: { archived: true } });
  } catch (err) {
    next(err);
  }

  });
}

/**
 * DELETE /api/channels/:id/permanent -- owner only
 * Hard-deletes the channel and all its messages. Irreversible.
 */
async function deleteChannelPermanently(req: Request, res: Response, next: NextFunction): Promise<void> {
  return runRequiredBundle('domain', 'channelsController:b1e9ddfc1309', async () => {
  if (!UUID_RE.test(paramStr(req, 'id'))) return next(createError(400, 'Invalid channel ID format'));
  try {
    const actorId = await resolveInternalActorId(req.adminUser?.id);
    const channel = await prisma.channel.findUnique({ where: { id: paramStr(req, 'id') } });
    if (!channel) return next(createError(404, 'Channel not found'));

    // Collect IDs to delete: the channel itself plus any children
    const childIds = (await prisma.channel.findMany({
      where: { parentId: paramStr(req, 'id') },
      select: { id: true },
    })).map(c => c.id);
    const allIds = [paramStr(req, 'id'), ...childIds];

    await runRequiredTransaction('domain', '3ff42302673d6612ce6fb10d', { stage: 'transaction-completion-unconfirmed' }, () => prisma.$transaction([
      // Messages have onDelete: Restrict — delete them first
      prisma.message.deleteMany({ where: { channelId: { in: allIds } } }),
      // Children (DiscordRelayMapping cascades automatically)
      prisma.channel.deleteMany({ where: { id: { in: childIds } } }),
      // Parent channel
      prisma.channel.delete({ where: { id: paramStr(req, 'id') } }),
    ]), { confirmedRollback: isPrismaAtomicRefusal, lazyArray: true, confirmedNoChange: replies => replies.every(isRowCountNoChange) });

    await runRequiredMutation('audit', '5b1044e7acf29c95d4642c8f', { stage: 'primary-write-unconfirmed' }, () => prisma.auditLog.create({
      data: {
        actorId,
        action: 'delete_channel',
        targetId: paramStr(req, 'id'),
        targetType: 'channel',
        metadata: { name: channel.name, childCount: childIds.length },
      },
    }), undefined, undefined, undefined);
    try {
      if ((global as any).broadcastChannelUpdate) (global as any).broadcastChannelUpdate('deleted', { id: paramStr(req, 'id') });
    } catch { /* non-fatal */ }
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }

  });
}

export { listChannels, createChannel, updateChannel, archiveChannel, deleteChannelPermanently };
module.exports = { listChannels, createChannel, updateChannel, archiveChannel, deleteChannelPermanently };
