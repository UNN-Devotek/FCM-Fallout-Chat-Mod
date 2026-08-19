/**
 * relaySeq.ts — global monotonic relay sequence counter.
 *
 * Redis key: relay:seq
 *
 * On startup, MUST seed from MAX(messages.relay_seq) to avoid replaying
 * history after a restart. seedRelaySeq() uses SET … NX so it is safe to call
 * on every boot — the first caller wins and subsequent calls are no-ops.
 *
 * Returns BIGINT-compatible numbers (JS Number is safe up to 2^53 - 1, which
 * is ~9 quadrillion — far beyond what this counter will ever reach).
 */

import { getRedisClient } from '../../config/redis';
import prisma from '../../config/prisma';
import logger from '../../config/logger';

const RELAY_SEQ_KEY = 'relay:seq';

/**
 * Seed the relay sequence counter from the database high-water mark.
 * Uses SET … NX so concurrent server instances are safe — only the first
 * write wins. Call once during server startup, before the first request.
 */
export async function seedRelaySeq(): Promise<void> {
  try {
    // Find the highest relay_seq already persisted.
    const result = await prisma.$queryRaw<[{ max: bigint | null }]>`
      SELECT MAX(relay_seq) AS max FROM messages
    `;
    const maxSeq = result[0]?.max ?? null;
    const seed   = maxSeq !== null ? Number(maxSeq) : 0;

    const redis = await getRedisClient();
    // SET … NX: only sets when the key does not yet exist.
    await redis.set(RELAY_SEQ_KEY, String(seed), { NX: true });

    logger.info({ seed }, '[relaySeq] seeded relay:seq');
  } catch (err) {
    // Non-fatal on startup — worst case the counter starts from 0 after a
    // Redis flush (clients will simply re-sync from the beginning of the
    // window rather than getting a clean diff). Log and continue.
    logger.warn({ err }, '[relaySeq] seedRelaySeq failed — starting from 0');
    try {
      const redis = await getRedisClient();
      await redis.set(RELAY_SEQ_KEY, '0', { NX: true });
    } catch (innerErr) {
      logger.error({ err: innerErr }, '[relaySeq] could not initialise relay:seq at all');
    }
  }
}

/**
 * Atomically increment and return the next relay sequence number.
 * Redis INCR is atomic — concurrent callers are guaranteed distinct values.
 */
export async function nextRelaySeq(): Promise<number> {
  const redis = await getRedisClient();
  const next  = await redis.incr(RELAY_SEQ_KEY);
  return next;
}

/**
 * Best-effort cursor allocation for ordinary chat producers.
 *
 * Relay-originated frames call nextRelaySeq() directly and therefore fail
 * closed when Redis cannot provide a globally ordered cursor. Dashboard/HUD
 * chat must remain available during a Redis incident, so those callers use
 * this wrapper and simply omit the relay cursor when allocation is unavailable.
 */
export async function tryNextRelaySeq(): Promise<number | undefined> {
  try {
    return await nextRelaySeq();
  } catch (err) {
    logger.warn({ err }, '[relaySeq] optional cursor allocation failed; continuing without relaySeq');
    return undefined;
  }
}
