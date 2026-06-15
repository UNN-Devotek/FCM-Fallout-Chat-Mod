import { Request, Response, NextFunction } from 'express';
import { query as dbQuery } from '../config/database';

// Actions safe to show publicly — internal admin actions excluded
const PUBLIC_ACTIONS = ['ban', 'warn', 'mute', 'kick', 'unmute', 'unban', 'message_deleted'];

/**
 * GET /api/public/moderation-log
 * Public sanitized moderation feed. No auth required.
 * Returns only public-safe actions. Metadata is stripped to channelId/channelName/duration only.
 *
 * Query params:
 *   search    - partial match on actor or target username
 *   channelId - UUID of channel to filter by (stored in metadata)
 *   limit     - max 50, default 50
 *   offset    - default 0
 */
async function publicModerationLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { search, channelId } = req.query as Record<string, string | undefined>;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 50);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

  const conditions: string[] = [`al.action = ANY($1)`];
  const params: any[] = [PUBLIC_ACTIONS];

  if (search) {
    params.push(`%${search.replace(/[%_]/g, '\\$&')}%`);
    const n = params.length;
    conditions.push(`(actor.username ILIKE $${n} OR target.username ILIKE $${n})`);
  }

  if (channelId) {
    params.push(channelId);
    conditions.push(`al.metadata->>'channelId' = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  params.push(limit, offset);

  try {
    const result = await dbQuery(
      `SELECT
         al.id,
         al.action,
         al.reason,
         al.created_at,
         actor.username   AS actor,
         target.username  AS target,
         al.metadata->>'channelId'   AS "channelId",
         al.metadata->>'channelName' AS "channelName",
         al.metadata->>'duration'    AS duration
       FROM audit_logs al
       LEFT JOIN users actor  ON actor.id  = al.actor_id
       LEFT JOIN users target ON target.id = al.target_id::uuid
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
}

export { publicModerationLog };
module.exports = { publicModerationLog };
