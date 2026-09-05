# ZFE Native Chat Relay Protocol (`chat.v1`) — Upstream Contract

> **Status: SHIPPED in ZFE 0.9.8 (2026-06-23).** This is the relay contract ZFE's native chat client
> implements — **verified directly from the `dxgi.dll` binary** (the `zfe-chat-v1` capability, the
> `register`/`hello`/`send`/`poll`/`subscribe`/`report`/`moderationAction` ops, the error codes, the
> channel vocab, and the `chat.message` event schema are all present). Reproduced here
> verbatim-in-substance as the canonical reference. FCM's relay implements R1–R3 + worldId — see
> [fcm-integration.md](fcm-integration.md) for the integration status (epic #282).
>
> **Status (2026-08-31): end-to-end send works on native Windows and Proton/Wine.** The
> `chat.v1.send` path is verified against the FCM relay on the current project ZFE build. The
> older 0.9.8 `dispatch_failed` and Proton/Wine TLS failures apply only to pre-fix ZFE builds.
> See [ZFE version history](#zfe-version-history) and [Transport / TLS](#transport--tls-chatv1-is-not-schannel)
> below.
>
> **This is NOT the existing FCMHUD/1 bridge.** FCM's shipping in-game chat is a *bespoke*
> line protocol (`color~channel~user~content` + M7 `HELLO/SEND/CHAN` verbs) riding ZFE's
> generic socket — see [../realtime-socket.md](../realtime-socket.md) and
> [../two-way-chat-implemented.md](../two-way-chat-implemented.md). The protocol below is a
> **standardized, relay-agnostic JSON contract** that ZFE itself defines and drives; a
> compliant relay needs none of FCM's custom SWF/wire code. See
> [README.md](README.md#how-this-differs-from-the-existing-fcmhud1-bridge) for the side-by-side.

ZFE is **relay agnostic**. A server can be written in any language as long as it speaks the
JSON-over-WebSocket contract below.

---

## ZFE version history

chat.v1-relevant ZFE builds:

| ZFE | chat.v1 status |
|-----|----------------|
| 0.9.8 | Protocol shipped, but `chat.v1.sendMessage` returned `dispatch_failed` (ZFE-side — the send never dispatched to the relay). |
| **0.9.9** | **Dispatch bug fixed → send works on native Windows.** This is the build the working Windows path needs. |
| 0.9.10 | Added Wine detection (`wine_get_version`) + a Zig TLS client + system-CA loading (Wine `Z:` paths), but chat still crashed under Wine. |
| 0.9.11 | Corrected misleading logging — the `Schannel/Winsock` line is the **legacy Text Chat** (now labeled `Legacy Text Chat transport backend`), not chat.v1. Added chat.v1 TLS CA logging (`TLS CA source: windows_store \| wine_pem_bundle`). |
| Current project-supported ZFE build | chat.v1 send and TLS work on native Windows and Proton/Wine. |

---

## Transport / TLS — chat.v1 is NOT Schannel

chat.v1 uses its **own Zig TLS client** plus a **PEM CA bundle**, on every platform. The
`Schannel/Winsock` line in older ZFE logs refers to the **legacy Text Chat** transport (SFE
compat), **not** chat.v1 — corrected in ZFE 0.9.11's logging.

The historical Proton/Wine partial-read failure was resolved in the current project ZFE build.
The FCM widget uses the same TLS-backed `chat.v1` path on native Windows and Proton/Wine; install
the current ZFE build rather than an older pre-fix binary. Plaintext public `ws://` endpoints remain
invalid; hosted packages use the target's `wss://` relay endpoint.

---

## What ZFE provides

ZFE runs inside Fallout 76 as the native bridge. A chat SWF calls ZFE through:

```actionscript
__ZFE.call(command, payloadJson)
```

ZFE handles, on the client side:

- **endpoint policy** — production `wss://`, loopback-only `ws://` for development;
- **server-issued auth token storage** — in a Windows **DPAPI**-protected local file;
- **reconnecting** the private live subscriber for production `wss://`;
- **forwarding** send / poll / report / moderation requests;
- **local validation** for channels, message size, and advertised permissions;
- **native hotkey and input** support used by chat UIs.

The SWF should **not** ask users to paste tokens. The relay issues a token on `register`, ZFE
stores it, and later ZFE authenticates with `hello`.

---

## Packaged config

For distribution, ship a **TextChat fragment** next to the BA2 instead of asking users to edit
`zfe.ini` by hand. The fragment filename must match the active `Data/hudmodloader.ini` entry for
the SWF:

```
Data/MyChat.ba2
Data/ZFE/TextChat/fragments/MyChat.ini
```

```ini
; Data/ZFE/TextChat/fragments/MyChat.ini
[TextChat]
OpenChatKey=PAGE_DOWN
DefaultChannel=global
AllowedChannels=local,global,server,trade,party,clan,whisper
EnableTimestamps=true
Endpoint=wss://chat.example.com/relay
AutoConnect=false
```

ZFE reads `Data/hudmodloader.ini` and applies the **first active matching fragment** it finds.
Inactive fragments are ignored, so an old fragment left in `Data` does not configure chat unless
the matching SWF is still active.

The canonical **user override** remains:

```ini
; Data/configuration/zfe.ini
[TextChat]
OpenChatKey=PAGE_DOWN
DefaultChannel=global
AllowedChannels=local,global,server,trade,party,clan,whisper
EnableTimestamps=true
Endpoint=wss://chat.example.com/relay
AutoConnect=false
```

Values in `zfe.ini` override fragment values **per key**. For example, if the fragment supplies
`Endpoint` and the user sets only `OpenChatKey`, ZFE uses the fragment endpoint and the user
hotkey. Use **`AllowedChannels`** to ship custom normal channel IDs for your SWF — for example
`global,market,raiders,whisper`.

For local relay development:

```ini
[TextChat]
Endpoint=ws://127.0.0.1:8788/
```

> **Endpoint policy.** Production endpoints **must** be `wss://` and **must** include a path such
> as `/relay` or `/`. Public `ws://`, LAN `ws://`, URL userinfo, fragments, malformed paths, and
> non-ASCII endpoint parts are **rejected** by ZFE.

---

## SWF client flow

At startup, read runtime info and require the online-chat capability:

```actionscript
var runtime:String = __ZFE.call("chat.v1.getRuntimeInfo", "{}");
// Require capabilities to include: zfe-chat-online-v1
```

Connect:

```actionscript
var payload:String =
  "{\"displayName\":\"" + escapeJson(characterName) + "\",\"autoRegister\":true}";
var result:String = __ZFE.call("chat.v1.connect", payload);
```

If the payload omits `endpoint`, ZFE uses `[TextChat] Endpoint` from the active TextChat fragment,
then applies user overrides from `Data/configuration/zfe.ini`. `displayName` is **presentation
metadata**; identity is the **relay-owned `userId`**.

Poll the ZFE event queue:

```actionscript
var events:String = __ZFE.call("chat.v1.pollEvents", "{\"max\":64}");
```

The SWF **still polls ZFE** even when production push is active. ZFE's private native subscriber
normalizes pushed relay events into the same `pollEvents` queue.

If a HUD widget is recreated while that native subscriber remains connected, `pollEvents` can be
empty because its queue was already drained. FCM's optional widget uses an authenticated reserved
`chat.v1.sendMessage` control (`FCMCTL/1/RESYNC`) to request a bounded replay from the relay; it is
not a new public `chat.v1` operation.

Send:

```actionscript
__ZFE.call("chat.v1.sendMessage",
  "{\"channel\":\"global\",\"targetUserId\":\"\",\"body\":\"hello\"}");
```

Report:

```actionscript
__ZFE.call("chat.v1.reportMessage",
  "{\"messageId\":\"msg_1\",\"reason\":\"spam\"}");
```

Moderation UI calls, if exposed:

```actionscript
__ZFE.call("chat.v1.moderationAction",
  "{\"action\":\"deleteMessage\",\"messageId\":\"msg_1\",\"targetUserId\":\"\",\"reason\":\"spam\"}");
```

Use `chat.v1.getAuthState` to show connection and push health:

```json
{
  "success": true,
  "state": "authenticated",
  "connected": true,
  "userId": "user_123",
  "linkedUserId": "fcm-account-123",
  "displayName": "CharacterName",
  "roles": ["user"],
  "permissions": {
    "canReport": true,
    "canDeleteMessage": false,
    "canKickUser": false,
    "canMuteUser": false,
    "canUnmuteUser": false,
    "canBanUser": false,
    "canUnbanUser": false,
    "canSetSlowMode": false
  },
  "liveSubscriber": {
    "active": true,
    "reconnectAttempts": 0,
    "lastError": "",
    "nextReconnectDelayMs": 0
  }
}
```

FCM's implementation returns `linkedUserId` only in the authenticated caller's own auth-state
response. Persisted chat events identify authors with that linked account UUID in `senderUserId`,
while `userId` remains the relay-text session identity. HUD clients must retain both values for
self-echo reconciliation; clients must never supply either identity in a send payload.

> **Never display or log the raw token.** ZFE intentionally never returns it to the SWF.

---

## Relay WebSocket contract

ZFE sends JSON **text frames** over WebSocket. For request/response operations, the server reads
one JSON request frame and replies with one JSON response frame. The connection may then stay open
or close. For `subscribe`, the connection is **long-lived**.

### Success and error envelopes

All success responses include:

```json
{ "success": true }
```

All error responses use this stable shape:

```json
{ "success": false, "error": { "code": "rate_limited", "message": "Rate limit exceeded" } }
```

For auth failures, these codes are **stable** because ZFE keys behavior off them:

| Code | Meaning | ZFE behavior |
|------|---------|--------------|
| `auth_token_invalid` | Saved token is stale | ZFE may auto-register if allowed |
| `auth_token_revoked` | Token revoked | Do **not** auto-register around this token |
| `user_banned` | User is banned | Do **not** auto-register around this user |
| `rate_limited` | Operation hit server limits | Back off |

---

## Required relay operations

### Register

```json
{ "op": "register", "displayName": "CharacterName" }
```

Response:

```json
{
  "success": true,
  "userId": "user_0123456789abcdef0123456789abcdef",
  "displayName": "CharacterName",
  "token": "relay_token_secret",
  "role": "user"
}
```

The server **owns both `userId` and `token`**. Generate `userId` on the server; do **not** accept
an id supplied by the client.

### Authenticate a saved token (`hello`)

```json
{ "op": "hello", "token": "relay_token_secret", "displayName": "CharacterName" }
```

Response:

```json
{
  "success": true,
  "userId": "user_0123456789abcdef0123456789abcdef",
  "displayName": "CharacterName",
  "role": "user"
}
```

Do **not** return the token from `hello`. If `displayName` is present and non-empty, update the
stored display name for that authenticated user **without** changing `userId`, `role`, `token`,
mute state, ban state, or moderation history. This lets a client replace an old fallback name while
preserving server identity.

### Send

```json
{ "op": "send", "token": "relay_token_secret", "channel": "global", "body": "hello", "targetUserId": "" }
```

Response:

```json
{
  "success": true,
  "messageId": "msg_1",
  "tag": "X",
  "supporterStar": true,
  "starColor": "#FD4DA6",
  "targetUserId": "FCMHUD/1;m=msg_1;s=1;c=%23FD4DA6;t=X"
}
```

The additive cosmetic fields appear only when the authenticated sender has the
corresponding server-resolved identity cosmetics. The HUD uses them to decorate its
authoritative live self-row; the same resolved supporter identity is also passed to
the Discord relay, where the immutable `★` is rendered beside the author. For widget
v2.10.16+, `targetUserId` carries the stable `messageId` as `m=...` plus the same validated
`FCMHUD/1;...` cosmetic envelope used by live events, because ZFE may strip newer JSON members
from native RPC responses. For older widgets the carrier is omitted. For capable widgets, the
carrier still includes `m=...` when the response has a stable message ID, even if no cosmetic
fields are present.

### Poll

```json
{ "op": "poll", "token": "relay_token_secret", "cursor": 0, "max": 64 }
```

Response:

```json
{
  "success": true,
  "events": [
    {
      "id": 1,
      "kind": "chat.message",
      "messageId": "msg_1",
      "channel": "global",
      "senderUserId": "user_0123456789abcdef0123456789abcdef",
      "senderDisplayName": "CharacterName",
      "body": "hello",
      "targetUserId": "",
      "createdAt": "2026-06-26T12:34:56.000Z"
    }
  ]
}
```

`id` is the **relay cursor**. It must **increase monotonically** for visible events. ZFE uses it to
avoid duplicate messages between push and poll.

`createdAt` is the message's **server send time** as an ISO 8601 UTC string (sourced from
`messages.created_at`). Clients render timestamps from this field. The system link-notice carries
the time it was issued. Older relays may omit it (treat absent/empty as "no timestamp").

FCM's relay adds optional HUD cosmetic fields to FCM chat events: `tag` (a validated
Overseer tag), `supporterStar: true` (an active Supporter/Overseer entitlement), and
`starColor` (a validated `#rrggbb` value). They may appear on live, polled, and
subscribe-time history events. Raw relay consumers receive these additive members. ZFE's native
bridge, however, filters unknown members before passing an event to Scaleform; therefore widget
v2.10.16+ also receives a `FCMHUD/1;...` envelope in the existing known `targetUserId` member.
For ordinary channel messages this is an empty transport slot, never a real recipient. The
envelope is capability-gated to v2.10.16+; older widgets receive an empty `targetUserId` and no
transport data. The relay records the negotiated token/version across separate connect and
subscribe sockets so the same gate applies to live, poll, and history delivery. The current Dev
widget v2.10.46 parses the stable message ID plus supporter fields and renders a fixed five-point
vector `Shape` in a row-local `Sprite`: 5px after the measured channel tag and centered on
the first message line with a 2px visual down-nudge. The marker and text share the same row and scroll offset; no document index
or global/local transform is used. The stable message ID lets an optimistic local send transaction
reconcile with its authoritative live echo exactly once, even when the native bridge strips
additive JSON members. If an extender presents different IDs on the ACK and event, the widget
first requires a proven local sender identity. For the old Dev bridge, the compatibility fallback
also requires one successful ACK, one unique candidate, a matching display name/channel/body, and
a 15-second window; an unknown/conflicting sender or ambiguous candidate is never merged by body
text alone. A live event may arrive before the send ACK; a stable-ID event can complete the one
pending local transaction in place, so the client still renders one row. It must never place U+2605
in `senderDisplayName` or `body`, nor use a bitmap, HTML image, or substitution token; see the
[Dev wire capture](dev-supporter-star-wire-capture-2026-09-02.md).

The event `body` remains the canonical raw text for web and relay consumers. The Dev HUD applies
one display-only normalization for Discord custom-emoji tokens: `<:name:id>` and `<a:name:id>`
become `:name:` before Scaleform escaping. This avoids exposing Discord snowflake IDs; the HUD does
not fetch or render remote emoji images. Public feed image/GIF attachments continue to be rejected
by the Discord bridge rather than entering the in-game event stream.

For an authenticated HUD send, the relay performs a bounded authoritative Discord
member-role refresh before decoration: once per linked Discord account per minute across
the deployment, coordinated by Redis. It derives the Discord ID from the linked FCM user,
never from the HUD frame. A successful refresh updates the entitlement and invalidates
resolved cosmetics only when the effective tier changes, before the message is broadcast,
so every subscriber and the sender's acknowledgement receive current supporter fields. The backend
delivers a finalized static-channel event directly to native subscribers on the same process before
publishing the web broadcast to Redis; other instances use the Redis subscriber path. The shared
instance guard prevents the direct and Redis paths from delivering the same event twice.
Transient Discord failures leave the last known entitlement in place; a definitive
member-not-found result is treated as loss of guild privileges.

When `cursor` is `0`, the server **may** include an initial visible history window. The history
size is relay policy, not a ZFE rule — a relay can return no history, five messages, twenty
messages, or another bounded count. Returned events still use their **real relay cursors** so the
client can continue from the newest event it received.

FCM's native subscriber implementation uses a separate bounded subscribe-time backfill so the
HUD receives context on first load. A cursor-zero subscription sends up to 15 recent rows for
each static feed (`global`, `trade`, `events`, `infests`, and `raids`) and up to 50 rows for the
current ephemeral `server` room: 125 events total. This is an FCM relay policy chosen to fit
xScal's 128-event queue; the native `pollEvents` limit remains 64, so the widget drains the
ordered snapshot over multiple polls. Other relay consumers must not assume this exact window.

### Subscribe

```json
{ "op": "subscribe", "token": "relay_token_secret", "cursor": 0, "max": 64 }
```

Acknowledgement:

```json
{
  "success": true,
  "op": "subscribed",
  "cursor": 0,
  "userId": "user_0123456789abcdef0123456789abcdef",
  "displayName": "CharacterName",
  "role": "user"
}
```

Push new events as they become visible to that user:

```json
{
  "op": "event",
  "cursor": 1,
  "event": {
    "id": 1,
    "kind": "chat.message",
    "messageId": "msg_1",
    "channel": "global",
    "senderUserId": "user_0123456789abcdef0123456789abcdef",
    "senderDisplayName": "CharacterName",
    "body": "hello",
    "targetUserId": "",
    "createdAt": "2026-06-26T12:34:56.000Z"
  }
}
```

The `subscribed` acknowledgement is followed by the subscription's initial history events when
the supplied cursor is `0`, then by live events. A nonzero cursor resumes after that cursor. This
subscription backfill is distinct from a short-lived `poll` response; it does not consume or alter
the cursor of any other connection. The relay holds live frames behind the initial snapshot and
flushes them in cursor order, preventing a live event from overtaking or duplicating the backfill.
FCM's xScal widget drains this stream with a bounded warm-up. A ZFE widget uses the authenticated
`FCMCTL/1/RESYNC` control only as a delayed fallback after an empty or dropped initial poll, which
prevents a normal subscribe snapshot from being appended twice when the native queue is still full.

### Report

```json
{ "op": "report", "token": "relay_token_secret", "messageId": "msg_1", "reason": "spam", "details": "" }
```

Response:

```json
{ "success": true, "status": "reported" }
```

The server validates the linked relay token, message UUID, message visibility, and
report reason/details. It derives the target user from the persisted message, rejects
self-reports, allows at most five reports per linked account in a ten-minute window,
rejects a second report for the same message by the same account, and returns success
only after the report has been stored.

### Moderation action

```json
{ "op": "moderationAction", "token": "moderator_token_secret", "action": "deleteMessage", "messageId": "msg_1", "targetUserId": "", "reason": "spam" }
```

Response:

```json
{ "success": true, "status": "submitted" }
```

Supported actions: `deleteMessage`, `kickUser`, `muteUser`, `unmuteUser`, `banUser`, `unbanUser`, `setSlowMode`.

The **server is authoritative**. ZFE only **pre-checks** the permissions it received from auth
Only linked Discord-backed `moderator`, `admin`, and `owner` accounts may submit these actions.
The relay routes delete, kick, mute, unmute, ban, and unban through the shared moderation service, audit
log, and live-session enforcement. In-game bans use the supplied reason as text evidence because
the relay cannot upload evidence files. `setSlowMode` is currently rejected with `invalid_action`
and `canSetSlowMode` remains `false`.

---

## Channels and limits

The channel vocabulary is **configurable, not fixed.** If `[TextChat] AllowedChannels` is omitted,
ZFE allows the built-in defaults `local`, `global`, `server`, `trade`, `party`, `clan`, `whisper`.
A chat UI can ship a **different comma-separated list** in its active TextChat fragment, and users
can override it in `zfe.ini`. This is the mechanism for relay-specific channels — a backend with
`events`, `raids`, or `infests` ships those exact IDs.

**Channel ID rules:**

- May contain ASCII letters, digits, `_`, `-`, `.`, or `:`
- Must be **shorter than 64 bytes**
- `system` is **reserved** — clients cannot send to it even if it appears in config
- Whispers require `targetUserId`

ZFE enforces a local **512 UTF-16 code-unit** message body limit, but the relay **must enforce its
own channel policy, permissions, and limits too**.

---

## Identity and bans

- Do **not** trust `displayName` for identity. It can change and is only for display.
- Use the **server-issued token** to authenticate a user, then map that token to the server-owned
  `userId`.
- If a user is banned or a token is revoked, return `user_banned` or `auth_token_revoked` so ZFE
  does **not** silently create a new account around the moderation action.
- For stronger ban resistance later, add server-side signals such as account linking, invite codes,
  operator review, rate limits, or proof of work. Do **not** base moderation solely on character
  display name.

---

## Existing relay compatibility notes

This section is aimed at backends that **already** run a chat system (like FCM) and want to adapt
rather than build greenfield.

- **Custom channels.** ZFE does **not** require relays to use its default channel vocabulary. If the
  backend already has channels such as `events`, `raids`, or `infests`, ship those IDs in the active
  `AllowedChannels` fragment and have the SWF send those exact channel strings. **Omit** default
  channels that have no meaning in the relay.
- **Cursors.** Every visible event needs a monotonically increasing `id` cursor. If the backend has
  no global message sequence, **assign a relay cursor when the message is broadcast** and make both
  `poll` and `subscribe` return that **same** cursor value for the same event.
- **Identity / account linking.** Display names are not identity. An existing account system can keep
  ZFE users in a **limited** state until they complete account linking, then return stronger roles or
  permission booleans from `register` or `hello`. If normal sending must be blocked before linking,
  reject `send` with **`permission_denied`** — ZFE does **not** currently advertise a separate
  `canSend` permission.
- **Slow mode.** If the relay has no slow-mode feature, return `canSetSlowMode: false` and reject
  `setSlowMode` with **`permission_denied`** or **`invalid_action`**.
- **Message deletion.** ZFE currently has **no dedicated deleted-message event kind**. Relays can
  **hide deleted messages** from later `poll` and history responses. Live removal of an
  already-rendered message needs either a future ZFE event extension or a convention handled by your
  own SWF.
- **Muted users.** Prefer rejecting `send` with **`user_muted`** so the client can show an explicit
  failure. Accepting and silently dropping muted sends is allowed by a relay, but gives weaker
  feedback.

> **Operational reject codes.** Beyond the four stable auth codes above, this section introduces
> `permission_denied`, `invalid_action`, and `user_muted` as the recommended rejection codes for the
> cases named here. ZFE surfaces them to the SWF; only the four auth codes drive ZFE's own
> auto-register / back-off behavior.

---

## Local compatibility test

1. Run the relay on loopback: `ws://127.0.0.1:8788/`
2. Set:
   ```ini
   [TextChat]
   Endpoint=ws://127.0.0.1:8788/
   ```
3. Launch the game, open chat, and send a message.
4. Confirm the relay sees the order: `register` (or `hello`) → `subscribe` → `send` → `poll`.
5. From another terminal/client, send a message to the same relay and verify the game receives it
   through `chat.v1.pollEvents`.

For production, put the relay behind TLS and configure:

```ini
[TextChat]
Endpoint=wss://chat.example.com/relay
```

---

## What a relay does *not* need to implement

A relay does **not** need ZFE's local DPAPI token file, hotkey polling, SWF input routing, or BA2
packaging — those are client-side ZFE/SWF concerns. The relay can use memory, SQLite, Postgres,
Redis, or any other backend, as long as the WebSocket JSON contract stays compatible.

---

## See also

- [README.md](README.md) — index for this sub-topic, and how it differs from FCMHUD/1
- [fcm-integration.md](fcm-integration.md) — how the FCM relay would implement this contract
- [../realtime-socket.md](../realtime-socket.md) — the existing bespoke FCMHUD/1 push bridge
- [../two-way-chat-implemented.md](../two-way-chat-implemented.md) — M7 in-game send over FCMHUD/1
