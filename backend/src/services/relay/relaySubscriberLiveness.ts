/**
 * Liveness policy for long-lived native relay subscriptions.
 *
 * A subscription whose client vanished (game crash, network change, a stalled native
 * worker) stays open on the server until the proxy chain notices, which can take many
 * minutes. Each such socket holds one of the five per-IP relay slots, so a player who
 * reconnects a few times is locked out of every send, room renewal and resubscribe.
 * Production logs (2026-11-14..16) showed 143 such lockouts, many lasting 5-30 minutes.
 */

/** Consecutive unanswered pings (at RELAY_PING_INTERVAL_MS) before a socket is reaped. */
export function relayMissedPongLimit(raw: string | undefined = process.env.RELAY_MISSED_PONGS): number {
  const parsed = Number(raw ?? 8);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 8;
}

/**
 * Reap only a socket that has proven it answers pings and then stopped. A client
 * whose WebSocket stack never answers pings is never judged by this rule, so this
 * cannot disconnect a healthy native client.
 */
export function shouldReapSubscriber(answeredPing: boolean, unansweredPings: number, limit: number): boolean {
  return limit > 0 && answeredPing && unansweredPings >= limit;
}

/**
 * Older subscriptions of the same relay identity that a new subscription replaces.
 * One native client holds one subscription per identity; an older one is a leftover
 * from a connection the client has already abandoned.
 */
export function supersededSubscriptions<T extends { userId: string }>(
  current: T, subscriptions: Iterable<T>,
): T[] {
  const replaced: T[] = [];
  for (const other of subscriptions) {
    if (other !== current && other.userId === current.userId) replaced.push(other);
  }
  return replaced;
}

/**
 * How long a relay socket may go without inbound traffic (a frame or a pong) before
 * a new connection from the same IP may take its slot when that IP is at its cap.
 * Healthy clients answer the 4 s keepalive ping, so 30 s of silence means the client
 * is gone. 0 disables eviction and restores plain refusal at the cap.
 */
export function relayEvictIdleMs(raw: string | undefined = process.env.RELAY_EVICT_IDLE_MS): number {
  const parsed = Number(raw ?? 30_000);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 30_000;
}

/**
 * The slot a new connection may take when its IP is at the cap: the longest-silent
 * socket, if it has been silent for at least `idleMs`. Supersession and missed-pong
 * reaping need the client to get a new socket in or to have answered pings; a player
 * whose every slot is held by dead sockets would otherwise be refused until the proxy
 * chain gives up on them. Live sockets are never chosen, so a burst of new connections
 * still cannot push out an active client.
 */
export function evictableRelaySlot<T extends { lastActivityAt: number }>(
  slots: Iterable<T>, now: number, idleMs: number,
): T | null {
  if (idleMs <= 0) return null;
  let oldest: T | null = null;
  for (const slot of slots) {
    if (now - slot.lastActivityAt < idleMs) continue;
    if (!oldest || slot.lastActivityAt < oldest.lastActivityAt) oldest = slot;
  }
  return oldest;
}
