/**
 * REST controller for moderator actions (kick, mute, unmute, ban, unban,
 * evidence proxy). All routes gated upstream by requireDiscordRole(OWNER,
 * ADMIN, MODERATOR). Protected-target checks are enforced inside the
 * moderationActionsService (throws ProtectedTargetError → 409 here).
 */
import { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import { createError } from '../middleware/errorHandler';
import {
  kickUser, muteUser, unmuteUser, createBan, reverseBan, ProtectedTargetError,
  type NewBanEvidence, REASON_CATEGORIES,
} from '../services/moderationActionsService';
import { uploadEvidence, downloadEvidence } from '../services/banEvidenceStorage';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MUTE_DAYS = 30;

function requireUuid(s: any, label: string): asserts s is string {
  if (typeof s !== 'string' || !UUID_RE.test(s)) throw createError(400, `${label} must be a UUID`);
}
function requireString(s: any, label: string, max = 4000): asserts s is string {
  if (typeof s !== 'string' || !s.trim()) throw createError(400, `${label} is required`);
  if (s.length > max) throw createError(422, `${label} is too long (max ${max})`);
}
/**
 * The auth middleware attaches req.adminUser.id = Discord ID (snowflake) for
 * OAuth admins, or 'api-key' for service-token auth. Mod actions need the
 * internal users.id UUID (for the bannedById FK). Resolves by discordId and
 * auto-creates a discord-only User row if the admin has no game account.
 * API-key actor is rejected — these actions need to attribute to a real human.
 */
async function actorUserId(req: Request): Promise<string> {
  const a = (req as any).adminUser as { id: string; username?: string; displayName?: string } | undefined;
  if (!a?.id) throw createError(401, 'no admin session');
  if (a.id === 'api-key') throw createError(400, 'moderation actions require Discord OAuth, not API key');
  const existing = await prisma.user.findFirst({ where: { discordId: a.id }, select: { id: true } });
  if (existing) return existing.id;
  const created = await prisma.user.create({
    data: {
      username: `admin-discord-${a.id}`,
      installToken: `admin:${a.id}`,
      discordId: a.id,
      discordUsername: a.username ?? null,
      discordDisplayName: a.displayName ?? a.username ?? null,
    },
    select: { id: true },
  });
  return created.id;
}
function handleProtected(err: unknown, next: NextFunction): boolean {
  if (err instanceof ProtectedTargetError) {
    next(createError(409, err.message));
    return true;
  }
  return false;
}

/**
 * Ban-evidence access roles. Only owners and admins can see ban evidence for
 * bans they did not personally issue. EVERY other persona admitted to the
 * moderation routes (moderator, supporter, developer, and any future
 * non-privileged role) is scoped to the bans they themselves issued — we must
 * not special-case the literal 'moderator' string, or a supporter/developer
 * persona would silently bypass the scope.
 */
const EVIDENCE_PRIVILEGED_ROLES = new Set(['owner', 'admin']);

function isEvidencePrivileged(req: Request): boolean {
  const role: string = (req as any).adminUser?.role ?? '';
  return EVIDENCE_PRIVILEGED_ROLES.has(role);
}

/**
 * Per-ban authorization for evidence access. Owners and admins may access any
 * ban's evidence; every other persona may only access evidence for bans they
 * personally issued (`ban.bannedById === actorUserId`).
 *
 * On denial (including a non-existent ban) this throws a 404 — NOT a 403 — so
 * the endpoint does not leak whether a given ban id exists to a moderator who
 * is not allowed to see it (avoids a ban-existence oracle).
 */
async function assertBanEvidenceAccess(req: Request, banId: string): Promise<void> {
  if (isEvidencePrivileged(req)) return;
  const actor = await actorUserId(req);
  const ban = await prisma.ban.findUnique({
    where: { id: banId },
    select: { bannedById: true },
  });
  if (!ban || ban.bannedById !== actor) throw createError(404, 'Ban not found');
}

// ── POST /api/moderation/kicks  { userId, reason } ───────────────────────────
export async function kickUserHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId, reason } = req.body ?? {};
    requireUuid(userId, 'userId');
    requireString(reason, 'reason', 300);
    const r = (reason as string).slice(0, 300);
    const result = await kickUser(userId, await actorUserId(req), r);
    res.json({ data: { kicked: true, until: result.until.toISOString(), disconnected: result.disconnected } });
  } catch (err) { if (!handleProtected(err, next)) next(err); }
}

// ── POST /api/moderation/mutes  { userId, durationHours, category, reason, durationMinutes? } ─
export async function muteUserHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId, durationHours, durationMinutes, category, reason } = req.body ?? {};
    requireUuid(userId, 'userId');
    requireString(category, 'category', 100);
    requireString(reason, 'reason', 500);
    const minutes = Number.isFinite(durationMinutes) ? Number(durationMinutes) : Number(durationHours ?? 0) * 60;
    if (!Number.isFinite(minutes) || minutes <= 0) throw createError(400, 'durationHours or durationMinutes must be a positive number');
    const cappedMin = Math.min(minutes, MAX_MUTE_DAYS * 24 * 60);
    const durationMs = cappedMin * 60_000;
    const result = await muteUser(userId, await actorUserId(req), durationMs, category, reason);
    res.json({ data: {
      muted: true,
      until: result.until.toISOString(),
      discordPropagated: result.discordPropagated,
      capped: minutes > cappedMin,
      maxMinutes: MAX_MUTE_DAYS * 24 * 60,
    } });
  } catch (err) { if (!handleProtected(err, next)) next(err); }
}

// ── DELETE /api/moderation/mutes/:userId  ?reason=... ─────────────────────────
export async function unmuteUserHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireUuid(req.params.userId, 'userId');
    const reason = (req.query.reason as string | undefined) || (req.body?.reason as string | undefined) || '';
    await unmuteUser(req.params.userId, await actorUserId(req), reason.slice(0, 300));
    res.json({ data: { unmuted: true } });
  } catch (err) { next(err); }
}

// ── POST /api/moderation/bans (multipart) ────────────────────────────────────
// Form fields: userId, category, reasonText, durationDays (omit/<=0 = permanent),
//              evidenceText (optional), evidenceFiles[] (optional, multer)
export async function createBanHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { userId, category, reasonText, durationDays, evidenceText } = req.body ?? {};
    requireUuid(userId, 'userId');
    if (!REASON_CATEGORIES.includes(category)) throw createError(400, `category must be one of: ${REASON_CATEGORIES.join(', ')}`);
    requireString(reasonText, 'reasonText', 4000);

    const days = Number(durationDays);
    const bannedUntil = Number.isFinite(days) && days > 0
      ? new Date(Date.now() + days * 86_400_000)
      : null;

    // Build evidence from uploaded files + optional text. The multer-reported
    // MIME is only a coarse pre-filter; uploadEvidence() re-validates via
    // magic-byte sniffing and throws on mismatches.
    const evidence: NewBanEvidence[] = [];
    const files = ((req as any).files as Express.Multer.File[] | undefined) ?? [];
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) throw createError(413, `image ${f.originalname} exceeds 10MB`);
      try {
        const up = await uploadEvidence(f.buffer, f.mimetype);
        evidence.push({ type: 'image', objectKey: up.objectKey, mime: up.mime, sizeBytes: up.sizeBytes });
      } catch (e: any) {
        throw createError(422, `${f.originalname}: ${e?.message || 'invalid image'}`);
      }
    }
    if (typeof evidenceText === 'string' && evidenceText.trim()) {
      evidence.push({ type: 'text', textContent: evidenceText.slice(0, 8000) });
    }
    if (evidence.length === 0) throw createError(422, 'at least one evidence item (image or text) is required');

    const result = await createBan(userId, await actorUserId(req), category, reasonText, bannedUntil, evidence);
    res.json({ data: {
      banned: true,
      banId: result.banId,
      bannedUntil: bannedUntil?.toISOString() ?? null,
      disconnected: result.disconnected,
      evidenceCount: evidence.length,
      discordLockdown: {
        rolesStripped: result.discordLockdown.stripped.length,
        voiceDisconnected: result.discordLockdown.voiceDisconnected,
        guildBanApplied: result.discordLockdown.guildBanApplied,
        warnings: result.discordLockdown.warnings,
      },
    } });
  } catch (err) { if (!handleProtected(err, next)) next(err); }
}

// ── GET /api/moderation/bans ─────────────────────────────────────────────────
export async function listBansHandler(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.ban.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        user:       { select: { id: true, username: true, discordId: true, discordDisplayName: true, discordUsername: true, discordAvatar: true, isBanned: true } },
        bannedBy:   { select: { id: true, username: true, discordDisplayName: true, discordUsername: true } },
        reversedBy: { select: { id: true, username: true, discordDisplayName: true, discordUsername: true } },
        evidence:   { select: { id: true, type: true, mime: true, sizeBytes: true } },
      },
    });
    res.json({ data: rows });
  } catch (err) { next(err); }
}

// ── GET /api/moderation/bans/:id ─────────────────────────────────────────────
export async function getBanHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireUuid(req.params.id, 'id');
    const row = await prisma.ban.findUnique({
      where: { id: req.params.id },
      include: {
        user:       { select: { id: true, username: true, discordId: true, discordDisplayName: true, discordUsername: true, discordAvatar: true, isBanned: true } },
        bannedBy:   { select: { id: true, username: true, discordDisplayName: true, discordUsername: true } },
        reversedBy: { select: { id: true, username: true, discordDisplayName: true, discordUsername: true } },
        evidence:   true,
      },
    });
    if (!row) return next(createError(404, 'Ban not found'));

    // Per-ban evidence scoping: owners/admins see the full evidence relation
    // (textContent + objectKey). For every other persona, strip the evidence
    // relation unless they personally issued this ban — otherwise the include
    // would leak evidence content (textContent/objectKey) of any ban to any
    // moderator. The ban metadata itself is not secret (it's in the ban list),
    // so we return the row with evidence removed rather than 404.
    if (!isEvidencePrivileged(req)) {
      const actor = await actorUserId(req);
      if ((row as any).bannedById !== actor) (row as any).evidence = [];
    }

    res.json({ data: row });
  } catch (err) { next(err); }
}

// ── POST /api/moderation/bans/:id/reverse  { reason } ────────────────────────
export async function reverseBanHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireUuid(req.params.id, 'id');
    const reason = (req.body?.reason as string | undefined) || '';
    requireString(reason, 'reason', 500);
    await reverseBan(req.params.id, await actorUserId(req), reason);
    res.json({ data: { reversed: true } });
  } catch (err) { next(err); }
}

// ── GET /api/moderation/bans/:id/evidence/:fileId — image stream proxy ───────
export async function streamBanEvidenceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    requireUuid(req.params.id, 'id');
    requireUuid(req.params.fileId, 'fileId');

    // Per-ban authorization: owners/admins can access any ban's evidence; every
    // other persona may only access evidence for bans they personally issued.
    // Denial (or a non-existent ban) throws 404 to avoid a ban-existence oracle.
    await assertBanEvidenceAccess(req, req.params.id);

    const ev = await prisma.banEvidence.findFirst({
      where: { id: req.params.fileId, banId: req.params.id, type: 'image' },
      select: { objectKey: true, mime: true },
    });
    if (!ev?.objectKey) return next(createError(404, 'Evidence file not found'));
    const obj = await downloadEvidence(ev.objectKey);
    if (!obj) return next(createError(404, 'Evidence file not found in storage'));
    // SR-003 hardening: the stored MIME came from the uploader's claimed
    // Content-Type (multer-reported, client-controllable). nosniff forces the
    // browser to honour our Content-Type header instead of sniffing the
    // body — stops an HTML/SVG payload disguised as image/png from
    // executing in a viewing mod's browser. Also force inline filename so
    // the asset isn't auto-downloaded into a script context.
    const mime = obj.mime || ev.mime || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="evidence-${req.params.fileId}"`);
    if (obj.sizeBytes) res.setHeader('Content-Length', String(obj.sizeBytes));
    res.setHeader('Cache-Control', 'private, max-age=300');
    obj.stream.pipe(res);
  } catch (err) { next(err); }
}

// ── GET /api/moderation/evidence — gallery list (all evidence, paginated) ────
export async function listEvidenceHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Owners/admins see the full evidence gallery. Every other persona is
    // scoped to evidence attached to bans they personally issued — otherwise
    // this unfiltered findMany would leak every ban's textContent/objectKey to
    // any moderator.
    const where = isEvidencePrivileged(req)
      ? undefined
      : { ban: { bannedById: await actorUserId(req) } };
    const rows = await prisma.banEvidence.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { ban: { select: { id: true, userId: true, reasonCategory: true, reasonText: true, createdAt: true, reversedAt: true, user: { select: { username: true, discordDisplayName: true, discordUsername: true } } } } },
    });
    res.json({ data: rows });
  } catch (err) { next(err); }
}

// ── GET /api/moderation/users/lookup?q=... — for the ban form prefill / search ─
export async function lookupUserHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const q = String(req.query.q || '').trim().slice(0, 64);
    if (!q) { res.json({ data: [] }); return; }
    const isUuid = UUID_RE.test(q);
    const rows = await prisma.user.findMany({
      where: isUuid
        ? { id: q }
        : { OR: [
            { username: { contains: q, mode: 'insensitive' } },
            { discordUsername: { contains: q, mode: 'insensitive' } },
            { discordDisplayName: { contains: q, mode: 'insensitive' } },
          ] },
      take: 20,
      select: { id: true, username: true, discordId: true, discordUsername: true, discordDisplayName: true, discordAvatar: true, isBanned: true, isMuted: true },
    });
    res.json({ data: rows });
  } catch (err) { next(err); }
}
