/**
 * Device keypair auth — verifies ECDSA P-256 / SHA-256 request signatures.
 *
 * Each install enrolls a public key (SPKI DER, base64). Authenticated requests
 * carry a signature over a canonical string covering method + path + body hash
 * + timestamp + nonce. This service verifies that signature against the stored
 * key, with a clock-skew window and single-use nonce (Redis) for replay
 * protection. See docs/device-keypair-auth-plan.md.
 *
 * INTEROP NOTE: the .NET client signs with DSASignatureFormat.Rfc3279DerSequence
 * (ASN.1 DER). Node's crypto.verify expects exactly that. The default .NET
 * IEEE-P1363 format would fail here — verified in the interop harness.
 */
import crypto from 'crypto';
import { getRedisClient } from '../config/redis';
import prisma from '../config/prisma';
import logger from '../config/logger';

export const SKEW_WINDOW_MS = 60_000;   // ±60s clock-skew tolerance
const NONCE_TTL_SECONDS = 120;           // > 2× skew window so an expired nonce can't be replayed

export interface SignatureHeaders {
  installToken: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export type VerifyResult =
  | { ok: true; installToken: string }
  | { ok: false; status: number; reason: string };

/** Pull the four signing headers off a request (case-insensitive via express). */
export function extractSignatureHeaders(headers: Record<string, unknown>): SignatureHeaders | null {
  const installToken = headers['x-device-install'];
  const timestamp = headers['x-device-timestamp'];
  const nonce = headers['x-device-nonce'];
  const signature = headers['x-device-signature'];
  if (typeof installToken !== 'string' || typeof timestamp !== 'string'
      || typeof nonce !== 'string' || typeof signature !== 'string') {
    return null;
  }
  return { installToken, timestamp, nonce, signature };
}

/** Canonical string the client signs. MUST match the .NET DeviceAuth.Sign exactly. */
export function buildCanon(method: string, path: string, bodySha256Hex: string, timestamp: string, nonce: string): string {
  return `${method.toUpperCase()}\n${path}\n${bodySha256Hex}\n${timestamp}\n${nonce}`;
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Verify a signed request. `rawBody` is the unparsed request body buffer
 * (captured by the express.json verify hook); pass an empty buffer for GETs.
 */
export async function verifySignedRequest(
  method: string,
  path: string,
  rawBody: Buffer,
  hdrs: SignatureHeaders,
): Promise<VerifyResult> {
  // 1. Timestamp window
  const ts = Number(hdrs.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SKEW_WINDOW_MS) {
    return { ok: false, status: 401, reason: 'timestamp outside allowed window' };
  }

  // 2. Nonce shape (16 bytes hex = 32 chars) — cheap guard before touching Redis
  if (!/^[0-9a-f]{16,64}$/i.test(hdrs.nonce)) {
    return { ok: false, status: 401, reason: 'malformed nonce' };
  }

  // 3. Device lookup
  const device = await prisma.device.findUnique({
    where: { installToken: hdrs.installToken },
    select: { publicKey: true, revokedAt: true },
  });
  if (!device) return { ok: false, status: 401, reason: 'device not enrolled' };
  if (device.revokedAt) return { ok: false, status: 403, reason: 'device key revoked' };

  // 4. Single-use nonce (replay protection). SET NX — fails if seen before.
  try {
    const redis = await getRedisClient();
    const set = await redis.set(`device_nonce:${hdrs.installToken}:${hdrs.nonce}`, '1', { NX: true, EX: NONCE_TTL_SECONDS });
    if (set !== 'OK') return { ok: false, status: 401, reason: 'nonce replay' };
  } catch (err) {
    // Fail CLOSED on nonce-store failure — replay protection is load-bearing.
    logger.warn({ err }, 'device-auth: nonce store unavailable, rejecting');
    return { ok: false, status: 503, reason: 'auth service unavailable' };
  }

  // 5. Signature verification
  const canon = buildCanon(method, path, sha256Hex(rawBody), hdrs.timestamp, hdrs.nonce);
  let pubKey: crypto.KeyObject;
  try {
    pubKey = crypto.createPublicKey({ key: Buffer.from(device.publicKey, 'base64'), format: 'der', type: 'spki' });
  } catch (err) {
    logger.warn({ err, installToken: hdrs.installToken }, 'device-auth: stored public key unparseable');
    return { ok: false, status: 500, reason: 'stored key invalid' };
  }
  let sigBuf: Buffer;
  try { sigBuf = Buffer.from(hdrs.signature, 'base64'); }
  catch { return { ok: false, status: 401, reason: 'malformed signature' }; }

  let valid = false;
  try { valid = crypto.verify('sha256', Buffer.from(canon, 'utf8'), pubKey, sigBuf); }
  catch { valid = false; } // DER-parse failures throw — treat as invalid
  if (!valid) return { ok: false, status: 401, reason: 'signature mismatch' };

  // 6. Bump last-seen (best-effort, non-blocking)
  prisma.device.update({ where: { installToken: hdrs.installToken }, data: { lastSeenAt: new Date() } })
    .catch(() => { /* non-fatal */ });

  return { ok: true, installToken: hdrs.installToken };
}

/**
 * Validate a public key is a well-formed P-256 SPKI before storing it at enroll.
 * Rejects anything that isn't an EC public key on the prime256v1 curve.
 */
export function isValidP256Spki(b64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec') return false;
    const details = key.asymmetricKeyDetails as { namedCurve?: string } | undefined;
    return details?.namedCurve === 'prime256v1';
  } catch {
    return false;
  }
}

export default { extractSignatureHeaders, buildCanon, sha256Hex, verifySignedRequest, isValidP256Spki, SKEW_WINDOW_MS };
module.exports = { extractSignatureHeaders, buildCanon, sha256Hex, verifySignedRequest, isValidP256Spki, SKEW_WINDOW_MS };
