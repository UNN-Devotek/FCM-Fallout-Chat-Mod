/**
 * tokenService.ts — relay token mint / verify / revoke.
 *
 * Token flow:
 *   register → mintToken:  generate relay userId (TEXT, "user_"+hex) + 256-bit
 *                           base64url token, hash with argon2id, store in
 *                           hud_pairing_tokens. NO users row created — a fresh
 *                           register is an anonymous limited identity.
 *   hello    → verifyToken: prefix lookup → argon2.verify → return RelayToken.
 *
 * Token prefix = first 8 chars of the raw base64url token (indexed for fast
 * prefix lookup without scanning the full hash list).
 *
 * Identity model:
 *   userId      = relay TEXT identity ("user_"+hex). Never a UUID FK to users.
 *                 This is the relay_user_id namespace WT2 references.
 *   linkedUserId = UUID FK → users.id.  NULL = "limited" — token owner cannot
 *                 send; receives a system notice with a link code.  Non-null =
 *                 "linked" — full send permissions granted. Authoritative flag.
 *
 * linked_user_id lifecycle:
 *   NULL       → "limited" (register default)
 *   non-NULL   → "linked"  (set by markRelayTokenLinked() called from /api/link/redeem)
 *
 * Ban/mute state: resolved via linkedUserId → users row (limited users are
 * blocked from send anyway; ban check still runs when linked to support
 * revocation of already-linked accounts).
 */

import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import prisma from '../../config/prisma';
import logger from '../../config/logger';

// argon2 0.45 split the old `Options` type into `HashOptions` / `VerifyOptions`.
// These feed argon2.hash() only, so HashOptions is the correct one. The values
// are unchanged — argon2id is still numeric 2 — so stored hashes stay valid.
const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,  // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

// Argon2id remains the source of truth, but re-running a 64 MiB verification
// for every frame lets one authenticated socket become a CPU/memory DoS. Cache
// successful verification results briefly; link/revoke/name mutations below
// explicitly invalidate the affected relay identity.
const VERIFY_CACHE_TTL_MS = 5_000;
const MAX_VERIFY_CACHE_ENTRIES = 10_000;
const VERIFY_FAILURE_WINDOW_MS = 10_000;
const MAX_VERIFY_FAILURES_PER_PREFIX = 10;

const verificationCache = new Map<string, { identity: RelayToken; expiresAt: number }>();
const failedVerifications = new Map<string, { windowStartedAt: number; count: number }>();

function tokenCacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function invalidateVerificationCache(userId?: string): void {
  if (!userId) {
    verificationCache.clear();
    return;
  }
  for (const [key, entry] of verificationCache) {
    if (entry.identity.userId === userId) verificationCache.delete(key);
  }
}

function invalidateVerificationCacheByLinkedUserId(linkedUserId: string): void {
  for (const [key, entry] of verificationCache) {
    if (entry.identity.linkedUserId === linkedUserId) verificationCache.delete(key);
  }
}

function allowArgonVerification(prefix: string): boolean {
  const now = Date.now();
  const prior = failedVerifications.get(prefix);
  if (!prior || now - prior.windowStartedAt >= VERIFY_FAILURE_WINDOW_MS) {
    failedVerifications.set(prefix, { windowStartedAt: now, count: 1 });
    return true;
  }
  if (prior.count >= MAX_VERIFY_FAILURES_PER_PREFIX) return false;
  prior.count += 1;
  return true;
}

/** Identity returned from a successful verifyToken call. */
export interface RelayToken {
  /** Relay TEXT identity — "user_"+hex. NOT a users.id UUID. */
  userId: string;
  fo76Name: string;
  role: 'user';
  /**
   * true when linked_user_id is set — the user has completed the link flow
   * via /api/link/redeem and has at least one verified external provider.
   * false = "limited" — can receive system notices but cannot send.
   */
  isLinked: boolean;
  /** The FCM users.id UUID the relay identity was bound to. Null while limited. */
  linkedUserId: string | null;
}

/**
 * Mint a fresh relay token for a new ZFE client.
 *
 * Inserts a hud_pairing_tokens row with a relay-owned TEXT userId
 * ("user_"+randomHex). Does NOT create a row in the users table — a fresh
 * registration is anonymous/limited until the user completes the link flow.
 *
 * Returns the raw token string — give it to the ZFE client once and discard.
 * The hash lives in the DB; the raw value is never stored.
 */
export async function mintToken(fo76Name: string): Promise<{ userId: string; token: string; role: 'user' }> {
  // Relay userId: "user_" + 32 random hex chars (128 bits). TEXT, not UUID.
  const userId      = `user_${randomBytes(16).toString('hex')}`;
  const rawBytes    = randomBytes(32);
  const token       = rawBytes.toString('base64url');
  const tokenPrefix = token.slice(0, 8);
  const tokenHash   = await argon2.hash(token, ARGON2_OPTIONS);

  // No users row — relay identity starts anonymous/limited.
  await prisma.hudPairingToken.create({
    data: {
      userId,
      tokenHash,
      tokenPrefix,
      fo76Name,
      role: 'user',
      // linkedUserId starts NULL — "limited" until link redemption.
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
  const cacheKey = tokenCacheKey(token);
  const cached = verificationCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.identity;
    verificationCache.delete(cacheKey);
  }

  const rows = await prisma.hudPairingToken.findMany({
    where: {
      tokenPrefix: prefix,
      revokedAt: null,
    },
  });

  if (rows.length > 0 && !allowArgonVerification(prefix)) {
    logger.warn({ prefix }, '[tokenService] throttling repeated failed token verification');
    return null;
  }

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

    // isLinked is determined solely by linked_user_id (the authoritative flag).
    // discordId/steamId on the users row are account-level; they don't govern
    // whether THIS relay identity completed the link flow.
    const linkedUserId = (row as any).linkedUserId ?? null;
    const isLinked     = linkedUserId !== null;

    const identity: RelayToken = {
      userId:    row.userId,
      fo76Name:  row.fo76Name,
      role:      'user',
      isLinked,
      linkedUserId,
    };

    failedVerifications.delete(prefix);
    if (verificationCache.size >= MAX_VERIFY_CACHE_ENTRIES) {
      const oldest = verificationCache.keys().next().value;
      if (oldest) verificationCache.delete(oldest);
    }
    verificationCache.set(cacheKey, { identity, expiresAt: Date.now() + VERIFY_CACHE_TTL_MS });
    return identity;
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
  invalidateVerificationCache(relayUserId);

  // Propagate the in-game CHARACTER name onto the linked FCM account so chat HISTORY (which
  // derives the sender from the user row, not per-message) shows the character, not the Discord
  // name. Live messages already carry identity.fo76Name via handleSend; this keeps history aligned.
  try {
    const tok = await prisma.hudPairingToken.findFirst({
      where:  { userId: relayUserId },
      select: { fo76Name: true },
    });
    if (tok?.fo76Name) {
      await prisma.user.update({ where: { id: fcmUserId }, data: { fo76AccountName: tok.fo76Name } });
    }
  } catch (err) {
    logger.warn({ err, relayUserId, fcmUserId }, '[tokenService] fo76AccountName propagation failed (non-fatal)');
  }
}

/**
 * Revoke all active tokens for a relay userId.
 * Sets revoked_at = NOW() on every row where revoked_at IS NULL.
 */
export async function revokeToken(userId: string): Promise<void> {
  await prisma.hudPairingToken.updateMany({
    where: { userId, revokedAt: null },
    data:  { revokedAt: new Date() },
  });
  invalidateVerificationCache(userId);
  logger.info({ userId }, '[tokenService] revoked relay tokens');
}

/**
 * Revoke every active relay token linked to an FCM account.
 * Permanent account bans use this because one account may have tokens minted
 * by more than one game installation. The linked-user cache entries must be
 * invalidated as well, otherwise a recent successful verify could survive the
 * database revocation for the cache TTL.
 */
export async function revokeTokensForLinkedUser(linkedUserId: string): Promise<void> {
  await prisma.hudPairingToken.updateMany({
    where: { linkedUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  invalidateVerificationCacheByLinkedUserId(linkedUserId);
  logger.info({ linkedUserId }, '[tokenService] revoked linked relay tokens');
}

/**
 * Update the fo76_name on all active token rows for a relay userId.
 * Used when a ZFE client reports a display-name change.
 * Does NOT update the users table (relay userId has no users row).
 */
export async function updateDisplayName(userId: string, fo76Name: string): Promise<void> {
  await prisma.hudPairingToken.updateMany({
    where: { userId, revokedAt: null },
    data:  { fo76Name },
  });
  invalidateVerificationCache(userId);
}

/** Test/maintenance seam: clear process-local auth state between isolated runs. */
export function clearVerificationCache(): void {
  invalidateVerificationCache();
  failedVerifications.clear();
}
