# Presence & Sessions

This document covers desktop WebSocket presence and identity, reviewed against local source on
2026-09-12. The retired desktop world-detection/endpoint attach flow remains removed. Optional
[FCMServerBridge 0.1.0](../overlay/zfe/background-server-bridge.md) now uses a separate invisible
HUDModLoader child and native roster controls to authorize desktop Server chat. Its independent
account/device lease is implemented locally; hosted deployment and runtime acceptance are pending.

---

## In-Memory Client Registry

The `clients` Map in `handlers.ts` owns authenticated desktop/chat sockets on this backend
instance. It is keyed by **session token**; separate tokens can connect the same account, while
a newer connection using the same token supersedes the old socket. Admin observers and native
HUD subscriptions have separate registries. Community online counts combine the transports
through `onlinePresenceService`.

```ts
const clients = new Map<string, ClientEntry>();
```

Source: [handlers.ts](../../backend/src/websocket/handlers.ts), `ClientEntry` and `clients`.

### ClientEntry fields

| Field | Type | Description |
|-------|------|-------------|
| `ws` | `WebSocket` | The socket |
| `userId` | `string` | Postgres user UUID |
| `username` | `string` | FO76 in-game name (or placeholder) |
| `displayName` | `string` | Resolved display name (see below) |
| `isMuted` | `boolean` | In-memory mute flag; auto-lifted on send if DB says expired |
| `bridge` | optional `BridgeConnection` | Private account/room state, serialized history/live delivery and lease checks |
| `worldSessionId` | optional `string\|null` | Retained compatibility field; not populated by the current connection path |
| `blockedIds` | `Set<string>` | UserIds this client has blocked; loaded on connect |
| `inGame` | `boolean` | Whether FO76 process is currently running (v1.4.0) |
| `role` | effective role | Resolved on connection for moderation/party observer behavior |

Endpoint candidates, nearby-player state and world-detection FSM flags are not current
`ClientEntry` fields. Process-running status alone does not establish world membership.

---

## Display Name Resolution

Priority order (highest wins):

1. `users.chat_name` when set (the free account chat name)
2. `users.username` if set and not a placeholder (`Wanderer`, `pending-*`, `Overlay<digits>`, `discord:*`)
3. `users.steamDisplayName` when nonempty
4. `users.discordDisplayName` (Discord display/global name)
5. `users.discordUsername` (Discord @handle)
6. Fallback: `"Wanderer"`

`handlers.ts:22–54` — `resolveDisplayName()`

No `#XXXX` discriminator is appended. Uniqueness is guaranteed by `UNIQUE` constraints on `users.username` and the Discord link.

---

## `refreshClientIdentity` — Live Name Update

When the overlay registers (or re-registers) a new FO76 in-game name, the register controller calls `refreshClientIdentity` to update every in-memory socket for that user **without requiring a reconnect**.

```ts
export function refreshClientIdentity(
  userId: string,
  username: string,
  discordUsername: string | null,
  discordDisplayName: string | null,
  installToken: string,
  chatName: string | null = null,
  steamDisplayName: string | null = null,
): number
```

After updating the **local instance's** `ClientEntry.username`/`displayName` fields it
broadcasts `user:identity_updated`, which `broadcast()` fans out to all instances via
Redis pub/sub so other overlays see the new name immediately.

Two limitations worth knowing, because this paragraph previously overstated the
guarantee:

- The pub/sub subscriber relays **frames, not state**. Remote instances update the
  rendered message history their clients hold, but their own `ClientEntry.username` /
  `displayName` fields are not refreshed — those are re-derived on reconnect. Today the
  backend runs single-instance (`dokploy-standby.yml` is a cold failover, not a second
  replica), so this is latent rather than live.
- The broadcast used to be gated on `touched > 0`, where `touched` counts local sockets
  only. That silently dropped the frame whenever the acting instance held no socket for
  the user — precisely the multi-instance case the pub/sub fan-out exists to serve. The
  gate has been removed; the frame is now emitted unconditionally.

The same frame also carries supporter cosmetics (`nameColor`, `effectId`, `tag`,
`badges`) via `refreshClientCosmetics()`, so a cosmetics change re-styles already
rendered history without a reconnect. See [Supporter cosmetics](../product/supporter-tier.md).

`handlers.ts:389–421`

---

## Redis Session Store

Session tokens are stored in Redis under `session:<token>` → userId string.

| Detail | Value |
|--------|-------|
| TTL | **24 hours** (`SESSION_TTL_SECONDS = 24 * 60 * 60`) |
| Written by | `POST /api/users/register` and `/api/users/login` |
| Read by | WS auth handshake (`handlers.ts:1479`) and `requireClientAuth` middleware |
| Deleted by | logout, ban, admin nuke |

`usersController.ts:20, 644`

On WS connect the backend does:
```ts
userId = await redis.get(`session:${token}`);
```
`handlers.ts:1480`

No token renewal on use — the 24h TTL is absolute from issuance, not a sliding window. The overlay silently re-registers via its install token on reconnect.

---

## Block Enforcement

Each `ClientEntry` carries a `blockedIds: Set<string>`. On connect this is populated from `blockService.getBlockedIds(userId)`. When a message is about to be delivered to a recipient, `recipientHasBlockedSender()` checks if the sender's userId is in the recipient's `blockedIds`. Blocked messages are silently dropped — the sender does not know they were blocked.

When a user adds or removes a block, `global.refreshClientBlocks(userId)` walks the `clients` Map and reloads the set from the service without a reconnect.

`handlers.ts:456–473, 740–749`

---

## World Session Identity (historical desktop behavior)

Older desktop versions used endpoints and later `world_sessions` UUIDs. That attach flow is
removed: the current WebSocket switch has no `server:join-manual`, `server:leave-manual`,
`world:joined` or `world:left` handler. `updateClientEndpoint` is a compatibility no-op.
`broadcastToSession` still exists but does not establish membership. Do not restore endpoint
scanning or treat the retained field/helpers as an active server-chat implementation.

The current `/api/player-list` compatibility route validates and caches submitted snapshots;
it does not assign a world session. The static channel-list response contains no virtual Server
tab. The native relay's Redis rooms are separate from these legacy database sessions.

### Stale Session Guard (connect-time)

The old two-minute database-world validation is not part of the current desktop connect path.
Native room expiry and confirmation are documented in
[SERVER session binding](../overlay/zfe/native-chat-relay/server-session-binding.md).
The background bridge validates its independent 45-second device/session lease on every
protected room operation; a retained database field or stale in-process room value is insufficient.
`bridge:watch` refreshes every ten seconds and supplies the local desktop Server tab. The static
channel tree and retired `worldSessionId` field are not used as room authorization.

---

## Presence Cleared Registry

`presenceClearedRegistry.ts` retains a 120-second in-memory guard utility from the retired
attach flow. Current `handlers.ts` and `routes/playerList.ts` do not call it. Its existence
does not provide leave protection to the native relay or the background bridge.

---

## WS Flap Grace Window (v1.1.37)

`WS_FLAP_GRACE_MS` (default 30 seconds) retains community presence briefly after the account's
last overlay socket closes. A reconnect cancels the pending expiry; superseded sockets cannot
remove their replacements. The retained handoff helper accepts endpoints, but both current
connect/close paths supply `null` and the old server peer-leave callback is empty.

The ordinary `room:leave` frame is emitted immediately on a non-forced close; it is not the
retired deferred server-room announcement. There is no current 45-second `serverSeenAt` check.

---

## In-Game Status & Presence

`inGame` (default `false`) is set via `client:status` frames whenever FO76 starts or stops. Only users with at least one socket that has `inGame: true` count as "online" for party member counts and online-dot indicators. WS-connected alone is not sufficient.

`handlers.ts:1290–1316`

```ts
export function isUserInGame(userId: string): boolean {
  for (const c of clients.values()) {
    if (c.userId === userId && c.ws.readyState === WebSocket.OPEN && c.inGame === true) {
      return true;
    }
  }
  return false;
}
```

`handlers.ts:1290–1297`
