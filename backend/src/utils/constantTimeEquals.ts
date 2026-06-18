import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Per-process random key used only to blind the comparison below. It is
 * generated fresh at module load and never persisted — the same key is used
 * for both operands, so equal inputs still produce equal digests. This is the
 * standard HMAC "blinding" technique for constant-time string comparison; it is
 * NOT password storage/hashing (nothing here is ever stored or verified later).
 */
const BLIND_KEY = randomBytes(32);

/**
 * Constant-time string compare. HMAC-SHA256 both sides under a per-process
 * random key first, so the comparison runs on equal-length, fixed-size buffers
 * regardless of input length, then `timingSafeEqual`. Same key on both sides in
 * the same process means equal inputs still compare equal — the function's
 * boolean contract is unchanged. Defeats the byte-by-byte timing side-channel
 * that a plain `===` leaks (and the length leak of comparing raw buffers).
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHmac('sha256', BLIND_KEY).update(a).digest();
  const hb = createHmac('sha256', BLIND_KEY).update(b).digest();
  return timingSafeEqual(ha, hb);
}

module.exports = { constantTimeEquals };
