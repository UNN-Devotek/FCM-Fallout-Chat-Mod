import { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../config/redis';
import prisma from '../config/prisma';
import { createError } from './errorHandler';
import logger from '../config/logger';
import { constantTimeEquals } from '../utils/constantTimeEquals';
import { getCachedRole } from '../services/roleVerificationService';
import env from '../config/environment';

// Extend Express Request to include our custom properties
declare global {
  namespace Express {
    interface Request {
      user?: any;
      adminUser?: any;
      sessionToken?: string;
    }
  }
}

/**
 * Validates X-Auth-Token header against Redis session store.
 * Attaches req.user on success.
 */
async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = req.headers['x-auth-token'] as string | undefined;

  if (!token) {
    return next(createError(401, 'Missing X-Auth-Token header'));
  }

  try {
    const redis = await getRedisClient();
    const userId = await redis.get(`session:${token}`);

    if (!userId) {
      return next(createError(401, 'Invalid or expired session token'));
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, isBanned: true, bannedUntil: true, banReason: true, banCategory: true, isMuted: true, muteExpiresAt: true },
    });

    if (!user) {
      return next(createError(401, 'User not found'));
    }

    // Auto-lift expired temp bans before the reject check
    if (user.isBanned && user.bannedUntil && new Date(user.bannedUntil) < new Date()) {
      await prisma.user.update({
        where: { id: userId },
        data: { isBanned: false, bannedUntil: null, banReason: null, banCategory: null, bannedById: null, bannedAt: null },
      });
      (user as any).isBanned = false;
    }

    if (user.isBanned) {
      // Structured 403 the frontend can render as a 'banned' splash with details.
      const detail = JSON.stringify({
        type: 'banned',
        until: user.bannedUntil ? user.bannedUntil.toISOString() : null,
        permanent: user.bannedUntil === null,
        reason: user.banReason ?? null,
        category: user.banCategory ?? null,
      });
      return next(createError(403, detail));
    }

    // Auto-lift expired mutes so moderators don't need to manually unmute
    if (user.isMuted && user.muteExpiresAt && new Date(user.muteExpiresAt) < new Date()) {
      await prisma.user.update({
        where: { id: userId },
        data: { isMuted: false, muteExpiresAt: null },
      });
      (user as any).isMuted = false;
      (user as any).muteExpiresAt = null;
    }

    req.user = user;
    req.sessionToken = token;
    next();
  } catch (err) {
    logger.error({ err }, 'Auth middleware error');
    next(err);
  }
}

/**
 * Middleware for Discord OAuth2 admin dashboard sessions.
 * Requires req.session.discordUser with a qualifying role.
 *
 * Verification order:
 * 1. Check Redis role cache (fastest, set by background verification)
 * 2. Check admin_users DB table (source of truth)
 * 3. Fall back to session roles (backward compat, covers dev-login)
 */
function requireDiscordRole(...allowedRoles: string[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    // API key bypass — grants full admin access from CLI/scripts
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey && env.ADMIN_API_KEY && constantTimeEquals(apiKey, env.ADMIN_API_KEY)) {
      req.adminUser = { id: 'api-key', username: 'API', role: 'owner', roles: [] };
      return next();
    }

    const user = (req.session as any)?.discordUser;

    if (!user) {
      return next(createError(401, 'Discord authentication or X-API-Key required'));
    }

    // Ban lockdown: a Discord-OAuth user whose linked game account is banned
    // gets locked out of every admin/dashboard route, regardless of role.
    // Auto-expires temp bans inline. Frontend renders a 'banned' splash from
    // the structured 403 body.
    try {
      const linked = await prisma.user.findFirst({
        where: { discordId: user.id },
        select: { id: true, isBanned: true, bannedUntil: true, banReason: true, banCategory: true },
      });
      if (linked?.isBanned && linked.bannedUntil && new Date(linked.bannedUntil) < new Date()) {
        await prisma.user.update({
          where: { id: linked.id },
          data: { isBanned: false, bannedUntil: null, banReason: null, banCategory: null, bannedById: null, bannedAt: null },
        }).catch(() => {});
        linked.isBanned = false;
      }
      if (linked?.isBanned) {
        return next(createError(403, JSON.stringify({
          type: 'banned',
          until: linked.bannedUntil ? linked.bannedUntil.toISOString() : null,
          permanent: linked.bannedUntil === null,
          reason: linked.banReason ?? null,
          category: linked.banCategory ?? null,
        })));
      }
    } catch { /* don't let a DB hiccup lock everyone out */ }

    // Filter out empty-string role IDs (unconfigured env vars)
    const validRoles = allowedRoles.filter(Boolean);

    // No role IDs configured -> dev mode. Still enforce role names so 'user'
    // persona is properly restricted even without real Discord role IDs.
    if (validRoles.length === 0) {
      const DEV_PRIVILEGED = ['owner', 'admin', 'moderator', 'supporter', 'developer'];
      if (!DEV_PRIVILEGED.includes(user.role)) {
        return next(createError(403, 'Insufficient Discord role'));
      }
      req.adminUser = user;
      return next();
    }

    try {
      // 1. Check Redis role cache (set by background role verification service)
      const cachedRole = await getCachedRole(user.id);
      if (cachedRole) {
        user.role = cachedRole;
        req.adminUser = user;
        return next();
      }

      // 2. Check admin_users DB table (source of truth)
      const adminUser = await prisma.adminUser.findUnique({
        where: { discordId: user.id },
        select: { role: true },
      });

      if (adminUser) {
        user.role = adminUser.role;
        req.adminUser = user;
        return next();
      }

      // 3. Fall back to session Discord role IDs (covers fresh login before first verification cycle)
      const hasRole = validRoles.some((role) => user.roles.includes(role));
      if (hasRole) {
        req.adminUser = user;
        return next();
      }

      return next(createError(403, 'Insufficient Discord role'));
    } catch (err) {
      // On error, fall back to session-based check (resilience)
      logger.warn({ err }, 'Role verification lookup failed -- falling back to session roles');
      const hasRole = validRoles.some((role) => user.roles.includes(role));
      if (!hasRole) {
        return next(createError(403, 'Insufficient Discord role'));
      }
      req.adminUser = user;
      next();
    }
  };
}

/**
 * Device-signature middleware. Verifies the request is signed by an enrolled
 * install key (ECDSA P-256 / SHA-256 over method+path+bodyhash+ts+nonce).
 * Attaches req.device = { installToken } on success. Pairs with the
 * express.json verify hook that captures req.rawBody.
 *
 * Used to replace the shared X-App-Client-Key gate on register / session-issue
 * once an install has enrolled (Phase C dual-accept handles the migration).
 */
async function requireSignedDevice(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { extractSignatureHeaders, verifySignedRequest } = require('../services/deviceAuthService');
  const hdrs = extractSignatureHeaders(req.headers as Record<string, unknown>);
  if (!hdrs) return next(createError(401, 'Missing device signature headers'));
  // Express strips the mount path; use originalUrl path (sans query) to match
  // what the client signed (the full request path).
  const path = (req.originalUrl || req.url).split('?')[0];
  const rawBody: Buffer = (req as any).rawBody ?? Buffer.alloc(0);
  const result = await verifySignedRequest(req.method, path, rawBody, hdrs);
  if (!result.ok) return next(createError(result.status, `Device auth failed: ${result.reason}`));
  (req as any).device = { installToken: result.installToken };
  next();
}

/**
 * Lightweight "is this any authenticated client" gate for shared read endpoints
 * (Discord emoji list, Tenor GIF proxy). Passes if the request carries ANY of:
 *   - a valid X-Auth-Token install session (desktop overlay), OR
 *   - a Discord OAuth admin session (logged-in dashboard / web chat), OR
 *   - a public Discord session.
 * Preserves the SR-002 intent (no anonymous abuse of our Tenor quota / emoji
 * metadata) without breaking either client — requireAuth alone rejected the
 * cookie-session web app, and the overlay wasn't sending the token. Cheap:
 * the cookie check is sync; the token check only runs if no session exists.
 */
async function requireAnyAuthedClient(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const sess = req.session as any;
  if (sess?.discordUser || sess?.publicUser) return next();
  const token = req.headers['x-auth-token'] as string | undefined;
  if (token) {
    try {
      const redis = await getRedisClient();
      const userId = await redis.get(`session:${token}`);
      if (userId) { (req as any).authedUserId = userId; return next(); }
    } catch { /* fall through to 401 */ }
  }
  return next(createError(401, 'Authentication required'));
}

export function requirePublicDiscordAuth(req: Request, res: Response, next: NextFunction): void {
  const pub = (req.session as any).publicUser;
  if (!pub?.discordId) {
    res.status(401).json({ title: 'Unauthorized', detail: 'Sign in with Discord first.' });
    return;
  }
  (req as any).publicUser = pub;
  next();
}

/**
 * Normalized Discord identity for any logged-in dashboard/web caller, resolved
 * from EITHER session shape:
 *   - publicUser  (set by the public /report & /apply Discord OAuth flow)   → { discordId, username, ... }
 *   - discordUser (set by the dashboard Discord OAuth flow)                 → { id, username, ... }
 * Used by the "dweller self-service" endpoints so a dashboard user (role
 * 'user'/'supporter') can submit and review their OWN reports/applications.
 */
export interface DashboardIdentity {
  discordId: string;
  username: string;
  discordDisplayName: string | null;
  avatar: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      dashboardUser?: DashboardIdentity;
    }
  }
}

/**
 * Gate for endpoints reachable by any signed-in web user (dashboard dweller OR
 * public-form user). Resolves a normalized Discord identity onto
 * req.dashboardUser. The endpoint must still resolve/scope the owning User row
 * by discordId for ownership enforcement. Rejects 401 if neither session exists.
 */
export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const sess = req.session as any;
  const pub = sess?.publicUser;
  const dash = sess?.discordUser;
  if (pub?.discordId) {
    req.dashboardUser = {
      discordId: pub.discordId,
      username: pub.username,
      discordDisplayName: pub.discordDisplayName ?? null,
      avatar: pub.avatar ?? null,
    };
    return next();
  }
  if (dash?.id) {
    req.dashboardUser = {
      discordId: dash.id,
      username: dash.username,
      discordDisplayName: dash.discordDisplayName ?? null,
      avatar: dash.avatar ?? null,
    };
    return next();
  }
  res.status(401).json({ title: 'Unauthorized', detail: 'Sign in with Discord first.' });
}

export { requireAuth, requireDiscordRole, requireSignedDevice, requireAnyAuthedClient };
module.exports = { requireAuth, requireDiscordRole, requirePublicDiscordAuth, requireSignedDevice, requireAnyAuthedClient, requireDashboardAuth };
