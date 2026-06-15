import crypto from 'crypto';

/**
 * Compute a 4-character uppercase hex discriminator from an install_token.
 * Uses SHA-256 and takes the first 4 hex characters.
 * Example: "ToddHoward" + install_token -> "A8F2"
 */
export function computeDiscriminator(installToken: string): string {
  const hash = crypto.createHash('sha256').update(installToken).digest('hex');
  return hash.slice(0, 4).toUpperCase();
}

module.exports = { computeDiscriminator };
