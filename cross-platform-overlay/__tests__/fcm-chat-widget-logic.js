// Pure logic ported from game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx
// (FCMChatWidget v2.5.3). The .hx (Haxe → SWF) is not unit-tested directly; per the
// repo HARD RULE the pure algorithms are mirrored here in JS and covered by Vitest
// (fcm-chat-widget-logic.test.js). Keep these in lockstep with the .hx — they are the
// same algorithms, not a re-design.

const MAX_SEND_LEN = 225;

// ── Channel slug normalization (FCMChatWidget.normChannel) ──────────────────────
// Maps relay-supplied aliases to the widget's canonical CHAN_SLUGS values.
function normChannel(c) {
  c = String(c == null ? '' : c).trim().toLowerCase();
  switch (c) {
    case 'general': return 'global';
    case 'gen':     return 'global';
    case 'trading': return 'trade';
    case 'event':   return 'events';
    case 'infest':
    case 'inf':     return 'infests';
    case 'raid':    return 'raids';
    default:        return c;
  }
}

// ── Optimistic-echo dedup keys (FCMChatWidget.echoIdKey / echoSbKey) ────────────
function echoIdKey(messageId) {
  return 'id:' + messageId;
}
function echoSbKey(userId, channel, body) {
  return 'sb:' + userId + '|' + channel + '|' + body;
}

// ── Expire pending echoes >15s old (FCMChatWidget.expirePendingEchoes) ──────────
// pending: Array<{key, ts}>; now: ms timer value. Returns the filtered array.
function expirePendingEchoes(pending, now) {
  return pending.filter((e) => now - e.ts <= 15000);
}

// ── Is this incoming chat.message our own optimistic echo? ──────────────────────
// Mirrors FCMChatWidget.isOwnEcho. Mutates `pending` (removes the matched entry)
// exactly like the .hx does, and returns a boolean.
function isOwnEcho(pending, { messageId, senderUserId, channel, body, relayUserId }) {
  messageId = messageId || '';
  senderUserId = senderUserId || '';
  relayUserId = relayUserId || '';

  // Strong signal: relay told us our own id and it's coming back.
  if (relayUserId.length > 0 && senderUserId === relayUserId) {
    removePendingMatch(pending, { messageId, senderUserId, channel, body, relayUserId });
    return true;
  }
  const idK = messageId.length > 0 ? echoIdKey(messageId) : '';
  const sbUser = relayUserId.length > 0 ? relayUserId : senderUserId;
  const sbK = echoSbKey(sbUser, channel, body);
  for (let k = 0; k < pending.length; k++) {
    const pk = pending[k].key;
    if ((idK.length > 0 && pk === idK) || pk === sbK) {
      pending.splice(k, 1);
      return true;
    }
  }
  return false;
}

function removePendingMatch(pending, { messageId, senderUserId, channel, body, relayUserId }) {
  messageId = messageId || '';
  relayUserId = relayUserId || '';
  const idK = messageId.length > 0 ? echoIdKey(messageId) : '';
  const sbUser = relayUserId.length > 0 ? relayUserId : senderUserId;
  const sbK = echoSbKey(sbUser, channel, body);
  for (let k = 0; k < pending.length; k++) {
    const pk = pending[k].key;
    if ((idK.length > 0 && pk === idK) || pk === sbK) {
      pending.splice(k, 1);
      return;
    }
  }
}

// ── Send error code → user-facing message (FCMChatWidget.sendMessage switch) ─────
// Returns { text, reconnect } where reconnect=true triggers the auth-reconnect path.
const LINK_HINT = 'Link your account at falloutchatmod.com/link to chat';
function sendErrorMessage(code, opts) {
  const pinned = opts && opts.pinnedSystemBody ? opts.pinnedSystemBody : '';
  const linkHint = pinned.length > 0 ? pinned : LINK_HINT;
  switch (code) {
    case 'permission_denied': return { text: linkHint, reconnect: false };
    case 'user_muted':        return { text: 'You are muted and cannot send right now.', reconnect: false };
    case 'rate_limited':      return { text: 'Sending too fast - slow down.', reconnect: false };
    case 'invalid_channel':   return { text: 'That channel is not available.', reconnect: false };
    case 'message_too_long':  return { text: 'Message too long (max ' + MAX_SEND_LEN + ').', reconnect: false };
    case 'auth_token_invalid':
    case 'auth_token_revoked':
    case 'user_banned':       return { text: 'Chat session ended - reconnecting...', reconnect: true };
    default:                  return { text: code && code.length > 0 ? ('Send failed: ' + code) : 'Send failed.', reconnect: false };
  }
}

// ── Slash channel switch (FCMChatWidget.switchChannelBySlash) ───────────────────
// Returns the channel index 0..4, or -1 if the command does not match.
function switchChannelBySlash(cmd) {
  cmd = String(cmd == null ? '' : cmd).toLowerCase();
  if (cmd === 'g' || cmd === 'gen'   || cmd === 'general') return 0;
  if (cmd === 't' || cmd === 'trade' || cmd === 'trading') return 1;
  if (cmd === 'e' || cmd === 'event' || cmd === 'events')  return 2;
  if (cmd === 'i' || cmd === 'inf'   || cmd === 'infests') return 3;
  if (cmd === 'r' || cmd === 'raid'  || cmd === 'raids')   return 4;
  if (cmd === 's' || cmd === 'server')                     return 5;
  return -1;
}

// ── Channel tab display order (FCMChatWidget.tabOrder) ──────────────────────────
// Slug-indices in DISPLAY order. SERVER (slug index 5) is shown immediately right of
// GENERAL (0) but ONLY while the player is in a world (inWorld). A channel is
// selectable iff its slug-index is in the current display order.
function tabOrder(inWorld) {
  return inWorld ? [0, 5, 1, 2, 3, 4] : [0, 1, 2, 3, 4];
}
function isChannelSelectable(idx, inWorld) {
  return tabOrder(inWorld).indexOf(idx) >= 0;
}

// ── Slash parse + consume (FCMChatWidget.onInputSubmit) ─────────────────────────
// Mirrors the consume logic: bare "/g" switches and sends NOTHING; "/g hi" switches
// then sends "hi"; "/x" no match → sent verbatim as a message.
// Returns { switchedIdx, send } where switchedIdx is -1 if no switch happened and
// send is the string to send (or null if nothing should be sent).
function parseInputSubmit(s) {
  s = String(s == null ? '' : s).trim();
  if (s.length === 0) return { switchedIdx: -1, send: null };

  if (s.length > 1 && (s.charAt(0) === '/' || s.charAt(0) === '.')) {
    const spaceIdx = s.indexOf(' ');
    const slashCmd = spaceIdx > 0 ? s.substr(1, spaceIdx - 1) : s.substr(1);
    const idx = switchChannelBySlash(slashCmd);
    if (idx >= 0) {
      const rest = spaceIdx > 0 ? s.substr(spaceIdx + 1).trim() : '';
      if (rest.length === 0) return { switchedIdx: idx, send: null }; // bare "/g"
      return { switchedIdx: idx, send: rest };                         // "/g hi"
    }
  }
  return { switchedIdx: -1, send: s };
}

// ── Empty-feed notice priority (FCMChatWidget.renderRecords guard) ──────────────
const CHAN_NAMES = ['GENERAL', 'TRADING', 'EVENTS', 'INFESTS', 'RAIDS', 'SERVER'];
function emptyFeedNotice({ connected, authState, pinnedSystemBody, chanIdx }) {
  if (!connected) return 'connecting...';
  if (authState !== 'authenticated') {
    return pinnedSystemBody && pinnedSystemBody.length > 0 ? pinnedSystemBody : LINK_HINT;
  }
  return 'No messages in ' + CHAN_NAMES[chanIdx] + ' yet';
}

// ── Minimal JSON string scan (FCMChatWidget.extractJsonString) ──────────────────
// Mirrors the .hx's quote-aware scanner: finds "<key>":" (or <key>:") and reads to
// the next unescaped quote. Used by parseInputText (JSON-object form) below.
function extractJsonString(json, key) {
  json = String(json == null ? '' : json);
  let needle = '"' + key + '":"';
  let idx = json.indexOf(needle);
  if (idx < 0) {
    needle = key + ':"';
    idx = json.indexOf(needle);
    if (idx < 0) return '';
  }
  const start = idx + needle.length;
  let i = start;
  while (i < json.length) {
    const c = json.charAt(i);
    if (c === '\\') { i += 2; continue; }
    if (c === '"') break;
    i++;
  }
  return json.substring(start, i);
}

// ── v2.5.3 decoded native chat-input API ────────────────────────────────────────
// The native chat-input verbs are TOP-LEVEL ZFE commands (bare, no "chat.v1." prefix)
// that take BARE-VALUE payloads ("true"/"false"/"1", not JSON) and return bare
// booleans/strings: setChatInputActive("true") -> true (activates), "false" deactivates;
// consumeChatInputSubmitted -> bare boolean (true == Enter pressed); readChatInput -> the
// in-progress buffer text. sendMessage is the opposite: chat.v1.sendMessage ONLY — never
// bare (bare hits the legacy bridge which returns literal `false`).

// chatVerbFailed: a raw response that looks like "command not found / not dispatched".
function chatVerbFailed(raw) {
  if (raw == null) return true;
  raw = String(raw);
  return raw.indexOf('dispatch_failed') >= 0
    || raw.indexOf('unsupported_command') >= 0
    || raw.indexOf('Unknown op') >= 0
    || raw.indexOf('unknown command') >= 0;
}

// The set of native chat-input verbs that MUST be called bare (top-level).
const NATIVE_INPUT_VERBS = [
  'setChatInputActive',
  'isChatInputActive',
  'readChatInput',
  'clearChatInput',
  'consumeChatInputSubmitted',
  'isChatKeyPressed',
];

// nativeCommandName (FCMChatWidget.callTop): the command name used for a native input
// verb — ALWAYS bare, NEVER prefixed with "chat.v1.".
function nativeCommandName(verb) {
  return verb; // bare / top-level
}

// callTopVerb models callTop(): call the bare verb once; return raw, or '' on throw.
function callTopVerb(verb, apiCall) {
  try {
    return String(apiCall(nativeCommandName(verb)));
  } catch (_e) {
    return '';
  }
}

// sendCommandName (FCMChatWidget.sendMessage): ALWAYS 'chat.v1.sendMessage', never bare.
function sendCommandName() {
  return 'chat.v1.sendMessage';
}

// setChatInputActivePayload (v2.5.3): the activate/deactivate payloads are BARE values,
// NOT JSON — "true" to activate, "false" to deactivate.
function setChatInputActivePayload(active) {
  return active ? 'true' : 'false';
}

// nativeTruthy (FCMChatWidget.nativeTruthy, v2.5.3): native verbs return BARE
// booleans/strings. Truthy = raw trimmed+lowercased equals "true" OR "1" OR contains
// "success":true. A bare "false"/""/JSON/failure response is NOT truthy.
function nativeTruthy(raw) {
  if (raw == null) return false;
  const t = String(raw).trim().toLowerCase();
  if (t.length === 0) return false;
  if (chatVerbFailed(raw)) return false; // dispatch_failed / unsupported_command / etc.
  if (t.indexOf('"success":false') >= 0) return false;
  return t === 'true' || t === '1' || t.indexOf('"success":true') >= 0;
}

// probeUsable (FCMChatWidget.runStartupProbe gate, v2.5.3): _nativeInputUsable is set
// from nativeTruthy(setChatInputActive("true") raw). Bare "false"/empty/JSON => NOT
// usable; bare "true"/"1"/success:true => usable.
function probeUsable(openRaw) {
  return nativeTruthy(openRaw);
}

// parseInputText (FCMChatWidget.parseInputText, v2.5.3): the readChatInput buffer text.
// raw may be a bare string ("hello"), a JSON-quoted string ("\"hello\""), or a JSON
// object with a text/value/input field. A bare "false"/empty => "".
function parseInputText(raw) {
  if (raw == null) return '';
  let t = String(raw).trim();
  if (t.length === 0) return '';
  if (t.toLowerCase() === 'false') return ''; // bare boolean "no buffer"
  if (t.charAt(0) === '{') {
    let f = extractJsonString(t, 'text');
    if (f.length > 0) return f;
    f = extractJsonString(t, 'value');
    if (f.length > 0) return f;
    return extractJsonString(t, 'input');
  }
  if (t.length >= 2 && t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') {
    t = t.substr(1, t.length - 2);
  }
  return t;
}

module.exports = {
  MAX_SEND_LEN,
  LINK_HINT,
  CHAN_NAMES,
  normChannel,
  echoIdKey,
  echoSbKey,
  expirePendingEchoes,
  isOwnEcho,
  removePendingMatch,
  sendErrorMessage,
  switchChannelBySlash,
  tabOrder,
  isChannelSelectable,
  parseInputSubmit,
  emptyFeedNotice,
  extractJsonString,
  chatVerbFailed,
  NATIVE_INPUT_VERBS,
  nativeCommandName,
  callTopVerb,
  sendCommandName,
  setChatInputActivePayload,
  nativeTruthy,
  probeUsable,
  parseInputText,
};
