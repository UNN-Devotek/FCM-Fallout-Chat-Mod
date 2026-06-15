/**
 * welcomeDedup — cross-path welcome deduplication
 *
 * Three independent code paths can each fire an "[N/24 players on this
 * server]" welcome message for the same join event:
 *
 *   A. world:joined WS frame  → wj:welcomed:<userId>:<gen>           TTL 1800s
 *   B. presence:update 60s    → sv:welcomed:<userId>:<endpoint>      TTL 1800s
 *   C. /api/player-list POST  → sv:welcomed:<userId>  (bare, NX 90s) + pl:summary:<userId>
 *
 * Each path previously checked only its own Redis key so they could all
 * fire simultaneously.  This module provides an atomic claim primitive
 * that sets ALL three key namespaces in one pipeline, ensuring the first
 * path to call tryClaimWelcome wins and every subsequent path (regardless
 * of which namespace it polls) sees the lock already set.
 */

import { getRedisClient } from '../config/redis';

const WJ_TTL = 1800;   // seconds — matches world:joined handler
const SV_TTL = 1800;   // seconds — upgraded from the old 90s bare key
const PL_TTL = 1800;   // seconds — matches pl:summary key
// Coarse cross-path arbiter. The gen-keyed NX (wj:welcomed:<uid>:<gen>) only
// blocks duplicates that share the same gen. In practice, three paths can fire
// welcomes with different gens for the same join event (world:joined, the 60s
// presence:update fallback, and playerList name-overlap promotion) — each NX
// succeeds independently, producing duplicate welcomes.
//
// This coarse NX blocks any second welcome for the same user regardless of gen
// or endpoint. The 300s TTL also covers FSM oscillation: when the desktop FSM
// briefly loses TCP rows (network blip) it fires WorldLeft → WorldJoined,
// generating fresh self-messages each cycle. FO76's AWS-edge rotation produces
// different endpoints on each cycle, defeating the per-endpoint SV key, so this
// coarse key is the only reliable suppressor. Trade-off: a legitimate fast
// world-swap inside 5 min misses the welcome on the second world; FO76 loading
// screens already take 30–90s, so this is rarely hit.
const ANY_TTL = 300;

// Normalize the endpoint so sv:welcomed:<uid>:<endpoint> is canonical across
// paths. world:joined frames carry "heap:<ip>:<port>" or "tcp:<ip>:<port>";
// presence:update writes the bare "<ip>:<port>" form. Without normalization the
// dedup key differs across paths for the same world.
function bareEndpoint(ep: string): string {
  if (ep.startsWith('tcp:'))  return ep.substring(4);
  if (ep.startsWith('heap:')) return ep.substring(5);
  return ep;
}

/**
 * Attempt to atomically claim the welcome slot for (userId, generation, endpoint).
 *
 * Uses a Redis pipeline:
 *   1. SET wj:welcomed:<userId>:<gen>          NX EX 1800  ← primary race arbiter
 *   2. SET sv:welcomed:<userId>:<endpoint>     XX-free EX 1800  ← blocks inferred path
 *   3. SET sv:welcomed:<userId>               XX-free EX 1800  ← blocks playerList bare check
 *   4. SET pl:summary:<userId>               XX-free EX 1800  ← blocks playerList summary key
 *
 * Returns true if the NX on key (1) was won — i.e. this call is the first
 * to claim the welcome for this (userId, gen) pair.  Returns false if the
 * slot was already claimed (duplicate fire suppressed).
 *
 * On Redis error, returns true (fail-open: better to send one duplicate
 * than to permanently suppress the welcome).
 */
export async function tryClaimWelcome(
  userId: string,
  generation: number,
  endpoint: string,
): Promise<boolean> {
  const genInt = Math.floor(generation);
  const ep = bareEndpoint(endpoint);
  const wjKey  = `wj:welcomed:${userId}:${genInt}`;
  const anyKey = `wj:welcomed-any:${userId}`;
  const svEpKey = `sv:welcomed:${userId}:${ep}`;
  const svBare  = `sv:welcomed:${userId}`;
  const plKey   = `pl:summary:${userId}`;

  try {
    const redis = await getRedisClient();
    const pipeline = redis.multi();
    pipeline.set(wjKey,   '1', { EX: WJ_TTL, NX: true });    // gen-keyed primary
    pipeline.set(anyKey,  '1', { EX: ANY_TTL, NX: true });   // coarse cross-path arbiter
    pipeline.set(svEpKey, '1', { EX: SV_TTL });
    pipeline.set(svBare,  ep, { EX: SV_TTL });
    pipeline.set(plKey,   '1', { EX: PL_TTL });
    // Also persist latest gen for world:left stale-gen check.
    pipeline.set(`wj:latestGen:${userId}`, String(genInt), { EX: WJ_TTL });
    const results = await pipeline.exec();
    // Win iff EITHER NX returned OK (non-null). When the gen matches a previous
    // claim but a different path re-fires, results[0] is null (gen-keyed
    // already-set) — that's correct dedup. When gen differs but the coarse
    // arbiter is still set from a recent welcome, results[1] is null — block.
    // Only when BOTH NX succeeded (truly first welcome) do we send.
    return results[0] !== null && results[1] !== null;
  } catch {
    return true; // fail-open
  }
}

/**
 * Check whether a welcome has already been claimed for any of the key
 * namespaces for this user.  Useful for paths that cannot call
 * tryClaimWelcome with a known (gen, endpoint) pair (e.g. playerList
 * when it doesn't know the latest gen at the time of the check).
 *
 * Returns true if ANY welcome key is currently set.
 */
export async function isWelcomeClaimed(userId: string, latestGen: number | null): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    const checks: Promise<string | null>[] = [
      redis.get(`sv:welcomed:${userId}`),
    ];
    if (latestGen !== null) {
      checks.push(redis.get(`wj:welcomed:${userId}:${Math.floor(latestGen)}`));
    }
    const results = await Promise.all(checks);
    return results.some(v => v !== null);
  } catch {
    return false; // fail-open: let the caller proceed
  }
}

/**
 * Clear all welcome dedup keys for a user (call on world-leave).
 *
 * Replaces / extends clearJoinDedupKeys — callers should migrate to this
 * function for the welcome-specific keys.  The scan-based approach handles
 * sv:welcomed:<userId>:* variants accumulated during canonical-drift.
 */
export async function clearWelcomeKeys(userId: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    // Gather all sv:welcomed:<userId>:* variants via SCAN
    const svKeys: string[] = [];
    for await (const k of redis.scanIterator({ MATCH: `sv:welcomed:${userId}*`, COUNT: 100 })) {
      const anyK: any = k;
      if (typeof anyK === 'string') svKeys.push(anyK);
      else if (anyK && typeof anyK.key === 'string') svKeys.push(anyK.key);
      else if (Array.isArray(anyK)) {
        for (const item of anyK) if (typeof item === 'string') svKeys.push(item);
      }
    }

    // Gather all wj:welcomed:<userId>:* variants via SCAN
    const wjKeys: string[] = [];
    for await (const k of redis.scanIterator({ MATCH: `wj:welcomed:${userId}:*`, COUNT: 100 })) {
      const anyK: any = k;
      if (typeof anyK === 'string') wjKeys.push(anyK);
      else if (anyK && typeof anyK.key === 'string') wjKeys.push(anyK.key);
      else if (Array.isArray(anyK)) {
        for (const item of anyK) if (typeof item === 'string') wjKeys.push(item);
      }
    }

    await Promise.all([
      ...svKeys.map(k => redis.del(k)),
      ...wjKeys.map(k => redis.del(k)),
      redis.del(`pl:summary:${userId}`),
      redis.del(`wj:latestGen:${userId}`),
      redis.del(`wj:welcomed-any:${userId}`),
    ]);
  } catch { /* non-fatal */ }
}
