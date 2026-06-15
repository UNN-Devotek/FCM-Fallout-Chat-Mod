/**
 * Supersession guard for the token-keyed WS clients map.
 *
 * The `clients` map in handlers.ts is keyed by SESSION TOKEN, and the desktop
 * overlay reconnects with the SAME token across WS flaps (the relay proxy reuses
 * `sessionToken` until a re-register). So during a reconnect flap two sockets can
 * briefly coexist for one token: a fresh socket has already called
 * `clients.set(token, NEW)` while the old socket is still settling.
 *
 * If the old (now-stale) socket's close/error/heartbeat ran the normal teardown,
 * its `clients.delete(token)` would evict the LIVE socket from the map — after
 * which no broadcasts or presence updates reach the user (chat goes blank, new
 * messages stop arriving) until the next reconnect. This was the root cause of the
 * in-game "blank chat after auto-hide / return-to-game" reports.
 *
 * `isSocketSuperseded(currentMapWs, thisWs)` returns true when the map holds a
 * DIFFERENT socket for the token — i.e. this socket has been replaced and must
 * tear down quietly without touching the map or firing leave events.
 *
 * Pure function, no imports — safe to unit-test without the WS lifecycle.
 */
export function isSocketSuperseded(currentMapWs: unknown, thisWs: unknown): boolean {
  // No entry (undefined/null) → NOT superseded: this is the last/only socket, run
  // normal teardown. An entry that is a different object → superseded.
  if (currentMapWs === undefined || currentMapWs === null) return false;
  return currentMapWs !== thisWs;
}
