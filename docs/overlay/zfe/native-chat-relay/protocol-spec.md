# ZFE Native Chat Relay Protocol (`chat.v1`) — Upstream Contract

> **Status: SHIPPED in ZFE 0.9.8 (2026-06-23).** This is the relay contract ZFE's native chat client
> implements — **verified directly from the `dxgi.dll` binary** (the `zfe-chat-v1` capability, the
> `register`/`hello`/`send`/`poll`/`subscribe`/`report`/`moderationAction` ops, the error codes, the
> channel vocab, and the `chat.message` event schema are all present). Reproduced here
> verbatim-in-substance as the canonical reference. FCM's relay implements R1–R3 + worldId — see
> [fcm-integration.md](fcm-integration.md) for the integration status (epic #282).
>
> **Status (2026-06-26): end-to-end send works on native Windows (ZFE 0.9.9+).** The `chat.v1.send`
> path is verified in-game against the FCM relay on **native Windows**. The 0.9.8 `dispatch_failed`
> on `sendMessage` was an upstream ZFE bug fixed in **0.9.9**. **Proton/Wine is blocked** by an
> upstream Zig TLS bug (fix = ZFE on Zig ≥ 0.14.0; #326). See [ZFE version history](#zfe-version-history)
> and [Transport / TLS](#transport--tls-chatv1-is-not-schannel) below.
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

---

## Transport / TLS — chat.v1 is NOT Schannel

chat.v1 uses its **own Zig TLS client** plus a **PEM CA bundle**, on every platform. The
`Schannel/Winsock` line in older ZFE logs refers to the **legacy Text Chat** transport (SFE
compat), **not** chat.v1 — corrected in ZFE 0.9.11's logging.

**Proton/Wine (Linux/Steam Deck) is BLOCKED — upstream.** `chat.v1.connect` panics the game during
the TLS handshake: Zig `std.crypto.tls.Client.readvAdvanced` has an out-of-bounds `@memcpy` on
**partial socket reads**, fixed by Zig 0.14.0. Wine read fragmentation + Cloudflare TLS 1.3 record
padding make it deterministic under Proton (only intermittent on native Windows). ZFE 0.9.11 logging
confirms the host CA bundle loads fine (`certs=149`) before the crash, so the CA bundle is not the
cause. **Fix = ZFE rebuilt on Zig ≥ 0.14.0**; there is no client-side workaround (plaintext `ws://`
loopback is refused, and a local `wss://` proxy still drives ZFE's buggy Zig TLS client). Tracked in
**#326**. Linux / Steam-Deck users use the native desktop overlay meanwhile.

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
  "displayName": "CharacterName",
  "roles": ["user"],
  "permissions": {
    "canReport": true,
    "canDeleteMessage": false,
    "canMuteUser": false,
    "canBanUser": false,
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
{ "success": true, "messageId": "msg_1" }
```

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

When `cursor` is `0`, the server **may** include an initial visible history window. The history
size is relay policy, not a ZFE rule — a relay can return no history, five messages, twenty
messages, or another bounded count. Returned events still use their **real relay cursors** so the
client can continue from the newest event it received.

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

> `subscribe` must **not** drain poll history. A client may reconnect with the last cursor and
> expect to receive only **newer** events.

### Report

```json
{ "op": "report", "token": "relay_token_secret", "messageId": "msg_1", "reason": "spam", "details": "" }
```

Response:

```json
{ "success": true, "status": "reported" }
```

### Moderation action

```json
{ "op": "moderationAction", "token": "moderator_token_secret", "action": "deleteMessage", "messageId": "msg_1", "targetUserId": "", "reason": "spam" }
```

Response:

```json
{ "success": true, "status": "submitted" }
```

Supported actions: `deleteMessage`, `muteUser`, `unmuteUser`, `banUser`, `unbanUser`, `setSlowMode`.

The **server is authoritative**. ZFE only **pre-checks** the permissions it received from auth
state so the UI can fail quickly.

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
