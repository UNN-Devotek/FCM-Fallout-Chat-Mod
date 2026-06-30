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
 * OR a signed-in dashboard/web Discord cookie session (resolved to the FCM user by discordId).
 * The web /link page authenticates by COOKIE, so the token-only requireAuth would 401 it into a
 * sign-in loop and the code-entry screen would never show. This implements the routes' documented
 * "X-Auth-Token or Discord session" contract. Mirrors requireAuth's ban auto-lift + reject.
 */
async function requireLinkAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    let userId: string | null = null;

    const token = req.headers['x-auth-token'];
    if (typeof token === 'string' && token) {
      const redis = await getRedisClient();
      userId = await redis.get(`session:${token}`);
    }

    // Fall back to the dashboard/web Discord cookie session.
    if (!userId) {
      const sess = req.session as any;
      const discordId: string | undefined = sess?.discordUser?.id ?? sess?.publicUser?.discordId;
      if (discordId) {
        const u = await prisma.user.findFirst({ where: { discordId }, select: { id: true } });
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
      select: { discordId: true, discordUsername: true, fo76AccountName: true },
    });

    const providers: Array<{ provider: string; username?: string | null; linkedAt: Date }> = [];
    if (user?.discordId) {
      providers.push({ provider: 'discord', username: user.discordUsername, linkedAt: new Date(0) });
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
 * Auth: requireAuth — the user must be signed in via Discord or Nexus first.
 * Body: { code: string }  (accepts "XXXXXXXX" or "XXXX-XXXX")
 * Rate: <=10/min per IP.
 *
 * On success:
 *   - Sets hud_link_codes.used_at + redeemed_by_user_id = req.user.id
 *   - Calls relay's markRelayTokenLinked(relayUserId, fcmUserId) to upgrade limited→linked
 *     (dynamic import — graceful 503 if relay WT1 not yet merged)
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
        createError(403, 'You must link a Discord or Nexus account before activating in-game chat.'),
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
    // markRelayTokenLinked is owned by relay agent WT1; dynamic import so this module compiles
    // and deploys solo before WT1 merges.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // NOTE: '../services/...' (NOT '../../src/...') so this resolves in the COMPILED build
      // (dist/routes -> dist/services), not just under tsx dev. The old path threw
      // MODULE_NOT_FOUND in prod, so the token was never actually linked (code marked used only).
      const relayService: any = await import('../services/relay/relayIdentityService');
      await relayService.markRelayTokenLinked(relayUserId, actorId);
      logger.info({ relayUserId, actorId }, 'Relay identity upgraded to linked');
      // Handshake: tell the user's live in-game subscriber it's now linked, so an
      // already-connected widget transitions from the link screen to chat immediately
      // (no reconnect needed). Optional-chained: a no-op if the relay module lacks it.
      await relayService.notifyLinkComplete?.(relayUserId);
    } catch (relayErr: any) {
      // If the relay service module isn't present yet (WT1 not merged), log and continue.
      // The relay will also poll hud_link_codes.used_at as its own fallback.
      if (
        relayErr?.code === 'MODULE_NOT_FOUND' ||
        (relayErr?.message && relayErr.message.includes('Cannot find module'))
      ) {
        logger.warn({ relayUserId }, 'relay/relayIdentityService not yet available — relay will poll used_at');
      } else {
        // Unexpected relay error: log but don't fail the user-facing redeem
        logger.error({ err: relayErr, relayUserId }, 'markRelayTokenLinked failed unexpectedly');
      }
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
        createError(403, 'You must link a Discord or Nexus account before minting a pairing token.'),
      );
    }

    // Check if this fo76Name is claimed by another user (collision)
    const existing = await prisma.user.findFirst({
      where: { fo76AccountName: fo76Name.trim(), id: { not: userId } },
      select: { id: true, discordId: true },
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
              providers_on_existing_account: existing.discordId ? ['discord'] : ['nexus'],
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
