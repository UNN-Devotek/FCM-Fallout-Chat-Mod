import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSteamDisplayName } from '../steamProfileService';
const id = '76561198000000001';
test('Steam profile name comes from the matching server-returned Steam ID', async () => {
  const fetchImpl: typeof fetch = async (url, options) => {
    assert.equal(new URL(String(url)).hostname, 'api.steampowered.com');
    assert.equal(options?.redirect, 'error');
    return new Response(JSON.stringify({ response: { players: [{ steamid: '76561198000000002', personaname: 'Other' }, { steamid: id, personaname: ' Steam Dweller ' }] } }));
  };
  assert.equal(await fetchSteamDisplayName(id, 'test-key', fetchImpl), 'Steam Dweller');
});
test('missing key and malformed IDs never make a profile request', async () => {
  let calls = 0;
  const fail: typeof fetch = async () => { calls++; throw new Error('should not fetch'); };
  assert.equal(await fetchSteamDisplayName(id, '', fail), null);
  assert.equal(await fetchSteamDisplayName('invalid', 'test-key', fail), null);
  assert.equal(calls, 0);
});
test('profile failures and mismatched identities return no display name', async () => {
  for (const data of [{}, {response:{players:[]}}, {response:{players:[{steamid:'other',personaname:'Fake'}]}}, {response:{players:[{steamid:id,personaname:42}]}}]) {
    assert.equal(await fetchSteamDisplayName(id, 'test-key', async () => new Response(JSON.stringify(data))), null);
  }
  assert.equal(await fetchSteamDisplayName(id, 'test-key', async () => new Response('', { status: 503 })), null);
  assert.equal(await fetchSteamDisplayName(id, 'test-key', async () => { throw new Error('timeout'); }), null);
});
test('Steam profile names are sanitized for HUD display', async () => {
  assert.equal(await fetchSteamDisplayName(id, 'test-key', async () => new Response(JSON.stringify({response:{players:[{steamid:id, personaname:'<Dweller>|\u0000'}]}}))), 'Dweller');
});
