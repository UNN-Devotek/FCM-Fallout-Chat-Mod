import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deletedMessageIdFromBroadcast,
  hudDeleteEventBody,
  parseModerationEnvelope,
  relayModerationError,
  repairModerationFrame,
  resolveModerationDuration,
} from '../hudModeration';
import { relayHistoryDisplayName } from '../historyDisplayName';
import { relayHudEventForClient } from '../relayCosmetics';
import { supportsHudModerationEvents } from '../clientCapability';

test('a ban never becomes permanent because its duration was lost or invalid', () => {
  assert.deepEqual(resolveModerationDuration('banUser', {}, null), {
    ok: false, message: 'A ban requires durationMinutes or an explicit permanent=true',
  });
  for (const durationMinutes of [0, -5, 1.5, 43_201, 'soon', '']) {
    assert.equal(resolveModerationDuration('banUser', { durationMinutes }, null).ok, false, String(durationMinutes));
  }
  assert.deepEqual(resolveModerationDuration('banUser', { permanent: true }, null), { ok: true, minutes: null });
  assert.equal(resolveModerationDuration('banUser', { permanent: true, durationMinutes: 60 }, null).ok, false);
  assert.deepEqual(resolveModerationDuration('banUser', { durationMinutes: 1440 }, null), { ok: true, minutes: 1440 });
});

test('the FCMMOD/1 messageId envelope carries duration, permanence and by-name targets through ZFE', () => {
  assert.deepEqual(parseModerationEnvelope('FCMMOD/1;d=1440'), { minutes: 1440 });
  assert.deepEqual(parseModerationEnvelope('FCMMOD/1;p=1'), { permanent: true });
  assert.deepEqual(parseModerationEnvelope('FCMMOD/1;n=Alice%20Smith'), { targetName: 'Alice Smith' });
  assert.equal(parseModerationEnvelope('33333333-3333-4333-8333-333333333333'), null);
  // The ZFE-safe envelope is equivalent to the JSON members, and the JSON member wins.
  assert.deepEqual(resolveModerationDuration('banUser', {}, parseModerationEnvelope('FCMMOD/1;d=60')), { ok: true, minutes: 60 });
  assert.deepEqual(resolveModerationDuration('banUser', {}, parseModerationEnvelope('FCMMOD/1;p=1')), { ok: true, minutes: null });
  assert.deepEqual(resolveModerationDuration('banUser', { durationMinutes: 30 }, parseModerationEnvelope('FCMMOD/1;d=60')), { ok: true, minutes: 30 });
  assert.equal(resolveModerationDuration('banUser', {}, parseModerationEnvelope('FCMMOD/1;d=0')).ok, false);
});

test('mutes keep the 10-minute default and reject permanent or invalid durations', () => {
  assert.deepEqual(resolveModerationDuration('muteUser', {}, null), { ok: true, minutes: 10 });
  assert.deepEqual(resolveModerationDuration('muteUser', {}, parseModerationEnvelope('FCMMOD/1;d=120')), { ok: true, minutes: 120 });
  assert.equal(resolveModerationDuration('muteUser', { permanent: true }, null).ok, false);
  assert.equal(resolveModerationDuration('muteUser', { durationMinutes: 0 }, null).ok, false);
});

test('ZFE-padded moderation frames are repaired only when the action corroborates it', () => {
  const pad = (value: string) => value.split('').join('u0000');
  const repaired = repairModerationFrame({ action: pad('banUser'), messageId: pad('FCMMOD/1;d=60'), reason: pad('spam') });
  assert.equal(repaired.action, 'banUser');
  assert.equal(repaired.messageId, 'FCMMOD/1;d=60');
  assert.equal(repaired.reason, 'spam');
  const clean = { action: 'banUser', reason: pad('spam') };
  assert.equal(repairModerationFrame(clean), clean);
});

test('service failures map to stable relay codes', () => {
  const protectedErr = Object.assign(new Error('protected'), { name: 'ProtectedTargetError', code: 'ProtectedTarget' });
  assert.equal(relayModerationError(protectedErr)?.code, 'protected_target');
  assert.equal(relayModerationError(Object.assign(new Error('x'), { code: 'AlreadyBanned' }))?.code, 'already_banned');
  assert.equal(relayModerationError(Object.assign(new Error('x'), { code: 'NotBanned' }))?.code, 'not_banned');
  assert.equal(relayModerationError(new Error('Ban already reversed'))?.code, 'not_banned');
  assert.equal(relayModerationError(Object.assign(new Error('x'), { code: 'TargetNotFound' }))?.code, 'target_not_found');
  assert.equal(relayModerationError(new Error('Message not found'))?.code, 'message_not_found');
  assert.equal(relayModerationError(Object.assign(new Error('db'), { code: 'P2023' })), null);
});

test('deletions are announced only to widgets that negotiated the private event', () => {
  assert.equal(deletedMessageIdFromBroadcast({ type: 'chat:delete', payload: { messageId: 'abc' } }), 'abc');
  assert.equal(deletedMessageIdFromBroadcast({ type: 'chat:message', payload: { messageId: 'abc' } }), null);
  assert.equal(hudDeleteEventBody('server:r:1:2'), 'FCMDEL/1;m=server%3Ar%3A1%3A2');
  assert.equal(supportsHudModerationEvents('2.10.152'), false);
  assert.equal(supportsHudModerationEvents('2.10.153'), true);
  assert.equal(supportsHudModerationEvents(undefined), false);
});

test('Server-room HUD events mirror the sender account id in the native carrier', () => {
  const accountId = '22222222-2222-4222-8222-222222222222';
  const event = relayHudEventForClient({ id: 5, kind: 'chat.message', messageId: 'server:r:x:5', channel: 'server',
    senderUserId: 'user_abc', linkedUserId: accountId, senderDisplayName: 'Peer', body: 'hi', targetUserId: '' }, true);
  assert.match(String(event.targetUserId), new RegExp(`;a=${accountId}$`));
  const global = relayHudEventForClient({ id: 6, kind: 'chat.message', messageId: 'm', channel: 'global',
    senderUserId: accountId, linkedUserId: accountId, body: 'hi', targetUserId: '' }, true);
  assert.doesNotMatch(String(global.targetUserId), /;a=/);
});

test('history replay never shows placeholder usernames and matches the live label', () => {
  const base = { username: 'pending-abc123', chat_name: null, steam_display_name: null, fo76_character_name: null,
    fo76_account_name: null, discord_display_name: null, discord_username: null };
  assert.equal(relayHistoryDisplayName({ ...base, source: 'relay', steam_display_name: 'SteamName' }), 'SteamName');
  assert.equal(relayHistoryDisplayName({ ...base, source: 'relay', fo76_account_name: 'Vaultie' , steam_display_name: 'SteamName' }), 'Vaultie');
  assert.equal(relayHistoryDisplayName({ ...base, source: 'web', chat_name: 'Chosen', fo76_account_name: 'Vaultie' }), 'Chosen');
  assert.equal(relayHistoryDisplayName({ ...base, source: 'relay' }), 'Wanderer');
  assert.equal(relayHistoryDisplayName({ ...base, source: 'bot' }), '[Vault-Tec]');
});
