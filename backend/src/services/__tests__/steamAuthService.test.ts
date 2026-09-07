import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSteamOpenIdUrl,
  extractSteamId,
  isValidSteamId,
  STEAM_OPENID_ENDPOINT,
  validateSteamAssertion,
} from '../steamAuthService';

const STEAM_ID = '76561198012345678';

test('Steam OpenID URL contains the fixed endpoint and callback parameters', () => {
  const url = new URL(buildSteamOpenIdUrl({
    returnTo: 'https://falloutchatmod.com/auth/steam/callback?state=state-1',
    realm: 'https://falloutchatmod.com/',
  }));

  assert.equal(`${url.origin}${url.pathname}`, STEAM_OPENID_ENDPOINT);
  assert.equal(url.searchParams.get('openid.mode'), 'checkid_setup');
  assert.equal(url.searchParams.get('openid.return_to'), 'https://falloutchatmod.com/auth/steam/callback?state=state-1');
  assert.equal(url.searchParams.get('openid.realm'), 'https://falloutchatmod.com/');
  assert.equal(url.searchParams.get('openid.identity'), 'http://specs.openid.net/auth/2.0/identifier_select');
});

test('Steam identity parsing accepts only a canonical 17-digit SteamID64', () => {
  assert.equal(isValidSteamId(STEAM_ID), true);
  assert.equal(extractSteamId(`https://steamcommunity.com/openid/id/${STEAM_ID}`), STEAM_ID);
  assert.equal(extractSteamId(`http://steamcommunity.com/openid/id/${STEAM_ID}`), null);
  assert.equal(extractSteamId(`https://steamcommunity.com/openid/id/123`), null);
  assert.equal(isValidSteamId('not-a-steam-id'), false);
});

test('Steam assertion validation posts only OpenID fields and requires is_valid:true', async () => {
  let requestBody = '';
  const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = String(init?.body ?? '');
    return new Response('ns:http://specs.openid.net/auth/2.0\nis_valid:true\n', { status: 200 });
  };

  const valid = await validateSteamAssertion({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'id_res',
    'openid.identity': `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    ignored: 'must-not-be-forwarded',
  }, fakeFetch);

  assert.equal(valid, true);
  const body = new URLSearchParams(requestBody);
  assert.equal(body.get('openid.mode'), 'check_authentication');
  assert.equal(body.get('ignored'), null);

  const invalid = await validateSteamAssertion({}, async () => new Response('is_valid:false', { status: 200 }));
  assert.equal(invalid, false);
});
