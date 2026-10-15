import { runRequiredEffect } from '../../lib/requiredEffects';
import { runtime } from '../../runtime';
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
  let observedSeed: number | undefined;
  try {
    // Find the highest relay_seq already persisted.
    const result = await prisma.$queryRaw<[{ max: bigint | null }]>`
      SELECT MAX(relay_seq) AS max FROM messages
    `;
    const maxSeq = result[0]?.max ?? null;
    const seed   = maxSeq !== null ? Number(maxSeq) : 0;
    observedSeed = seed;

    const redis = await getRedisClient();
    // SET … NX: only sets when the key does not yet exist.
    await runRequiredEffect('relay:seed', { sequence: seed, stage: 'startup-cursor-seed-unconfirmed' },
      () => redis.set(RELAY_SEQ_KEY, String(seed), { NX: true }));

    logger.info({ seed }, '[relaySeq] seeded relay:seq');
  } catch (err) {
    // Availability is preserved, but an unconfirmed SET is durable failure
    // evidence. Never replace a known high-water mark with a zero fallback.
    logger.warn({ err }, '[relaySeq] seedRelaySeq failed — attempting observed seed fallback');
    try {
      const redis = await getRedisClient();
      const seed = observedSeed ?? 0;
      await runRequiredEffect('relay:seed', { sequence: seed, stage: 'startup-cursor-fallback-seed-unconfirmed' },
        () => redis.set(RELAY_SEQ_KEY, String(seed), { NX: true }));
    } catch (innerErr) {
      logger.error({ err: innerErr }, '[relaySeq] could not initialise relay:seq at all');
    }
  }
}

/**
 * Give legacy chat rows a relay cursor so they can participate in native HUD
 * history. Older Discord/game/HUD rows predate relay_seq and are otherwise
 * invisible to fetchHistoryEvents, which intentionally filters on a cursor.
 *
 * This is idempotent: rows are numbered only while relay_seq is NULL. It runs
 * before the server starts accepting traffic, so the Redis high-water mark can
 * be advanced safely before the first new cursor is allocated.
 */
export async function backfillMissingRelaySeq(): Promise<number> {
  let updatedRows = 0;
  let observedMax: number | undefined;
  let observedCurrent: number | undefined;
  let stage = 'legacy-cursor-write-unconfirmed';
  try {
    const prismaResult = await runRequiredEffect('relay:backfill', { stage }, () => prisma.$executeRaw`
      WITH legacy AS (
        SELECT id,
               created_at,
               COALESCE((SELECT MAX(relay_seq) FROM messages), 0)
                 + ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS next_seq
        FROM messages
        WHERE relay_seq IS NULL
      )
      UPDATE messages AS m
         SET relay_seq = legacy.next_seq
        FROM legacy
       WHERE m.id = legacy.id
         AND m.created_at = legacy.created_at
    `);
    updatedRows = Number(prismaResult) || 0;
    stage = 'backfilled-cursor-highwater-query-unconfirmed';
    const rows = await prisma.$queryRaw<[{ max: bigint | null }]>`
      SELECT MAX(relay_seq) AS max FROM messages
    `;
    const maxSeq = rows[0]?.max === null || rows[0]?.max === undefined
      ? 0
      : Number(rows[0].max);

    observedMax = maxSeq;
    stage = 'backfilled-cursor-current-read-unconfirmed';
    const redis = await getRedisClient();
    const currentRaw = await redis.get(RELAY_SEQ_KEY);
    const currentSeq = currentRaw === null ? 0 : Number(currentRaw);
    observedCurrent = Number.isFinite(currentSeq) ? currentSeq : undefined;
    if (!Number.isFinite(currentSeq) || currentSeq < maxSeq) {
      stage = 'backfilled-cursor-highwater-advance-unconfirmed';
      await runRequiredEffect('relay:backfill', { maxSeq, currentSeq: observedCurrent, updatedRows, stage },
        () => redis.set(RELAY_SEQ_KEY, String(maxSeq)));
    }

    if (updatedRows > 0) {
      logger.info({ updatedRows, maxSeq }, '[relaySeq] backfilled legacy chat cursors');
    }
    return updatedRows;
  } catch (err) {
    if (updatedRows > 0 && stage !== 'backfilled-cursor-highwater-advance-unconfirmed') {
      runtime.recordFailure('relay:backfill', err, { updatedRows, maxSeq: observedMax, currentSeq: observedCurrent, stage });
    }
    logger.warn({ err }, '[relaySeq] legacy cursor backfill failed — continuing without backfill');
    return 0;
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
