# WebSocket Protocol — Message Type Catalog

All frames are JSON objects with a `type` string and a `payload` object. Direction is from the perspective of a game client (Electron overlay).

**Legend:** C→S = client sends, S→C = server sends, S↔C = either direction

---

## Admin Observer Connections (`/auth/ws-ticket`)

The `/auth/ws-ticket` REST endpoint issues a 60-second single-use token that upgrades a WebSocket connection at `/ws?ticket=<token>` to an admin-observer socket.

**Role gate:** Only sessions with role `owner`, `admin`, or `moderator` (i.e. `isPrivilegedRole()` returns true) may obtain a ticket. Non-staff members receive HTTP 403. The ticket JSON stored in Redis carries the role and is re-validated inside `handleAdminObserver` as defense in depth — a ticket issued before a role downgrade is rejected at upgrade time.

**Ticket JSON shape stored in Redis:**
```json
{ "type": "admin", "discordId": "...", "username": "...", "role": "moderator" }
```

---

## Backpressure

Broadcast loops (`localBroadcast`, `broadcastToPartyMembers`, `broadcastToSession`, `broadcastToUsers`) check each socket's `bufferedAmount` before sending. If `bufferedAmount` exceeds `WS_MAX_BUFFERED_BYTES` (5 MB) the frame is skipped for that socket and a warning is logged. This prevents the Node.js event loop from stalling on a slow or stuck client.

---

## Cross-Instance Delivery (Redis Pub/Sub)

The backend can run as multiple instances behind a load balancer. Broadcasts use Redis pub/sub channel `chat:broadcast` with the following envelope scopes:

| Scope | When used | Delivery key |
|-------|-----------|--------------|
| *(none)* | Global channel chat | all local clients |
| `scope:'party'` | Party chat messages | `memberUserIds` array |
| `scope:'session'` | Server/world-session chat | `sessionId` UUID |
| `scope:'users'` | Private-message delivery / read receipts | `userIds` array |

Each instance ignores envelopes where `instanceId` matches its own `INSTANCE_ID` (echo suppression). If Redis is unavailable at startup, `initPubSub` retries automatically every 30 s — multi-instance delivery degrades gracefully rather than staying permanently disabled.

**Note:** Presence state (who is connected to which instance) is in-memory per instance. Multi-instance deployments that need accurate cross-instance presence (e.g. `isUserConnected()`) require either Redis-backed presence or sticky sessions at the load balancer.

---

## Deprecated Aliases (one-release compat)

| Old name | New name |
|----------|----------|
| `send-message` | `chat:send` |
| `load-history` | `chat:history` |
| `user-join` | `room:join` |

`handlers.ts:1773–1778`

---

## Connection / Presence

### `ping` (C→S)
No payload. Server replies with `pong`.

### `pong` (S→C)
Response to `ping`. Payload `{}`.

### `room:join` (S→C broadcast)
Sent to all other clients when a user connects.
```json
{
  "type": "room:join",
  "payload": {
    "username": "Devotek",
    "timestamp": "2026-06-04T12:00:00.000Z"
  }
}
```
`handlers.ts:1699`

### Connection supersession (token-keyed `clients` map)

The `clients` map is keyed by **session token**, and the desktop overlay reconnects with the **same token** across WS flaps (the relay proxy reuses `sessionToken` until a re-register). During a reconnect flap two sockets can briefly coexist for one token: a fresh socket has already run `clients.set(token, NEW)` while the old socket is still settling.

The close / error / heartbeat handlers therefore guard every `clients.delete(token)` with `isSocketSuperseded(clients.get(token)?.ws, ws)` (`websocket/socketSupersession.ts`, unit-tested). A **superseded** stale socket tears down **quietly** — it does NOT delete the (newer) map entry and does NOT fire `room:leave` / schedule a peer-leave. Without this guard, a stale socket's close evicted the **live** socket from the map, after which no broadcasts or presence reached the user — the chat went blank and new messages stopped arriving until the next reconnect (root cause of the in-game "blank chat after auto-hide / return-to-game" reports). The per-IP connection counter is still decremented independently by `server.ts`'s own `ws.on('close')`.

> The repeated socket *drops* that trigger the flap are transport-level (e.g. a `1006` abnormal close from a Cloudflare idle timeout / NIC sleep / AV). The overlay's `onclose` now logs `code=<n> reason="…"` to make the next occurrence diagnosable.

### `room:leave` (S→C broadcast)
Sent to all clients when a user disconnects (after `WS_FLAP_GRACE_MS`). Suppressed for superseded stale sockets (see above).
```json
{
  "type": "room:leave",
  "payload": {
    "username": "Devotek",
    "timestamp": "2026-06-04T12:00:00.000Z"
  }
}
```
`handlers.ts:3309`

### `presence:state` (S→C, on connect)
Server-authoritative snapshot of the connecting user's DB state. Sent immediately on connect; used by the overlay to reconcile any drift during disconnection.
```json
{
  "type": "presence:state",
  "payload": {
    "userId": "<uuid>",
    "role": "user",
    "serverEndpoint": "tcp:1.2.3.4:3001",
    "alternateEndpoints": [],
    "serverJoinedAt": "2026-06-04T11:00:00.000Z",
    "endpointInferred": false
  }
}
```
`handlers.ts:1661–1671`

### `client:status` (C→S)
Reports fullscreen mode and whether FO76 is currently running. The `inGame` flag gates "online" presence — WS-connected but `inGame: false` = OFFLINE for party online counts.
```json
{
  "type": "client:status",
  "payload": {
    "fullscreen": false,
    "inGame": true
  }
}
```
`handlers.ts:2690–2706`

---

## Chat Messages

### `chat:send` (C→S)
Send a message to a channel. `channelId` is either a UUID (regular channel) or `server:<endpoint-or-UUID>` (virtual server channel). Optional `mentions` array maps display names to Discord IDs for the Discord relay. Optional `metadata` object is persisted (JSONB) and echoed back on `chat:message` / `chat:history` — used for rich cards (e.g. `{ "type": "wiki_share", "wikiTitle": "...", "name": "...", "kind": "..." }`, which the overlay renders as a glowing in-overlay link that opens the entry in the WikiPanel). Card-share metadata includes the command and attribution fields, for example `{ "type": "card_share", "command": "/minerva", "label": "Minerva's Big Sale", "sourceName": "Fallout Builds", "sourceUrl": "https://www.falloutbuilds.com/fo76/minerva" }`.
```json
{
  "type": "chat:send",
  "payload": {
    "channelId": "00000000-0000-0000-0000-000000000001",
    "content": "Hello wasteland",
    "clientCreatedAt": "2026-06-04T12:00:00.000Z",
    "mentions": [
      { "name": "Devotek", "discordId": "1234567890123456789" }
    ],
    "metadata": { "type": "wiki_share", "wikiTitle": "The Fixer", "name": "The Fixer", "kind": "weapon" }
  }
}
```

Validation rules:
- `content` max 500 characters
- `clientCreatedAt` must be within ±5 minutes of server time
- `channelId` must be a UUID or start with `server:`
- `metadata` capped at 2 KB serialized (oversized → dropped to `null`); rendered as plain text nodes client-side (no HTML injection)
- Shared-card title actions re-run only supported card commands (`/nukecodes`, `/serverstatus`, `/camp`, `/minerva`) against the clicked message's `channelId`. This preserves delivery in aggregate feeds where the selected parent channel differs from the message's child channel.
- Rate-limited to 5 msg/s

`handlers.ts:1836–2461`

### `chat:message` (S→C broadcast)
Broadcast to all clients (or session members for server-channel messages) when a message is accepted.
```json
{
  "type": "chat:message",
  "payload": {
    "id": "<uuid>",
    "content": "Hello wasteland",
    "username": "Devotek",
    "userId": "<uuid>",
    "channelId": "00000000-0000-0000-0000-000000000001",
    "source": "game",
    "timestamp": "2026-06-04T12:00:00.000Z",
    "editedAt": null,
    "avatarUrl": "https://cdn.discordapp.com/...",
    "metadata": null,
    "nameColor": "#57DBDB",
    "effectId": "glow-soft",
    "tag": null,
    "badges": ["supporter"]
  }
}
```

`source` values:

| Value | Origin |
|-------|--------|
| `game` | Electron overlay client |
| `web` | Web dashboard / admin observer |
| `server` | Virtual server (same-world) channel |
| `bot` | `[Vault-Tec]` system message |
| `party` | Party-scoped message |
| `discord` | Relayed from Discord |

`handlers.ts:2417–2429`

### `chat:edit` (C→S request)
Edit a message authored by the authenticated user. The client sends `source: "pm"` with
`conversationId` for private messages, `source: "party"` with the party UUID in `channelId`
for party messages, or the original source plus a regular channel UUID for channel messages.
The server verifies ownership (and party/conversation access), rejects deleted/system/server
messages, reruns AutoMod, and records `edited_at` before broadcasting the patch.

```json
{
  "type": "chat:edit",
  "payload": {
    "messageId": "<uuid>",
    "content": "corrected text",
    "source": "game",
    "channelId": "<channel-uuid>"
  }
}
```

Successful edits are broadcast as `chat:edit` with `messageId`, normalized `content`,
`editedAt`, and the source-specific routing fields. The sender also receives
`message:edit:ack` with the same payload. Invalid, unauthorized, muted, rate-limited, or
AutoMod-blocked edits return the standard `error` frame.

For bridged public channel messages, the server also retains the Discord message
snowflake. An edit made in the overlay mirrors to the bot-authored Discord copy.
An edit made to a human-authored Discord message updates the linked overlay row
and emits the same `chat:edit` broadcast. The bot cannot edit a Discord user's
original message, so overlay edits of Discord-origin messages remain local.

Bot messages (source `bot`, userId `system`, username `[Vault-Tec]`) are never block-filtered. `handlers.ts:742–749`

### `message:ack` (S→C)
Sent back to the sender after each accepted message.
```json
{
  "type": "message:ack",
  "payload": {
    "messageId": "<uuid>",
    "rateRemaining": 2,
    "peerCount": 3,
    "channelKind": "server"
  }
}
```
`peerCount` is only present for server-channel messages (v1.1.59). `channelKind` is `"server"` for virtual server messages. `handlers.ts:2216–2219`

### `chat:history` (C→S request, S→C response)
Request historical messages for a channel.
```json
{
  "type": "chat:history",
  "payload": {
    "channelId": "00000000-0000-0000-0000-000000000001",
    "limit": 300,
    "offset": 0
  }
}
```
Response uses the same `type: 'chat:history'` with `payload.messages` (array, chronological). Limit is capped at 300, offset at 10000. Each row is decorated with the author's **current** resolved `nameColor`, `effectId`, `tag`, and `badges`, just like a live `chat:message`; cosmetics are not frozen into the message row, so changing an appearance remains visible after a tab/history reload.

For server channels (`server:<UUID>`): user must be a member of that session; history is bounded to the session's `createdAt`. `handlers.ts:2510–2688`

### `chat:typing` (C→S, S→C broadcast)
Ephemeral typing indicator. Never persisted. Clients should send at most once every 2 s. Server broadcasts to all other clients (for channel typing) or party members only (for party typing). Discord `typingStart` events for mapped relay channels use the same frame and add `source: "discord"`; this field is omitted from client-originated frames. The overlay automatically expires the indicator after four seconds because Discord has no typing-stopped event.
```json
{
  "type": "chat:typing",
  "payload": {
    "channelId": "00000000-0000-0000-0000-000000000001",
    "username": "Devotek",
    "userId": "<uuid>",
    "source": "discord"
  }
}
```
Party variant uses `partyId` instead of `channelId`. `handlers.ts:2463–2508`

### `chat:delete` (S→C broadcast)
Sent when a moderator soft-deletes a message.
```json
{
  "type": "chat:delete",
  "payload": { "messageId": "<uuid>" }
}
```
`handlers.ts:1204–1206`

---

## Private Messages

Private messages use their own tables (`private_conversations`, `private_messages`) and their own WebSocket frames. They are delivered only to the sender and recipient, are never relayed to Discord, and never appear in public channel feeds, party feeds, or public website mode.

### `pm:list` (C→S request, S→C response)

Requests the caller's private-message inbox. The server responds with `payload.conversations`, sorted by most recent `last_message_at`.

```json
{
  "type": "pm:list",
  "payload": {
    "conversations": [
      {
        "conversationId": "<uuid>",
        "otherUserId": "<uuid>",
        "otherDisplayName": "Stealthmog",
        "lastMessagePreview": "meet at whitespring?",
        "lastMessageSenderId": "<uuid>",
        "lastMessageAt": "2026-06-25T15:53:00.000Z",
        "unreadCount": 2
      }
    ]
  }
}
```

`lastMessageSenderId` is the user id of the most recent non-deleted private message in the conversation, or `null` when the conversation exists but has no messages yet.

The server returns at most 50 inbox rows, ordered by most recent activity. Unread counts are
computed in one database aggregate using each participant's read watermark; clients must not
assume that an omitted conversation is deleted.

`pm:open` reuses the same response frame and adds `openedConversationId` when the server creates or finds the target conversation.

### `pm:open` (C→S)

Creates or returns the sorted-pair conversation for the caller and `targetUserId`.

```json
{
  "type": "pm:open",
  "payload": { "targetUserId": "<uuid>" }
}
```

### `pm:history` (C→S request, S→C response)

Loads one private conversation's history. Only participants may request it.

```json
{
  "type": "pm:history",
  "payload": {
    "conversationId": "<uuid>",
    "limit": 100,
    "offset": 0
  }
}
```

Response:

```json
{
  "type": "pm:history",
  "payload": {
    "conversationId": "<uuid>",
    "messages": [
      {
        "id": "<uuid>",
        "conversationId": "<uuid>",
        "senderId": "<uuid>",
        "senderName": "Stealthmog",
        "recipientId": "<uuid>",
        "content": "meet at whitespring?",
        "createdAt": "2026-06-25T15:52:00.000Z",
        "editedAt": null
      }
    ]
  }
}
```

### `pm:send` (C→S)

Sends a private message to exactly one recipient. Enforcement matches channel chat where applicable: authenticated users only, no self-PM, blocked pairs rejected with the generic error `Message unavailable.`, mute checks, rate limits, participant-only access, automod, and a 255-character content limit.

```json
{
  "type": "pm:send",
  "payload": {
    "conversationId": "<uuid>",
    "recipientUserId": "<uuid>",
    "content": "meet at whitespring?",
    "clientCreatedAt": "2026-06-25T15:10:00.000Z"
  }
}
```

### `pm:message` (S→C)

Delivered only to the sender and recipient.

```json
{
  "type": "pm:message",
  "payload": {
    "id": "<uuid>",
    "conversationId": "<uuid>",
    "senderId": "<uuid>",
    "senderName": "Stealthmog",
    "recipientId": "<uuid>",
    "content": "meet at whitespring?",
    "createdAt": "2026-06-25T15:10:00.000Z",
    "editedAt": null
  }
}
```

### `pm:read` (C→S and S→C)

Marks the caller's read watermark for one conversation. The server echoes a `pm:read` frame to the caller's sockets so multiple overlay windows/tabs keep the unread badge in sync.

```json
{
  "type": "pm:read",
  "payload": {
    "conversationId": "<uuid>",
    "unreadCount": 0
  }
}
```

---

## Party Chat

### `party:send` (C→S)
Send a message to a party. User must be a member. Requires `PARTIES_ENABLED` feature flag.
```json
{
  "type": "party:send",
  "payload": {
    "partyId": "<uuid>",
    "content": "Let's raid the vault",
    "clientCreatedAt": "2026-06-04T12:00:00.000Z"
  }
}
```
`handlers.ts:3088–3218`

#### Moderator fan-out (`_modObserver`)

After broadcasting to party members, the server performs a second pass over all connected clients. Any connected client whose stored role is `owner`, `admin`, or `moderator` and who is **not** a member of the party receives the identical `chat:message` frame with `_modObserver: true` inside **`payload`** (not at the frame top level):

```json
{
  "type": "chat:message",
  "payload": {
    "_modObserver": true,
    "id": "...",
    "channelId": "<partyId>",
    "source": "party",
    "content": "...",
    ...
  }
}
```

Key guarantees:
- **Members** receive the frame **without** `_modObserver` in payload (unchanged behaviour).
- **Privileged members** receive the frame once via the member path, without `_modObserver` — the member path takes precedence, preventing double delivery.
- Observer delivery is **server-enforced** — the client must never be trusted to request or gate observer access.
- Block logic applies on the member path only; mod observers always receive the message regardless of block relationships.
- Cross-instance correctness: each backend instance fans out to its own privileged sockets after the Redis pub/sub party-scope delivery, so no privileged client is missed on a multi-instance deployment.
- Privileged observers are **never** added to `party_members`, never appear in `party:member-update` frames, and never in `GET /api/parties/:id/members`.

The role stored on the `ClientEntry` is resolved at connect-time via `getEffectiveRole()` (Redis-cached) and defaults to `'user'` on any resolution failure (fail-safe, never defaults to a privileged role).

### `party:history` (C→S request)
Request historical party messages. Same response shape as `chat:history` with `channelId` = partyId. `handlers.ts:3221–3284`

---

## Server (World Session) Channel

### `server:leave-manual` (C→S)
User clicked "Leave Server" in the overlay. Detaches from current world session, clears server endpoint state. Sets `manualLeaveActive` to block FSM re-attach.

No payload required. Responses:
- `server:leave-manual:ack` `{ ok: true }` on success
- `server:leave-manual:ack` `{ ok: false, reason: 'rate-limit' }` if rate-limited
- `channels:refresh` is also pushed to trigger UI update

`handlers.ts:2717–2848`

### `server:join-manual` (C→S)
User clicked "Join Server" or "Refresh". Clears `manualLeaveActive`, calls `joinOrMintSession`, and pushes `channels:refresh`. Optional `endpointHint` is validated against server-side state before use (must match in-memory or DB endpoint).
```json
{
  "type": "server:join-manual",
  "payload": {
    "endpointHint": "tcp:1.2.3.4:3001"
  }
}
```
Response: `server:join-manual:ack` `{ ok: boolean, sessionId?, minted?, reason? }` plus `channels:refresh`. `handlers.ts:2851–3071`

### `server:leave-manual:ack` / `server:join-manual:ack` (S→C)
Acknowledgement frames for the manual join/leave actions.

### `channels:refresh` (S→C)
Tells the overlay to re-fetch its channel list (e.g. after joining/leaving a server session or a block add/remove). Payload `{}`. `handlers.ts:2813`

### `presence:members` (S→C)
Sent to peers when a member joins or leaves a session, prompting a member-list refresh. Payload `{}`. `handlers.ts:2824`

---

## Client Configuration

### `client:set-manual-mode` (C→S)
Opt out of FSM auto-detect. When `enabled: true`, all auto-attach paths are suppressed; Join/Leave Server buttons remain functional.
```json
{
  "type": "client:set-manual-mode",
  "payload": { "enabled": true }
}
```
`handlers.ts:3074–3083`

---

## Moderation (Overlay → Server)

These frames are only accepted from clients whose effective role is `moderator`, `admin`, or `owner`.

### `mod:kick` (C→S)
```json
{
  "type": "mod:kick",
  "payload": { "userId": "<uuid>", "reason": "Spam" }
}
```

### `mod:mute` (C→S)
```json
{
  "type": "mod:mute",
  "payload": {
    "userId": "<uuid>",
    "durationMinutes": 60,
    "category": "Harassment",
    "reason": "repeated insults"
  }
}
```
Max duration: 30 days (43200 minutes).

### `mod:unmute` (C→S)
```json
{
  "type": "mod:unmute",
  "payload": { "userId": "<uuid>" }
}
```

`handlers.ts:1791–1834`

---

## User State Events (S→C)

### `user:muted`
Pushed on connect (if muted) and on any mute action. Greys out the chat input in the overlay.
```json
{
  "type": "user:muted",
  "payload": {
    "until": "2026-06-04T13:00:00.000Z",
    "reason": "Repeated spam",
    "category": "Spam"
  }
}
```

### `user:unmuted`
Pushed when a mute is lifted.

### `user:identity_updated`
Broadcast to all instances when a user's display name changes (e.g. after registering an FO76 in-game name). Connected overlays update their name cache in real time without reconnecting.
```json
{
  "type": "user:identity_updated",
  "payload": {
    "userId": "<uuid>",
    "username": "VaultDweller76",
    "displayName": "VaultDweller76"
  }
}
```
`handlers.ts:411–421`

---

## Telemetry kill-switch (deprecated)

### `telemetry:set` (S→C) — deprecated kill-switch
Emitted once on connect. Telemetry was removed; this event is a permanent kill-switch and is never toggled. The payload is always `{ "enabled": false }`.
```json
{
  "type": "telemetry:set",
  "payload": { "enabled": false }
}
```
`handlers.ts:1690–1696`

### `report:new` (S→C, admin observers only)
Delivered to admin observer sockets when a `/report` or `/bug` command is submitted.
```json
{
  "type": "report:new",
  "payload": {
    "id": "<uuid>",
    "reportType": "player",
    "content": "/report PlayerName griefing",
    "username": "Devotek",
    "userId": "<uuid>",
    "createdAt": "2026-06-04T12:00:00.000Z"
  }
}
```

### `channel:update` (S→C broadcast)
Sent when a channel is archived or updated (admin REST action).
```json
{
  "type": "channel:update",
  "payload": { "action": "archive", "channel": { "id": "...", ... } }
}
```

### `commands:updated` (S→C broadcast)
Sent when the admin updates the slash-command list.
```json
{
  "type": "commands:updated",
  "payload": { "commands": [ ... ] }
}
```

### `app:update-available` (S→C, sent on WS connect)
Sent by the backend to each client immediately after the WS connection handshake (alongside
`presence:state`). The payload carries the latest published version from the server's
in-memory cache, initialized at boot and refreshed by `POST /admin/releases`.

The client compares `latestVersion` against its own build version (`APP_VERSION`). If the
server version is newer, the overlay shows a **passive OS notification** (Windows toast /
Linux libnotify / macOS) with a click handler that opens the Nexus Mods page for a manual
download. The overlay **downloads and installs nothing**.

This is a connect-time handshake message, not a broadcast. A once-per-app-session guard in
the client suppresses duplicate toasts on reconnects within the same session.

```json
{
  "type": "app:update-available",
  "payload": { "latestVersion": "1.3.90" }
}
```

**Nexus ToS compliance note:** the latest version rides over the existing chat WebSocket
(the crucial connection). No dedicated update network call is made by the binary.

### `mod:report` (S→C broadcast)
Broadcast when a report is filed (mirrors `report:new` for legacy admin panel consumers).

---

## Error Frame

```json
{
  "type": "error",
  "payload": { "message": "You are not on this server." }
}
```

### `rate:status`
Accompanies an `error` frame when the message rate limit is exceeded.
```json
{
  "type": "rate:status",
  "payload": { "remaining": 0, "retryAfterMs": 1000 }
}
```

---

## Giveaway Events

### `giveaway:update` (S→C broadcast)

Sent to all connected clients whenever the entry count or status of a giveaway changes (on join,
leave, cancel, or draw). Clients use this to update live entry counts and button state on
giveaway announcement cards without re-fetching.

```json
{
  "type": "giveaway:update",
  "payload": {
    "giveawayId": "<uuid>",
    "shortId": "A1B2C3",
    "entryCount": 7,
    "status": "active"
  }
}
```

`status` values: `"active"` | `"cancelled"` | `"completed"`.

Giveaway announcements and winner results arrive as standard `chat:message` frames from source
`"bot"` with a structured `metadata` field:

**Announcement** (`metadata.type = "giveaway"`):
```json
{
  "type": "giveaway",
  "giveawayId": "<uuid>",
  "shortId": "A1B2C3",
  "itemName": "Ultracite Flux x10",
  "creatorName": "Devotek",
  "endsAt": "2026-06-19T14:35:00Z",
  "durationMin": 5,
  "entryCount": 0
}
```

**Winner / end result** (`metadata.type = "giveaway_winner"`):
```json
{
  "type": "giveaway_winner",
  "giveawayId": "<uuid>",
  "shortId": "A1B2C3",
  "itemName": "Ultracite Flux x10",
  "winnerName": "Wastelander76",
  "entryCount": 12,
  "cancelled": false
}
```

`winnerName` is `null` when the giveaway ended with no entries. `cancelled: true` when stopped early.

## ZFE wire repair (in-game HUD clients)

ZFE 0.9.12–0.12.1 corrupt every **string value a mod passes through `chat.v1.*`**: each
character is emitted followed by the literal text `u0000` — the escape for the 0x00 high byte of
the UTF-16 code unit, with the backslash lost. ZFE's own values (relay token, cursors) are clean,
and ZFE parses the mod's JSON envelope correctly, so only the extracted values are damaged.

Proven on dev 2026-08-06 with widget v2.9.8: the widget logged `displayName=Abderaan` (8 clean
ASCII characters) and the relay stored `Au0000bu0000du0000eu0000ru0000au0000au0000n` (43). The
same transform hits `channel`, so `global` arrived as `gu0000lu0000ou0000bu0000au0000lu0000`,
failed `ALL_SLUGS.includes(slug)`, and **every in-game send was rejected `invalid_channel`**. The
`server` slug was mangled identically, so the world/roster control intercept never fired and
SERVER chat could never bind.

The widget cannot work around this — a clean string goes in and a mangled one comes out — so the
relay repairs it on receipt. `readWireString()`
([`wireSanitize.ts`](../../backend/src/services/relay/wireSanitize.ts)) is applied to the
mod-supplied `channel`, `body`, and `displayName` frame fields.

**It only repairs a string mangled end to end** (every character padded, final character bare).
Ordinary text that merely contains `u0000` is returned untouched, so message bodies are never
silently rewritten. Remove this once ZFE ships a fix *and* the affected builds are out of
circulation.
