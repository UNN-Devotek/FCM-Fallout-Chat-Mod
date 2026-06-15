# Glossary

Domain terms used throughout the codebase and documentation.

---

## installToken

A UUID generated on first launch of the Electron overlay and stored in `overlay-state.json` in the Electron `userData` directory. It is the permanent identity anchor for a game client before (and after) Discord linking. Every REST request and WebSocket upgrade from the overlay carries this token; the backend exchanges it for a short-lived 24 h session token stored in Redis.

---

## session token

A UUID stored in Redis under `session:<token>` (value = `userId`, TTL = 24 h). Issued by `POST /api/auth/register`. Sent on every API request as the `x-auth-token` header and on every WS upgrade. Distinct from the Express cookie-based session used by the admin dashboard.

---

## channel

A row in the `channels` PostgreSQL table. Seeded defaults:

| UUID suffix | Name | Type |
|-------------|------|------|
| `…0001` | General | Main channel |
| `…0002` | Trading | Sub-channel of General |
| `…0003` | Events | Sub-channel of General |
| `…0004` | Raids | Sub-channel of General |

Messages are stored in the `messages` table with a `channel_id` FK.

---

## sub-channel

A channel whose `parentId` column points to a main channel. In the overlay UI, sub-channels appear as tabs under their parent. A message sent to a sub-channel is stored with both `channel_id` and `parent_channel_id`.

---

## combined feed

When a user selects a **main** channel tab (e.g. General), the overlay displays messages from that main channel **and** all of its sub-channels, each prefixed with a short tag (e.g. `[Trade]`). The tag color comes from the channel's `color` field. Selecting a **sub-channel** tab shows only that sub's messages with no tag.

---

## party

A small private chat room created in-game by a user. Parties are stored in the `parties` table and their messages in `party_messages`. They are **not** Discord-bridged. Parties can be public (`isPrivate=false`) or private. The public website's overlay shows only public parties in read-only mode.

---

## overlayShell

A runtime Boolean in `ChatOverlay.tsx` that is truthy when the component is running inside the Electron overlay (detected via `getOverlayShell()`). Used to gate IPC calls (scroll-to-bottom, window chrome events) that are only valid in the Electron context.

---

## isPublicMode

`true` when `!user && !getOverlayShell()` — i.e. the component is rendered on the public website without an authenticated session and not inside Electron. In this mode the overlay is **read-only**: the input is hidden, no WebSocket is opened, data comes from unauthenticated REST endpoints (`GET /api/messages/public`, `GET /api/parties/public`), and no moderation or account actions are available. Server enforcement is primary; the client checks are a backstop.

---

## displayName resolution

The priority order for rendering a user's name in chat (implemented in `resolveDisplayName()`, `backend/src/websocket/handlers.ts:22`):

1. `users.username` — if set, non-empty, and not a placeholder (`Wanderer`, `pending-*`, `Overlay<digits>`, `discord:*`)
2. `users.discord_display_name` — Discord global name / server nick, refreshed on every OAuth callback
3. `users.discord_username` — Discord @handle
4. Falls back to `'Wanderer'`

No `#XXXX` discriminator suffix is appended.

---

## WS client identity cache

The `clients` Map in `backend/src/websocket/handlers.ts` caches `username` and `displayName` per open socket at connection time. If a DB row is updated (e.g. after Discord linking), open sockets continue serving the stale name until reconnect **unless** `refreshClientIdentity(userId, username, discordUsername, discordDisplayName, installToken)` is called, which walks the Map and re-resolves names in place.

---

## admin debug mirror

A pattern where Discord-OAuth-gated admin endpoints are mirrored under `/admin/debug/*` and gated by `X-Admin-API-Key` instead. This allows CLI tooling (curl, scripts) to reach the same data without a browser session. Both paths use identical request/response shapes. See `backend/src/server.ts` for examples.

---

## Full Jitter backoff (WebSocket reconnect)

The overlay WS client reconnects using Full Jitter: `delay = random(0, min(16s, base * 2^attempt))`. This prevents thundering-herd reconnect storms after a backend restart.

---

## Windowed Borderless (overlay z-order requirement)

The Electron overlay requires Fallout 76 to run in **Windowed Borderless** mode. In **Exclusive Fullscreen** the game takes exclusive GPU output, making it impossible for any OS window to render above it. This is an OS/GPU restriction, not a software limitation.

---

## Related docs

- [README.md](./README.md) — system overview
- [system-overview.md](./system-overview.md) — component table, conventions
- [data-flow.md](./data-flow.md) — how auth, messages, and the Discord bridge work
