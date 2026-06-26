# Real-Time Layer — Overview

This document covers the raw WebSocket relay that powers live chat in Fallout Chat Mod. All real-time traffic between the Electron overlay (and the web dashboard) and the backend flows over a single authenticated WSS connection.

**Related docs:**
- [WebSocket Protocol](./websocket-protocol.md) — full message-type catalog
- [Presence & Sessions](./presence-and-sessions.md) — identity cache, heartbeat, Redis session store
- [HUD Push](./hud-push.md) — `/ws/hud` and TCP :4001; FCMHUD/1 line protocol for in-game live feed

---

## Typed Message Envelope

Every frame sent or received over the WebSocket uses this JSON shape:

```json
{
  "type": "chat:message",
  "payload": { ... }
}
```

There is no top-level `timestamp` or `userId` field on the envelope itself. Those fields appear **inside `payload`** on the messages that carry them (e.g. `chat:message` includes `timestamp` and `userId` inside `payload`).

`handlers.ts:238–306` — `ClientEntry` interface

---

## Connection Lifecycle

```mermaid
sequenceDiagram
    participant C as Client (overlay / dashboard)
    participant B as Backend (Express/WS)
    participant R as Redis

    C->>B: GET /auth/ws-ticket (HTTP, credentials: include)
    B->>R: SET ws_ticket:<uuid> "admin-json-or-installToken" EX 30
    B-->>C: { data: { ticket: "<uuid>" } }

    C->>B: WS Upgrade /ws?ticket=<uuid>
    B->>R: GET ws_ticket:<uuid>  (one-time use; DEL immediately)
    R-->>B: ticket value (discordId + role)
    B-->>C: WS OPEN (admin observer path)

    Note over C,B: Game-client path (Electron overlay)

    C->>B: WS Upgrade /ws  (header: X-Auth-Token: <session-token>)
    B->>R: GET session:<token>
    R-->>B: userId
    B->>B: Load user from Postgres, check ban/kick/mute
    B-->>C: WS OPEN
    B-->>C: presence:state  (DB snapshot)
    B-->>C: user:muted  (if muted)
    B-->>C: telemetry:set  (deprecated kill-switch, always false)
    B->>all: room:join broadcast
```

`handlers.ts:1429–1699`

### Two auth paths

| Path | How to connect | Who uses it |
|------|---------------|-------------|
| **Game client** | `X-Auth-Token: <session-token>` header | Electron overlay |
| **Admin observer** | `?ticket=<uuid>` query param | Web dashboard admin tab |

The ticket is a one-time Redis key (`ws_ticket:<uuid>`) consumed on first use (`handlers.ts:1438`). The session token is a long-lived Redis key (`session:<token>`) with a 24h TTL (`usersController.ts:20`).

**Admin observer role gate:** `GET /auth/ws-ticket` requires the session user's role to be `owner`, `admin`, or `moderator`. Non-privileged (e.g. `member`/`user`) sessions receive HTTP 403. The role is also stored in the ticket JSON and re-validated when the WebSocket upgrade arrives (`handleAdminObserver`) as defense in depth against role-downgrade races.

Close codes used by the backend:

| Code | Meaning |
|------|---------|
| `4001` | Auth failed (missing/invalid/expired token or ticket) |
| `4002` | User is banned |
| `4002` with body `KICK_COOLDOWN:<secs>` | Kicked; retry after N seconds |
| `4003` | Outdated build — only on the dev backend when `QA_BUILD_LOCK=true`; the close reason is `OUTDATED_BUILD:<activeVersion>`. The overlay shows an update prompt. |

**`x-client-version` upgrade header (dev/QA path only):** game-client overlays built with
the `qa` build channel (`dist:qa`) send an `x-client-version: <version>` header on the WS
upgrade request. When `QA_BUILD_LOCK=true` the backend evaluates this against
`QA_ACTIVE_VERSION` via `buildLock.ts:evaluateBuildGate`. A mismatch closes the socket
with `4003`. The header is read by Node's HTTP layer (always lowercase: `x-client-version`).
This mechanism is a no-op on the production backend — `QA_BUILD_LOCK` defaults to false.

---

## Full Jitter Backoff

The client reconnects with **Full Jitter** — a capped random delay:

```
delay = random(0, min(16000ms, 1000 * 2^attempt))
```

Source: `ChatOverlay.tsx:2396`

```ts
const delay = Math.random() * Math.min(16000, 1000 * 2 ** attempt);
retryTimeout = setTimeout(() => connect(attempt + 1), delay);
```

- Attempt 0: up to 1s
- Attempt 1: up to 2s
- Attempt 2: up to 4s
- Attempt 4+: up to 16s (cap)

---

## Redis Pub/Sub (Multi-Instance Broadcast)

The backend uses a single Redis pub/sub channel (`chat:broadcast`) to fan out messages across multiple backend instances. Each instance has a unique `INSTANCE_ID` (UUID generated at startup) and ignores messages it published itself.

`handlers.ts:704–846`

Three broadcast scopes exist:

| Scope | Envelope field | Routing |
|-------|---------------|---------|
| Global | none | All connected clients on all instances |
| Party | `scope: 'party'`, `memberUserIds: string[]` | Only members of that party |
| Session | `scope: 'session'`, `sessionId: string` | Only clients on the matching world session (server/virtual channel) |

When Redis pub/sub is unavailable at startup, `initPubSub` schedules automatic retries every 30 s — it will re-activate as soon as Redis becomes reachable. Until then the backend falls back to local-only broadcast; other instances simply don't receive those frames.

**Presence is per-instance.** The `isUserConnected()` / `isUserInGame()` helpers only see clients connected to the local instance. Multi-instance deployments that need accurate cross-instance presence (e.g. exact party online counts) require either Redis-backed presence or sticky sessions at the load balancer.

---

## Rate Limiting

Two sliding-window rate limiters protect the WS send path:

| Limiter | Limit | Window | Redis key |
|---------|-------|--------|-----------|
| Per-socket message rate | 5 msg | 1 s | `ws_rate:<userId>` |
| `server:leave-manual` | 4 | 60 s | `rl_ws:leave-manual:<userId>` |
| `server:join-manual` | 4 | 60 s | `rl_ws:join-manual:<userId>` |

When the rate is exceeded the backend sends:
```json
{ "type": "rate:status", "payload": { "remaining": 0, "retryAfterMs": 1000 } }
```
followed by an `error` frame. `handlers.ts:710–728`

---

## Heartbeat & Zombie Cleanup

A 30-second `setInterval` on the server checks `ws.readyState`. Stale sockets that are no longer `OPEN` are removed from the `clients` Map. `handlers.ts:3296–3302`

On `ws.on('close')` the backend defers peer-leave announcements by `WS_FLAP_GRACE_MS` (default 30 s). If the same user reconnects on the same endpoint within the window the leave is suppressed (WS-flap guard, v1.1.37). `handlers.ts:3304–3418`

---

## On-Connect Server Push

Immediately after a game-client connection is established the backend pushes three frames without the client asking:

1. `presence:state` — current DB-backed endpoint + role snapshot
2. `user:muted` — only if the user is currently muted
3. `telemetry:set` — deprecated kill-switch; always `{ enabled: false }` (telemetry was removed)

`handlers.ts:1649–1696`
