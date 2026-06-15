import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSocketSuperseded } from '../socketSupersession';

// Stand-in socket identities — the guard only compares object identity.
const A = { id: 'A' };
const B = { id: 'B' };

test('not superseded when the map still points at this socket', () => {
  assert.equal(isSocketSuperseded(A, A), false);
});

test('superseded when the map holds a DIFFERENT socket for the token', () => {
  // A fresh socket B replaced A in the clients map (same session-token reconnect).
  // A's close must NOT delete the map entry — that would evict the live socket B.
  assert.equal(isSocketSuperseded(B, A), true);
});

test('not superseded when there is no map entry (last/only socket)', () => {
  // undefined/null = map has no entry → run normal teardown.
  assert.equal(isSocketSuperseded(undefined, A), false);
  assert.equal(isSocketSuperseded(null, A), false);
});

test('flap sequence: stale close is a no-op, live close tears down', () => {
  // Simulate the token-keyed map across a reconnect flap.
  let mapWs: unknown = A;          // A connected: clients.set(token, A)
  mapWs = B;                       // B reconnects (same token): clients.set(token, B)

  // A's delayed close fires — must be treated as superseded (no delete).
  const aSuperseded = isSocketSuperseded(mapWs, A);
  assert.equal(aSuperseded, true);
  if (!aSuperseded) mapWs = undefined; // (would-be delete) — must NOT happen
  assert.equal(mapWs, B, 'live socket B must remain in the map after A closes');

  // Later, B's own close fires — it IS current, so it tears down.
  const bSuperseded = isSocketSuperseded(mapWs, B);
  assert.equal(bSuperseded, false);
  if (!bSuperseded) mapWs = undefined;
  assert.equal(mapWs, undefined, 'map cleared once the live socket closes');
});
