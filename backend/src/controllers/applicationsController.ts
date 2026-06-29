import { Request, Response, NextFunction } from 'express';
import { paramStr, paramsOf } from '../utils/reqParams';
import prisma from '../config/prisma';

export async function listApplications(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const apps = await prisma.staffApplication.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ data: apps });
  } catch (err) { next(err); }
}

/**
 * Resolve the caller's discordId from either session shape (publicUser or
 * discordUser). Returns null when neither session is present (anonymous public
 * submitter), in which case the application is created without a userId.
 */
function callerDiscordId(req: Request): string | null {
  const sess = req.session as any;
  return sess?.publicUser?.discordId ?? sess?.discordUser?.id ?? null;
}

/**
 * GET /api/applications/mine — the caller's own staff applications.
 * Auth: requireDashboardAuth (req.dashboardUser). Ownership: filtered by the
 * resolved user id, so other applicants' rows are never returned.
 */
export async function listMineApplications(req: Request, res: Response, next: NextFunction): Promise<void> {
  const id = req.dashboardUser;
  if (!id) { res.status(401).json({ title: 'Unauthorized' }); return; }
  try {
    const user = await prisma.user.findFirst({ where: { discordId: id.discordId }, select: { id: true } });
    if (!user) { res.json({ data: [] }); return; }
    const apps = await prisma.staffApplication.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: apps });
  } catch (err) { next(err); }
}

/**
 * GET /api/applications/mine/:id — one of the caller's own applications.
 * 404 if not found OR not owned by the caller.
 */
export async function getMineApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
  const id = req.dashboardUser;
  if (!id) { res.status(401).json({ title: 'Unauthorized' }); return; }
  try {
    const user = await prisma.user.findFirst({ where: { discordId: id.discordId }, select: { id: true } });
    if (!user) { res.status(404).json({ title: 'Not Found' }); return; }
    const app = await prisma.staffApplication.findFirst({
      where: { id: paramStr(req, 'id'), userId: user.id },
    });
    if (!app) { res.status(404).json({ title: 'Not Found' }); return; }
    res.json({ data: app });
  } catch (err) { next(err); }
}

// SR-013: field length caps — prevents unbounded TEXT inserts (DoS)
const APP_LIMITS: Record<string, number> = {
  inGameName: 64, discordTag: 128, age: 8, timezone: 32,
  availability: 256, experience: 2000, motivation: 2000,
};

export async function createApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { inGameName, discordTag, age, timezone, experience, motivation, availability } = req.body;
  if (!inGameName || !discordTag || !age || !timezone || !experience || !motivation || !availability) {
    res.status(422).json({ title: 'Invalid', detail: 'All fields are required.' });
    return;
  }
  // Length validation
  const fields = { inGameName, discordTag, age, timezone, availability, experience, motivation };
  for (const [key, val] of Object.entries(fields)) {
    if (typeof val === 'string' && val.length > (APP_LIMITS[key] ?? 2000)) {
      res.status(422).json({ title: 'Invalid', detail: `Field '${key}' exceeds maximum length.` });
      return;
    }
  }
  try {
    // Link the application to the submitter's User row when a Discord session is
    // present (dashboard dweller OR public-form user) so they can review it from
    // the self-service view. Anonymous submissions stay unlinked (userId null).
    let userId: string | null = null;
    const discordId = callerDiscordId(req);
    if (discordId) {
      const user = await prisma.user.findFirst({ where: { discordId }, select: { id: true } });
      userId = user?.id ?? null;
    }
    const app = await prisma.staffApplication.create({
      data: { inGameName, discordTag, age, timezone, experience, motivation, availability, userId },
    });
    res.status(201).json({ data: app });
  } catch (err) { next(err); }
}

export async function updateApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { id } = paramsOf(req);
  const { status, adminNotes } = req.body;
  try {
    const app = await prisma.staffApplication.update({
      where: { id },
      data: { ...(status && { status }), ...(adminNotes !== undefined && { adminNotes }) },
    });
    res.json({ data: app });
  } catch (err: any) {
    if (err.code === 'P2025') { res.status(404).json({ title: 'Not Found' }); return; }
    next(err);
  }
}
