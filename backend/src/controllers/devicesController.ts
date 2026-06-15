/**
 * Device enrolment + admin management for per-install keypair auth.
 * See docs/device-keypair-auth-plan.md.
 */
import { Request, Response, NextFunction } from 'express';
import prisma from '../config/prisma';
import env from '../config/environment';
import { createError } from '../middleware/errorHandler';
import { constantTimeEquals } from '../utils/constantTimeEquals';
import {
  extractSignatureHeaders, verifySignedRequest, isValidP256Spki,
} from '../services/deviceAuthService';

/**
 * POST /api/devices/enroll  { installToken, publicKey }
 *
 * - First enrolment for an install: trusted via X-App-Client-Key (TOFU, M1).
 * - Re-enrolment (row exists, not revoked): MUST be signed under the CURRENT
 *   key — stops an attacker who only knows the installToken from rotating the
 *   key out from under the owner.
 * - Re-enrolment after admin revoke: allowed again via the client-key TOFU path
 *   (revoke is the explicit "let this device re-establish trust" signal).
 */
export async function enrollDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { installToken, publicKey } = req.body ?? {};
    if (typeof installToken !== 'string' || !installToken.trim()) {
      return next(createError(400, 'installToken is required'));
    }
    if (typeof publicKey !== 'string' || !isValidP256Spki(publicKey)) {
      return next(createError(422, 'publicKey must be a P-256 SPKI DER (base64)'));
    }

    const existing = await prisma.device.findUnique({
      where: { installToken },
      select: { id: true, revokedAt: true },
    });

    // Re-enrolment of an active key → require a valid signature under the current key.
    if (existing && !existing.revokedAt) {
      const hdrs = extractSignatureHeaders(req.headers as Record<string, unknown>);
      if (!hdrs || hdrs.installToken !== installToken) {
        return next(createError(401, 'Re-enrolment of an active device must be signed by the current key'));
      }
      const path = (req.originalUrl || req.url).split('?')[0];
      const rawBody: Buffer = (req as any).rawBody ?? Buffer.alloc(0);
      const r = await verifySignedRequest(req.method, path, rawBody, hdrs);
      if (!r.ok) return next(createError(r.status, `Device auth failed: ${r.reason}`));
    } else {
      // First enrolment OR re-enrol after revoke → TOFU via shared client key (M1).
      const expectedKey = env.APP_CLIENT_KEY;
      if (!expectedKey) return next(createError(503, 'Enrolment unavailable: server misconfigured'));
      const clientKey = req.headers['x-app-client-key'] as string | undefined;
      if (!clientKey || !constantTimeEquals(clientKey, expectedKey)) {
        return next(createError(403, 'Invalid or missing client key'));
      }
    }

    const device = await prisma.device.upsert({
      where: { installToken },
      create: { installToken, publicKey },
      update: { publicKey, revokedAt: null, enrolledAt: new Date() },
      select: { id: true, enrolledAt: true },
    });
    res.json({ data: { enrolled: true, deviceId: device.id, enrolledAt: device.enrolledAt.toISOString() } });
  } catch (err) { next(err); }
}

/** GET /api/admin/devices — admin device list (most recently seen first). */
export async function listDevices(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await prisma.device.findMany({
      orderBy: { lastSeenAt: 'desc' },
      take: 500,
    });
    // Join usernames for display (installToken matches users.install_token).
    const tokens = rows.map((r) => r.installToken);
    const users = await prisma.user.findMany({
      where: { installToken: { in: tokens } },
      select: { installToken: true, username: true, discordUsername: true, isBanned: true },
    });
    const byToken = new Map(users.map((u) => [u.installToken, u]));
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        installToken: r.installToken,
        enrolledAt: r.enrolledAt,
        lastSeenAt: r.lastSeenAt,
        revokedAt: r.revokedAt,
        user: byToken.get(r.installToken) ?? null,
      })),
    });
  } catch (err) { next(err); }
}

/** DELETE /api/admin/devices/:installToken — revoke a device key (admin). */
export async function revokeDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { installToken } = req.params;
    const existing = await prisma.device.findUnique({ where: { installToken }, select: { id: true } });
    if (!existing) return next(createError(404, 'Device not found'));
    await prisma.device.update({ where: { installToken }, data: { revokedAt: new Date() } });
    await prisma.auditLog.create({
      data: {
        actorId: (req as any).adminUser?.id ?? null,
        action: 'revoke_device',
        targetType: 'device',
        reason: `Revoked device key for install ${installToken}`,
        metadata: { installToken },
      },
    }).catch(() => {});
    res.json({ data: { revoked: true } });
  } catch (err) { next(err); }
}
