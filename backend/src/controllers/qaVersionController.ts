import { Request, Response, NextFunction } from 'express';
import { setActiveQaVersion, getActiveQaVersion } from '../services/activeQaVersion';

/** POST /api/admin/qa/active-version  { version } -> flip the active golden build. */
async function setQaActiveVersion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const version = String((req.body && req.body.version) || '').trim();
    if (!version) {
      res.status(400).json({ error: 'A non-empty `version` is required.' });
      return;
    }
    await setActiveQaVersion(version);
    res.json({ data: { activeVersion: version } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/qa/active-version -> the current active golden build version. */
async function getQaActiveVersion(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const activeVersion = await getActiveQaVersion();
    res.json({ data: { activeVersion } });
  } catch (err) {
    next(err);
  }
}

export { setQaActiveVersion, getQaActiveVersion };
module.exports = { setQaActiveVersion, getQaActiveVersion };
