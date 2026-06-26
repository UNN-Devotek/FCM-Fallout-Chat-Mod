# Authentication Model

There are three distinct auth flows in the backend, each serving a different client type.

> **Direction (locked): mandatory multi-provider auth gate.** Chat access is moving to **require a
> linked Nexus or Discord account** (one or the other). The overlay already enforces a Discord login
> wall; **Nexus is being added** as an alternative, and the in-game chat gets a **device-code link**.
> The install-token flow below stays as the device/session mechanism, but on its own it no longer
> grants chat — a bare install is **limited** until linked. Public-website read-only stays open;
> **sending is gated**. The admin dashboard stays Discord-only (elevated roles need Discord, #168).
> Authoritative design: [hud-chat-auth-design.md](hud-chat-auth-design.md) (multi-provider + pairing /
> device-code) and epic #163; the chat.v1 in-game gate is in
> [native-chat-relay/fcm-integration.md](../overlay/zfe/native-chat-relay/fcm-integration.md#mandatory-auth-gate--limited-until-nexusdiscord-linked-locked).

---

## 1. Overlay / Desktop Client Auth (install token → session token)

**Files:** `server.ts` (register endpoint), `middleware/auth.ts` (`requireAuth`), `middleware/requireClientAuth.ts`

### Step 1 — Registration (`POST /api/users`)

A fresh Electron install generates a random UUID `installToken` locally and sends it to `POST /api/users/register` with the static `X-App-Client-Key` header (a shared secret that gates first registration). The backend upserts a `users` row keyed on `installToken`.

### Step 2 — Session Issue (`POST /api/auth/session`)

After registration the client calls `POST /api/auth/session` with the `installToken` to receive a `sessionToken` (UUID). The backend:
1. Looks up the `users` row by `installToken`.
2. Generates a UUID token.
3. Stores `session:<token> → userId` in Redis with a 24h TTL (`SESSION_TTL_SECONDS = 24 * 60 * 60`).
4. Returns `{ data: { token } }`.

### Step 3 — Authenticated Requests

Every subsequent request from the desktop client includes `X-Auth-Token: <sessionToken>`.

**`requireAuth`** (`middleware/auth.ts`):
- Reads `X-Auth-Token`.
- Looks up `session:<token>` in Redis → `userId`.
- Fetches the user from Postgres; checks for ban.
- Auto-lifts expired temp-bans and expired mutes inline.
- Attaches `req.user` and `req.sessionToken`.
- Returns 403 with a structured JSON body (`{ type: "banned", until, permanent, reason, category }`) for banned users so the frontend can render a ban splash.

**`requireClientAuth`** (`middleware/requireClientAuth.ts`):
- Same Redis/DB lookup as `requireAuth`.
- Additionally enforces that `req.body.installToken` (if present) matches the authenticated user's stored `installToken` — prevents a leaked session token from being used to submit records under a different identity.

---

## 2. Discord OAuth2 — Admin Dashboard

**Files:** `server.ts` (OAuth2 routes), `middleware/auth.ts` (`requireDiscordRole`), `services/roleVerificationService.ts`

### OAuth2 Flow

1. **`GET /auth/discord`** — stores a CSRF state token in Redis (`oauth_state:<state>` → intent JSON, 5-min TTL) and redirects to Discord with scopes `identify guilds.members.read`.

2. **`GET /auth/discord/callback`** — validates the state token (deleted from Redis on use), exchanges the authorization code for an access token, fetches Discord identity and guild membership. Determines the user's role:
   - Compares the user's guild roles against `OWNER_ROLE_ID`, `ADMIN_ROLE_ID`, `MODERATOR_ROLE_ID` environment variables.
   - Priority order: `owner > admin > moderator > member`.
   - Every Discord guild member can log in; non-admin roles get `member`.
   - Upserts into `admin_users` table only for admin/mod/owner roles.
   - Caches the resolved role in Redis (`role:verified:<discordId>`, 5-min TTL).
   - Stores `req.session.discordUser = { id, username, discordDisplayName, avatar, roles, role }`.
   - Redirects: `member` → `/chat`; admin/mod/owner → `/server-health`.

3. **`GET /auth/logout`** — destroys the session.

4. **`GET /auth/me`** — returns the session user's identity + DB-resolved `fo76Name` and avatar URL.

5. **`GET /auth/ws-ticket`** — issues a 60s single-use UUID ticket in Redis (`ws_ticket:<ticket>`) so admin observers can open an authenticated WebSocket without re-sending cookie credentials.

### `requireDiscordRole(...allowedRoles)`

Applied on admin/mod routes. Verification order per request:
1. `X-API-Key` header bypass — grants `owner` access (same key as `ADMIN_API_KEY`).
2. `req.session.discordUser` must exist.
3. Ban lockdown: checks linked game user for active ban; returns structured 403 if banned.
4. Checks Redis role cache (`role:verified:<discordId>`).
5. Falls back to `admin_users` DB table.
6. Falls back to session `roles` array (covers fresh login before first verification cycle).

### Public Discord Auth (Reports / Applications)

For the `/report` and `/apply` website forms, the same OAuth2 callback runs but stores a lighter `req.session.publicUser = { discordId, username, discordDisplayName, avatar, intent }` instead. Guild membership is still verified; no role enforcement.

**`requirePublicDiscordAuth`** and **`requireDashboardAuth`** gate these endpoints. `requireDashboardAuth` normalizes both `publicUser` and `discordUser` session shapes into a `req.dashboardUser: DashboardIdentity`.

---

## 3. Discord OAuth2 — Desktop Client Linking

**Files:** `server.ts` (`/auth/discord/link`, `/auth/discord/link/callback`, `/api/auth/discord-status/:installToken`)

The Electron overlay opens a browser window to `GET /auth/discord/link?installToken=<token>`. The backend:
1. Stores a CSRF state (`oauth_link_state:<state>` → `installToken`, 5-min TTL).
2. Redirects to Discord OAuth2 with scope `identify guilds.members.read`.

On callback:
- Validates CSRF state and retrieves the stored `installToken`.
- Requires guild membership (403 with Pip-Boy HTML if not a member).
- Handles account reclaim: if a prior row already owns that `discordId`, all FK tables are migrated into the canonical row via `mergeUserInto()` (Prisma transaction), the `installToken` is updated, and `refreshClientIdentity()` pushes the updated name to any open WebSocket sessions.
- Stores the result in Redis (`discord_link:<installToken>`, 10-min TTL).
- Returns a Pip-Boy-styled HTML success/error page (displayed in the browser window).

The overlay polls `GET /api/auth/discord-status/:installToken` to check whether the link completed and to retrieve the resolved display name and avatar URL.

---

## 4. Device Keypair Auth (ECDSA P-256)

**Files:** `services/deviceAuthService.ts`, `middleware/auth.ts` (`requireSignedDevice`), `routes/devices.ts`

An optional second authentication layer for desktop clients that have enrolled a keypair. The install calls `POST /api/devices/enroll` to store its public key (SPKI DER, base64) in the `devices` table.

Signed requests carry four headers: `X-Device-Install`, `X-Device-Timestamp`, `X-Device-Nonce`, `X-Device-Signature`. The `requireSignedDevice` middleware:
1. Parses the signature headers.
2. Enforces a ±60s clock-skew window.
3. Checks the nonce is unused (Redis, 120s TTL).
4. Looks up the device's public key in `devices`.
5. Verifies the ECDSA signature over `METHOD\nPATH\nBODY_SHA256\nTIMESTAMP\nNONCE` using the stored key.
6. Attaches `req.device = { installToken }`.

The `.NET` client signs in ASN.1 DER format (`DSASignatureFormat.Rfc3279DerSequence`), which is what Node's `crypto.verify` expects.

---

## 5. Admin API Key (`requireAdminKey`)

**File:** `middleware/requireAdminKey.ts`

Reads `X-Admin-API-Key` and compares it to `env.ADMIN_API_KEY` using constant-time equality (`utils/constantTimeEquals.ts`). Used exclusively on `/admin/debug/*` endpoints and as a `requireDiscordRole` bypass for CLI tooling. Every use is audit-logged.

## 6. Migration Key (`requireMigrationKey`)

**File:** `middleware/requireMigrationKey.ts`

Reads `X-Migration-Key` and gates `/admin/migration/*` (ad-hoc SQL, `pg_dump`, `psql` restore). Separate from `ADMIN_API_KEY`.

---

## Redis Key Summary

| Key | Value | TTL |
|-----|-------|-----|
| `session:<token>` | userId | 24h |
| `oauth_state:<state>` | JSON `{ intent }` | 5 min |
| `oauth_link_state:<state>` | installToken | 5 min |
| `discord_link:<installToken>` | JSON Discord identity | 10 min |
| `ws_ticket:<ticket>` | JSON `{ type, discordId, username }` | 60 s |
| `role:verified:<discordId>` | role string | 5 min |
| `device:nonce:<nonce>` | `1` | 120 s |

---

## 7. Dual Discord Role Gate (Hosted Dev Environment)

**Files:** `services/devAuthService.ts`, `routes/verifyDevRole.ts`, `controllers/verifyDevRoleController.ts`

Access to the hosted dev environment requires a contributor to hold the developer role in **both** the production Discord guild and the dev Discord guild simultaneously.

- The **prod backend** exposes `GET /api/internal/verify-dev-role` (gated by `PROD_VERIFY_TOKEN`), which uses the prod bot to check prod-guild membership and returns only `{ data: { hasDevRole: boolean } }`.
- The **dev backend** uses `makeDevSideDeps()` to check the dev guild locally (via the dev bot) and delegates prod-guild reads to the prod verify endpoint.
- The pure `verifyDualRole()` function is the single source of truth for the access decision.

See [services.md](./services.md#devauthservicets) for the full service API and [docs/deployment/hosted-dev-environment.md](../deployment/hosted-dev-environment.md) for the complete design.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PROD_GUILD_ID` | Discord guild ID of the production server (for dual-role gate) |
| `PROD_DEVELOPER_ROLE_ID` | Role ID that grants developer access in the prod guild |
| `DEV_GUILD_ID` | Discord guild ID of the dev server |
| `DEV_DEVELOPER_ROLE_ID` | Role ID that grants developer access in the dev guild |
| `PROD_VERIFY_URL` | Full URL of the prod backend verify endpoint (e.g. `https://falloutchatmod.com/api/internal/verify-dev-role`) |
| `PROD_VERIFY_TOKEN` | Bearer token for authenticating calls to `verify-dev-role` |

All six default to `''` (empty string). The gate fails closed whenever any of them are missing.
