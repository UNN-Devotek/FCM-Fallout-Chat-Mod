// Vitest coverage for the pure logic of the in-game HUD chat widget
// (game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx, v2.10.4). The .hx compiles
// to a SWF and is not testable in-process; the pure algorithms are mirrored in
// fcm-chat-widget-logic.js and asserted here. Keep both in lockstep with the .hx.

const {
  MAX_SEND_LEN,
  LINK_HINT,
  normChannel,
  echoIdKey,
  echoSbKey,
  expirePendingEchoes,
  isOwnEcho,
  sendErrorMessage,
  switchChannelBySlash,
  tabOrder,
  isChannelSelectable,
  serverSessionResult,
  serverSendDecision,
  shouldSendRosterControl,
  nativeLockAdmission,
  nativeLockRelease,
  hudUserEventAction,
  hudUserEventIsDown,
  isExternalInputAction,
  mergeNativeInputText,
  shouldRebindWorldId,
  shouldIgnoreBlankWorldId,
  historyResyncControlBody,
  shouldRenderReplayMessage,
  inputChannelAction,
  LINK_CODE_REFRESH_MS,
  linkGateOnReconnect,
  clearLinkGate,
  linkGateOnSystemNotice,
  linkCodeStale,
  shouldRefreshLinkCode,
  linkHintStatus,
  extractLinkCode,
  linkGateRender,
  fcmClean,
  normalizeDiscordEmojiMarkup,
  readDisplayName,
  resolveDisplayName,
  shouldReconcileDisplayName,
  bareName,
  replaceIfPresent,
  stripControlChars,
  jsonEscapeGuarded,
  worldControlBody,
  jsonEscape,
  sharedHudPromptMode,
  customEventDefinitionNames,
  parseInputSubmit,
  emptyFeedNotice,
  chatVerbFailed,
  NATIVE_INPUT_VERBS,
  nativeCommandName,
  callTopVerb,
  sendCommandName,
  setChatInputActivePayload,
  nativeTruthy,
  probeUsable,
  parseInputText,
  jsonObjectEnd,
  parseModerationCommand,
  findModerationTarget,
  resolveModerationTarget,
} = require('./fcm-chat-widget-logic.js');

describe('HUD custom emoji normalization', () => {
  it('keeps the emoji name and removes the Discord numeric ID', () => {
    expect(normalizeDiscordEmojiMarkup('hello <:vaultboy:123456789012345678>'))
      .toBe('hello :vaultboy:');
  });

  it('normalizes animated and multiple custom emoji tokens', () => {
    expect(normalizeDiscordEmojiMarkup('<a:wave:987654321098765432> <:ok:123456789012345678>'))
      .toBe(':wave: :ok:');
  });

  it('leaves malformed tokens unchanged', () => {
    expect(normalizeDiscordEmojiMarkup('<:bad-name:123456789012345678>'))
      .toBe('<:bad-name:123456789012345678>');
  });
});

describe('normChannel', () => {
  it('maps general → global', () => expect(normChannel('general')).toBe('global'));
  it('maps gen → global', () => expect(normChannel('gen')).toBe('global'));
  it('maps trading → trade', () => expect(normChannel('trading')).toBe('trade'));
  it('maps event → events', () => expect(normChannel('event')).toBe('events'));
  it('maps infest/inf → infests', () => {
    expect(normChannel('infest')).toBe('infests');
    expect(normChannel('inf')).toBe('infests');
  });
  it('maps raid → raids', () => expect(normChannel('raid')).toBe('raids'));
  it('passes infests through unchanged', () => expect(normChannel('infests')).toBe('infests'));
  it('passes an unknown slug through unchanged', () => expect(normChannel('server')).toBe('server'));
  it('passes canonical global through unchanged', () => expect(normChannel('global')).toBe('global'));
  it('is case-insensitive and trims', () => {
    expect(normChannel('  GENERAL ')).toBe('global');
    expect(normChannel('Trading')).toBe('trade');
  });
});

describe('dedup keys + pending-echo matching', () => {
  it('builds the id key and sb key', () => {
    expect(echoIdKey('abc123')).toBe('id:abc123');
    expect(echoSbKey('u1', 'global', 'hi')).toBe('sb:u1|global|hi');
  });

  it('matches by id key and removes the pending entry', () => {
    const pending = [{ key: echoIdKey('m1'), ts: 0 }];
    const hit = isOwnEcho(pending, {
      messageId: 'm1', senderUserId: 'other', channel: 'global', body: 'hi', relayUserId: 'me',
    });
    expect(hit).toBe(true);
    expect(pending.length).toBe(0);
  });

  it('matches by sb key when no messageId present', () => {
    const pending = [{ key: echoSbKey('me', 'global', 'hi'), ts: 0 }];
    const hit = isOwnEcho(pending, {
      messageId: '', senderUserId: 'other', channel: 'global', body: 'hi', relayUserId: 'me',
    });
    expect(hit).toBe(true);
    expect(pending.length).toBe(0);
  });

  it('treats senderUserId === relayUserId as our own echo even with no pending entry', () => {
    const pending = [];
    const hit = isOwnEcho(pending, {
      messageId: '', senderUserId: 'me', channel: 'global', body: 'hi', relayUserId: 'me',
    });
    expect(hit).toBe(true);
  });

  it('does NOT match a different user / different body', () => {
    const pending = [{ key: echoSbKey('me', 'global', 'hi'), ts: 0 }];
    const hit = isOwnEcho(pending, {
      messageId: '', senderUserId: 'other', channel: 'global', body: 'different', relayUserId: 'me',
    });
    expect(hit).toBe(false);
    expect(pending.length).toBe(1);
  });

  it('falls back to sb key against pending when relayUserId is empty', () => {
    const pending = [{ key: echoSbKey('them', 'trade', 'wts'), ts: 0 }];
    const hit = isOwnEcho(pending, {
      messageId: '', senderUserId: 'them', channel: 'trade', body: 'wts', relayUserId: '',
    });
    expect(hit).toBe(true);
    expect(pending.length).toBe(0);
  });

  it('expires entries older than 15s and keeps fresh ones', () => {
    const pending = [
      { key: 'a', ts: 0 },         // 20s old at now=20000 → expired
      { key: 'b', ts: 6000 },      // 14s old → kept
      { key: 'c', ts: 20000 },     // 0s old → kept
    ];
    const kept = expirePendingEchoes(pending, 20000);
    expect(kept.map((e) => e.key)).toEqual(['b', 'c']);
  });

  it('keeps an entry exactly at the 15s boundary', () => {
    const kept = expirePendingEchoes([{ key: 'x', ts: 0 }], 15000);
    expect(kept.length).toBe(1);
  });
});

describe('history reload replay controls', () => {
  it('uses the printable authenticated resync sentinel', () => {
    expect(historyResyncControlBody()).toBe('FCMCTL/1/RESYNC');
  });

  it('renders a replayed message ID only once per widget instance', () => {
    const seen = {};
    expect(shouldRenderReplayMessage(seen, 'message-1')).toBe(true);
    expect(shouldRenderReplayMessage(seen, 'message-1')).toBe(false);
    expect(shouldRenderReplayMessage(seen, '')).toBe(true);
  });
});

describe('sendErrorMessage', () => {
  it('permission_denied → link hint, no reconnect', () => {
    expect(sendErrorMessage('permission_denied')).toEqual({ text: LINK_HINT, reconnect: false });
  });
  it('permission_denied uses the pinned system body when present', () => {
    const r = sendErrorMessage('permission_denied', { pinnedSystemBody: 'Your code: 1234' });
    expect(r).toEqual({ text: 'Your code: 1234', reconnect: false });
  });
  it('user_muted → muted notice', () => {
    expect(sendErrorMessage('user_muted').text).toMatch(/muted/i);
    expect(sendErrorMessage('user_muted').reconnect).toBe(false);
  });
  it('rate_limited → slow down notice', () => {
    expect(sendErrorMessage('rate_limited').text).toMatch(/slow down/i);
  });
  it('invalid_channel → not available notice', () => {
    expect(sendErrorMessage('invalid_channel').text).toMatch(/not available/i);
  });
  it('message_too_long → includes the max length', () => {
    expect(sendErrorMessage('message_too_long').text).toContain(String(MAX_SEND_LEN));
  });
  it.each(['auth_token_invalid', 'auth_token_revoked', 'user_banned'])(
    '%s → reconnect path', (code) => {
      const r = sendErrorMessage(code);
      expect(r.reconnect).toBe(true);
      expect(r.text).toMatch(/reconnecting/i);
    });
  it('unknown code → "Send failed: <code>"', () => {
    expect(sendErrorMessage('weird_code')).toEqual({ text: 'Send failed: weird_code', reconnect: false });
  });
  it('empty code → generic "Send failed."', () => {
    expect(sendErrorMessage('')).toEqual({ text: 'Send failed.', reconnect: false });
  });
});

describe('switchChannelBySlash', () => {
  it.each([
    ['g', 0], ['gen', 0], ['general', 0],
    ['t', 1], ['trade', 1], ['trading', 1],
    ['e', 2], ['event', 2], ['events', 2],
    ['i', 3], ['inf', 3], ['infests', 3],
    ['r', 4], ['raid', 4], ['raids', 4],
    ['s', 5], ['server', 5],
  ])('"%s" → index %i', (cmd, idx) => {
    expect(switchChannelBySlash(cmd)).toBe(idx);
  });
  it('unknown command → -1', () => {
    expect(switchChannelBySlash('x')).toBe(-1);
    expect(switchChannelBySlash('whisper')).toBe(-1);
  });
  it('is case-insensitive', () => {
    expect(switchChannelBySlash('GENERAL')).toBe(0);
  });
});

describe('HUD moderation command routing', () => {
  const records = [
    { messageId: '11111111-1111-4111-8111-111111111111', senderUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel: 'global', user: 'Alice' },
    { messageId: '22222222-2222-4222-8222-222222222222', senderUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', channel: 'trade', user: 'Bob' },
  ];

  it('consumes only /mod commands and preserves the full reason', () => {
    expect(parseModerationCommand('/g hello')).toEqual({ handled: false });
    expect(parseModerationCommand('/mod #11111111 mute 15 repeated spam in trade')).toEqual({
      handled: true,
      request: { action: 'muteUser', target: '#11111111', durationMinutes: 15, reason: 'repeated spam in trade' },
    });
  });

  it('accepts an exact visible player name as the target, including quoted multi-word names', () => {
    expect(parseModerationCommand('/mod Alice mute 15 repeated spam in trade')).toEqual({
      handled: true,
      request: { action: 'muteUser', target: 'Alice', durationMinutes: 15, reason: 'repeated spam in trade' },
    });
    expect(parseModerationCommand('/mod "Alice Smith" kick repeated harassment')).toEqual({
      handled: true,
      request: { action: 'kickUser', target: 'Alice Smith', reason: 'repeated harassment' },
    });
  });

  it('requires an explicit duration for a ban and permits permanent bans deliberately', () => {
    expect(parseModerationCommand('mod #11111111 ban griefing')).toEqual({
      handled: true,
      error: 'ban_duration_required',
    });
    expect(parseModerationCommand('mod #11111111 ban permanent repeated harassment')).toEqual({
      handled: true,
      request: { action: 'banUser', target: '#11111111', durationMinutes: 0, reason: 'repeated harassment' },
    });
  });

  it('routes delete, kick, unmute, and unban to the selected message target', () => {
    expect(parseModerationCommand('mod #11111111 delete remove scam link').request).toMatchObject({
      action: 'deleteMessage', target: '#11111111', reason: 'remove scam link',
    });
    expect(parseModerationCommand('mod #11111111 kick cooldown abuse').request).toMatchObject({ action: 'kickUser' });
    expect(parseModerationCommand('mod #11111111 unmute appeal accepted').request).toMatchObject({ action: 'unmuteUser' });
    expect(parseModerationCommand('mod #11111111 unban appeal accepted').request).toMatchObject({ action: 'unbanUser' });
  });

  it('only resolves a staff reference to an exact visible message in the active channel', () => {
    expect(findModerationTarget(records, '#11111111', 'global')).toEqual(records[0]);
    expect(findModerationTarget(records, '#22222222', 'global')).toBeNull();
    expect(findModerationTarget(records, '#deadbeef', 'global')).toBeNull();
  });

  it('resolves an exact visible name to the newest record for that account, case-insensitively', () => {
    const repeated = [
      ...records,
      { messageId: '33333333-3333-4333-8333-333333333333', senderUserId: records[0].senderUserId, channel: 'global', user: 'ALICE' },
    ];
    expect(findModerationTarget(repeated, ' alice ', 'global')).toEqual(repeated[2]);
  });

  it('refuses an ambiguous visible name instead of selecting one player', () => {
    const duplicate = [
      ...records,
      { messageId: '33333333-3333-4333-8333-333333333333', senderUserId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', channel: 'global', user: 'Alice' },
    ];
    expect(resolveModerationTarget(duplicate, 'Alice', 'global')).toEqual({ target: null, ambiguous: true });
    expect(findModerationTarget(duplicate, 'Alice', 'global')).toBeNull();
  });
});

describe('tabOrder (SERVER tab display order + relay-session gating)', () => {
  it('before the relay accepts a server control → 5 community channels, no SERVER', () => {
    expect(tabOrder(false)).toEqual([0, 1, 2, 3, 4]);
  });
  it('after a server control is acknowledged → SERVER (5) sits immediately right of GENERAL (0)', () => {
    expect(tabOrder(true)).toEqual([0, 5, 1, 2, 3, 4]);
    expect(tabOrder(true)[1]).toBe(5); // right of GENERAL
  });
  it('SERVER is selectable only after a relay session is ready', () => {
    expect(isChannelSelectable(5, true)).toBe(true);
    expect(isChannelSelectable(5, false)).toBe(false);
  });
  it('community channels are always selectable', () => {
    for (const idx of [0, 1, 2, 3, 4]) {
      expect(isChannelSelectable(idx, false)).toBe(true);
      expect(isChannelSelectable(idx, true)).toBe(true);
    }
  });
  it('/server resolves to the SERVER slug index but is gated by relay readiness', () => {
    const idx = switchChannelBySlash('server');
    expect(idx).toBe(5);
    expect(isChannelSelectable(idx, false)).toBe(false); // ignored out of a world
    expect(isChannelSelectable(idx, true)).toBe(true);
  });
});

describe('server-room acknowledgement gating', () => {
  it('keeps SERVER hidden when the relay rejects a roster/world control', () => {
    const state = serverSessionResult('{"success":false,"error":{"code":"invalid_channel","message":"Message channel is not supported by the relay"}}');
    expect(state).toEqual({ ready: false, error: 'Message channel is not supported by the relay' });
    expect(tabOrder(state.ready)).toEqual([0, 1, 2, 3, 4]);
  });
  it('enables SERVER only after a successful control acknowledgement', () => {
    const state = serverSessionResult('{"success":true,"messageId":""}');
    expect(state).toEqual({ ready: true, error: '' });
    expect(isChannelSelectable(5, state.ready)).toBe(true);
  });
  it('clears readiness after a successful leave control', () => {
    expect(serverSessionResult('{"success":true,"messageId":""}', false)).toEqual({ ready: false, error: '' });
  });
  it('blocks an ordinary SERVER send until bind succeeds with an actionable message', () => {
    expect(serverSendDecision(false, '')).toEqual({ send: false, text: 'Server chat is initializing...' });
    expect(serverSendDecision(false, 'relay unavailable')).toEqual({ send: false, text: 'Server chat is unavailable: relay unavailable' });
    expect(serverSendDecision(true, '')).toEqual({ send: true, text: '' });
  });
  it('binds a valid solo/empty roster and rebinds immediately after reconnect', () => {
    expect(shouldSendRosterControl({
      rosterObserved: true, serverSessionReady: false, now: 5_000, lastSentAt: 4_000,
      lastSentNames: '', names: [],
    })).toBe(true);
    expect(shouldSendRosterControl({
      rosterObserved: true, serverSessionReady: true, now: 5_000, lastSentAt: 4_000,
      lastSentNames: '', names: [],
    })).toBe(false);
    expect(shouldSendRosterControl({
      rosterObserved: false, serverSessionReady: false, now: 5_000, lastSentAt: 0,
      lastSentNames: '', names: [],
    })).toBe(false);
  });
  it('forces the legacy worldId fallback to rebind after reconnect', () => {
    expect(shouldRebindWorldId('', 'world-42')).toBe(true);
    expect(shouldRebindWorldId('world-42', 'world-42')).toBe(false);
  });
  it('keeps a fresh roster-derived room when the legacy worldId becomes blank', () => {
    expect(shouldIgnoreBlankWorldId({
      lastWorldId: 'legacy-world', currentWorldId: '', freshRosterObservation: true,
    })).toBe(true);
    expect(shouldIgnoreBlankWorldId({
      lastWorldId: 'legacy-world', currentWorldId: '', freshRosterObservation: false,
    })).toBe(false);
  });
  it('emits a PRINTABLE control frame that needs no escaping at all', () => {
    // Retired the NUL-delimited legacy frame. Control bytes must never appear in the SWF:
    // a NUL constant cannot be split() on under GFx, and that is what caused the 2026-08
    // send outage. The frame now survives serialisation untouched.
    const body = worldControlBody('roster', ['Ada', 'Beck']);
    expect(body).toBe('FCMCTL/1/ROSTER:Ada|Beck');
    expect(jsonEscapeGuarded(body)).toBe('FCMCTL/1/ROSTER:Ada|Beck');
  });

  it('world and leave frames are printable too', () => {
    expect(worldControlBody('world', 'w123')).toBe('FCMCTL/1/WORLD:w123');
    expect(worldControlBody('leave')).toBe('FCMCTL/1/LEAVE');
    expect(jsonEscapeGuarded(worldControlBody('leave'))).toBe('FCMCTL/1/LEAVE');
  });

  it('no control frame contains a control byte', () => {
    for (const b of [worldControlBody('world', 'w1'), worldControlBody('leave'),
                     worldControlBody('roster', ['A', 'B'])]) {
      for (let i = 0; i < b.length; i++) expect(b.charCodeAt(i)).toBeGreaterThanOrEqual(32);
    }
  });
});

describe('native input requires a balanced game-input lock', () => {
  it('opens native input only when activation and StartEditText both succeed', () => {
    expect(nativeLockAdmission(true, true)).toEqual({ nativeOpen: true, fallback: false, deactivate: false, ownsLock: true });
  });
  it('closes the half-open native session and falls back when StartEditText fails', () => {
    expect(nativeLockAdmission(true, false)).toEqual({ nativeOpen: false, fallback: true, deactivate: true, ownsLock: false });
  });
  it('falls back without deactivation when native activation itself fails', () => {
    expect(nativeLockAdmission(false, false)).toEqual({ nativeOpen: false, fallback: true, deactivate: false, ownsLock: false });
  });
  it('emits EndEditText exactly once only for a lock owned by this widget', () => {
    expect(nativeLockRelease(true)).toEqual({ dispatchEndEditText: true, ownsLockAfter: false, retry: false });
    expect(nativeLockRelease(false)).toEqual({ dispatchEndEditText: false, ownsLockAfter: false, retry: false });
  });
  it('retains lock ownership and schedules recovery when EndEditText fails', () => {
    expect(nativeLockRelease(true, false)).toEqual({ dispatchEndEditText: true, ownsLockAfter: true, retry: true });
    // A later successful retry is the only transition that clears ownership.
    expect(nativeLockRelease(true, true)).toEqual({ dispatchEndEditText: true, ownsLockAfter: false, retry: false });
  });
});

describe('in-session channel actions', () => {
  const base = { inputOpen: true, isKeyDown: false, nextAction: 'NextPage', prevAction: 'PrevPage' };
  it('cycles next/previous while keeping the input session open', () => {
    expect(inputChannelAction({ ...base, action: 'NextPage' })).toBe('next');
    expect(inputChannelAction({ ...base, action: 'PrevPage' })).toBe('prev');
  });
  it('ignores key-down actions but cycles while the feed is idle too', () => {
    expect(inputChannelAction({ ...base, isKeyDown: true, action: 'NextPage' })).toBe('none');
    expect(inputChannelAction({ ...base, inputOpen: false, action: 'NextPage' })).toBe('next');
    expect(inputChannelAction({ ...base, inputOpen: false, action: 'PrevPage' })).toBe('prev');
  });
});

describe('HUDModLoader event compatibility and native-input recovery', () => {
  it('reads the documented lower-camel event fields', () => {
    expect(hudUserEventAction({ actionName: 'NextPage', isDown: false })).toBe('NextPage');
    expect(hudUserEventIsDown({ actionName: 'NextPage', isDown: true })).toBe(true);
  });
  it('accepts the legacy capitalized event aliases', () => {
    expect(hudUserEventAction({ EventName: 'PrevPage', IsKeyDown: false })).toBe('PrevPage');
    expect(hudUserEventIsDown({ EventName: 'PrevPage', IsKeyDown: true })).toBe(true);
  });
  it('prefers documented fields when both event shapes are present', () => {
    expect(hudUserEventAction({ actionName: 'NextPage', EventName: 'PrevPage' })).toBe('NextPage');
    expect(hudUserEventIsDown({ isDown: false, IsKeyDown: true })).toBe(false);
  });
  it('falls back when an older wrapper leaves the current action field empty', () => {
    expect(hudUserEventAction({ actionName: '', EventName: 'PrevPage' })).toBe('PrevPage');
  });
  it('recognizes external focus actions without treating channel actions as dismissal', () => {
    expect(isExternalInputAction('QuickActionsMenu')).toBe(true);
    expect(isExternalInputAction('FriendsList')).toBe(true);
    expect(isExternalInputAction('Escape')).toBe(true);
    expect(isExternalInputAction('NextPage')).toBe(false);
  });
  it('accumulates a one-character native stream without duplicating a repeated poll', () => {
    expect(mergeNativeInputText('', 'h')).toBe('h');
    expect(mergeNativeInputText('h', 'e')).toBe('he');
    expect(mergeNativeInputText('he', 'e')).toBe('e');
    expect(mergeNativeInputText('he', '')).toBe('');
  });
});

describe('HUDModLoader fallback presentation and menu routing', () => {
  it('does not mirror a SharedHUDTools field into the widget prompt', () => {
    expect(sharedHudPromptMode()).toBe('label-only');
  });
  it('prefers the game-qualified CustomEvent class required by ControlMap', () => {
    expect(customEventDefinitionNames()[0]).toBe('Shared.AS3.Events.CustomEvent');
  });
});

describe('parseInputSubmit (slash parse + consume)', () => {
  it('bare "/g" switches and sends nothing', () => {
    expect(parseInputSubmit('/g')).toEqual({ switchedIdx: 0, send: null });
  });
  it('"/g hi" switches and sends "hi"', () => {
    expect(parseInputSubmit('/g hi')).toEqual({ switchedIdx: 0, send: 'hi' });
  });
  it('"/x ..." no match → sent verbatim as a message', () => {
    expect(parseInputSubmit('/x hello')).toEqual({ switchedIdx: -1, send: '/x hello' });
  });
  it('plain text → sent as a message, no switch', () => {
    expect(parseInputSubmit('hello world')).toEqual({ switchedIdx: -1, send: 'hello world' });
  });
  it('empty / whitespace → nothing sent', () => {
    expect(parseInputSubmit('   ')).toEqual({ switchedIdx: -1, send: null });
  });
  it('a lone "/" is not a command → sent verbatim', () => {
    expect(parseInputSubmit('/')).toEqual({ switchedIdx: -1, send: '/' });
  });
  it('long-form "/trading wts" switches to trade and sends', () => {
    expect(parseInputSubmit('/trading wts')).toEqual({ switchedIdx: 1, send: 'wts' });
  });
});

describe('emptyFeedNotice priority', () => {
  it('not connected → connecting...', () => {
    expect(emptyFeedNotice({ connected: false, authState: 'limited', pinnedSystemBody: '', chanIdx: 0 }))
      .toBe('connecting...');
  });
  it('connected + limited + pinned notice → pinned notice', () => {
    expect(emptyFeedNotice({ connected: true, authState: 'limited', pinnedSystemBody: 'Code 42', chanIdx: 0 }))
      .toBe('Code 42');
  });
  it('connected + limited + no pinned → link hint', () => {
    expect(emptyFeedNotice({ connected: true, authState: 'limited', pinnedSystemBody: '', chanIdx: 0 }))
      .toBe(LINK_HINT);
  });
  it('connected + authenticated → "No messages in <CHANNEL> yet"', () => {
    expect(emptyFeedNotice({ connected: true, authState: 'authenticated', pinnedSystemBody: '', chanIdx: 1 }))
      .toBe('No messages in TRADING yet');
    expect(emptyFeedNotice({ connected: true, authState: 'authenticated', pinnedSystemBody: '', chanIdx: 0 }))
      .toBe('No messages in GENERAL yet');
  });
});

// =============================================================================
// v2.5.3 — DECODED native chat-input API: bare-value payloads ("true"/"false"), bare
// boolean returns; sendMessage is chat.v1. only; usable-gate is truthy-only.
// =============================================================================

describe('chatVerbFailed', () => {
  it('flags dispatch_failed', () => {
    expect(chatVerbFailed('{"success":false,"error":{"code":"dispatch_failed"}}')).toBe(true);
  });
  it('flags unsupported_command (the v2.5.0 prefixed-verb failure mode)', () => {
    expect(chatVerbFailed('{"success":false,"error":{"code":"unsupported_command",'
      + '"message":"Unsupported ZFE chat v1 command: setChatInputActive"}}')).toBe(true);
  });
  it('flags "Unknown op"', () => expect(chatVerbFailed('Unknown op: foo')).toBe(true));
  it('flags "unknown command"', () => expect(chatVerbFailed('unknown command bar')).toBe(true));
  it('null is treated as a failure', () => expect(chatVerbFailed(null)).toBe(true));
  it('a normal success response is NOT a failure', () => {
    expect(chatVerbFailed('{"success":true,"active":true}')).toBe(false);
  });
});

describe('native input verbs are TOP-LEVEL (bare, NOT chat.v1.)', () => {
  it('nativeCommandName never prefixes with chat.v1.', () => {
    for (const v of NATIVE_INPUT_VERBS) {
      expect(nativeCommandName(v)).toBe(v);
      expect(nativeCommandName(v).startsWith('chat.v1.')).toBe(false);
    }
  });

  it('callTopVerb calls the BARE name (no chat.v1. prefix)', () => {
    const names = [];
    const apiCall = (name) => { names.push(name); return '{"success":true,"active":true}'; };
    const raw = callTopVerb('setChatInputActive', apiCall);
    expect(names).toEqual(['setChatInputActive']); // bare, never chat.v1.setChatInputActive
    expect(raw).toContain('"active":true');
  });

  it('callTopVerb returns "" (not a throw) when the bare call throws', () => {
    const apiCall = () => { throw new Error('boom'); };
    expect(callTopVerb('clearChatInput', apiCall)).toBe('');
  });

  it('every native input verb is invoked bare', () => {
    for (const v of NATIVE_INPUT_VERBS) {
      const names = [];
      callTopVerb(v, (name) => { names.push(name); return '{}'; });
      expect(names).toEqual([v]);
    }
  });
});

describe('sendMessage command name (chat.v1. ONLY — never bare)', () => {
  it('sendCommandName is always chat.v1.sendMessage', () => {
    expect(sendCommandName()).toBe('chat.v1.sendMessage');
  });
  it('sendMessage never resolves to a bare "sendMessage"', () => {
    expect(sendCommandName()).not.toBe('sendMessage');
    expect(sendCommandName().startsWith('chat.v1.')).toBe(true);
  });
});

describe('setChatInputActivePayload (bare "true"/"false", NOT JSON)', () => {
  it('activate → bare "true"', () => {
    expect(setChatInputActivePayload(true)).toBe('true');
  });
  it('deactivate → bare "false"', () => {
    expect(setChatInputActivePayload(false)).toBe('false');
  });
  it('payloads are NEVER JSON', () => {
    expect(setChatInputActivePayload(true).startsWith('{')).toBe(false);
    expect(setChatInputActivePayload(false).startsWith('{')).toBe(false);
  });
});

describe('nativeTruthy (v2.5.3 — bare booleans/strings, not JSON)', () => {
  it('a bare "true" is truthy', () => {
    expect(nativeTruthy('true')).toBe(true);
    expect(nativeTruthy('  TRUE \n')).toBe(true); // trimmed + case-insensitive
  });
  it('a bare "1" is truthy', () => {
    expect(nativeTruthy('1')).toBe(true);
  });
  it('a "success":true response is truthy', () => {
    expect(nativeTruthy('{"success":true,"active":true}')).toBe(true);
  });
  it('a bare "false" is NOT truthy', () => {
    expect(nativeTruthy('false')).toBe(false);
    expect(nativeTruthy('  False ')).toBe(false);
  });
  it('an empty / null raw is NOT truthy', () => {
    expect(nativeTruthy('')).toBe(false);
    expect(nativeTruthy('   ')).toBe(false);
    expect(nativeTruthy(null)).toBe(false);
  });
  it('a JSON object (no success:true) is NOT truthy', () => {
    expect(nativeTruthy('{"active":true}')).toBe(false);
  });
  it('unsupported_command / dispatch_failed are NOT truthy', () => {
    expect(nativeTruthy('{"success":false,"error":{"code":"unsupported_command"}}')).toBe(false);
    expect(nativeTruthy('{"success":false,"error":{"code":"dispatch_failed"}}')).toBe(false);
  });
});

describe('probeUsable (startup-probe _nativeInputUsable gate, v2.5.3 truthy-only)', () => {
  it('usable when setChatInputActive("true") returns a bare "true"', () => {
    expect(probeUsable('true')).toBe(true);
  });
  it('usable on a bare "1"', () => {
    expect(probeUsable('1')).toBe(true);
  });
  it('NOT usable on a BARE "false"', () => {
    expect(probeUsable('false')).toBe(false);
  });
  it('NOT usable on empty raw', () => {
    expect(probeUsable('')).toBe(false);
    expect(probeUsable(null)).toBe(false);
  });
  it('NOT usable on a JSON form (the old wrong payload did nothing)', () => {
    expect(probeUsable('{"active":true}')).toBe(false);
  });
  it('NOT usable on unsupported_command / success:false', () => {
    expect(probeUsable('{"success":false,"error":{"code":"unsupported_command"}}')).toBe(false);
    expect(probeUsable('{"success":false,"error":{"code":"dispatch_failed"}}')).toBe(false);
  });
});

describe('parseInputText (readChatInput buffer; bare string / quoted / json / false)', () => {
  it('a bare string is the text', () => expect(parseInputText('hello world')).toBe('hello world'));
  it('a JSON-quoted string is unquoted', () => expect(parseInputText('"wts plans"')).toBe('wts plans'));
  it('a JSON object text field is extracted', () => {
    expect(parseInputText('{"text":"wts ple"}')).toBe('wts ple');
  });
  it('a JSON object falls back to value then input', () => {
    expect(parseInputText('{"value":"abc"}')).toBe('abc');
    expect(parseInputText('{"input":"xyz"}')).toBe('xyz');
  });
  it('a bare "false" is empty (no buffer)', () => {
    expect(parseInputText('false')).toBe('');
    expect(parseInputText('  FALSE ')).toBe('');
  });
  it('empty / null / whitespace is empty', () => {
    expect(parseInputText('')).toBe('');
    expect(parseInputText('   ')).toBe('');
    expect(parseInputText(null)).toBe('');
  });
  it('trims surrounding whitespace of a bare string', () => {
    expect(parseInputText('  hi  ')).toBe('hi');
  });
});

describe('jsonObjectEnd (relay event framing)', () => {
  it('finds a normal object boundary', () => {
    const raw = '{"id":1}{"id":2}';
    expect(jsonObjectEnd(raw, 0)).toBe(7);
  });

  it('ignores braces inside a message body', () => {
    const raw = '{"body":"use { and } safely","id":1} trailing';
    expect(jsonObjectEnd(raw, 0)).toBe(raw.indexOf('} trailing'));
  });

  it('honors escaped quotes and backslashes in a message body', () => {
    const raw = '{"body":"say \\"{\\" then \\\\ ok","id":1}';
    expect(jsonObjectEnd(raw, 0)).toBe(raw.length - 1);
  });

  it('fails closed on an incomplete object', () => {
    const raw = '{"body":"unfinished"';
    expect(jsonObjectEnd(raw, 0)).toBe(raw.length);
  });
});

// The regression this suite exists for: on 2026-08-05 a player skipped the link prompt on
// first boot, the widget reconnected ~95 min later, and the link screen never came back —
// the gate was cleared on every reconnect and the relay's one-shot notice never repeated.
describe('link gate (v2.9.7)', () => {
  const NOTICE = 'LINK REQUIRED - visit falloutchatmod.com/link, sign in, and enter code: 4F2A-9C31 (expires 10m)';

  describe('linkGateOnReconnect', () => {
    it('keeps the gate up across a reconnect when the account is still unlinked', () => {
      expect(linkGateOnReconnect(true)).toBe(true);
    });

    it('stays down for an already-linked session', () => {
      expect(linkGateOnReconnect(false)).toBe(false);
    });
  });

  describe('linkGateOnSystemNotice', () => {
    it('raises the gate and stamps the code on a LINK REQUIRED notice', () => {
      expect(linkGateOnSystemNotice(NOTICE, 1000)).toEqual({
        needsLink: true, pinnedSystemBody: NOTICE, linkNoticeAt: 1000, refreshPending: false,
      });
    });

    it('clears the gate on LINK COMPLETE', () => {
      expect(linkGateOnSystemNotice('LINK COMPLETE - account linked. Chat activated.', 1000))
        .toEqual({ needsLink: false, pinnedSystemBody: '', linkNoticeAt: 0, refreshPending: false });
    });

    it('re-stamps arrival time when a fresh code replaces an old one', () => {
      const first = linkGateOnSystemNotice(NOTICE, 1000);
      const second = linkGateOnSystemNotice(NOTICE, 600000);
      expect(first.linkNoticeAt).toBe(1000);
      expect(second.linkNoticeAt).toBe(600000);
    });
  });

  describe('clearLinkGate', () => {
    it('drops the pinned code along with the gate', () => {
      expect(clearLinkGate()).toEqual({
        needsLink: false, pinnedSystemBody: '', linkNoticeAt: 0, refreshPending: false,
      });
    });
  });

  describe('linkCodeStale', () => {
    it('is false for a code inside its usable window', () => {
      expect(linkCodeStale({ needsLink: true, linkNoticeAt: 0 + 1, now: LINK_CODE_REFRESH_MS - 1 }))
        .toBe(false);
    });

    it('is true once the refresh threshold is reached', () => {
      expect(linkCodeStale({ needsLink: true, linkNoticeAt: 1, now: 1 + LINK_CODE_REFRESH_MS }))
        .toBe(true);
    });

    it('never fires while the account is linked', () => {
      expect(linkCodeStale({ needsLink: false, linkNoticeAt: 1, now: 1 + LINK_CODE_REFRESH_MS }))
        .toBe(false);
    });

    it('never fires before any code has arrived', () => {
      expect(linkCodeStale({ needsLink: true, linkNoticeAt: 0, now: 9999999 })).toBe(false);
    });
  });

  describe('shouldRefreshLinkCode', () => {
    const stale = { needsLink: true, linkNoticeAt: 1, now: 1 + LINK_CODE_REFRESH_MS };

    it('reconnects once when the on-screen code has expired', () => {
      expect(shouldRefreshLinkCode({ ...stale, refreshPending: false })).toBe(true);
    });

    it('does not stack reconnects while one is already in flight', () => {
      expect(shouldRefreshLinkCode({ ...stale, refreshPending: true })).toBe(false);
    });

    it('leaves a fresh code alone', () => {
      expect(shouldRefreshLinkCode({
        needsLink: true, linkNoticeAt: 1, now: 2, refreshPending: false,
      })).toBe(false);
    });
  });

  describe('extractLinkCode', () => {
    it('pulls the code out of the relay notice and stops at the expiry text', () => {
      expect(extractLinkCode(NOTICE)).toBe('4F2A-9C31');
    });

    it('returns empty for a body with no code', () => {
      expect(extractLinkCode('LINK COMPLETE - account linked. Chat activated.')).toBe('');
      expect(extractLinkCode('')).toBe('');
      expect(extractLinkCode(null)).toBe('');
    });
  });

  describe('linkHintStatus', () => {
    it('shows the code when one is pinned', () => {
      expect(linkHintStatus({ pinnedSystemBody: NOTICE, refreshPending: false }))
        .toEqual({ status: 'code', code: '4F2A-9C31' });
    });

    it('shows the first-notice wait before any code arrives', () => {
      expect(linkHintStatus({ pinnedSystemBody: '', refreshPending: false }).status).toBe('waiting');
    });

    it('tells the player a new code is coming after expiry', () => {
      expect(linkHintStatus({ pinnedSystemBody: '', refreshPending: true }).status).toBe('expired');
    });
  });

  describe('linkGateRender', () => {
    it('shows the link screen instead of the feed while unlinked', () => {
      expect(linkGateRender({ connected: true, needsLink: true })).toBe('link-screen');
    });

    it('shows the feed once linked', () => {
      expect(linkGateRender({ connected: true, needsLink: false })).toBe('feed');
    });

    it('connecting outranks the link screen', () => {
      expect(linkGateRender({ connected: false, needsLink: true })).toBe('connecting');
    });
  });

  it('end to end: skip the prompt, reconnect much later, still get a redeemable code', () => {
    // 14:17 — first boot, notice arrives, player ignores it. (getTimer() is already past 0 by
    // the time a notice lands; 0 is the "no code pinned" sentinel.)
    let gate = linkGateOnSystemNotice(NOTICE, 1000);
    expect(linkGateRender({ connected: true, needsLink: gate.needsLink })).toBe('link-screen');

    // 15:51 — reconnect. Pre-2.9.7 this cleared the gate and dropped the player into the feed.
    gate = { ...gate, needsLink: linkGateOnReconnect(gate.needsLink) };
    expect(linkGateRender({ connected: true, needsLink: gate.needsLink })).toBe('link-screen');

    // The 14:17 code is long dead, so the widget asks the relay for a replacement.
    const now = 95 * 60 * 1000;
    expect(shouldRefreshLinkCode({ ...gate, now })).toBe(true);
    gate = { ...gate, pinnedSystemBody: '', refreshPending: true };
    expect(linkHintStatus(gate).status).toBe('expired');

    // Relay re-pushes on subscribe; the player redeems it and chat opens.
    gate = linkGateOnSystemNotice(NOTICE, now);
    expect(linkHintStatus(gate)).toEqual({ status: 'code', code: '4F2A-9C31' });
    gate = linkGateOnSystemNotice('LINK COMPLETE - account linked. Chat activated.', now + 5000);
    expect(linkGateRender({ connected: true, needsLink: gate.needsLink })).toBe('feed');
  });
});

// Source-level guard. This bug class is invisible to the pure-logic mirror above: it is not a
// logic error at all, but a *string-pool* error. A NUL-bearing string constant anywhere in the
// widget SWF poisons every string crossing the ZFE boundary on native Windows — each character
// arrives NUL-padded. On 2026-08-05 that made the relay see the channel slug as "g\0l\0o\0b\0a\0l",
// fail its ALL_SLUGS check and reject every send with invalid_channel, and made the "server"
// world/roster controls unmatchable so SERVER chat could never bind. v2.9.5 introduced it,
// v2.9.6 removed only the NUL control *prefixes* and left the literals in the escape helpers.
describe('FCMChatWidget.hx contains no control-byte string literals', () => {
  const fs = require('fs');
  const path = require('path');
  const HX = path.join(
    __dirname, '..', '..', 'game-mods', 'FCMBridge', 'hudmodloader-chat', 'FCMChatWidget.hx',
  );
  const src = fs.readFileSync(HX, 'utf8');

  // Strip line comments so the explanatory notes above the constants don't trip the guard.
  const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

  it('has no "\\x00" NUL literal', () => {
    expect(code).not.toMatch(/"\\x00"/);
  });

  it('has no "\\x1F" unit-separator literal', () => {
    expect(code).not.toMatch(/"\\x1F"/i);
  });

  it('builds control bytes through the non-inline ctrlChar() helper instead', () => {
    expect(code).toMatch(/static\s+var\s+NUL:String\s*=\s*ctrlChar\(0\)/);
    expect(code).toMatch(/static\s+var\s+UNIT_SEP:String\s*=\s*ctrlChar\(31\)/);
    expect(code).toMatch(/static\s+function\s+ctrlChar\(code:Int\):String/);
  });

  it('never marks ctrlChar inline — inlining lets Haxe constant-fold the NUL back in', () => {
    expect(code).not.toMatch(/static\s+inline\s+function\s+ctrlChar/);
    expect(code).not.toMatch(/static\s+inline\s+var\s+(NUL|UNIT_SEP)/);
  });

  it('keeps the world/roster control prefixes printable', () => {
    expect(code).toMatch(/WORLD_CTRL_PREFIX:String\s*=\s*"FCMCTL\/1\/WORLD:"/);
    expect(code).toMatch(/WORLD_LEAVE_PREFIX:String\s*=\s*"FCMCTL\/1\/LEAVE"/);
    expect(code).toMatch(/WORLD_ROSTER_PREFIX:String\s*=\s*"FCMCTL\/1\/ROSTER:"/);
  });

  it('joins roster names with a printable separator, not the unit separator', () => {
    expect(code).toMatch(/names\.join\("\|"\)/);
  });
});

// Regression for the 2026-08-06 "channel isn't available / never joins server chat" report.
// readDisplayName() used to jsonEscape() the raw BSUIDataManager value, and startConnect()
// escaped it AGAIN when building the payload — so a name carrying the UTF-16 NULs the game
// hands back was stored on the relay as 337 characters instead of 8. Sanitize on read;
// escape exactly once, at serialization.
describe('game-UI string sanitization (v2.9.8)', () => {
  const NUL = String.fromCharCode(0);
  const UTF16_NAME = 'A' + NUL + 'b' + NUL + 'd' + NUL + 'e' + NUL + 'r' + NUL + 'a' + NUL + 'a' + NUL + 'n';

  it('strips the UTF-16 NUL padding the game returns', () => {
    expect(readDisplayName(UTF16_NAME)).toBe('Abderaan');
  });

  it('strips NULs that arrive already escaped as text', () => {
    expect(readDisplayName('A\\u0000b\\u0000d\\u0000e\\u0000r\\u0000a\\u0000a\\u0000n')).toBe('Abderaan');
  });

  it('strips the bare u0000 form ZFE emits when its encoding is off', () => {
    expect(readDisplayName('Au0000bu0000du0000eu0000ru0000au0000au0000n')).toBe('Abderaan');
  });

  it('leaves an already-clean name untouched', () => {
    expect(readDisplayName('Abderaan')).toBe('Abderaan');
  });

  it('never returns an escape sequence — that is the double-escape bug', () => {
    const out = readDisplayName(UTF16_NAME);
    expect(out).not.toContain('\\u0000');
    expect(out).not.toContain('u0000');
    expect(out).not.toContain(NUL);
  });

  it('a sanitized name survives one jsonEscape pass unchanged', () => {
    expect(jsonEscape(readDisplayName(UTF16_NAME))).toBe('Abderaan');
  });

  it('caps the name at 64 characters', () => {
    expect(readDisplayName('x'.repeat(200)).length).toBe(64);
  });

  it('returns empty for a name the game has not populated yet', () => {
    expect(readDisplayName('')).toBe('');
    expect(readDisplayName(null)).toBe('');
    expect(readDisplayName(NUL + NUL)).toBe('');
  });

  it('bareName sanitizes before stripping the <title decorations', () => {
    expect(bareName('J' + NUL + 'm' + NUL + 's' + NUL + '<Squeaky-Clean<Floater')).toBe('Jms');
  });

  it('bareName still removes the roster separator', () => {
    expect(bareName('Ann|Mandys')).toBe('AnnMandys');
  });

  it('fcmClean removes control bytes that would corrupt a control frame body', () => {
    expect(fcmClean('AAA' + NUL + String.fromCharCode(31) + 'BBB')).toBe('AAABBB');
  });
});

describe('player identity resolution (HUDModLoader widget)', () => {
  it('prefers the local roster character over remote players and account metadata', () => {
    expect(resolveDisplayName({
      playerListData: { data: [
        { isLocal: false, characterName: 'NearbyPlayer' },
        { isLocal: true, characterName: 'MyActualCharacter' },
      ] },
      accountInfoData: { data: { name: 'BethesdaHandle' } },
    })).toBe('MyActualCharacter');
  });

  it('accepts the HUD local-player flag variant and sanitizes the character name', () => {
    expect(resolveDisplayName({
      playerListData: { data: [
        { isLocalPlayer: true, characterName: 'A' + String.fromCharCode(0) + 'b' + String.fromCharCode(0) + 'deraan' },
      ] },
    })).toBe('Abderaan');
  });

  it('accepts wrapped roster data and string local-player flags', () => {
    expect(resolveDisplayName({
      playerListData: { data: { players: [
        { isLocal: 'false', characterName: 'NearbyPlayer' },
        { isSelf: 'true', characterName: 'WrappedCharacter' },
      ] } },
    })).toBe('WrappedCharacter');
  });

  it('falls back through CharacterInfoData and nested AccountInfoData.account.name', () => {
    expect(resolveDisplayName({
      characterInfoData: { data: { characterName: 'CharacterInfoName' } },
    })).toBe('CharacterInfoName');
    expect(resolveDisplayName({
      accountInfoData: { data: { account: { name: 'NestedAccountName' } } },
    })).toBe('NestedAccountName');
  });

  it('does not treat a blank or placeholder candidate as a resolved player name', () => {
    expect(resolveDisplayName({
      playerListData: { data: [{ isLocal: true, characterName: 'Wanderer' }] },
      accountInfoData: { data: { name: '' } },
    })).toBe('');
  });

  it('reconciles only when a connected session has a new real name', () => {
    expect(shouldReconcileDisplayName({
      connected: true, lastSentDisplayName: 'Wanderer', displayName: 'MyActualCharacter',
    })).toBe(true);
    expect(shouldReconcileDisplayName({
      connected: true, lastSentDisplayName: 'MyActualCharacter', displayName: 'MyActualCharacter',
    })).toBe(false);
    expect(shouldReconcileDisplayName({
      connected: false, lastSentDisplayName: 'Wanderer', displayName: 'MyActualCharacter',
    })).toBe(false);
    expect(shouldReconcileDisplayName({
      connected: true, lastSentDisplayName: 'Wanderer', displayName: 'Wanderer',
    })).toBe(false);
  });
});

// The bug that broke in-game sending (v2.9.11 fix). Scaleform GFx returns "" from
// String.fromCharCode(0). Splitting on "" does not strip -- it explodes the string, inserting
// the escape between every character. That is what put an escaped slug on the wire.
describe('replaceIfPresent -- never split on an empty needle (v2.9.11)', () => {
  const NUL = String.fromCharCode(0);
  const UNIT_SEP = String.fromCharCode(31);

  it('THE BUG: splitting on an empty needle explodes the string', () => {
    expect('test'.split('').join('\\u0000')).toBe('t\\u0000e\\u0000s\\u0000t');
    expect('global'.split('').join('\\u0000')).toBe('g\\u0000l\\u0000o\\u0000b\\u0000a\\u0000l');
  });

  it('an empty needle is a no-op, not an explosion', () => {
    expect(replaceIfPresent('test', '', '\\u0000')).toBe('test');
    expect(replaceIfPresent('global', '', '\\u0000')).toBe('global');
  });

  it('an ordinary printable needle still replaces normally', () => {
    expect(replaceIfPresent('a-b', '-', '')).toBe('ab');
    expect(replaceIfPresent('a|b', '|', '/')).toBe('a/b');
  });

  it('a control-char needle is refused (v2.9.12) - use stripControlChars for those', () => {
    expect(replaceIfPresent('a' + NUL + 'b', NUL, '')).toBe('a' + NUL + 'b');
    expect(replaceIfPresent('a' + UNIT_SEP + 'b', UNIT_SEP, '')).toBe('a' + UNIT_SEP + 'b');
    expect(stripControlChars('a' + NUL + 'b')).toBe('ab');
  });

  it('handles a null needle and null input', () => {
    expect(replaceIfPresent('test', null, 'X')).toBe('test');
    expect(replaceIfPresent(null, NUL, '')).toBe('');
  });
});

describe('control-byte stripping without split() (v2.9.12)', () => {
  const NUL = String.fromCharCode(0);
  const UNIT_SEP = String.fromCharCode(31);

  it('a control-character needle is refused, because GFx split() explodes on it', () => {
    // v2.9.11 only guarded length, so a real NUL still reached split() and nothing changed.
    expect(replaceIfPresent('global', NUL, '\\u0000')).toBe('global');
    expect(replaceIfPresent('test', UNIT_SEP, '\\u001F')).toBe('test');
  });

  it('stripControlChars removes NUL and unit separator', () => {
    expect(stripControlChars('a' + NUL + 'b' + UNIT_SEP + 'c')).toBe('abc');
    expect(stripControlChars(NUL + NUL)).toBe('');
  });

  it('stripControlChars keeps CR/LF/TAB so jsonEscape can still escape them', () => {
    expect(stripControlChars('a\r\n\tb')).toBe('a\r\n\tb');
  });

  it('stripControlChars leaves clean text alone', () => {
    expect(stripControlChars('global')).toBe('global');
    expect(stripControlChars('hey want to run a raid')).toBe('hey want to run a raid');
  });

  it('THE FIX: clean slug and body serialise verbatim', () => {
    expect(jsonEscapeGuarded('global')).toBe('global');
    expect(jsonEscapeGuarded('events')).toBe('events');
    expect(jsonEscapeGuarded('test')).toBe('test');
  });

  it('the exact payload that failed in-game is now correct', () => {
    const slug = jsonEscapeGuarded('global');
    const body = jsonEscapeGuarded('test');
    expect('{"channel":"' + slug + '","targetUserId":"","body":"' + body + '"}')
      .toBe('{"channel":"global","targetUserId":"","body":"test"}');
  });

  it('a slug carrying real NULs is stripped, never exploded', () => {
    expect(jsonEscapeGuarded('g' + NUL + 'l' + NUL + 'o' + NUL + 'b' + NUL + 'a' + NUL + 'l'))
      .toBe('global');
  });

  it('still escapes quotes, backslashes and newlines', () => {
    expect(jsonEscapeGuarded('say "hi"')).toBe('say \\"hi\\"');
    expect(jsonEscapeGuarded('a\\b')).toBe('a\\\\b');
    expect(jsonEscapeGuarded('a\nb')).toBe('a\\nb');
  });
});
