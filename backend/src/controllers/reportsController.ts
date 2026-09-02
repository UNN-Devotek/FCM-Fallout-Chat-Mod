import { Request, Response, NextFunction } from 'express';
import { paramStr } from '../utils/reqParams';
import prisma from '../config/prisma';
import { query as dbQuery } from '../config/database';
import { createError } from '../middleware/errorHandler';
import { postModAlert } from '../services/discordService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_REPORT_STATUSES = ['open', 'resolved', 'dismissed', 'escalated'];

/**
 * POST /api/reports -- authenticated game client
 */
async function submitReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { targetUserId, messageId, reason, notes } = req.body;
  try {
    // Compare case-insensitively: targetUserId is Joi .uuid()-validated but NOT
    // case-normalized, so an uppercased copy of the caller's own id would slip a
    // case-sensitive === check while Postgres canonicalizes it to lowercase on insert.
    if (String(req.user.id).toLowerCase() === String(targetUserId).toLowerCase()) {
      return next(createError(400, 'You cannot report yourself'));
    }
    // Use raw transaction for the message lock (FOR SHARE) -- Prisma doesn't support row-level locks
    const report = await prisma.$transaction(async (tx) => {
      if (messageId) {
        // FOR SHARE locks the row, preventing concurrent soft-deletes from racing
        const msgCheck = await tx.$queryRaw<any[]>`
          SELECT id FROM messages WHERE id = ${messageId}::uuid AND NOT is_deleted FOR SHARE`;
        if (msgCheck.length === 0) {
          const err: any = new Error('Referenced message not found or already deleted');
          err.status = 404;
          throw err;
        }
      }
      return await tx.report.create({
        data: {
          reporterUserId: req.user.id,
          targetUserId,
          messageId: messageId || null,
          reason,
          notes: notes || null,
        },
        select: { id: true, createdAt: true },
      });
    });

    if ((global as any).broadcastReportAlert) {
      (global as any).broadcastReportAlert({ id: report.id, createdAt: report.createdAt, reason });
    }

    // Mod-log Discord alert (fire-and-forget — never throws)
    try {
      const [reporter, target] = await Promise.all([
        prisma.user.findUnique({ where: { id: req.user.id }, select: { username: true, discordUsername: true } }),
        prisma.user.findUnique({ where: { id: targetUserId }, select: { username: true, discordUsername: true } }),
      ]);
      const reporterName = reporter?.username || reporter?.discordUsername || req.user.id;
      const targetName = target?.username || target?.discordUsername || targetUserId;
      postModAlert({
        title: '🚩 User Report Submitted',
        color: '#FF8C00',
        fields: [
          { name: 'Reporter', value: reporterName, inline: true },
          { name: 'Reported User', value: targetName, inline: true },
          { name: 'Reason', value: (reason || 'No reason').slice(0, 1024) },
          ...(notes ? [{ name: 'Notes', value: (notes as string).slice(0, 1024) }] : []),
          ...(messageId ? [{ name: 'Message ID', value: messageId, inline: true }] : []),
        ],
        timestamp: true,
        footerText: `Report ID: ${report.id}`,
      }).catch(() => {});
    } catch { /* non-fatal */ }

    res.status(201).json({ data: report });
  } catch (err: any) {
    if (err.status === 404) return next(createError(404, err.message));
    next(err);
  }
}

/**
 * GET /api/reports -- moderator+
 * Supports ?status=, ?limit=, ?offset= for pagination
 */
async function listReports(req: Request, res: Response, next: NextFunction): Promise<void> {
  const status = req.query.status as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

  if (status && !VALID_REPORT_STATUSES.includes(status)) {
    return next(createError(400, `status must be one of: ${VALID_REPORT_STATUSES.join(', ')}`));
  }

  try {
    const params: any[] = [];
    let where = 'TRUE';

    if (status) {
      params.push(status);
      where = `r.status = $${params.length}`;
    }

    params.push(limit, offset);

    const result = await dbQuery(
      `SELECT r.id, r.reason, r.notes, r.status, r.created_at,
              u_rep.username AS reporter_username,
              u_tgt.username AS target_username,
              r.message_id
       FROM reports r
       JOIN users u_rep ON u_rep.id = r.reporter_user_id
       JOIN users u_tgt ON u_tgt.id = r.target_user_id
       WHERE ${where}
       ORDER BY r.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/reports/:id -- with surrounding message context (5 before + 5 after)
 */
async function getReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!UUID_RE.test(paramStr(req, 'id'))) return next(createError(400, 'Invalid report ID format'));
  try {
    const report = await prisma.report.findUnique({
      where: { id: paramStr(req, 'id') },
    });
    if (!report) return next(createError(404, 'Report not found'));

    let context: any[] = [];

    if (report.messageId) {
      // Fetch the flagged message's timestamp, then retrieve surrounding context via UNION.
      const flagged = await dbQuery(
        'SELECT channel_id, created_at FROM messages WHERE id = $1',
        [report.messageId]
      );
      if (flagged.rows.length > 0) {
        const { channel_id, created_at } = flagged.rows[0];
        const ctxResult = await dbQuery(
          `(SELECT m.id, m.content, u.username, m.created_at, 'flagged' AS role
            FROM messages m JOIN users u ON u.id = m.user_id
            WHERE m.id = $3 AND NOT m.is_deleted)
           UNION ALL
           (SELECT m.id, m.content, u.username, m.created_at, 'context' AS role
            FROM messages m JOIN users u ON u.id = m.user_id
            WHERE m.channel_id = $1 AND m.created_at < $2 AND NOT m.is_deleted
            ORDER BY m.created_at DESC LIMIT 5)
           UNION ALL
           (SELECT m.id, m.content, u.username, m.created_at, 'context' AS role
            FROM messages m JOIN users u ON u.id = m.user_id
            WHERE m.channel_id = $1 AND m.created_at > $2 AND NOT m.is_deleted
            ORDER BY m.created_at ASC LIMIT 5)
           ORDER BY created_at`,
          [channel_id, created_at, report.messageId]
        );
        context = ctxResult.rows;
      }
    }

    res.json({ data: { report, context } });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/reports/:id -- moderator+
 */
async function resolveReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!UUID_RE.test(paramStr(req, 'id'))) return next(createError(400, 'Invalid report ID format'));
  const { status } = req.body;
  try {
    const result = await dbQuery(
      `UPDATE reports
       SET status = $1, resolved_by = $2,
           resolved_at = CASE WHEN $1 IN ('resolved', 'dismissed') THEN NOW() ELSE resolved_at END
       WHERE id = $3 RETURNING *`,
      [status, req.adminUser?.id || null, paramStr(req, 'id')]
    );
    if (result.rows.length === 0) return next(createError(404, 'Report not found'));
    // Notify all admin observers that a report status changed
    if ((global as any).broadcastReportAlert) {
      (global as any).broadcastReportAlert({ ...result.rows[0], _event: 'report-updated' });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    next(err);
  }
}

export { submitReport, listReports, getReport, resolveReport };
module.exports = { submitReport, listReports, getReport, resolveReport };
