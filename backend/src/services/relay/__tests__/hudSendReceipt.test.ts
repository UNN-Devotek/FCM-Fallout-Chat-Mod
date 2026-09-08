import test from 'node:test';
import assert from 'node:assert/strict';
import { claimHudSend, hudSendReceiptIdentity, hudSendResponse, parseHudSendCarrier, type ReceiptStore } from '../hudSendReceipt';

function fixture() {
  const data = new Map<string, string>();
  const store: ReceiptStore = {
    async set(key, value) { if (data.has(key)) return null; data.set(key, value); return 'OK'; },
    async get(key) { return data.get(key) ?? null; },
  };
  const request = { id: 'abcdefgh0123456789', room: 'world:one' };
  const identity = hudSendReceiptIdentity('device-a', 'account-a', request, 'server', 'hello');
  return { data, store, request, identity };
}

test('native carrier validates bounded ID and room encoding, never accepts malformed prefixes', () => {
  assert.deepEqual(parseHudSendCarrier('FCMOUT/1;i=abcdefgh0123456789;r=world%3Aone'), { id: 'abcdefgh0123456789', room: 'world:one' });
  for (const value of ['FCMOUT/1;i=short;r=', 'FCMOUT/1;i=abcdefgh0123456789;r=%', 'FCMOUT/1;i=abcdefgh0123456789;r=%00', 'FCMOUT/1;i=abcdefgh0123456789;r=one;extra=yes']) assert.equal(parseHudSendCarrier(value), null);
});
test('shared atomic store permits only one instance to execute a send', async () => {
  const { store, identity } = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => claimHudSend(store, identity)));
  assert.equal(results.filter(r => r.kind === 'claimed').length, 1);
  assert.equal(results.filter(r => r.kind === 'pending').length, 19);
});
test('completed responses replay exactly without executing, incomplete old claims remain uncertain', async () => {
  const { store, identity, data } = fixture();
  await claimHudSend(store, identity);
  data.set(identity.key, JSON.stringify({ fingerprint: identity.fingerprint, createdAt: Date.now() - 121_000 }));
  assert.deepEqual(await claimHudSend(store, identity), { kind: 'uncertain' });
  const response = hudSendResponse({ success: true, messageId: 'm', targetUserId: 'FCMHUD/1;m=m;n=%23FF8800' }, 'abcdefgh0123456789');
  data.set(identity.key, JSON.stringify({ fingerprint: identity.fingerprint, response }));
  assert.deepEqual(await claimHudSend(store, identity), { kind: 'replay', response });
  assert.equal(response.targetUserId, 'FCMHUD/1;m=m;n=%23FF8800;q=abcdefgh0123456789');
  assert.deepEqual(hudSendResponse(response, 'abcdefgh0123456789'), response);
});
test('receipt scopes device and linked account and binds channel body and room', async () => {
  const { store, identity, request } = fixture();
  await claimHudSend(store, identity);
  for (const altered of [
    hudSendReceiptIdentity('device-a', 'account-a', request, 'global', 'hello'),
    hudSendReceiptIdentity('device-a', 'account-a', request, 'server', 'changed'),
    hudSendReceiptIdentity('device-a', 'account-a', { ...request, room: 'world:two' }, 'server', 'hello'),
  ]) assert.deepEqual(await claimHudSend(store, altered), { kind: 'conflict' });
  assert.equal((await claimHudSend(store, hudSendReceiptIdentity('device-b', 'account-a', request, 'server', 'hello'))).kind, 'claimed');
  assert.equal((await claimHudSend(store, hudSendReceiptIdentity('device-a', 'account-b', request, 'server', 'hello'))).kind, 'claimed');
});
