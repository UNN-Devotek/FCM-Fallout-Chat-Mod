import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../config/prisma';
import { uploadReportImages, ImageUploadError } from '../services/reportImageService';
import env from '../config/environment';
import { postModAlert } from '../services/discordService';

const CONTENT_MAX = 2000; // SR-002: hard cap on report content length

const VALID_REPORT_TYPES = new Set(['player', 'bug']);

export async function listPlayerReports(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const typeParam = req.query.type as string | undefined;
    const typeFilter = typeParam && VALID_REPORT_TYPES.has(typeParam) ? typeParam : undefined;
    const reports = await prisma.playerReport.findMany({
      where: typeFilter ? { reportType: typeFilter } : undefined,
      include: { user: { select: { username: true, discordUsername: true, discordAvatar: true, discordDisplayName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: reports });
  } catch (err) { next(err); }
}

const VALID_REPORT_STATUSES = new Set(['open', 'reviewed', 'closed']);
const VALID_REPORT_TYPES_CREATE = new Set(['player', 'bug']);

export async function updatePlayerReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { id } = req.params;
  const { status } = req.body;
  // SR-007: constrain status to known enum values
  if (status !== undefined && !VALID_REPORT_STATUSES.has(status)) {
    res.status(422).json({ title: 'Invalid', detail: `Status must be one of: ${[...VALID_REPORT_STATUSES].join(', ')}.` });
    return;
  }
  try {
    const report = await prisma.playerReport.update({
      where: { id },
      data: { ...(status && { status }) },
    });
    res.json({ data: report });
  } catch (err: any) {
    if (err.code === 'P2025') { res.status(404).json({ title: 'Not Found' }); return; }
    next(err);
  }
}

/**
 * Resolve (or lazily create) the game User row for a Discord identity. Mirrors
 * the upsert that createPlayerReportWeb has always used for public-form users so
 * that dashboard dwellers and public submitters end up on the same User row.
 */
async function resolveUserByDiscordId(id: {
  discordId: string;
  username?: string;
  discordDisplayName?: string | null;
  avatar?: string | null;
}) {
  let user = await prisma.user.findFirst({ where: { discordId: id.discordId } });
  if (!user) {
    // SR-004: use discordId as the username slug for new users — Discord display
    // names are NOT unique and would trip the UNIQUE(username) constraint.
    user = await prisma.user.create({
      data: {
        username: `discord:${id.discordId}`,
        installToken: crypto.randomUUID(),
        discordId: id.discordId,
        discordUsername: id.username ?? null,
        discordDisplayName: id.discordDisplayName ?? null,
        discordAvatar: id.avatar || null,
      },
    });
  }
  return user;
}

/**
 * GET /api/player-reports/mine?type=player|bug
 * Returns ONLY the caller's own reports. Auth: dashboard or public Discord
 * session (req.dashboardUser). Ownership: filtered by the resolved user id.
 */
export async function listMinePlayerReports(req: Request, res: Response, next: NextFunction): Promise<void> {
  const id = req.dashboardUser;
  if (!id) { res.status(401).json({ title: 'Unauthorized' }); return; }
  try {
    const user = await prisma.user.findFirst({ where: { discordId: id.discordId }, select: { id: true } });
    if (!user) { res.json({ data: [] }); return; }
    const typeParam = req.query.type as string | undefined;
    const typeFilter = typeParam && VALID_REPORT_TYPES.has(typeParam) ? typeParam : undefined;
    const reports = await prisma.playerReport.findMany({
      where: { userId: user.id, ...(typeFilter ? { reportType: typeFilter } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: reports });
  } catch (err) { next(err); }
}

/**
 * GET /api/player-reports/mine/:id — one of the caller's own reports.
 * 404 if it doesn't exist OR isn't owned by the caller (no ownership leak).
 */
export async function getMinePlayerReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  const id = req.dashboardUser;
  if (!id) { res.status(401).json({ title: 'Unauthorized' }); return; }
  try {
    const user = await prisma.user.findFirst({ where: { discordId: id.discordId }, select: { id: true } });
    if (!user) { res.status(404).json({ title: 'Not Found' }); return; }
    const report = await prisma.playerReport.findFirst({
      where: { id: req.params.id, userId: user.id },
    });
    if (!report) { res.status(404).json({ title: 'Not Found' }); return; }
    res.json({ data: report });
  } catch (err) { next(err); }
}

export async function createPlayerReportWeb(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Accept either a public-form session (req.publicUser) or a dashboard session
  // (req.dashboardUser). The route's requireDashboardAuth sets the latter.
  const pub = req.dashboardUser ?? (req as any).publicUser;
  if (!pub?.discordId) { res.status(401).json({ title: 'Unauthorized', detail: 'Sign in first.' }); return; }
  const { content, involvedPlayers, reportType } = req.body;
  if (!content?.trim()) { res.status(422).json({ title: 'Invalid', detail: 'Report content required.' }); return; }

  const reportTypeSafe = typeof reportType === 'string' && VALID_REPORT_TYPES_CREATE.has(reportType) ? reportType : 'player';

  // SR-002: server-side content length cap (client limit is advisory only)
  if (typeof content === 'string' && content.trim().length > CONTENT_MAX) {
    res.status(422).json({ title: 'Invalid', detail: `Report content must be ${CONTENT_MAX} characters or fewer.` });
    return;
  }

  // Sanitize involvedPlayers: plain text only, no HTML, capped at 500 chars
  const involvedSafe = typeof involvedPlayers === 'string'
    ? involvedPlayers.replace(/[<>"'&;\\]/g, '').slice(0, 500).trim() || null
    : null;

  try {
    const user = await resolveUserByDiscordId({
      discordId: pub.discordId,
      username: pub.username,
      discordDisplayName: pub.discordDisplayName ?? null,
      avatar: pub.avatar ?? null,
    });

    // SR-001: validate imageUrls against our own MinIO origin — reject any external URLs
    const minioBase = (env.MINIO_PUBLIC_URL || `${env.MINIO_ENDPOINT}/${env.MINIO_BUCKET || 'avatars'}`).replace(/\/$/, '');
    let imageUrlsSafe: string | null = null;
    if (Array.isArray(req.body.imageUrls) && req.body.imageUrls.length > 0) {
      const valid = (req.body.imageUrls as unknown[])
        .filter((u): u is string => typeof u === 'string' && u.startsWith(minioBase + '/'))
        .slice(0, 3);
      if (valid.length > 0) imageUrlsSafe = JSON.stringify(valid);
    }

    const report = await prisma.playerReport.create({
      data: { userId: user.id, content: content.trim(), reportType: reportTypeSafe, involvedPlayers: involvedSafe, imageUrls: imageUrlsSafe },
    });

    // Mod-log Discord alert (fire-and-forget).
    const reporterName = user.username || user.discordUsername || pub.discordId;
    postModAlert({
      title: reportTypeSafe === 'bug' ? '🐛 Bug Report Submitted' : '🚩 Player Report Submitted',
      color: '#FF8C00',
      fields: [
        { name: 'Reporter', value: String(reporterName), inline: true },
        { name: 'Type', value: reportTypeSafe, inline: true },
        { name: 'Content', value: content.trim().slice(0, 1500) },
        ...(involvedSafe ? [{ name: 'Involved Players', value: involvedSafe.slice(0, 1024) }] : []),
      ],
      timestamp: true,
      footerText: `Report ID: ${report.id}`,
    }).catch(() => {});

    res.status(201).json({ data: report });
  } catch (err) { next(err); }
}

/**
 * POST /api/player-reports/upload-image
 * Accepts multipart/form-data with up to 3 images (field name: "images").
 * Requires publicUser session. Returns { data: { urls: string[] } }.
 */
export async function uploadReportImage(req: Request, res: Response, next: NextFunction): Promise<void> {
  const pub = req.dashboardUser ?? (req as any).publicUser;
  if (!pub) { res.status(401).json({ title: 'Unauthorized', detail: 'Sign in first.' }); return; }

  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) { res.status(422).json({ title: 'Invalid', detail: 'No files uploaded.' }); return; }

  try {
    const urls = await uploadReportImages(files.map(f => f.buffer));
    res.json({ data: { urls } });
  } catch (err) {
    if (err instanceof ImageUploadError) { res.status(err.status).json({ title: 'Upload Error', detail: err.message }); return; }
    next(err);
  }
}
