# Presence & Sessions

This document covers how the backend tracks connected clients, resolves display names, and manages world session membership.

---

## In-Memory Client Registry

The `clients` Map in `handlers.ts` is the authoritative source for all live WS state. It is keyed by **session token** (not userId) to support multiple simultaneous connections for the same user (multi-tab, overlay + dashboard).

```ts
const clients = new Map<string, ClientEntry>();
```

`handlers.ts:328`

### ClientEntry fields

| Field | Type | Description |
|-------|------|-------------|
| `ws` | `WebSocket` | The socket |
| `userId` | `string` | Postgres user UUID |
| `username` | `string` | FO76 in-game name (or placeholder) |
| `displayName` | `string` | Resolved display name (see below) |
| `isMuted` | `boolean` | In-memory mute flag; auto-lifted on send if DB says expired |
| `serverEndpoint` | `string\|null` | Current world server endpoint (e.g. `tcp:1.2.3.4:3001`) |
| `alternateEndpoints` | `string[]` | Additional endpoint candidates from memory scanner |
| `nearbyPlayers` | `string[]` | Last FO76 mod roster snapshot |
| `nearbyPlayersAt` | `Date\|null` | When `nearbyPlayers` was last written |
| `worldSessionId` | `string\|null` | UUID of the active `world_sessions` row (primary routing key, v1.1.56+) |
| `blockedIds` | `Set<string>` | UserIds this client has blocked; loaded on connect |
| `inGame` | `boolean` | Whether FO76 process is currently running (v1.4.0) |
| `manualMode` | `boolean` | User opted out of FSM auto-attach |
| `manualLeaveActive` | `boolean` | User clicked Leave Server; blocks re-attach until Join Server |
| `fsmEverSeen` | `boolean` | True once any world FSM frame was processed |
| `fsmInWorld` | `boolean\|undefined` | Latest FSM in-world state (true=in world, false=at menu) |

`handlers.ts:238–306`

---

## Display Name Resolution

Priority order (highest wins):

1. `users.chat_name` when set (the free account chat name)
2. `users.username` if set and not a placeholder (`Wanderer`, `pending-*`, `Overlay<digits>`, `discord:*`)
3. `users.discordDisplayName` (Discord display/global name, e.g. "Devotek")
4. `users.discordUsername` (Discord @handle, e.g. "devotek")
5. Fallback: `"Wanderer"`

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

## World Session Identity (v1.1.56+)

Before v1.1.56, same-server grouping was driven by string-matching on `serverEndpoint`. This was replaced with a backend-minted UUID (`worldSessionId`) stored in the `world_sessions` table. Same-server membership is now a simple FK equality check.

```ts
// v1.1.56 lock-in: broadcast via session id when available.
if (senderSessionId) {
  deliveredCount = await broadcastToSession(broadcastPayload, senderSessionId, null);
}
```

`handlers.ts:2116–2123`

The `worldSessionId` is:
- Loaded from `users.worldSessionId` on WS connect (stale sessions >2 min idle are cleared)
- Updated by `server:join-manual` and `server:leave-manual` handlers
- Synced via `setClientWorldSessionId(userId, sessionId)` from player-list POST hooks

`handlers.ts:589–594, 1551–1591`

### Stale Session Guard (connect-time)

On every reconnect, if the user's DB row has a `worldSessionId`, the backend validates it:
- Session row must exist and have no `endedAt`
- `lastActivityAt` must be within **2 minutes** (player-list POST cadence is ~10s)

If stale, the backend null-clears `worldSessionId`, `serverEndpoint`, and all related fields before hydrating the in-memory entry. This prevents users from re-joining a stale Server tab after closing FO76.

`handlers.ts:1551–1591`

---

## Presence Cleared Registry

`presenceClearedRegistry.ts` tracks users who recently had their server presence explicitly cleared (via Leave Server or world:left). It gates subsequent player-list POST writes for a **120-second TTL** so stale `nearbyPlayers` data can't re-arm name-overlap grouping and silently re-create a Server tab the user just left.

```ts
markRecentlyCleared(userId)   // called on Leave Server
isRecentlyCleared(userId)     // checked in playerList.ts before nearbyPlayers write
clearRecentlyCleared(userId)  // called on Join Server (explicit refresh)
```

`presenceClearedRegistry.ts:26–52`

---

## WS Flap Grace Window (v1.1.37)

To suppress false "X left server chat" / "X joined server chat" messages during brief WS drops (e.g. backend deploy, short network blip), the backend defers the peer-leave announcement by `WS_FLAP_GRACE_MS` (default 30 s) using the `pendingDisconnect` Map.

If the same user reconnects on the **same endpoint** within the window, the leave and `clearJoinDedupKeys` are both cancelled. If the user reconnects on a **different endpoint**, the old-endpoint leave fires immediately (it was a real transition).

Additionally, if the user's `serverSeenAt` (bumped by player-list POSTs) is within 45 s of the WS drop, the peer-leave is suppressed — the FO76 client is still active even though the overlay's WS socket dropped.

`handlers.ts:330–388, 3304–3418`

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
