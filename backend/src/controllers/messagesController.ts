import { Request, Response, NextFunction } from 'express';
import { paramStr } from '../utils/reqParams';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../config/prisma';
import { createError } from '../middleware/errorHandler';
import { relayToDiscord } from '../services/discordService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/messages?channelId=&limit=50&offset=0
 */
async function listMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  const channelId = req.query.channelId as string;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
  const offset = Math.min(Math.max(parseInt(req.query.offset as string, 10) || 0, 0), 10000);

  if (!channelId) return next(createError(400, 'channelId query parameter is required'));
  if (!UUID_RE.test(channelId)) return next(createError(400, 'channelId must be a valid UUID'));

  try {
    const messages = await prisma.$queryRaw<any[]>`
      SELECT m.id, m.content, u.username, u.discord_display_name, u.discord_username, m.user_id, m.channel_id, m.source, m.created_at
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = ${channelId}::uuid AND NOT m.is_deleted
      ORDER BY m.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`;

    // Prefer the FO76 in-game name; placeholder usernames (pending-*, Overlay\d+, discord:) fall through to Discord fields.
    const isPlaceholder = (n: string | null | undefined) =>
      !n || n === 'Wanderer' || n.startsWith('pending-') || /^overlay\d+$/i.test(n) || n.startsWith('discord:');
    const transformed = messages.map((row: any) => {
      const displayName = !isPlaceholder(row.username)
        ? row.username
        : (row.discord_display_name || row.discord_username || row.username || 'Wanderer');
      const { discord_username, discord_display_name, username, ...rest } = row;
      return { ...rest, username: displayName };
    });
    res.json({ data: transformed });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/messages -- send a message as the authenticated admin user
 * Body: { content: string, channelId: string }
 */
async function createMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { content, channelId } = req.body || {};

  if (!content || typeof content !== 'string' || content.trim().length === 0)
    return next(createError(400, 'content is required'));
  if (content.length > 500)
    return next(createError(400, 'Message too long (max 500 chars)'));
  if (!channelId || !UUID_RE.test(channelId))
    return next(createError(400, 'channelId must be a valid UUID'));

  try {
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, isArchived: false },
      select: { id: true },
    });
    if (!channel) return next(createError(404, 'Channel not found'));

    const messageId = uuidv4();
    const createdAt = new Date().toISOString();
    const username = req.adminUser.username;

    if ((global as any).broadcast) {
      (global as any).broadcast({
        type: 'chat:message',
        payload: { id: messageId, content: content.trim(), username, userId: null, channelId, source: 'admin', timestamp: createdAt },
      });
    }

    // Admin messages are live-broadcast and Discord-relayed only — no DB row.
    relayToDiscord(channelId, username, content.trim()).catch(() => {});

    res.status(201).json({ data: { id: messageId } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/messages/scrub -- admin+
 * Body: { messageIds: [array of message UUIDs] }
 * Replaces message content with '[REDACTED]' for PII removal.
 */
async function scrubMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { messageIds } = req.body || {};

  if (!Array.isArray(messageIds) || messageIds.length === 0)
    return next(createError(400, 'messageIds must be a non-empty array'));
  if (messageIds.length > 100)
    return next(createError(400, 'Cannot scrub more than 100 messages at once'));
  if (!messageIds.every((id: string) => UUID_RE.test(id)))
    return next(createError(400, 'All messageIds must be valid UUIDs'));

  try {
    const result = await prisma.$executeRaw`
      UPDATE messages SET content = '[REDACTED]' WHERE id = ANY(${messageIds}::uuid[]) AND content != '[REDACTED]'`;

    const count = result;

    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || null,
        action: 'scrub_messages',
        targetType: 'message',
        metadata: { count, messageIds },
      },
    });

    res.json({ data: { scrubbed: count } });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/messages/:id -- moderator+
 */
async function deleteMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!UUID_RE.test(paramStr(req, 'id'))) return next(createError(400, 'Invalid message ID format'));
  try {
    // Raw query required — Message has a composite PK.
    const result = await prisma.$executeRaw`
      UPDATE messages SET is_deleted = TRUE WHERE id = ${paramStr(req, 'id')}::uuid AND NOT is_deleted`;

    if (result === 0) return next(createError(404, 'Message not found'));
    await prisma.auditLog.create({
      data: {
        actorId: req.adminUser?.id || null,
        action: 'delete_message',
        targetId: paramStr(req, 'id'),
        targetType: 'message',
      },
    });
    if ((global as any).broadcastMessageDeletion) {
      (global as any).broadcastMessageDeletion(paramStr(req, 'id'));
    }
    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/messages/search?q=&limit=50&offset=0
 * Admin-only full-text search across all channels.
 */
async function searchMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  const q = ((req.query.q as string) || '').trim();
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const offset = Math.min(Math.max(parseInt(req.query.offset as string, 10) || 0, 0), 10000);

  if (!q) return next(createError(400, 'q query parameter is required'));
  if (q.length > 200) return next(createError(400, 'Search query too long'));

  const pattern = `%${q}%`;

  try {
    const channelMsgs = await prisma.$queryRaw<any[]>`
      SELECT
        m.id::text AS id,
        m.content,
        CASE
          WHEN u.username IS NOT NULL
            AND u.username <> 'Wanderer'
            AND u.username <> ''
            AND u.username !~ '^(pending-|discord:|[Oo]verlay[0-9])'
          THEN u.username
          ELSE COALESCE(u.discord_display_name, u.discord_username, 'Wanderer')
        END AS username,
        m.user_id AS "userId",
        m.channel_id::text AS "channelId",
        c.name AS "channelName",
        m.source,
        m.created_at AS timestamp,
        'channel' AS "msgType"
      FROM messages m
      JOIN users u ON u.id = m.user_id
      JOIN channels c ON c.id = m.channel_id
      WHERE NOT m.is_deleted
        AND m.content ILIKE ${pattern}
      ORDER BY m.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`;

    res.json({ data: channelMsgs, total: channelMsgs.length, q });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/messages/public?channelId=&limit=40
 * Public read-only feed — no auth required. Max 50 messages.
 * Only real (UUID) channel IDs accepted; virtual server channels are excluded.
 */
async function listPublicMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  const channelId = req.query.channelId as string;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 40, 50);

  if (!channelId) return next(createError(400, 'channelId query parameter is required'));
  if (!UUID_RE.test(channelId)) return next(createError(400, 'channelId must be a valid UUID'));

  try {
    const messages = await prisma.$queryRaw<any[]>`
      SELECT m.id, m.content, u.username, u.discord_display_name, u.discord_username, m.source, m.created_at
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = ${channelId}::uuid AND NOT m.is_deleted
      ORDER BY m.created_at DESC
      LIMIT ${limit}`;

    const isPlaceholderPub = (n: string | null | undefined) =>
      !n || n === 'Wanderer' || n.startsWith('pending-') || /^overlay\d+$/i.test(n) || n.startsWith('discord:');
    const transformed = messages.reverse().map((row: any) => {
      const displayName = !isPlaceholderPub(row.username)
        ? row.username
        : (row.discord_display_name || row.discord_username || row.username || 'Wanderer');
      return { id: row.id, content: row.content, username: displayName, source: row.source, channelId: row.channel_id, createdAt: row.created_at };
    });
    res.json({ data: transformed });
  } catch (err) {
    next(err);
  }
}

export { listMessages, createMessage, scrubMessages, deleteMessage, searchMessages, listPublicMessages };
module.exports = { listMessages, createMessage, scrubMessages, deleteMessage, searchMessages, listPublicMessages };
