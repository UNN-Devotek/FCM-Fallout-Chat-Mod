import { Request, Response, RequestHandler } from 'express';
import { paramStr } from '../utils/reqParams';
import { getRedisClient } from '../config/redis';
import logger from '../config/logger';
import env from '../config/environment';
import { evaluateBuildGate } from '../services/buildLock';
import { getActiveQaVersion } from '../services/activeQaVersion';

export interface QaGrant { token: string; userId: string; displayName: string; role: string; }

export interface QaStatusDeps {
  getActiveQaVersion(): Promise<string | null>;
  readGrant(installToken: string): Promise<QaGrant | null>;
  deleteGrant(installToken: string): Promise<void>;
}

/**
 * GET /api/auth/qa-status/:installToken — polled by the overlay after QA OAuth.
 * Enforces the golden-build lock (426 when stale), then hands back the session
 * grant exactly once.
 */
export function makeQaStatusHandler(deps: QaStatusDeps): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const installToken = paramStr(req, 'installToken');
    if (!installToken) { res.status(400).json({ data: { authorized: false } }); return; }

    const activeVersion = await deps.getActiveQaVersion();
    const gate = evaluateBuildGate(req.headers as Record<string, unknown>, activeVersion, env.QA_BUILD_LOCK);
    if (!gate.allowed) {
      res.status(426).json({
        error: 'OUTDATED_BUILD',
        detail: gate.reason,
        activeVersion,
      });
      return;
    }

    const grant = await deps.readGrant(installToken);
    if (!grant) { res.json({ data: { authorized: false } }); return; }
    await deps.deleteGrant(installToken);
    res.json({ data: { authorized: true, token: grant.token, displayName: grant.displayName, role: grant.role } });
  };
}

export const defaultQaStatusDeps: QaStatusDeps = {
  getActiveQaVersion,
  async readGrant(installToken) {
    try {
      const redis = await getRedisClient();
      const raw = await redis.get(`qa_grant:${installToken}`);
      return raw ? (JSON.parse(raw) as QaGrant) : null;
    } catch (err) {
      logger.warn({ err }, '[qa-status] readGrant failed');
      return null;
    }
  },
  async deleteGrant(installToken) {
    try {
      const redis = await getRedisClient();
      await redis.del(`qa_grant:${installToken}`);
    } catch (err) {
      logger.warn({ err }, '[qa-status] deleteGrant failed');
    }
  },
};
