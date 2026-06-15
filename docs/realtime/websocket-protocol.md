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

Broadcast loops (`localBroadcast`, `broadcastToPartyMembers`, `broadcastToSession`) check each socket's `bufferedAmount` before sending. If `bufferedAmount` exceeds `WS_MAX_BUFFERED_BYTES` (5 MB) the frame is skipped for that socket and a warning is logged. This prevents the Node.js event loop from stalling on a slow or stuck client.

---

## Cross-Instance Delivery (Redis Pub/Sub)

The backend can run as multiple instances behind a load balancer. Broadcasts use Redis pub/sub channel `chat:broadcast` with the following envelope scopes:

| Scope | When used | Delivery key |
|-------|-----------|--------------|
| *(none)* | Global channel chat | all local clients |
| `scope:'party'` | Party chat messages | `memberUserIds` array |
| `scope:'session'` | Server/world-session chat | `sessionId` UUID |

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
Send a message to a channel. `channelId` is either a UUID (regular channel) or `server:<endpoint-or-UUID>` (virtual server channel). Optional `mentions` array maps display names to Discord IDs for the Discord relay. Optional `metadata` object is persisted (JSONB) and echoed back on `chat:message` / `chat:history` — used for rich cards (e.g. `{ "type": "wiki_share", "wikiTitle": "...", "name": "...", "kind": "..." }`, which the overlay renders as a glowing in-overlay link that opens the entry in the WikiPanel).
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
    "avatarUrl": "https://cdn.discordapp.com/...",
    "metadata": null
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
Response uses the same `type: 'chat:history'` with `payload.messages` (array, chronological). Limit is capped at 300, offset at 10000.

For server channels (`server:<UUID>`): user must be a member of that session; history is bounded to the session's `createdAt`. `handlers.ts:2510–2688`

### `chat:typing` (C→S, S→C broadcast)
Ephemeral typing indicator. Never persisted. Clients should send at most once every 2 s. Server broadcasts to all other clients (for channel typing) or party members only (for party typing).
```json
{
  "type": "chat:typing",
  "payload": {
    "channelId": "00000000-0000-0000-0000-000000000001",
    "username": "Devotek",
    "userId": "<uuid>"
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

## Admin / Telemetry

### `telemetry:set` (S→C)
Pushed on connect and when an admin toggles the telemetry flag.
```json
{
  "type": "telemetry:set",
  "payload": { "enabled": true }
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

### `release:published` (S→C broadcast)
Sent by `POST /admin/releases`. Triggers the Electron auto-updater to check for a new version.
```json
{
  "type": "release:published",
  "payload": { "version": "1.3.82", "downloadUrl": "https://...", "releaseNotes": "..." }
}
```

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
