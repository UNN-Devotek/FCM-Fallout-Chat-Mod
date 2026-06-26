import crypto from 'crypto';
import prisma from '../config/prisma';

// Crockford base32 alphabet (excludes I, L, O, U — confusable chars)
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

/** Generate an 8-char Crockford base32 code (uppercase, no I/L/O/U).
 * Uses crypto.randomInt (unbiased rejection sampling) rather than modulo on a
 * random byte, which would bias the distribution for alphabets whose length does
 * not evenly divide 256. */
export function generateLinkCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CROCKFORD_ALPHABET[crypto.randomInt(CROCKFORD_ALPHABET.length)];
  }
  return code;
}

/** Normalize a code: uppercase, strip hyphens/spaces (handles XXXX-XXXX display format). */
export function normalizeLinkCode(raw: string): string {
  return raw.toUpperCase().replace(/[-\s]/g, '');
}

/**
 * Issue a new link code for a relay identity.
 * Called by the relay (WT1) on register/hello when the identity is limited.
 * Any existing active code for this relayUserId is superseded (deleted).
 * Returns the raw code to display in-game as XXXX-XXXX.
 */
export async function issueLinkCode(relayUserId: string): Promise<string> {
  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + TTL_MS);

  // Delete any existing code for this relay identity (one active code per relay user)
  await prisma.hudLinkCode.deleteMany({ where: { relayUserId } });

  await prisma.hudLinkCode.create({
    data: { code, relayUserId, expiresAt },
  });

  return code;
}

export type RedeemResult =
  | { ok: true; relayUserId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_used' | 'max_attempts' };

/**
 * Redeem a link code on behalf of an authenticated FCM user.
 * Called from POST /api/link/redeem (requireAuth).
 * On success: sets used_at + redeemed_by_user_id. The relay polls
 *   WHERE code = $1 AND used_at IS NOT NULL
 * and reads redeemed_by_user_id to bind the relay token to the FCM account.
 */
export async function redeemLinkCode(rawCode: string, redeemedByUserId: string): Promise<RedeemResult> {
  const code = normalizeLinkCode(rawCode);

  const row = await prisma.hudLinkCode.findUnique({ where: { code } });
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.usedAt) return { ok: false, reason: 'already_used' };
  if (new Date() > row.expiresAt) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'max_attempts' };

  // Increment attempts first (counts even on success to prevent retry loops)
  const updated = await prisma.hudLinkCode.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 } },
  });

  if (updated.attempts > MAX_ATTEMPTS) {
    return { ok: false, reason: 'max_attempts' };
  }

  // Mark as used and bind to the authed FCM user
  await prisma.hudLinkCode.update({
    where: { id: row.id },
    data: { usedAt: new Date(), redeemedByUserId },
  });

  return { ok: true, relayUserId: row.relayUserId };
}

export type ValidateResult =
  | { ok: true; relayUserId: string; redeemedByUserId: string }
  | { ok: false; reason: 'not_found' | 'not_redeemed' };

/**
 * Relay-side seam: check whether a code has been redeemed and return the bound FCM userId.
 * Called by the relay (WT1) to determine if a limited identity should be upgraded to linked.
 * Does not modify any state — read-only poll used after a short delay post-issuance.
 */
export async function validateAndConsume(rawCode: string): Promise<ValidateResult> {
  const code = normalizeLinkCode(rawCode);

  const row = await prisma.hudLinkCode.findUnique({ where: { code } });
  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.usedAt || !row.redeemedByUserId) return { ok: false, reason: 'not_redeemed' };

  return { ok: true, relayUserId: row.relayUserId, redeemedByUserId: row.redeemedByUserId };
}
