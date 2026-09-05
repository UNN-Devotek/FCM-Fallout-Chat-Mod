# REST API Reference

All routes under `/api/` are subject to `apiLimiter` (100 req/15min per session token, 500/15min per IP) unless noted. Responses use `{ "data": ... }` on success and RFC 7807 on error.

Auth abbreviations:
- **public** — no auth required
- **requireAuth** — `X-Auth-Token` session (desktop overlay)
- **requireClientAuth** — `X-Auth-Token` session + optional install-token binding check
- **requireDiscordRole(...)** — Discord OAuth2 session with a qualifying role (owner/admin/moderator) OR `X-API-Key`
- **requireAdminKey** — `X-Admin-API-Key` header
- **requireDashboardAuth** — any signed-in web user (dashboard Discord session or public Discord session)
- **requireAnyAuthedClient** — any of: `X-Auth-Token` session, Discord OAuth session, public Discord session

---

## Auth (`/auth/*`, `/api/auth/*`)

These routes are outside `/api/` and not subject to `apiLimiter`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/discord` | public | Initiate Discord OAuth2 (admin dashboard) |
| GET | `/auth/discord/callback` | public | OAuth2 callback; sets session |
| GET | `/auth/nexus` | public | Initiate Nexus OAuth2 + PKCE (feature-flagged) |
| GET | `/auth/nexus/callback` | public | Validate Nexus OAuth2 state, provision/link identity, set session |
| DELETE | `/auth/nexus` | requireAuth | Unlink Nexus identity unless it is the last provider |
| GET | `/auth/discord/link` | public | Initiate Discord link for desktop client (`?installToken=`) |
| GET | `/auth/discord/link/callback` | public | OAuth2 callback for desktop link |
| GET | `/auth/steam` | public | Initiate Steam OpenID sign-in for `/link` |
| GET | `/auth/steam/link` | public | Initiate Steam OpenID link for desktop client (`?installToken=`) |
| GET | `/auth/steam/callback` | public | Validate Steam OpenID assertion and establish/link the account |
| GET | `/auth/logout` | public | Destroy session |
| GET | `/auth/me` | Discord session | Current admin user identity + avatarUrl |
| GET | `/auth/ws-ticket` | Discord session | Issue 60s single-use WS ticket |
| GET | `/api/auth/discord-status/:installToken` | public | Poll Discord link status for desktop client; when linked, also performs the bounded live supporter-role reconciliation |
| GET | `/api/auth/steam-status/:installToken` | public | Poll verified Steam link status for the desktop client |
| POST | `/api/dev/login-as` | loopback or `X-Dev-Persona-Key`, DEV-only | Issue an immediate synthetic persona session for an unpackaged local or hosted DEV overlay (`{ persona, installToken }`) |
| GET | `/auth/discord/dev-login` | public, DEV-only | Legacy OAuth-gated persona login (`?installToken=&persona=`); not used by the overlay DevAccount buttons |
| GET | `/api/auth/dev-login-status/:installToken` | public, DEV-only | Consume the one-time legacy hosted DEV persona session grant |

See [auth.md](./auth.md) for full details.

---

## Users (`/api/users`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/users` | requireDiscordRole(owner/admin/mod) | List all users |
| POST | `/api/users` | public + rate-limited | Register a new install (requires `X-App-Client-Key`) |
| DELETE | `/api/users/session` | requireAuth | Log out / invalidate session token |
| GET | `/api/users/presence/same-server` | none (resolves X-Auth-Token OR Discord session) | Same-server presence lookup |
| GET | `/api/users/mention-search` | public (apiLimiter only) | Username autocomplete for @mentions |
| GET | `/api/users/:id/profile` | public | Public-safe user profile (excludes ban reason, installToken, endpoint) |
| GET | `/api/users/:id` | requireDiscordRole(owner/admin/mod) | Full user record |
| GET | `/api/users/:id/aliases` | requireDiscordRole(owner/admin/mod) | Username alias history |
| GET | `/api/users/:id/messages` | requireDiscordRole(owner/admin/mod) | Messages by user |
| POST | `/api/users/:id/mute` | requireDiscordRole(owner/admin/mod) | Mute user |
| DELETE | `/api/users/:id/mute` | requireDiscordRole(owner/admin/mod) | Unmute user |
| POST | `/api/users/:id/kick` | requireDiscordRole(owner/admin/mod) | Kick user from chat |
| POST | `/api/users/:id/ban` | requireDiscordRole(owner/admin) | Ban user |
| DELETE | `/api/users/:id/ban` | requireDiscordRole(owner) | Unban user |
| POST | `/api/users/:id/wipe` | requireDiscordRole(owner) | Wipe all user data |
| DELETE | `/api/users/:id` | requireDiscordRole(owner) | Delete user record |

`POST /api/users` applies `registerIpFloodLimiter` + `registerLimiter` + `authLimiter` in sequence. See `routes/users.ts`.

---

## Auth Routes (under `/api/auth`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/session` | public | Issue session token for an installToken |

Defined in `routes/auth.ts`.

---

## Devices (`/api/devices`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/devices/enroll` | public (rate-limited) | Enroll a device keypair (ECDSA P-256 public key) |
| GET | `/api/devices/admin/list` | requireDiscordRole(owner/admin) | List enrolled devices |
| DELETE | `/api/devices/admin/:installToken` | requireDiscordRole(owner/admin) | Revoke device keypair |

See [auth.md](./auth.md) for the keypair auth protocol.

---

## Channels (`/api/channels`)

Uses `channelsLimiter` (500 req/15min) instead of `apiLimiter`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/channels` | public | List all active channels |
| POST | `/api/channels` | requireDiscordRole(owner/admin) | Create a channel |
| PATCH | `/api/channels/:id` | requireDiscordRole(owner/admin) | Update channel |
| DELETE | `/api/channels/:id` | requireDiscordRole(owner) | Archive channel |

---

## Messages (`/api/messages`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/messages/public` | public | Recent messages (public read-only mode) |
| GET | `/api/messages/search` | requireDiscordRole(owner/admin/mod) | Full-text message search |
| GET | `/api/messages` | requireAuth | Message history (authenticated) |
| POST | `/api/messages` | requireDiscordRole(owner/admin/mod) | Create a message (admin-injected) |
| POST | `/api/messages/scrub` | requireDiscordRole(owner/admin) | Bulk-delete messages matching criteria |
| DELETE | `/api/messages/:id` | requireDiscordRole(owner/admin/mod) | Delete a message |

---

## Parties (`/api/parties`)

Feature-gated: all routes return 404 when `PARTIES_ENABLED=false` (default).

Public (unauthenticated) endpoints registered before the auth-gated mount:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/parties/public` | public (partiesListLimiter) | List public parties (logged-out website overlay) |
| GET | `/api/parties/public/:id/messages` | public (partiesListLimiter) | Messages in a public party |

Authenticated endpoints (`requireClientAuth` applied to whole router):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/parties` | requireClientAuth + partiesListLimiter | List/search parties |
| POST | `/api/parties` | requireClientAuth + partyCreateLimiter | Create party |
| POST | `/api/parties/upload-image` | requireClientAuth + partyImageUploadLimiter | Upload party image (multer, 8 MB) |
| GET | `/api/parties/invites` | requireClientAuth | My pending invites |
| POST | `/api/parties/invites/:id/accept` | requireClientAuth | Accept invite |
| POST | `/api/parties/invites/:id/decline` | requireClientAuth | Decline invite |
| GET | `/api/parties/:id` | requireClientAuth | Party details |
| GET | `/api/parties/:id/members` | requireClientAuth | Party members |
| GET | `/api/parties/:id/invite-search` | requireClientAuth + partiesListLimiter | Search users to invite |
| PATCH | `/api/parties/:id` | requireClientAuth | Update party settings |
| POST | `/api/parties/:id/join` | requireClientAuth + partyJoinLimiter | Join party |
| POST | `/api/parties/:id/leave` | requireClientAuth | Leave party |
| DELETE | `/api/parties/:id` | requireClientAuth | Delete party |
| POST | `/api/parties/:id/invite` | requireClientAuth + partyInviteLimiter | Invite a user |
| POST | `/api/parties/:id/invite-public` | requireClientAuth + partyInviteLimiter | Invite via public link |
| POST | `/api/parties/:id/kick` | requireClientAuth | Kick member |
| POST | `/api/parties/:id/promote` | requireClientAuth | Promote member to co-mod |
| POST | `/api/parties/:id/demote` | requireClientAuth | Demote co-mod |

Admin party endpoints (see server.ts lines 1042–1050):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/parties` | requireDiscordRole(owner/admin) | List all parties |
| GET | `/api/admin/parties/:id` | requireDiscordRole(owner/admin) | Party details |
| GET | `/api/admin/parties/:id/messages` | requireDiscordRole(owner/admin) | Party messages |
| DELETE | `/api/admin/parties/:partyId/messages/:messageId` | requireDiscordRole(owner/admin) | Delete party message |

Debug mirrors under `/admin/debug/parties/*` use `requireAdminKey` with the same handlers.

**Per-party capacity guard.** When a party sets `maxMembers`, both `POST /api/parties/:id/join`
and `POST /api/parties/invites/:id/accept` enforce the limit and return **`409 "Party is full"`**
when it is reached. The check is race-safe: each path runs the capacity count and the member
insert inside a single `prisma.$transaction` that first takes a row lock on the party
(`SELECT id FROM parties WHERE id = … FOR UPDATE`). Concurrent joins/accepts for the same party
serialize on that lock, so they cannot both read a stale count below the cap and both insert —
membership never exceeds `maxMembers`. (A bare transaction without the row lock would NOT be
safe under READ COMMITTED, since `count()` takes no lock and cannot see another transaction's
uncommitted insert.) Idempotent re-accept of an existing membership is exempt from the cap.

---

## Giveaways (`/api/giveaways`)

Community item raffles. Created and joined via the `/giveaway` chat command; draw timer fires
automatically server-side. The REST endpoints are for the dashboard and admin tooling.

| Method   | Path                        | Auth                                    | Description             |
|----------|-----------------------------|-----------------------------------------|-------------------------|
| GET      | `/api/giveaways`            | requireClientAuth                       | List active giveaways   |
| DELETE   | `/api/admin/giveaways/:id`  | requireDiscordRole(owner/admin/mod)     | Force-cancel a giveaway |

`id` in the admin delete path is the giveaway `shortId` (6-char, e.g. `A1B2C3`), not the UUID.

---

## Block (`/api/block`)

`requireClientAuth` applied to whole router.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/block` | requireClientAuth | List blocked users |
| POST | `/api/block` | requireClientAuth | Block a user |
| DELETE | `/api/block/:userId` | requireClientAuth | Unblock a user |

---

## Presence (`/api/presence`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/presence/server-messages` | requireDiscordRole(owner/admin) | List recent server-channel messages |
| DELETE | `/api/presence/server-messages/:id` | requireDiscordRole(owner/admin/mod) | Soft-delete a server message |

Note: the main presence updates (`presence:update`) flow over the WebSocket — see [../realtime/](../realtime/).

---

## Player List (`/api/player-list`)

Uses `playerListLimiter` (30 req/min per token). Desktop client POSTs every 5s in warm cadence.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/player-list` | requireClientAuth | Submit nearby player list snapshot |

---

## Reports — Chat Message Reports (`/api/reports`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/reports` | requireAuth | Submit a report about a chat message |
| GET | `/api/reports` | requireDiscordRole(owner/admin/mod) | List reports |
| GET | `/api/reports/:id` | requireDiscordRole(owner/admin/mod) | Report detail |
| PATCH | `/api/reports/:id` | requireDiscordRole(owner/admin/mod) | Resolve report |

---

## Player Reports (`/api/player-reports`)

Player reports and bug reports submitted via the web form.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/player-reports` | requireDiscordRole(owner/admin/mod) | List player reports |
| GET | `/api/player-reports/mine` | requireDashboardAuth | Own submitted reports |
| GET | `/api/player-reports/mine/:id` | requireDashboardAuth | Own report detail |
| POST | `/api/player-reports` | requireDashboardAuth | Submit player/bug report |
| POST | `/api/player-reports/upload-image` | requireDashboardAuth | Attach images (multer, 5 MB × 3) |
| PATCH | `/api/player-reports/:id` | requireDiscordRole(owner/admin/mod) | Update/resolve report |

---

## Applications (`/api/applications`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/applications` | requireDiscordRole(owner/admin/mod) | List staff applications |
| GET | `/api/applications/mine` | requireDashboardAuth | Own application list |
| GET | `/api/applications/mine/:id` | requireDashboardAuth | Own application detail |
| POST | `/api/applications` | public + applicationsLimiter (3/hr/IP) | Submit staff application |
| PATCH | `/api/applications/:id` | requireDiscordRole(owner/admin) | Update application status |

---

## Cosmetics & Supporter tier (`/api/cosmetics`, `/api/supporter`)

Chat appearance personalisation and the paid supporter entitlement. Design record:
[docs/product/supporter-tier.md](../product/supporter-tier.md).

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| GET | `/api/supporter/tiers` | public | Pricing data for the marketing page (tier labels, prices, option counts) |
| GET | `/api/cosmetics/catalog` | requireDashboardAuth | Colour + effect catalog, reserved colours, picker bounds and contrast floor. **Single source of truth** — the web picker, the Discord `/cosmetics` autocomplete and the user guide all render from this rather than re-declaring it |
| GET | `/api/supporter/status` | requireDashboardAuth | Caller's tier, entitled tier, whether privileges are active, and whether they need to rejoin the Discord; refreshes the caller's live tier role first |
| GET | `/api/overlay/cosmetics` | requireAuth (`X-Auth-Token`) | Electron overlay's self-only appearance payload: catalog, resolved/stored cosmetics and active Discord tier. Performs a bounded live role check first. The target comes solely from the install session, never from a renderer-supplied user id. |
| PATCH | `/api/overlay/cosmetics` | requireAuth (`X-Auth-Token`) + rate limit | Electron overlay's self-only cosmetic update. Rechecks the live role before applying the same `applyCosmetics()` service and PATCH semantics as the profile and Discord bot. |
| GET | `/api/users/:id/cosmetics` | requireDashboardAuth | Resolved + stored cosmetics. Self, or moderator+. A self-read refreshes the live tier role first. |
| PATCH | `/api/users/:id/cosmetics` | requireDashboardAuth + rate limit | Self only. Refreshes the live tier role before applying a partial patch |
| POST | `/api/admin/users/:id/cosmetics/reset` | requireDiscordRole(owner/admin/moderator) | Reset an abusive colour, effect or tag to defaults (#232) |

### PATCH semantics

An **absent** key means "leave unchanged"; an explicit **`null`** means "clear". The two
are distinct and the service relies on that.

Appearance patches include `starColorPresetId`, which is independent of
`colorPresetId`. It accepts the same catalog and tier rules as a username colour. The
fixed supporter marker remains `★`; clients never accept a glyph from the API. Clear it
with `starColorPresetId: null` (or Discord `/cosmetics clear field:star`).

```json
{ "colorPresetId": "cryo", "effectId": null }
```

`colorPresetId` and `customColorHex` are mutually exclusive — setting one clears the other.

### Error responses

RFC 7807 as usual, with a machine-readable `code` matching the service's rejection reason:

| Reason | Status | Meaning |
| --- | --- | --- |
| `tier_locked` | 403 | Option requires a higher supporter tier |
| `blacklisted` | 400 | Name/tag rejected by the blacklist or automod. **Deliberately does not say which pattern matched** — that would make the endpoint an oracle for probing the filters |
| `invalid_tag` | 400 | Length or charset |
| `invalid_color` | 400 | Unparseable, below the contrast floor, or too close to a reserved colour |
| `not_found` | 404 | No such user |

The cosmetic appearance PATCH routes are rate-limited at **120 / 5 min per IP**
(`cosmeticsAppearanceLimiter`; 500 for an unpackaged dev overlay). They do not submit
candidate display names to blacklist/automod matching, so the free chat-name endpoint
retains its separate, stricter 20 / 5 min anti-probing bucket.

## Free chat name (`/api/users/:id/chat-name`)

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| PATCH | `/api/users/:id/chat-name` | `requireDashboardAuth` + write rate limit | Self only. Sets the user's free account chat name; `{ "chatName": null }` clears it and restores the Fallout 76 / Discord-derived name. No supporter tier or calendar cooldown applies. Names are 2–32 characters after sanitisation and pass the same blacklist/automod checks as other visible identity fields. |

### Note on ownership

`requireDashboardAuth` does **not** enforce ownership, so these controllers scope by the
caller's `discordId` themselves.

---

## Commands (`/api/commands`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/commands` | public | List available chat commands |
| POST | `/api/commands` | requireDiscordRole(owner/admin) | Create command |
| PATCH | `/api/commands/:id` | requireDiscordRole(owner/admin) | Update command |
| DELETE | `/api/commands/:id` | requireDiscordRole(owner/admin) | Delete command |

---

## Releases (`/admin/releases`, `/api/releases`)

Mounted at both paths. Auth is handled inside `releasesController` using `ADMIN_RELEASE_TOKEN`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/admin/releases` or `/api/releases` | Bearer `ADMIN_RELEASE_TOKEN` | Publish a new release; updates the server's in-memory `latestVersion` cache (new WS connects receive `app:update-available`) |
| GET | `/admin/releases` or `/api/releases` | public | List releases (current version + notes) |
| DELETE | `/admin/releases/:version` | Bearer `ADMIN_RELEASE_TOKEN` | Remove release entry |

**POST body:** `{ version, downloadUrl, releaseNotes, announce?, mentionEveryone? }`. Both
`announce` and `mentionEveryone` default to `true`. Set `announce` to `false` to skip Discord
entirely, or set `mentionEveryone` to `false` to post the embed without the channel-wide
`@everyone` mention. The site download, `latestVersion` cache / in-app `app:update-available`,
and GitHub Release still update in either quiet mode. See
[releasing-the-overlay.md](../deployment/releasing-the-overlay.md) → Step 6.

---

## Version (`/api/version`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/version` | public | Current backend version string |

---

## Health (`/api/health`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | public | Service health (DB + Redis ping) |

---

## Admin Users (`/api/admin-users`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin-users` | requireDiscordRole(owner/admin/mod) | List admin users |
| PATCH | `/api/admin-users/:id` | requireDiscordRole(owner) | Update admin role |
| DELETE | `/api/admin-users/:id` | requireDiscordRole(owner) | Remove admin user |

---

## Audit Log (`/api/audit-log`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/audit-log` | requireDiscordRole(owner/admin/mod) | Paginated audit log |

See [../moderation/](../moderation/) for full moderation documentation.

---

## Moderation (`/api/moderation`)

Documented in [../moderation/](../moderation/). Covers:
- Bans, kicks, mutes (`/api/moderation/kicks`, `/mutes`, `/bans`, `/evidence`, `/users/lookup`)
- AutoMod rules (`/api/moderation/automod-rules`, `/automod-violations`)
- Settings (`GET`/`PATCH /api/moderation/settings`) — the key/value `moderation_settings` store.
  `PATCH` has three validation paths: `mod_log_channel_id` (Discord snowflake),
  the AI moderation keys (`ai_moderation_enabled` boolean string,
  `ai_moderation_mode` = `shadow`|`enforce`, `ai_moderation_thresholds` /
  `ai_moderation_identifier_thresholds` JSON of category → score in `(0,1]`),
  and everything else (positive integers). See
  [../moderation/ai-moderation.md](../moderation/ai-moderation.md).
- Voice settings, embed builder, reaction-role panels — see [../discord/](../discord/)

---

## Community Stats (`/api/admin/community-stats`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/community-stats` | requireDiscordRole(admin) | Signup/message/version/download metrics (`?range=90d`) |

Debug mirror: `GET /admin/debug/community-stats` — `requireAdminKey`.

---

## Name Blacklist (`/api/admin/name-blacklist`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/name-blacklist` | requireDiscordRole(owner/admin) | List blacklisted name patterns |
| POST | `/api/admin/name-blacklist` | requireDiscordRole(owner/admin) | Add pattern |
| DELETE | `/api/admin/name-blacklist/:id` | requireDiscordRole(owner/admin) | Remove pattern |

---

## Admin Status (`/api/admin/status`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/status` | requireDiscordRole(owner/admin/mod) | Live service status snapshot |

---

## Discord Emojis + Tenor Search

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/discord-emojis` | requireAnyAuthedClient | Guild emoji list |
| GET | `/api/tenor-search` | requireAnyAuthedClient | Tenor GIF proxy (`?q=`) |

---

## Debug Overlay Reports

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/debug/overlay-report` | requireClientAuth + debugReportLimiter | Submit overlay diagnostic snapshot |
| GET | `/admin/debug/overlay-reports` | requireAdminKey | List submitted reports |

---

## Public Moderation Log

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/public/moderation-log` | public | Public-safe moderation action log |

---

## Public Stats (`/api/public/stats`)

Mounted **before** `requireClientAuth` so it is reachable with no auth. Exposes
only world-readable aggregates — no PII, no per-user rows. Rate-limited 60 req /
15 min per IP (Redis-backed, fail-open). Heavy aggregates are cached in memory
30 s in `publicStatsService`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/public/stats` | public | World-readable aggregate community stats |

Response (`{ data: {...} }`):

```jsonc
{
  "data": {
    "onlineNow": 12,            // current WS client count (same source as /api/health websocket_clients)
    "totalUsers": 4210,         // count(*) from users
    "totalMessages": 98300,     // lifetime non-deleted messages (pg_class reltuples estimate, exact fallback)
    "usersOverTime": [          // LAST 7 DAYS, daily buckets, CUMULATIVE running total
      { "bucket": "2026-05-29T00:00:00.000Z", "total": 4150 }
      // ... 7 entries, UTC-midnight day boundaries
    ],
    "onlineOverTime": [         // LAST 7 DAYS, daily buckets, PEAK (max) online that day; 0 if no snapshot
      { "bucket": "2026-05-29T00:00:00.000Z", "online": 9 }
      // ... 7 entries, SAME 7 day-boundaries/order as usersOverTime
    ]
  }
}
```

Both time-series share an identical 7-day daily axis (UTC-midnight boundaries via
`generate_series`) so the frontend can zip them by `bucket` for a single dual-line
chart. Every day appears in both arrays — `online` is `0` for days with no
snapshot yet — so the arrays are always equal length and aligned order.

---

## Migration Suite (`/admin/migration`)

Outside `/api/`; gated by `requireMigrationKey` (10 req/15min per IP).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/admin/migration/sql` | requireMigrationKey | Execute ad-hoc SQL (returns up to 1000 rows) |
| POST | `/admin/migration/dump` | requireMigrationKey | Stream `pg_dump` as `.sql` attachment |
| POST | `/admin/migration/restore` | requireMigrationKey | Pipe SQL dump into `psql` (overwrites data) |

---

## Static Assets

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/avatars/default` | public | Default Pip-Boy SVG avatar |
| GET | `/avatars/:discordId` | public | User Discord avatar (streams MinIO, falls back to CDN) |
| GET | `/party-images/:imageId` | public | Party chat image (streams MinIO) |

---

## Developer Role Verification (`/api/internal/verify-dev-role`)

Production endpoint. Used by the hosted dev environment dual-role gate to ask the prod backend whether a Discord user holds the prod developer role. See [docs/deployment/hosted-dev-environment.md](../deployment/hosted-dev-environment.md) for the full design.

Rate-limited: 30 req/min per IP.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/internal/verify-dev-role?discordId=<id>` | Bearer `PROD_VERIFY_TOKEN` (constant-time) | Returns `{ data: { hasDevRole: boolean } }` |

**Auth:** `Authorization: Bearer <PROD_VERIFY_TOKEN>` header required. 403 if missing, invalid, or if `PROD_VERIFY_TOKEN` / `PROD_GUILD_ID` / `PROD_DEVELOPER_ROLE_ID` are not configured (fail-closed).

**Query parameter:** `discordId` — numeric string (1–32 digits), required. 400 if absent or non-numeric.

**Responses:**

| Status | Condition |
|--------|-----------|
| 200 | `{ "data": { "hasDevRole": true\|false } }` — member not in guild resolves to `false`, not an error |
| 400 | Missing or invalid `discordId` |
| 403 | Bad/missing token, or endpoint not configured |
| 502 | Discord transport failure (do not treat as "no role") |

Source: `backend/src/routes/verifyDevRole.ts`, `backend/src/controllers/verifyDevRoleController.ts`

---

## Simulation Routes (`/api/admin/sim/*`)

**DEV-ONLY** — mounted only when `NODE_ENV === 'development'` and `ENABLE_DEV_LOGIN` is set. All routes require `Authorization: Bearer <ADMIN_API_KEY>`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/admin/sim/users` | Bearer `ADMIN_API_KEY` | Bulk-create simulation users (default 100, max 200); returns session tokens |
| DELETE | `/api/admin/sim/users` | Bearer `ADMIN_API_KEY` | Delete all simulation users (those with `installToken` starting with `sim-`) |
| POST | `/api/admin/sim/stream` | Bearer `ADMIN_API_KEY` | Drip synthetic FO76-flavored chat messages through the real WS broadcast path |

### POST `/api/admin/sim/stream`

Drips `count` synthetic messages authored by existing sim users through the **real** `broadcast()` / `localBroadcast()` / `hudPushNotify()` path — identical to the live `chat:message` hot path. Messages are also queued for write-behind persistence via `messagePersist`. Fire-and-forget: returns immediately; self-terminates after `count` messages.

Request body:

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `count` | integer | 20 | Max 200 |
| `intervalMs` | integer | 1500 | Spacing between messages (ms); clamped 100–30 000 |
| `channelId` | string | General channel UUID | Target channel |

Response: `{ "data": { "started": true, "count", "intervalMs", "channelId", "authors" } }`

Source: `backend/src/routes/simUsers.ts`

---

## Admin Debug Mirrors Pattern

Endpoints under `/admin/debug/*` are exact mirrors of their `/api/admin/*` counterparts but gated by `X-Admin-API-Key` instead of a Discord OAuth session. They are NOT mounted under `/api/` and are not subject to `apiLimiter`. This pattern allows CLI tooling (curl, scripts) to access admin functionality without a browser OAuth session.

## CAMP Item Search (`/api/camp`)

Public endpoints — no auth required. Mounted **before** `requireClientAuth`. Served from the local `camp_items` Postgres table (populated from the 76-CAMPDatabase JSON on first boot; refreshable via admin endpoint).

| Method | Path | Auth | Rate limit | Description |
|--------|------|------|------------|-------------|
| GET | `/api/camp/search?q=&limit=` | public | `campSearchLimiter` (300 req/15min) | Case-insensitive LIKE search on `camp_items.name`. Returns items with `imageUrl` + `sourceLabel`. `limit` capped at 20. |
| GET | `/api/camp/img/:id` | public | none | Image proxy — streams the item's `.webp` thumbnail from MinIO; falls back to mrsblobby GitHub Pages CDN. In-memory byte cache (≤400 entries). |
| POST | `/api/admin/camp/ingest` | requireDiscordRole(owner/admin) | `apiLimiter` | Full re-sync: fetch JSON, upsert all rows (source labels + image mirror). Returns `{ data: { status, fetched, upserted, imagesAdded } }`. |
| GET | `/api/admin/camp/updates` | requireDiscordRole(owner/admin) | `apiLimiter` | Check whether the upstream JSON has changed since last sync. Cached ~5 min. Returns `{ data: CampUpdateStatus }`. |

### Query parameters — `GET /api/camp/search`

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `q` | string | required | Search term |
| `limit` | integer | 8 | Capped at 20 |

### Response shape — `GET /api/camp/search`

```json
{
  "data": [
    {
      "id": "a1b2c3d4-...",
      "name": "Wood Stove",
      "category": "Furniture",
      "subCategory": "Appliances",
      "budgetCost": 2,
      "plan": "Plan: Wood Stove",
      "imageUrl": "/api/camp/img/a1b2c3d4-...",
      "sourceLabel": "Plan: Wood Stove",
      "sourceType": "plan"
    }
  ]
}
```

`plan` is `null` when no plan is required. `budgetCost` is `null` when unknown. `imageUrl` is `null` when no image has been mirrored yet.

### Response shape — `GET /api/admin/camp/updates`

```json
{
  "data": {
    "lastSyncAt": "2026-06-05T00:00:00.000Z",
    "updatesAvailable": 0,
    "checkedAt": "2026-06-05T12:00:00.000Z"
  }
}
```

`updatesAvailable` is `1` when the upstream JSON hash differs from the stored hash (a sync is recommended), `0` when up-to-date.

### `/camp` slash command

```
/camp <item name>
```

Sends a private (ephemeral) reply to the sender with the item's category, budget cost, required plan, and source. On no match: `No CAMP item found for "<query>".`

Metadata shape on match:
```json
{
  "type": "camp_item",
  "name": "string",
  "category": "string",
  "subCategory": "string",
  "budgetCost": 2.0,
  "plan": "Plan: Wood Stove",
  "imageUrl": "/api/camp/img/<id>",
  "sourceType": "plan",
  "sourceLabel": "Plan: Wood Stove",
  "source": "76 CAMP Database",
  "sourceUrl": "https://mrsblobby.github.io/76-CAMPDatabase/Live/"
}
```

---

## HUD Feed (`/api/game/hud-feed`)

Public, unauthenticated, read-only endpoint. Consumed by **FCMBridge.swf** running inside Fallout 76's Scaleform layer via ZFE's `readRemoteData` API. ZFE caches the response on the client side (300 s minimum); the backend returns `Cache-Control: public, max-age=30` for Cloudflare edge caching. This is the **cold-start and fallback** path — see HUD Push below for real-time delivery.

Mounted at `server.ts:1016` with `hudFeedLimiter` applied before the router.

| Method | Path | Auth | Rate limit | Description |
|--------|------|------|------------|-------------|
| GET | `/api/game/hud-feed` | public | `hudFeedLimiter` (120 req/15min/IP) | Returns up to 30 recent messages from top-level community channels (General / Trading / Events / Raids), ordered oldest-first. |

### Response shape

```json
{ "t": "#C8A840~General~Devotek~hello|#4A9FE0~Trade~Vault101~WTS plans" }
```

The `t` value is a `|`-joined list of `color~channel~user~content` records, pre-rendered by
`buildFeedLines()` and sanitized by `zfeSafe()` (quote-free, no `<>`, no `&`). The SWF splits
on `|` then `~` and renders each record as styled htmlText without further JSON parsing.

Channel filter: `parent_id IS NULL AND is_archived = false AND is_deleted = false`.

Source: `backend/src/services/hudFeedService.ts` (shared core), `backend/src/routes/hudFeed.ts` (thin router)  
Tests: `backend/tests/hudFeed.test.js`, `backend/src/routes/__tests__/hudFeed.test.ts`  
ZFE integration: [docs/overlay/zfe/fcmbridge-data-pattern.md](../overlay/zfe/fcmbridge-data-pattern.md)

---

## HUD Push (real-time)

Real-time counterpart to the polling endpoint above. Two front-ends share one transport-agnostic
core (`hudPush.ts`). Both are **off by default** and must be explicitly enabled.

> **Dev-only:** both transports hard-refuse to start when `NODE_ENV=production`, even with
> their env flags set (a warning is logged). Removing that guard is an explicit step of the
> M6 production-exposure milestone — see
> [docs/overlay/zfe/realtime-socket.md](../overlay/zfe/realtime-socket.md).

### Endpoints

| Transport | Path / Port | Env flag | Default |
|-----------|------------|----------|---------|
| Path A — raw TCP (TLS) | `:4001` (configurable via `HUD_PUSH_TCP_PORT`) | `HUD_PUSH_TCP_ENABLED` | `false` |
| Path B — WebSocket | `/ws/hud` (HTTP upgrade on the backend port) | `HUD_PUSH_WS_ENABLED` | `false` |

**Path A TLS env vars** (both must be set for TLS; empty = plaintext — ZFE cannot connect):

| Var | Purpose |
|-----|---------|
| `HUD_PUSH_TCP_TLS_CERT` | Path to PEM cert file (self-signed works — ZFE/Schannel skips validation) |
| `HUD_PUSH_TCP_TLS_KEY` | Path to PEM private key file |

### Auth

None. No `Origin` check on `/ws/hud`. The game client sends no/odd `Origin` headers; this is a
public read-only feed. Per-IP connection cap: **3** concurrent connections on each transport.
The production guard currently refuses to attach this unauthenticated WebSocket listener in
`NODE_ENV=production`, and disabled/unknown upgrade paths are rejected by the shared router.

### FCMHUD/1 line protocol

Plain UTF-8, `\n`-terminated lines on both transports.

| Line format | Direction | When |
|-------------|-----------|------|
| `HELLO~1~<n>` | server → client | First line sent; `<n>` = backfill count to follow |
| `color~channel~user~content` | server → client | Backfill + live messages |
| `PING~<unixSeconds>` | server → client | Every 10 s idle (ZFE ~15 s idle timeout; also defeats Cloudflare ~100 s WS drop) |
| `HELLO~<accountName>~<characterName>` | **client → server** | M7: identity handshake. Must be sent before any SEND. |
| `SEND~<channelId>~<text>` | **client → server** | M7: ingest as a real chat message. Only accepted after HELLO. |

Record format is byte-identical to `GET /api/game/hud-feed` records. Control lines have <4
`~`-fields so the SWF's `renderRecords()` guard skips them with no code change.

**M7 inbound parsing (Path A / TCP only):** The old blunt 4 KB total-bytes cap is replaced with
a **per-line cap** (2048 bytes). Oversized lines are dropped; the connection is NOT destroyed.
Flood control is the shared Redis rate-limiter (`ws_rate:<userId>`). Unknown verbs are silently
ignored. HELLO timeout: 10 s.

TCP connections are still destroyed when the write buffer exceeds **64 KB** (backpressure guard).

### Backend wiring

`localBroadcast()` in `handlers.ts:758` calls `hudPushNotify(payload)` for every outbound
payload. The push core filters `chat:message` events, resolves the channel (60 s TTL cache),
applies `isHudEligibleChannel()`, formats via `buildFeedLines()`, and fans out.

Started from `server.ts start()` after `initPubSub()`:
```ts
await initHudPushTcp();
initHudPushWs(server);
```

The `/ws/hud` upgrade handler coexists with the `/ws` WebSocketServer. The shared upgrade router
leaves `/ws/hud` untouched only when `HUD_PUSH_WS_ENABLED=true` in a non-production process;
disabled and unknown upgrade paths are destroyed promptly.

**M7 identity env var:** `HUD_IDENTITY_SECRET` — HMAC-SHA256 key for deriving `identityHash` from FO76 `accountName`. Dev default in `.env.example`; must be a strong random secret before production use.

**M7 ingestion service:** `backend/src/services/ingestMessage.ts` — `ingestMessage({ userId, channelId, rawContent, source, identityHash? })` runs the canonical governance pipeline (mute → rate-limit → content validation → emoji expansion → channel validity → automod → broadcast → persist → Discord relay). Both the WS `chat:send` handler and the HUD TCP `SEND` handler call it. `source: 'hud' | 'ws'` is stored on the message row for auditing; it does NOT skip any governance step.

**M7 identity service:** `backend/src/services/hudIdentityService.ts` — `resolveHudIdentity`, `getActiveBlock`, `blockHash`, `unblockHash`. `HudIdentityBlock` DB table stores mute/ban records keyed on `identityHash`.

Sources: `backend/src/services/hudPush.ts`, `hudPushTcp.ts`, `hudPushWs.ts`, `ingestMessage.ts`, `hudIdentityService.ts`  
Tests: `backend/src/services/__tests__/hudPush.test.ts`, `backend/tests/hudPushTcp.test.js`, `backend/tests/hudPushWs.test.js`, `backend/tests/ingestMessage.test.js`, `backend/tests/hudIdentityService.test.js`  
Full protocol + ZFE env vars: [docs/overlay/zfe/realtime-socket.md](../overlay/zfe/realtime-socket.md)

---

## Wiki Catalog (`/api/wiki`)

Public endpoints — no auth required. Mounted **before** `requireClientAuth`. Served exclusively from the local Postgres catalog (`wiki_entries` / `wiki_aliases`). **Never calls Fandom.**

| Method | Path | Auth | Rate limit | Description |
|--------|------|------|------------|-------------|
| GET | `/api/wiki/search?q=&limit=` | public | `wikiSearchLimiter` (300 req/15min) | Fuzzy `pg_trgm` search over entry names + aliases. `q` 1–100 chars, null bytes stripped. Returns `{ data: [{ id, name, kind, thumbnailUrl, score }] }`. |
| GET | `/api/wiki/entry/:title` | public | `apiLimiter` | Fetch a single entry by display name (case-insensitive; alias fallback). Returns `{ data: { id, name, kind, imageUrl, imageAspect, imageMime, imageWidth, imageHeight, imageSourceUrl, images, locations, articleUrl, wikiTitle, fields, attribution, campData } }`. `fields` is trimmed per-kind subset of the infobox. `images` is an array of `{ url, aspect, isMap, width, height }` ordered by position (primary first). `locations` is a string array of spawn/find location names. `imageUrl` = `images[0]?.url` (back-compat). `campData` is an array of matching CAMP buildable rows (empty when not a CAMP item). 404 if not found; 200 with `fields: {}` / `images: []` / `locations: []` / `campData: []` when no data. |
| POST | `/api/admin/wiki/ingest` | requireDiscordRole(owner/admin) | `apiLimiter` | Trigger catalog ingestion (async, non-blocking). Body: `{ mode?: "incremental"\|"full", titles?: string[] }`. `mode` defaults to `"incremental"` (recentchanges since last sync); `"full"` walks all seed categories. `titles` overrides both modes (targeted re-sync, bypasses rate limit). Returns 202 `{ data: { status: "started", mode } }` or 409 if already running / rate-limited. |
| GET | `/api/admin/wiki/updates` | requireDiscordRole(owner/admin) | `apiLimiter` | Check how many wiki pages changed since last sync. Result cached ~5 min in Redis. Returns 200 `{ data: { lastSyncAt, updatesAvailable, changedPages, newPages, checkedAt } }`. |

### Query parameters — `GET /api/wiki/search`

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `q` | string | required | Search term, 1–100 chars |
| `limit` | integer | 10 | Capped at 50 |

### Response shape — `GET /api/wiki/entry/:title`

`fields` contains only the per-kind subset (spec §3.4); absent infobox fields are omitted (never blank rows). `attribution` is always `"Fallout Wiki · CC-BY-SA 3.0"`. `articleUrl` is the canonical Fandom article URL.

| Field | Type | Notes |
|-------|------|-------|
| `images` | `{ url, aspect, isMap, width, height }[]` | All images ordered by `position` asc (position-0 = primary/carousel-first). `isMap=true` = spawn-map overlay. Empty array if none ingested. |
| `locations` | `string[]` | Spawn / find location names (e.g. `"Whitespring Resort"`). Empty array if not set. |
| `imageUrl` | `string \| null` | Back-compat alias for `images[0]?.url`. Prefer `images[0]` in new code. |
| `campData` | `{ id, name, category, subCategory, budgetCost, plan, sourceLabel, imageUrl }[]` | All CAMP database rows whose `name` exactly matches the wiki entry name (case-insensitive). Multiple rows indicate variants or multiple categories. `budgetCost` is the C.A.M.P. budget cost (integer or null). `imageUrl` = `/api/camp/img/<id>` when the item has a mirrored image, else null. Empty array when the entry is not in the CAMP database. |

---

Key debug mirrors:
- `/admin/debug/community-stats` ↔ `/api/admin/community-stats`
- `/admin/debug/parties/*` ↔ `/api/admin/parties/*`
- `/admin/debug/automod-rules` ↔ `/api/moderation/automod-rules`
- `/admin/debug/automod-violations` ↔ `/api/moderation/automod-violations`

Additional admin-key-only debug endpoints (no public API mirror):
- `GET /admin/debug/ws-clients` — snapshot of connected WebSocket clients
- `GET /admin/debug/presence-audit?userId=&limit=` — Redis ring buffer of raw `presence:update` payloads
- `GET /admin/debug/peer-announce-events?limit=` — in-memory ring buffer of peer join announcements
- `GET /admin/debug/server-messages?endpoint=&limit=` — recent server-channel message rows
- `GET /admin/debug/users/:userId/aliases` — username alias history
- `POST /admin/debug/set-username` — force-set a user's username
- `POST /admin/debug/clear-rate-limit` — clear `rl_api:*` Redis keys
- `POST /admin/debug/clear-matchmake-endpoints` — null-out `:3000` endpoints
- `POST /admin/debug/clear-user-endpoint` — force-clear a user's server endpoint
- `POST /admin/debug/merge-users` — merge a duplicate user row into the canonical one
- `POST /admin/nuke-users` — hard wipe of all users (requires `?confirm=yes-delete-everything`)
