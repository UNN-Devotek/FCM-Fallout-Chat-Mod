import { Request, Response, NextFunction } from 'express';
import logger from '../config/logger';
import { getRedisClient } from '../config/redis';
import prisma from '../config/prisma';

/**
 * Shared auth middleware for desktop-client write endpoints.
 *
 * Requires a valid `X-Auth-Token` header, which is looked up in Redis under
 * `session:<token>` to resolve the owning user. On success, `req.user` and
 * `req.sessionToken` are populated just like `requireAuth` does. When the
 * request body carries an `installToken`, it MUST match the authenticated
 * user's install token — otherwise a hijacker with a valid token could
 * target a different user's records.
 *
 * The previous legacy `X-App-Client-Key` fallback has been removed. The only
 * remaining use of `X-App-Client-Key` / `env.APP_CLIENT_KEY` is the
 * bootstrap endpoint `POST /api/users/register`, which has no session token
 * yet and therefore still requires a static shared key (plus the public
 * rate limiter) to gate installs.
 *
 * Missing or invalid token → 401. Install-token mismatch on a valid session
 * → 403.
 *
 * Mirrors the shape of `requireAdminKey.ts` for consistency.
 */
async function requireClientAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authToken = req.headers['x-auth-token'];
  const sessionToken = typeof authToken === 'string' && authToken.length > 0 ? authToken : undefined;

  const routePath = req.originalUrl || req.path;
  const sourceIp = req.ip;

  if (!sessionToken) {
    res.status(401).json({ error: 'Missing or invalid X-Auth-Token header' });
    return;
  }

  try {
    const redis = await getRedisClient();
    const userId = await redis.get(`session:${sessionToken}`);
    if (!userId) {
      res.status(401).json({ error: 'Invalid or expired session token' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, installToken: true, isBanned: true },
    });
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    if (user.isBanned) {
      res.status(403).json({ error: 'User is banned' });
      return;
    }

    // Install-token binding: if the request body includes an installToken,
    // it must match the authenticated user. Guards against a leaked session
    // token being used to submit reports for other users.
    const body = (req.body ?? {}) as { installToken?: unknown };
    const bodyInstallToken = typeof body.installToken === 'string' ? body.installToken : undefined;
    if (bodyInstallToken && bodyInstallToken !== user.installToken) {
      logger.warn(
        { audit: 'install-token-mismatch', userId: user.id, path: routePath, sourceIp },
        'Rejected request with mismatched installToken under session auth',
      );
      res.status(403).json({ error: 'installToken does not match authenticated user' });
      return;
    }

    req.user = user;
    req.sessionToken = sessionToken;
    next();
    return;
  } catch (err) {
    logger.error({ err, path: routePath }, 'requireClientAuth: session lookup failed');
    next(err);
    return;
  }
}

export { requireClientAuth };
module.exports = { requireClientAuth };
