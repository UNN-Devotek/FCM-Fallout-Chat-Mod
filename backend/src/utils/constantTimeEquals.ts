import { createHash, timingSafeEqual } from 'crypto';

/**
 * Constant-time string compare. SHA-256 both sides first so the comparison
 * runs on equal-length buffers regardless of input, then `timingSafeEqual`.
 * Defeats the byte-by-byte timing side-channel that a plain `===` leaks.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

module.exports = { constantTimeEquals };
