import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoundOAuthState, serializeBoundOAuthState } from '../oauthState';

test('bound OAuth state round-trips for the initiating session', () => {
  const value = serializeBoundOAuthState({
    sessionId: 'session-a',
    intent: 'admin',
    codeVerifier: 'verifier',
  });

  assert.deepEqual(parseBoundOAuthState(value, 'session-a'), {
    sessionId: 'session-a',
    intent: 'admin',
    codeVerifier: 'verifier',
  });
});

test('bound OAuth state rejects another session and malformed payloads', () => {
  const value = serializeBoundOAuthState({ sessionId: 'session-a', intent: 'admin' });

  assert.equal(parseBoundOAuthState(value, 'session-b'), null);
  assert.equal(parseBoundOAuthState('{not-json}', 'session-a'), null);
  assert.equal(parseBoundOAuthState(JSON.stringify({ intent: 'admin' }), 'session-a'), null);
});
