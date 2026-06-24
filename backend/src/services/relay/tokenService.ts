/**
 * tokenService.ts — relay token mint / verify / revoke.
 *
 * Token flow:
 *   register → mintToken:  generate UUID userId + 256-bit token (base64url),
 *                           hash with argon2id, store in hud_pairing_tokens.
 *   hello    → verifyToken: prefix lookup → argon2.verify → return RelayToken.
 *
 * Token prefix = first 8 chars of the raw base64url token (indexed for fast
 * prefix lookup without scanning the full hash list).
 *
 * Lightweight user rows are created in the users table with:
 *   username     = 'relay-<tokenPrefix>'
 *   installToken = 'relay-<userId>'
 *
 * linked_user_id lifecycle:
 *   NULL       = "limited" — token owner cannot send; receives system notice with link code.
 *   non-NULL   = "linked"  — full send permissions granted.
 *   Set by markRelayTokenLinked(), called from /api/link/redeem (WT2) after the
 *   user redeems a link code + provider gate passes.
 */

import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../../config/prisma';
import logger from '../../config/logger';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,  // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

/** Identity returned from a successful verifyToken call. */
export interface RelayToken {
  userId: string;
  fo76Name: string;
  role: 'user';
  /**
   * true when linked_user_id is set — i.e. the user has completed the link flow
   * via /api/link/redeem and has at least one verified external provider.
   * false = "limited" — can receive but cannot send.
   */
  isLinked: boolean;
  /** The FCM user UUID that the relay identity was bound to on link redemption. */
  linkedUserId: string | null;
}

/**
 * Mint a fresh relay token for a new ZFE client.
 *
 * Creates a lightweight user row (if one does not already exist for this
 * fo76Name — callers should deduplicate, but mintToken is idempotent at the
 * DB level because username is unique), then inserts a hud_pairing_tokens row.
 *
 * Returns the raw token string — store it nowhere; hand it straight to the ZFE
 * client and discard. The hash lives in the DB.
 */
export async function mintToken(fo76Name: string): Promise<{ userId: string; token: string; role: 'user' }> {
  const userId       = uuidv4();
  const rawBytes     = randomBytes(32);
  const token        = rawBytes.toString('base64url');
  const tokenPrefix  = token.slice(0, 8);
  const tokenHash    = await argon2.hash(token, ARGON2_OPTIONS);

  // Create a lightweight user row for this relay identity.
  // username must be unique in the users table.
  await prisma.user.create({
    data: {
      id:           userId,
      username:     `relay-${tokenPrefix}`,
      installToken: `relay-${userId}`,
      fo76AccountName: fo76Name,
    },
  });

  await prisma.hudPairingToken.create({
    data: {
      userId,
      tokenHash,
      tokenPrefix,
      fo76Name,
      role: 'user',
      // linkedUserId starts NULL — the identity is "limited" until link redemption.
    },
  });

  logger.info({ userId, tokenPrefix, fo76Name }, '[tokenService] minted relay token');
  return { userId, token, role: 'user' };
}

/**
 * Verify a raw relay token.
 *
 * Splits off the first 8 chars as the prefix, looks up all non-revoked rows
 * with that prefix, then argon2-verifies the full token against each hash.
 * Returns the RelayToken on success, or null on failure (not found / revoked /
 * wrong hash).
 *
 * Also updates last_used_at on the matched row.
 */
export async function verifyToken(token: string): Promise<RelayToken | null> {
  if (typeof token !== 'string' || token.length < 8) return null;

  const prefix = token.slice(0, 8);

  const rows = await prisma.hudPairingToken.findMany({
    where: {
      tokenPrefix: prefix,
      revokedAt: null,
    },
    include: {
      user: {
        select: {
          id: true,
          fo76AccountName: true,
          fo76CharacterName: true,
          discordId: true,
          steamId: true,
          isBanned: true,
          isMuted: true,
        },
      },
    },
  });

  for (const row of rows) {
    let matches = false;
    try {
      matches = await argon2.verify(row.tokenHash, token);
    } catch (err) {
      logger.warn({ err, prefix }, '[tokenService] argon2 verify error');
      continue;
    }

    if (!matches) continue;

    // Update last_used_at in the background — non-blocking.
    prisma.hudPairingToken.update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    }).catch((err) => logger.warn({ err }, '[tokenService] last_used_at update failed'));

    // isLinked is determined by linked_user_id being set (the authoritative flag),
    // not by discordId/steamId on the user row — those are account-level, whereas
    // linked_user_id tracks whether THIS relay identity completed the link flow.
    const linkedUserId = (row as any).linkedUserId ?? null;
    const isLinked     = linkedUserId !== null;

    return {
      userId:       row.userId,
      fo76Name:     row.fo76Name,
      role:         'user',
      isLinked,
      linkedUserId,
    };
  }

  return null;
}

/**
 * Mark all active tokens for a relay userId as linked to a FCM user account.
 * Called by /api/link/redeem (WT2) after the user enters a valid link code and
 * the provider gate passes.
 *
 * Sets linked_user_id = fcmUserId on every non-revoked token row for the relay
 * user. If the relay userId doesn't exist (stale / already revoked), this is a
 * no-op (updateMany count = 0 is not an error).
 */
export async function markRelayTokenLinked(relayUserId: string, fcmUserId: string): Promise<void> {
  const result = await prisma.hudPairingToken.updateMany({
    where:  { userId: relayUserId, revokedAt: null },
    data:   { linkedUserId: fcmUserId },
  });
  logger.info({ relayUserId, fcmUserId, count: result.count }, '[tokenService] relay token linked');
}

/**
 * Revoke all active tokens for a userId.
 * Sets revoked_at = NOW() on every row where revoked_at IS NULL.
 */
export async function revokeToken(userId: string): Promise<void> {
  await prisma.hudPairingToken.updateMany({
    where: { userId, revokedAt: null },
    data:  { revokedAt: new Date() },
  });
  logger.info({ userId }, '[tokenService] revoked relay tokens');
}

/**
 * Update the fo76_name on all active token rows for a userId.
 * Used when a ZFE client reports a display-name change.
 */
export async function updateDisplayName(userId: string, fo76Name: string): Promise<void> {
  await prisma.hudPairingToken.updateMany({
    where: { userId, revokedAt: null },
    data:  { fo76Name },
  });
  // Also propagate to the user row.
  await prisma.user.update({
    where: { id: userId },
    data:  { fo76AccountName: fo76Name },
  });
}
