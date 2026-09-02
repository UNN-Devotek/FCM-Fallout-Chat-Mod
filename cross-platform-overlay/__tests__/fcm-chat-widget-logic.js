// Pure logic ported from game-mods/FCMBridge/hudmodloader-chat/FCMChatWidget.hx
// (FCMChatWidget v2.10.4). The .hx (Haxe → SWF) is not unit-tested directly; per the
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
function tabOrder(serverSessionReady) {
  return serverSessionReady ? [0, 5, 1, 2, 3, 4] : [0, 1, 2, 3, 4];
}
function isChannelSelectable(idx, serverSessionReady) {
  return tabOrder(serverSessionReady).indexOf(idx) >= 0;
}

// ── Server-room control acknowledgement (FCMChatWidget.applyServerControlResult) ─
// Observing nearby players only requests a bind; SERVER is selectable only after the
// relay synchronously acknowledges the roster/world control.
function serverSessionResult(raw, readyOnSuccess = true) {
  raw = String(raw == null ? '' : raw);
  const success = raw.includes('"success":true') || raw.includes('success:true');
  if (success) return { ready: readyOnSuccess, error: '' };
  const errorMatch = raw.match(/"message":"([^"\\]*(?:\\.[^"\\]*)*)"/);
  const codeMatch = raw.match(/"code":"([^"\\]*(?:\\.[^"\\]*)*)"/);
  return { ready: false, error: (errorMatch && errorMatch[1]) || (codeMatch && codeMatch[1]) || 'relay did not accept the server session' };
}

function serverSendDecision(serverSessionReady, serverSessionError) {
  if (serverSessionReady) return { send: true, text: '' };
  return {
    send: false,
    text: serverSessionError
      ? 'Server chat is unavailable: ' + serverSessionError
      : 'Server chat is initializing...',
  };
}

function shouldSendRosterControl({ rosterObserved, serverSessionReady, now, lastSentAt, lastSentNames, names }) {
  if (!rosterObserved) return false;
  const namesField = names.join('|');
  return !serverSessionReady || now - lastSentAt >= 30000 || namesField !== lastSentNames;
}

// ── Relay-control framing (FCMChatWidget world controls) ───────────────────────
// PRINTABLE frames (v2.9.6+). The NUL-delimited legacy form is gone: control bytes must never
// appear in this SWF at all. A NUL cannot even be split() on under GFx (see stripControlChars),
// and a NUL-bearing constant is what produced the 2026-08 send outage. The relay accepts both
// forms; printable is the only safe one to emit.
const WORLD_CONTROL_PREFIXES = {
  world: 'FCMCTL/1/WORLD:',
  leave: 'FCMCTL/1/LEAVE',
  roster: 'FCMCTL/1/ROSTER:',
};

function worldControlBody(kind, namesOrWorldId = []) {
  switch (kind) {
    case 'world': return WORLD_CONTROL_PREFIXES.world + String(namesOrWorldId);
    case 'leave': return WORLD_CONTROL_PREFIXES.leave;
    case 'roster': return WORLD_CONTROL_PREFIXES.roster + namesOrWorldId.join('|');
    default: return '';
  }
}

function historyResyncControlBody() {
  return 'FCMCTL/1/RESYNC';
}

function shouldRenderReplayMessage(seen, messageId) {
  if (!messageId) return true;
  if (seen[messageId]) return false;
  seen[messageId] = true;
  return true;
}

function jsonEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\x00/g, '\\u0000')
    .replace(/\x1F/g, '\\u001F')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

// ── Native-input lock lifecycle (FCMChatWidget.open/closeInputNative) ──────────
function nativeLockAdmission(nativeActivated, startEditTextDispatched) {
  if (!nativeActivated) return { nativeOpen: false, fallback: true, deactivate: false, ownsLock: false };
  if (!startEditTextDispatched) return { nativeOpen: false, fallback: true, deactivate: true, ownsLock: false };
  return { nativeOpen: true, fallback: false, deactivate: false, ownsLock: true };
}

function nativeLockRelease(ownsLock, endDispatched = true) {
  if (!ownsLock) return { dispatchEndEditText: false, ownsLockAfter: false, retry: false };
  return {
    dispatchEndEditText: true,
    ownsLockAfter: !endDispatched,
    retry: !endDispatched,
  };
}

function shouldRebindWorldId(lastWorldIdAfterReconnect, currentWorldId) {
  return currentWorldId !== lastWorldIdAfterReconnect;
}

function shouldIgnoreBlankWorldId({ lastWorldId, currentWorldId, freshRosterObservation }) {
  return currentWorldId === '' && currentWorldId !== lastWorldId && freshRosterObservation;
}

// ── HUDModLoader event decoding + in-session channel action routing ────────────
// HUDModLoader's public event fields are lower camel case. The capitalized aliases
// are accepted for older loader builds that shipped the earlier event wrapper.
function hudUserEventAction(event) {
  if (!event) return '';
  const value = event.actionName != null && String(event.actionName).length > 0
    ? event.actionName : event.EventName;
  return value == null ? '' : String(value);
}

function hudUserEventIsDown(event) {
  if (!event) return false;
  const value = event.isDown != null ? event.isDown : event.IsKeyDown;
  return value === true;
}

function isExternalInputAction(action) {
  const value = String(action == null ? '' : action).toLowerCase();
  return value === 'escape' || value === 'cancel'
    || value.includes('quick')
    || value.includes('friend')
    || value.includes('social');
}

function inputChannelAction({ inputOpen, isKeyDown, action, nextAction, prevAction }) {
  if (isKeyDown) return 'none';
  if (action === nextAction) return 'next';
  if (action === prevAction) return 'prev';
  return 'none';
}

// Some ZFE/Steam Input builds return only the newest character from readChatInput.
// Accumulate that stream while preserving shorter real edits and empty clears.
function mergeNativeInputText(previous, observed) {
  previous = String(previous == null ? '' : previous);
  observed = String(observed == null ? '' : observed);
  if (!observed) return '';
  if (previous && observed.length === 1 && !previous.endsWith(observed)) return previous + observed;
  return observed;
}

// SharedHUDTools owns and renders the fallback TextField, so the widget must leave
// its overlapping prompt as a label rather than mirroring the same typed string.
function sharedHudPromptMode() {
  return 'label-only';
}

function customEventDefinitionNames() {
  return ['Shared.AS3.Events.CustomEvent', 'CustomEvent'];
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

// ── HUD moderation command parsing (FCMChatWidget.handleModerationCommand) ────
// Staff may enter an exact visible name (quote multi-word names) or the short reference
// beside a visible message. The widget resolves either input locally to the record's immutable
// relay messageId/senderUserId; names are never sent to the relay as a target.
function readModerationTarget(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return { target: '', rest: '', valid: false, quoted: false };
  if (s[0] === '"') {
    const close = s.indexOf('"', 1);
    if (close < 0) return { target: '', rest: '', valid: false, quoted: true };
    const target = s.slice(1, close).trim();
    return { target, rest: s.slice(close + 1).trim(), valid: target.length > 0, quoted: true };
  }
  const match = s.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return { target: '', rest: '', valid: false, quoted: false };
  return { target: match[1], rest: (match[2] || '').trim(), valid: true, quoted: false };
}

function parseModerationCommand(input) {
  let s = String(input == null ? '' : input).trim();
  if (s.startsWith('/') || s.startsWith('.')) s = s.slice(1).trim();
  const commandMatch = s.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!commandMatch || commandMatch[1].toLowerCase() !== 'mod') return { handled: false };

  let rest = (commandMatch[2] || '').trim();
  if (!rest || rest.toLowerCase() === 'help') return { handled: true, help: true };
  const targetPart = readModerationTarget(rest);
  if (!targetPart.valid) return { handled: true, error: 'usage' };
  const target = targetPart.target;
  rest = targetPart.rest;
  const actionMatch = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!actionMatch) return { handled: true, error: 'usage' };
  const actionWord = actionMatch[1].toLowerCase();
  let tail = (actionMatch[2] || '').trim();

  const plain = {
    delete: 'deleteMessage',
    kick: 'kickUser',
    unmute: 'unmuteUser',
    unban: 'unbanUser',
  };
  if (plain[actionWord]) {
    if (!tail) return { handled: true, error: 'reason_required' };
    return { handled: true, request: { action: plain[actionWord], target, reason: tail.slice(0, 500) } };
  }

  if (actionWord === 'mute') {
    const durationMatch = tail.match(/^(\d+)\s+([\s\S]+)$/);
    const durationMinutes = durationMatch ? Number(durationMatch[1]) : 0;
    const reason = durationMatch ? durationMatch[2].trim() : '';
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 43200) {
      return { handled: true, error: 'mute_duration_required' };
    }
    if (!reason) return { handled: true, error: 'reason_required' };
    return { handled: true, request: { action: 'muteUser', target, durationMinutes, reason: reason.slice(0, 500) } };
  }

  if (actionWord === 'ban') {
    const durationMatch = tail.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const durationWord = durationMatch ? durationMatch[1].toLowerCase() : '';
    const reason = durationMatch && durationMatch[2] ? durationMatch[2].trim() : '';
    const durationMinutes = durationWord === 'perm' || durationWord === 'permanent'
      ? 0
      : (/^\d+$/.test(durationWord) ? Number(durationWord) : -1);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 0 || durationMinutes > 43200) {
      return { handled: true, error: 'ban_duration_required' };
    }
    if (!reason) return { handled: true, error: 'reason_required' };
    return { handled: true, request: { action: 'banUser', target, durationMinutes, reason: reason.slice(0, 500) } };
  }

  return { handled: true, error: 'unknown_action' };
}

function isVisibleModerationRecord(record, activeChannel) {
  return record.channel === activeChannel
    && String(record.messageId || '').length >= 8
    && String(record.senderUserId || '').length > 0;
}

function resolveModerationTarget(records, targetInput, activeChannel) {
  const target = String(targetInput == null ? '' : targetInput).trim();
  if (target.startsWith('#')) {
    const ref = target.slice(1).toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(ref)) return { target: null, ambiguous: false };
    return {
      target: records.find((record) =>
        isVisibleModerationRecord(record, activeChannel)
        && String(record.messageId).slice(0, 8).toLowerCase() === ref,
      ) || null,
      ambiguous: false,
    };
  }

  const normalizedName = target.toLowerCase();
  if (!normalizedName) return { target: null, ambiguous: false };
  let matched = null;
  for (const record of records) {
    if (!isVisibleModerationRecord(record, activeChannel)) continue;
    if (String(record.user || '').trim().toLowerCase() !== normalizedName) continue;
    if (matched && String(matched.senderUserId) !== String(record.senderUserId)) {
      return { target: null, ambiguous: true };
    }
    // Records are chronological; keep the most recent message for delete-by-name.
    matched = record;
  }
  return { target: matched, ambiguous: false };
}

function findModerationTarget(records, targetInput, activeChannel) {
  return resolveModerationTarget(records, targetInput, activeChannel).target;
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

// ── Link gate (FCMChatWidget v2.9.7) ────────────────────────────────────────────
// The relay pushes its link-code notice as a ONE-SHOT frame on register/hello/subscribe
// (relayHandler.pushLinkNotice) — nothing replays it. So "no notice on this connect" must
// NOT be read as "linked", or a missed push strands the player in the chat feed with no way
// back to the link screen. The gate is sticky and only PROOF of linking clears it.
const LINK_CODE_REFRESH_MS = 540000; // 9 min; relay codes expire at 10

// linkGateOnReconnect (FCMChatWidget.startConnect success path): the gate carries over.
// v2.9.6 and earlier returned false here unconditionally — that was the bug.
function linkGateOnReconnect(prevNeedsLink) {
  return prevNeedsLink === true;
}

// clearLinkGate (FCMChatWidget.clearLinkGate): the only transition to "linked".
function clearLinkGate() {
  return { needsLink: false, pinnedSystemBody: '', linkNoticeAt: 0, refreshPending: false };
}

// linkGateOnSystemNotice (FCMChatWidget.parseAndRenderEvents system branch): a
// "LINK COMPLETE" body clears the gate; anything else is a link-code notice that raises it
// and (re)stamps the code's arrival time.
function linkGateOnSystemNotice(body, now) {
  body = String(body == null ? '' : body);
  if (body.indexOf('LINK COMPLETE') >= 0) return clearLinkGate();
  return { needsLink: true, pinnedSystemBody: body, linkNoticeAt: now, refreshPending: false };
}

// linkCodeStale (FCMChatWidget.linkCodeStale): a pinned code past its usable lifetime.
function linkCodeStale({ needsLink, linkNoticeAt, now }) {
  if (!needsLink || !(linkNoticeAt > 0)) return false;
  return now - linkNoticeAt >= LINK_CODE_REFRESH_MS;
}

// shouldRefreshLinkCode (FCMChatWidget.maybeRefreshLinkCode): reconnect exactly once per
// stale code — the relay re-pushes a fresh notice on the next subscribe while still limited.
function shouldRefreshLinkCode({ needsLink, linkNoticeAt, now, refreshPending }) {
  if (refreshPending) return false;
  return linkCodeStale({ needsLink, linkNoticeAt, now });
}

// linkHintStatus (FCMChatWidget.linkHint): which of the three line endings the link screen
// shows — the code itself, the first-notice wait, or the post-expiry refresh.
function linkHintStatus({ pinnedSystemBody, refreshPending }) {
  const code = extractLinkCode(pinnedSystemBody);
  if (code.length > 0) return { status: 'code', code };
  return { status: refreshPending ? 'expired' : 'waiting', code: '' };
}

// extractLinkCode (FCMChatWidget.extractLinkCode): pull "XXXX-XXXX" out of the relay notice.
function extractLinkCode(body) {
  if (body == null) return '';
  body = String(body);
  const i = body.indexOf('code: ');
  if (i < 0) return '';
  const rest = body.substr(i + 6).trim();
  let out = '';
  for (let j = 0; j < rest.length; j++) {
    if (/[0-9A-Za-z-]/.test(rest.charAt(j))) out += rest.charAt(j);
    else break;
  }
  return out;
}

// linkGateRender (FCMChatWidget.renderRecords gate order): connecting beats the link screen,
// which beats the feed.
function linkGateRender({ connected, needsLink }) {
  if (!connected) return 'connecting';
  if (needsLink) return 'link-screen';
  return 'feed';
}

// ── Game-UI string sanitization (FCMChatWidget.fcmClean / readDisplayName) ──────
// BSUIDataManager hands names back carrying UTF-16 NULs, and ZFE sometimes pre-escapes them
// to the text " " (or, when its encoding is off, a bare "u0000"). readDisplayName used to
// jsonEscape() the raw value and startConnect escaped it AGAIN when building the payload, so the
// relay stored 337 characters instead of 8. Sanitize on read; escape only when serializing.
const NUL = String.fromCharCode(0);
const UNIT_SEP = String.fromCharCode(31);

function fcmClean(s) {
  if (s == null) return '';
  s = String(s)
    .split('~').join(' ')
    .split('\r').join(' ')
    .split('\n').join(' ')
    .split(NUL).join('')
    .split(UNIT_SEP).join('')
    .split('\\u0000').join('')
    .split('u0000').join('');
  return s.trim();
}

// Mirrors FcmConfig.normalizeDiscordEmojiMarkup. The web renderer keeps custom
// emoji as CDN-backed images; the Scaleform HUD uses a readable shortcode label
// and must not expose the Discord snowflake ID.
function normalizeDiscordEmojiMarkup(s) {
  if (s == null || String(s).indexOf('<') < 0) return s;
  s = String(s);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const animated = s.substr(i, 3) === '<a:';
    if (!animated && s.substr(i, 2) !== '<:') {
      out += s.charAt(i); i += 1; continue;
    }
    const nameStart = i + (animated ? 3 : 2);
    const nameEnd = s.indexOf(':', nameStart);
    if (nameEnd <= nameStart) { out += s.charAt(i); i += 1; continue; }
    const idEnd = s.indexOf('>', nameEnd + 1);
    if (idEnd <= nameEnd + 1) { out += s.charAt(i); i += 1; continue; }
    const name = s.slice(nameStart, nameEnd);
    const id = s.slice(nameEnd + 1, idEnd);
    if (name.length > 64 || id.length > 22 || !/^[A-Za-z0-9_]+$/.test(name) || !/^\d+$/.test(id)) {
      out += s.charAt(i); i += 1; continue;
    }
    out += ':' + name + ':';
    i = idEnd + 1;
  }
  return out;
}

// readDisplayName: sanitize + truncate. Must NOT escape — the payload builder does that once.
function readDisplayName(raw) {
  const clean = fcmClean(raw);
  return clean.length > 0 ? clean.slice(0, 64) : '';
}

// resolveDisplayName mirrors FCMChatWidget's HUD data priority. The local entry in
// PlayerListData is the character identity; AccountInfoData is retained as a compatibility
// fallback because older HUD builds expose the name there instead.
function resolveDisplayName({ playerListData, characterInfoData, accountInfoData } = {}) {
  const unwrap = (value) => {
    if (value == null) return null;
    return value && value.data != null ? value.data : value;
  };

  const cleanCandidate = (value, stripDecorations = false) => {
    if (value == null) return '';
    let name = fcmClean(value);
    if (stripDecorations) {
      const marker = name.indexOf('<');
      if (marker >= 0) name = name.slice(0, marker);
      name = name.split('|').join('');
    }
    name = name.trim();
    if (!name || name === 'Wanderer') return '';
    return name.slice(0, 64);
  };

  const fieldCandidate = (value, fields, stripDecorations = false) => {
    if (value == null || typeof value !== 'object') return '';
    for (const field of fields) {
      const name = cleanCandidate(value[field], stripDecorations);
      if (name) return name;
    }
    return '';
  };

  const localRosterName = (raw) => {
    const data = unwrap(raw);
    const list = Array.isArray(data)
      ? data
      : [data && data.players, data && data.entries, data && data.list]
        .find((candidate) => Array.isArray(candidate));
    if (!list) return '';
    const truthy = (value) => value === true || value === 1
      || String(value == null ? '' : value).trim().toLowerCase() === 'true'
      || String(value == null ? '' : value).trim() === '1';
    for (const entry of list) {
      if (!entry || ![entry.isLocal, entry.isLocalPlayer, entry.isSelf].some(truthy)) continue;
      const name = fieldCandidate(entry, ['characterName', 'displayName', 'playerName', 'name'], true);
      if (name) return name;
    }
    return '';
  };

  const rosterName = localRosterName(playerListData);
  if (rosterName) return rosterName;

  const characterData = unwrap(characterInfoData);
  const characterName = fieldCandidate(characterData, ['characterName', 'displayName', 'playerName', 'name'], true);
  if (characterName) return characterName;

  const accountData = unwrap(accountInfoData);
  const accountName = fieldCandidate(accountData, ['characterName', 'displayName', 'playerName', 'name']);
  if (accountName) return accountName;
  return fieldCandidate(accountData && accountData.account, ['characterName', 'displayName', 'playerName', 'name']);
}

// Mirrors FCMChatWidget.reconcileDisplayName's state gate. The relay only needs a second
// connect after a real HUD name differs from the name accepted by the previous connect.
function shouldReconcileDisplayName({ connected, lastSentDisplayName, displayName } = {}) {
  const name = String(displayName == null ? '' : displayName);
  return Boolean(connected && name.length > 0 && name !== 'Wanderer' && name !== (lastSentDisplayName || ''));
}

// bareName: strip the "<title" decorations after sanitizing.
function bareName(s) {
  if (s == null) return '';
  s = fcmClean(s);
  const i = s.indexOf('<');
  if (i >= 0) s = s.slice(0, i);
  return s.split('|').join('').trim();
}


// -- replaceIfPresent (FCMChatWidget v2.9.11) -----------------------------------
// ROOT CAUSE of "That channel is not available" (2026-08-06). Scaleform GFx returns "" from
// String.fromCharCode(0), and a "\x00" literal in the SWF string pool collapses to "" too.
// Splitting on "" does not strip anything -- it EXPLODES the string, inserting the escape
// between every character. A clean slug "global" left the widget NUL-escaped and ZFE
// correctly rejected it as invalid_channel.
function replaceIfPresent(s, needle, rep) {
  if (s == null) return '';
  if (needle == null || needle.length === 0) return String(s);
  // A CONTROL-CHARACTER needle is equally unusable: GFx's split() is C-string based, so a NUL
  // separator reads as an empty one and explodes the string just as '' does. Confirmed in-game
  // 2026-08-07 -- v2.9.11 added only the length guard and the payload was byte-identical.
  if (needle.charCodeAt(0) < 32) return String(s);
  return String(s).split(needle).join(rep);
}

// stripControlChars: remove control characters WITHOUT split() -- the only way to strip a NUL
// on GFx. Keeps CR/LF/TAB so jsonEscape can still escape them.
function stripControlChars(s) {
  if (s == null) return '';
  let out = '';
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 32 || c === 9 || c === 10 || c === 13) out += str.charAt(i);
  }
  return out;
}

// Mirrors the FIXED FCMChatWidget.jsonEscape: control-byte substitutions go through
// replaceIfPresent, so an empty constant is a no-op instead of an explosion.
function jsonEscapeGuarded(s) {
  s = String(s == null ? '' : s);
  s = s.split('\\').join('\\\\');
  s = s.split('"').join('\\"');
  s = stripControlChars(s);
  s = s.split('\r').join('\\r');
  s = s.split('\n').join('\\n');
  s = s.split('\t').join('\\t');
  return s;
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

// jsonObjectEnd mirrors FCMChatWidget.jsonObjectEnd. Event payloads are JSON and
// message bodies may contain braces, quotes, and escaped backslashes; a simple
// brace counter would split a valid event at the wrong position.
function jsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
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
  serverSessionResult,
  serverSendDecision,
  shouldSendRosterControl,
  WORLD_CONTROL_PREFIXES,
  worldControlBody,
  historyResyncControlBody,
  shouldRenderReplayMessage,
  jsonEscape,
  nativeLockAdmission,
  nativeLockRelease,
  hudUserEventAction,
  hudUserEventIsDown,
  isExternalInputAction,
  mergeNativeInputText,
  shouldRebindWorldId,
  shouldIgnoreBlankWorldId,
  inputChannelAction,
  sharedHudPromptMode,
  customEventDefinitionNames,
  parseInputSubmit,
  emptyFeedNotice,
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
  jsonObjectEnd,
  parseModerationCommand,
  findModerationTarget,
  resolveModerationTarget,
};
