import { Router, Request, Response, NextFunction } from 'express';
import { createError } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/auth';
import { redeemLinkCode } from '../services/linkCodeService';
import {
  hasLinkedProvider,
  linkProviderIdentity,
  unlinkProviderIdentity,
  getLinkedIdentities,
  isBannedIdentity,
} from '../services/linkedIdentityService';
import { clientIp } from '../utils/clientIp';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedisClient } from '../config/redis';
import prisma from '../config/prisma';
import logger from '../config/logger';
import { paramStr } from '../utils/reqParams';
import { isValidSteamId } from '../services/steamAuthService';

// Re-export for use in server.ts Nexus OAuth routes
export { isBannedIdentity, linkProviderIdentity, unlinkProviderIdentity };

const router = Router();

function makeLinkRedisStore(prefix: string) {
  return new RedisStore({
    prefix,
    sendCommand: async (...args: string[]) => {
      const client = await getRedisClient();
      return client.sendCommand(args);
    },
  });
}

// Redemption: <=10/min per IP
const redemptionIpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => clientIp(req),
  store: makeLinkRedisStore('rl_link_redeem_ip:'),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    type: 'https://fo76chat.app/errors/429',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Redemption rate limit exceeded.',
  },
});

/**
 * Link-flow auth: resolves req.user from EITHER the overlay install session (X-Auth-Token)
 * OR a signed-in dashboard/web Discord, Nexus, or Steam cookie session (resolved server-side to the
 * FCM user by provider identity).
 * The web /link page authenticates by COOKIE, so the token-only requireAuth would 401 it into a
 * sign-in loop and the code-entry screen would never show. This implements the routes' documented
 * "X-Auth-Token or provider session" contract. Mirrors requireAuth's ban auto-lift + reject.
 */
async function requireLinkAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    let userId: string | null = null;

    const token = req.headers['x-auth-token'];
    if (typeof token === 'string' && token) {
      const redis = await getRedisClient();
      userId = await redis.get(`session:${token}`);
    }

    // Fall back to the dashboard/web provider cookie session.
    if (!userId) {
      const sess = req.session as any;
      const discordId: string | undefined = sess?.discordUser?.id ?? sess?.publicUser?.discordId;
      if (discordId) {
        const u = await prisma.user.findFirst({ where: { discordId }, select: { id: true } });
        userId = u?.id ?? null;
      }

      // Nexus-only sessions are backed by a linked identity created during the
      // OAuth callback. Resolve the provider UID server-side; never trust a
      // client-supplied user ID from the session payload.
      if (!userId && sess?.nexusUser?.providerUid) {
        const identity = await prisma.linkedIdentity.findUnique({
          where: {
            provider_providerUid: {
              provider: 'nexus',
              providerUid: String(sess.nexusUser.providerUid),
            },
          },
          select: { userId: true },
        });
        userId = identity?.userId ?? null;
      }

      // Steam OpenID sessions are backed by the canonical steam_id column. Resolve
      // the ID server-side; never trust a client-supplied user ID from the cookie.
      if (!userId && isValidSteamId(sess?.steamUser?.steamId)) {
        const u = await prisma.user.findFirst({
          where: { steamId: String(sess.steamUser.steamId) },
          select: { id: true },
        });
        userId = u?.id ?? null;
      }
    }

    if (!userId) return next(createError(401, 'Sign in to link your account.'));

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, isBanned: true, bannedUntil: true, banReason: true, banCategory: true },
    });
    if (!user) return next(createError(401, 'User not found'));

    // Auto-lift expired temp bans, then reject active bans (mirrors requireAuth).
    if (user.isBanned && user.bannedUntil && new Date(user.bannedUntil) < new Date()) {
      await prisma.user.update({
        where: { id: user.id },
        data: { isBanned: false, bannedUntil: null, banReason: null, banCategory: null, bannedById: null, bannedAt: null },
      }).catch(() => {});
      (user as any).isBanned = false;
    }
    if (user.isBanned) {
      return next(createError(403, JSON.stringify({
        type: 'banned',
        until: user.bannedUntil ? user.bannedUntil.toISOString() : null,
        permanent: user.bannedUntil === null,
        reason: user.banReason ?? null,
        category: user.banCategory ?? null,
      })));
    }

    req.user = user as any;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/link/game
 * Returns the current link state for the authenticated user.
 * Auth: session (X-Auth-Token or Discord cookie session) — see requireLinkAuth.
 */
router.get('/game', requireLinkAuth, async (req: Request, res: Response, next) => {
  try {
    const userId = req.user!.id;
    const hasProvider = await hasLinkedProvider(userId);
    const identities = await getLinkedIdentities(userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { discordId: true, discordUsername: true, steamId: true, fo76AccountName: true },
    });

    const providers: Array<{ provider: string; username?: string | null; linkedAt: Date }> = [];
    if (user?.discordId) {
      providers.push({ provider: 'discord', username: user.discordUsername, linkedAt: new Date(0) });
    }
    if (isValidSteamId(user?.steamId)) {
      providers.push({ provider: 'steam', username: null, linkedAt: new Date(0) });
    }
    for (const id of identities) {
      providers.push({ provider: id.provider, username: id.username, linkedAt: id.linkedAt });
    }

    res.json({
      data: {
        hasLinkedProvider: hasProvider,
        fo76AccountName: user?.fo76AccountName ?? null,
        providers,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/link/redeem
 * Redeems a relay-issued link code, binding the signed-in FCM user to the relay identity.
 * Auth: requireAuth — the user must be signed in via Discord, Nexus, or Steam first.
 * Body: { code: string }  (accepts "XXXXXXXX" or "XXXX-XXXX")
 * Rate: <=10/min per IP.
 *
 * On success:
 *   - Sets hud_link_codes.used_at + redeemed_by_user_id = req.user.id
 *   - Calls relay's markRelayTokenLinked(relayUserId, fcmUserId) to upgrade limited→linked
 *     (a successful response requires at least one active relay token to be updated)
 *   - Writes audit log entry
 */
router.post('/redeem', requireLinkAuth, redemptionIpLimiter, async (req: Request, res: Response, next) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code || typeof code !== 'string') {
      return next(createError(400, 'Missing or invalid code'));
    }

    const actorId = req.user!.id;

    // Provider gate: authed user must have at least one linked provider before activating chat
    const hasProvider = await hasLinkedProvider(actorId);
    if (!hasProvider) {
      return next(
        createError(403, 'You must link a Discord, Nexus, or Steam account before activating in-game chat.'),
      );
    }

    const result = await redeemLinkCode(code, actorId);
    if (!result.ok) {
      const statusMap: Record<string, number> = {
        not_found: 404,
        expired: 410,
        already_used: 409,
        max_attempts: 429,
      };
      const detailMap: Record<string, string> = {
        not_found: 'Link code not found.',
        expired: 'Link code has expired. Request a new one in-game.',
        already_used: 'Link code has already been used.',
        max_attempts: 'Too many failed attempts. Request a new code in-game.',
      };
      return next(
        createError(statusMap[result.reason] ?? 400, detailMap[result.reason] ?? 'Invalid link code'),
      );
    }

    const { relayUserId } = result;

    // Notify the relay so it can upgrade the identity from limited → linked immediately.
    // Keep the import dynamic for the separately deployable relay module, but fail
    // closed: consuming a code without binding an active token strands the HUD in
    // limited mode while the website falsely reports success.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const relayService: any = await import('../services/relay/relayIdentityService.js');
      const linkedCount = await relayService.markRelayTokenLinked(relayUserId, actorId);
      if (typeof linkedCount !== 'number') {
        logger.error({ relayUserId }, 'Relay link promotion returned no acknowledgement');
        return next(createError(503, 'Chat relay is updating. Please retry this code shortly.'));
      }
      if (linkedCount < 1) {
        logger.warn({ relayUserId }, 'Link code has no active relay token to promote');
        return next(createError(409, 'This HUD session is no longer active. Request a new code in-game.'));
      }
      logger.info({ relayUserId, actorId }, 'Relay identity upgraded to linked');
    } catch (relayErr: any) {
      // redeemLinkCode is idempotent for the same actor, so a transient relay or
      // deployment error can be retried without issuing another code.
      logger.error({ err: relayErr, relayUserId }, 'Relay link promotion failed');
      return next(createError(503, 'Chat relay is temporarily unavailable. Please retry shortly.'));
    }

    // Handshake delivery is best-effort after the durable token promotion. A
    // missed notification is recoverable through the widget's reconnect path;
    // it must not undo or hide an already successful link.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const relayService: any = await import('../services/relay/relayIdentityService.js');
      await relayService.notifyLinkComplete?.(relayUserId);
    } catch (notifyErr) {
      logger.warn({ err: notifyErr, relayUserId }, 'Relay link completion notification failed (non-fatal)');
    }

    // Write audit log
    await prisma.auditLog.create({
      data: {
        actorId,
        action: 'hud_link_code_redeemed',
        targetId: actorId,
        targetType: 'user',
        metadata: { relayUserId },
      },
    });

    logger.info({ actorId, relayUserId }, 'Link code redeemed — relay identity bound');
    res.json({
      data: { success: true, message: 'In-game chat activated. You can now send messages.' },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/link/pairing-token
 * Mint (or rotate) a pairing token for the FCMHUD/1 flow.
 * Requires: authenticated session + at least one linked provider.
 * Body: { fo76Name: string }
 * Note: depends on hud_pairing_tokens table (owned by relay agent WT1).
 * When that table is absent this route returns 503.
 */
router.post('/pairing-token', requireAuth, async (req: Request, res: Response, next) => {
  try {
    const userId = req.user!.id;
    const { fo76Name } = req.body as { fo76Name?: string };

    if (!fo76Name || typeof fo76Name !== 'string' || fo76Name.trim().length < 1) {
      return next(createError(400, 'fo76Name is required'));
    }

    const hasProvider = await hasLinkedProvider(userId);
    if (!hasProvider) {
      return next(
        createError(403, 'You must link a Discord, Nexus, or Steam account before minting a pairing token.'),
      );
    }

    // Check if this fo76Name is claimed by another user (collision)
    const existing = await prisma.user.findFirst({
      where: { fo76AccountName: fo76Name.trim(), id: { not: userId } },
      select: { id: true, discordId: true, steamId: true },
    });
    if (existing) {
      return next(
        createError(
          409,
          JSON.stringify({
            type: 'https://fo76chat.app/errors/name_claimed',
            title: 'FO76 Name Already Claimed',
            status: 409,
            code: 'NAME_CLAIMED',
            detail: 'This FO76 name is already linked to another account.',
            hint: {
              providers_on_existing_account: [
                ...(existing.discordId ? ['discord'] : []),
                ...(existing.steamId ? ['steam'] : []),
                ...(!existing.discordId && !existing.steamId ? ['nexus'] : []),
              ],
            },
          }),
        ),
      );
    }

    // Update fo76AccountName if different, log rename to user_aliases
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { fo76AccountName: true },
    });
    if (currentUser?.fo76AccountName && currentUser.fo76AccountName !== fo76Name.trim()) {
      await prisma.userAlias.upsert({
        where: { userId_alias: { userId, alias: currentUser.fo76AccountName } },
        update: {},
        create: { userId, alias: currentUser.fo76AccountName },
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { fo76AccountName: fo76Name.trim() },
    });

    // Attempt to mint a pairing token. HudPairingToken table is owned by relay agent WT1;
    // if it doesn't exist yet, return 503 so the caller knows to retry after WT1 merges.
    try {
      const crypto = await import('crypto');
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const tokenPrefix = rawToken.slice(0, 8);

      // argon2 is installed by the relay agent (WT1) as a shared dep; dynamic require
      // so the auth-gate route can be deployed before WT1 merges (caught by the try/catch below).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const argon2: any = await import('argon2' as any);
      const tokenHash = await argon2.hash(rawToken, { type: argon2.argon2id });

      // Revoke any existing active token for this user
      await (prisma as any).hudPairingToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      // Create new token
      await (prisma as any).hudPairingToken.create({
        data: { userId, tokenHash, tokenPrefix, fo76Name: fo76Name.trim() },
      });

      logger.info({ userId }, 'Pairing token minted');
      res.status(201).json({ data: { token: rawToken, fo76Name: fo76Name.trim() } });
    } catch (tokenErr: any) {
      if (
        tokenErr?.code === 'P2021' ||
        (tokenErr?.message && tokenErr.message.includes('does not exist'))
      ) {
        // hud_pairing_tokens table not yet deployed (relay agent WT1 not merged)
        logger.warn({ userId }, 'hud_pairing_tokens table not found — pairing-token minting unavailable');
        return next(createError(503, 'Pairing token feature not yet available. Please try again later.'));
      }
      throw tokenErr;
    }
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/link/pairing-token
 * Revokes the active pairing token. User must re-mint to reconnect in-game.
 */
router.delete('/pairing-token', requireAuth, async (req: Request, res: Response, next) => {
  try {
    const userId = req.user!.id;

    try {
      const result = await (prisma as any).hudPairingToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      if (result.count === 0) {
        return next(createError(404, 'No active pairing token to revoke.'));
      }

      logger.info({ userId }, 'Pairing token revoked');
      res.json({ data: { success: true } });
    } catch (tokenErr: any) {
      if (
        tokenErr?.code === 'P2021' ||
        (tokenErr?.message && tokenErr.message.includes('does not exist'))
      ) {
        return next(createError(503, 'Pairing token feature not yet available.'));
      }
      throw tokenErr;
    }
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/link/provider/:provider
 * Unlink a non-Discord provider. Refuses if it would leave the user with no providers.
 */
router.delete('/provider/:provider', requireAuth, async (req: Request, res: Response, next) => {
  try {
    const userId = req.user!.id;
    const provider = paramStr(req, 'provider');

    if (provider === 'discord') {
      return next(
        createError(400, 'Cannot unlink Discord via this endpoint. Use the account settings.'),
      );
    }

    // Steam is the canonical inline provider on users (rather than a
    // linked_identities row), so handle it before the generic provider path.
    if (provider === 'steam') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { steamId: true, discordId: true },
      });
      if (!isValidSteamId(user?.steamId)) return next(createError(404, 'Steam identity not linked.'));
      const otherIdentities = await prisma.linkedIdentity.count({ where: { userId } });
      if (!user.discordId && otherIdentities < 1) {
        return next(createError(409, 'Cannot remove your last linked provider. Link another account first.'));
      }
      await prisma.user.update({ where: { id: userId }, data: { steamId: null } });
      logger.info({ userId, provider }, 'Provider identity unlinked');
      res.json({ data: { success: true } });
      return;
    }

    const result = await unlinkProviderIdentity(userId, provider);
    if (!result.ok) {
      if (result.reason === 'last_provider') {
        return next(
          createError(409, 'Cannot remove your last linked provider. Link another account first.'),
        );
      }
      return next(createError(404, 'Provider identity not found.'));
    }

    logger.info({ userId, provider }, 'Provider identity unlinked');
    res.json({ data: { success: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
