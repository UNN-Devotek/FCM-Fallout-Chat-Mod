import { Request, Response, NextFunction } from 'express';
import { query as dbQuery } from '../config/database';
import { createError } from '../middleware/errorHandler';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/audit-log?actor=&action=&from=&to=&limit=50&offset=0
 * Filterable audit log -- moderator+
 */
async function listAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { actor, action, from, to } = req.query as Record<string, string | undefined>;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const offset = Math.min(Math.max(parseInt(req.query.offset as string, 10) || 0, 0), 100000);

  if (actor && !UUID_RE.test(actor)) return next(createError(400, 'actor must be a valid UUID'));
  if (from && isNaN(Date.parse(from))) return next(createError(400, 'from must be a valid ISO date'));
  if (to && isNaN(Date.parse(to))) return next(createError(400, 'to must be a valid ISO date'));

  const conditions: string[] = [];
  const params: any[] = [];

  if (actor)  { params.push(actor);  conditions.push(`al.actor_id = $${params.length}`); }
  if (action) { params.push(action); conditions.push(`al.action = $${params.length}`); }
  if (from)   { params.push(from);   conditions.push(`al.created_at >= $${params.length}`); }
  if (to)     { params.push(to);     conditions.push(`al.created_at <= $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(limit, offset);

  try {
    const result = await dbQuery(
      `SELECT al.id, u.username AS actor, al.action, al.target_id, al.target_type, al.reason, al.metadata, al.created_at
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.actor_id
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

/**
 * GET /api/audit-log/export?actor=&action=&from=&to=&format=csv|json
 * Export audit log entries -- admin+ only
 */
async function exportAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { actor, action, from, to } = req.query as Record<string, string | undefined>;
  const format = (req.query.format as string) || 'json';

  if (format !== 'json' && format !== 'csv') return next(createError(400, 'format must be "json" or "csv"'));
  if (actor && !UUID_RE.test(actor)) return next(createError(400, 'actor must be a valid UUID'));
  if (from && isNaN(Date.parse(from))) return next(createError(400, 'from must be a valid ISO date'));
  if (to && isNaN(Date.parse(to))) return next(createError(400, 'to must be a valid ISO date'));

  const conditions: string[] = [];
  const params: any[] = [];

  if (actor)  { params.push(actor);  conditions.push(`al.actor_id = $${params.length}`); }
  if (action) { params.push(action); conditions.push(`al.action = $${params.length}`); }
  if (from)   { params.push(from);   conditions.push(`al.created_at >= $${params.length}`); }
  if (to)     { params.push(to);     conditions.push(`al.created_at <= $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await dbQuery(
      `SELECT al.id, u.username AS actor, al.action, al.target_id, al.target_type, al.reason, al.metadata, al.created_at
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.actor_id
       ${where}
       ORDER BY al.created_at DESC`,
      params
    );

    if (format === 'csv') {
      const header = 'id,actor,action,target_id,target_type,reason,metadata,created_at';
      const rows = result.rows.map((r: any) => {
        const escapeCsv = (val: any): string => {
          if (val == null) return '';
          const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
          return str.includes(',') || str.includes('"') || str.includes('\n')
            ? `"${str.replace(/"/g, '""')}"` : str;
        };
        return [r.id, r.actor, r.action, r.target_id, r.target_type, r.reason, r.metadata, r.created_at]
          .map(escapeCsv).join(',');
      });
      const csv = [header, ...rows].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=audit-log-export.csv');
      res.send(csv);
      return;
    }

    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
}

export { listAuditLogs, exportAuditLogs };
module.exports = { listAuditLogs, exportAuditLogs };
