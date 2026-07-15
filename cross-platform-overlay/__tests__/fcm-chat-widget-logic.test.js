// Vitest coverage for the pure logic of the in-game HUD chat widget
// (game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx, v2.5.3). The .hx compiles
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
  shouldRebindWorldId,
  shouldIgnoreBlankWorldId,
  inputChannelAction,
  worldControlBody,
  sharedHudPromptMode,
  hudMenuAction,
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
} = require('./fcm-chat-widget-logic.js');

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
  it('uses an ASCII-only control body so ZFE cannot truncate it at a leading NUL', () => {
    const body = worldControlBody('roster', ['Ada', 'Beck']);
    expect(body).toBe('FCMCTL/1/ROSTER:Ada|Beck');
    expect(body.includes('\x00')).toBe(false);
    expect(body.includes('\x1F')).toBe(false);
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
  it('ignores key-down and closed-input actions, preserving the draft/session', () => {
    expect(inputChannelAction({ ...base, isKeyDown: true, action: 'NextPage' })).toBe('none');
    expect(inputChannelAction({ ...base, inputOpen: false, action: 'NextPage' })).toBe('none');
  });
});

describe('HUDModLoader fallback presentation and menu routing', () => {
  it('does not mirror a SharedHUDTools field into the widget prompt', () => {
    expect(sharedHudPromptMode()).toBe('label-only');
  });
  it('routes the F12/DynamicSnapshot action to the registered HUDTools menu', () => {
    expect(hudMenuAction({ isKeyDown: false, action: 'DiagnosticSnapshot' })).toBe('show-menu');
    expect(hudMenuAction({ isKeyDown: true, action: 'DiagnosticSnapshot' })).toBe('none');
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
