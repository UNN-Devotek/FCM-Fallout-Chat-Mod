# QA Role + Golden Dev Build — Design

- **Status:** Approved design, pending implementation plan
- **Date:** 2026-06-25
- **Owner:** maintainer (UNN-Devotek)
- **Surface:** `backend-dev`, `cross-platform-overlay`, dev Discord, Cloudflare Access (dev host)

## Goal

Let vetted **QA testers** (end users, not developers) run a packaged "golden" Dev
build that connects to the hosted dev service **as a regular chat user**, gated by a
new Discord **QA role** — without the heavy developer onboarding (Cloudflare Access
email allowlist + dual developer-role gate). Add a **golden-build version lock** so
only the single currently-blessed build can connect to the dev service; outdated
builds are hard-rejected so they can't be used (or exploited) against dev.

## Non-goals / out of scope

- The in-game HUD `.ba2` modding track. This is the **EULA-safe overlay** track only —
  the QA build still merely process-detects `Fallout76`; no game-memory reading, no
  injection, no network scanning.
- Any change to the **prod** overlay, prod release flow, or prod auth. The version lock
  and QA login are **dev-only**.
- Replacing the existing developer dual-role gate or CF Access for the developer
  dashboard. Developers keep their current path unchanged.

## Background — current state (verified)

- **Dev host is fully SSO-gated.** `dev.falloutchatmod.com` → `backend-dev:7676` sits
  entirely behind Cloudflare Access (the "FCM Developers" email-allowlist group). An
  overlay cannot reach it today without a CF Access browser session; even
  `/auth/discord/callback` is gated.
- **Hosted dev has `ENABLE_DEV_LOGIN=false`** — credential-less persona login is
  local-only. So an enforced QA gate via real Discord OAuth is the only viable hosted
  model.
- **Dev OAuth-issues-a-session is deferred/unbuilt.** Only the dual-role *logic*
  (`backend/src/services/devAuthService.ts`) and the prod verify endpoint
  (`GET /api/internal/verify-dev-role`) exist; no OAuth callback issues a dev session.
- **Roles:** `admin_users.role` ∈ {`owner`,`admin`,`moderator`}, resolved from Discord
  role IDs in `roleVerificationService.resolveRole()`. The overlay's normal auth is
  install-token registration (`POST /api/users` + `X-App-Client-Key`), not OAuth.
- **Packaged builds hardcode prod URLs and disable dev login** (`app.isPackaged`). Dev
  targeting only exists via the unpackaged `dev:cloud` / `dev:local` scripts.
- **No server-side version awareness.** The overlay never transmits its version. The
  server pushes `app:update-available` (latest, from the `Release` table via
  `getLatestVersion()`) on WS connect; the client compares locally and shows a passive
  notification. Nothing rejects an old build.

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | QA tester auth model | **Enforced QA role via Discord OAuth** — server checks the QA role before issuing a session |
| D2 | Golden-build identity / enforcement | **Version-string lock** — server stores the active dev version; overlay sends its version; non-match is hard-rejected |
| D3 | Cloudflare bypass | **Path-bypass on the same host** — open the overlay paths, keep dashboard/admin SSO-gated |
| D4 | QA role placement | **Dev guild only** — dev bot reads it directly; no prod round-trip |
| D5 | Flipping the active build | **Admin endpoint** (Redis/DB-backed value, default from env) — one call, no redeploy |
| D6 | Build delivery | **Posted to the existing dev Discord updates channel** — binary is useless without the server-side QA gate, so the link needn't be secret |

## Architecture

### 1. QA Discord role (dev guild only) — D4

- Create a `QA` role in the **dev** Discord server. New env `DEV_QA_ROLE_ID` on
  `backend-dev`.
- The dev bot is already in the dev guild, so it reads the calling user's member object
  (roles included) directly — no prod-side `verify-dev-role` round-trip.
- Onboarding = invite tester to the dev Discord + assign the QA role.
- Revocation = remove the role → access lapses within the session TTL (see §4).

### 2. QA login: Discord OAuth that issues a regular-user session — D1

This finishes the deferred "OAuth issues a session" wiring, scoped to the overlay and
gated on the **QA role** (not the dual developer role). It runs on `backend-dev` only.

Flow:

1. The golden build shows **"Sign in with Discord (QA)"**.
2. Overlay opens the system browser to `…/auth/discord/qa/start`, passing the
   `installToken` + a CSRF `state` and a **loopback redirect** (an ephemeral
   `127.0.0.1:<port>` listener the overlay spins up for this login). This reuses/extends
   the existing overlay Discord-link OAuth plumbing (`/auth/discord/*` in
   `cross-platform-overlay/main.js` + the backend route).
3. User authorizes with the **dev** Discord application; scopes `identify
   guilds.members.read`.
4. `…/auth/discord/qa/callback`:
   - Exchange code → resolve the verified Discord identity.
   - Read the user's roles in the **dev guild** (dev bot member lookup, the same
     boundary `devAuthService` already uses) and check for `DEV_QA_ROLE_ID`.
   - **Absent** → deny with a clear message ("You need the QA role in the FCM dev
     Discord").
   - **Present** → upsert a `User` row for this Discord ID and mint the normal
     `X-Auth-Token` **session**, then 302 the browser to the overlay's loopback
     redirect carrying the token.
5. Overlay captures the token from the loopback hit, stores it in-process (as today),
   and connects the WebSocket.

The issued session is a **plain `user`** — QA testers chat as normal users; the QA role
gates *getting in*, it is not a chat privilege.

### 3. The golden build: a packaged build pointed at dev — D2/D6

- Replace the `isPackaged`-based prod assumption with a **build channel** constant
  injected at build time, e.g. `__BUILD_CHANNEL__ ∈ {'stable','qa'}` (Vite define +
  electron-builder config), distinct from `app.isPackaged`.
- The `qa` channel bakes in: dev relay URLs (`https://dev.falloutchatmod.com`,
  `wss://dev.falloutchatmod.com/ws`), the QA-OAuth login UI (instead of install-token
  registration), and a version string carrying a `-qa` marker.
- Produced as a **distinct artifact** ("Fallout Chat Mod QA"); the prod/stable build is
  untouched and continues to point at prod with dev login disabled.
- The QA build download is posted to the **existing dev Discord updates channel** (the
  same announcement surface release notes use); no separate gated download is needed.

### 4. Golden-build version lock (deactivation) — D2/D5

- The overlay sends **`X-Client-Version`** on the WS upgrade request and on the QA
  login/registration HTTP calls.
- `backend-dev` holds a single **active QA version** in a flip-able store
  (Redis/DB-backed; defaults from a `QA_ACTIVE_VERSION` env on boot). It is **kept
  separate from the `Release` table** on purpose: the `Release` table feeds prod's
  `app:update-available` via `getLatestVersion()`, so a `-qa` version must never leak
  there and nag prod users.
- **Flip control (D5):** `POST /api/admin/qa/active-version` (admin-authed) sets the
  active version live — blessing a new build is one call, no redeploy.
- **Gate (dev-only, behind a `QA_BUILD_LOCK` flag):**
  - WS handshake (after auth succeeds): if `X-Client-Version` ≠ active QA version →
    `ws.close(4010, 'OUTDATED_BUILD')` with a payload pointing to the current download.
  - QA login/registration REST path: reject early with **`426 Upgrade Required`** so the
    user gets a clear message before the WS even opens.
- **Session TTL** for QA sessions is kept short so role removal (and a build flip) take
  effect promptly; an optional periodic re-check that drops live sessions on role loss
  is a later enhancement.
- **Accepted limit:** `X-Client-Version` is a forgeable header. This is acceptable —
  the real identity/revocation control is the QA-role gate, and dev data is fake by
  construction. The version-string lock's job is to keep honest testers current and
  block casual use of stale builds, not to be tamper-proof (that is why D2 chose
  version-string over an opaque token).

### 5. Cloudflare Access path-bypass (`dev.falloutchatmod.com`) — D3

Keep one host; open only the overlay surface and keep the human surface SSO-gated. CF
Access evaluates the most-specific path first, so sub-path policies override the broad
one:

- **Bypass (no Access):** `/ws`, `/auth/discord/*` (the QA OAuth), and the `/api/*`
  routes the overlay uses.
- **Keep SSO Access:** `/api/admin/*`, `/api/internal/*`, and the dashboard web app
  (root + static assets).
- **Verify** that a WebSocket upgrade succeeds through an Access *bypass* application.
- App-level auth is the sole boundary on the bypassed surface — mitigated by the
  QA-role gate (§2), the version lock (§4), fake dev data by construction, and keeping
  `/api/admin/*` + `/api/internal/*` SSO-gated as defense-in-depth.

## New / changed surfaces (summary)

- **Endpoints (backend-dev):**
  - `GET /auth/discord/qa/start` — begin QA OAuth (installToken + state + loopback).
  - `GET /auth/discord/qa/callback` — role-check + mint session + redirect to loopback.
  - `POST /api/admin/qa/active-version` — admin sets the active QA version.
- **Env (backend-dev):** `DEV_QA_ROLE_ID`, `QA_ACTIVE_VERSION` (default), `QA_BUILD_LOCK`
  (enable gate).
- **WebSocket:** new request header `X-Client-Version`; new close code `4010
  OUTDATED_BUILD`.
- **HTTP:** `426 Upgrade Required` on the QA login path for a stale build.
- **Overlay:** `__BUILD_CHANNEL__` build constant; QA-OAuth login UI; loopback redirect
  listener; sends `X-Client-Version`; handles `4010` / `426` with an "update your QA
  build" prompt linking to the dev Discord updates post.
- **Discord:** `QA` role in the dev guild.
- **Cloudflare:** path-bypass policy as in §5.

## Security model & accepted risks

- The QA-role Discord check is the **real, per-person, revocable** access gate.
- Removing CF Access from the overlay paths means app-level auth is the boundary there;
  this matches the existing hosted-dev threat model (dev data is fake by construction; a
  gate bypass exposes no secrets). Admin/internal stay SSO-gated.
- The version header is forgeable (accepted, see §4).
- No prod secret or prod data is reachable from any of this; all new code paths are
  dev-only and flag-gated.

## Testing (hard rule: ships with tests + CI)

- **Unit:** QA-role resolution from dev-guild roles; the version-lock comparison/gate as
  a pure function (match / stale / missing-header); the OAuth callback role-check with an
  injectable Discord-fetch boundary (granted vs denied); REST `426` and WS `4010`
  rejection paths.
- **Overlay (Vitest):** `__BUILD_CHANNEL__` selects dev URLs + QA login; loopback token
  capture; `4010`/`426` handling shows the update prompt.
- **CI:** extend the existing Vitest (overlay) / Jest (backend) suites; the pure
  version-lock function and role-check are the priority gates.

## Docs to update (hard rule: docs in sync)

- `docs/deployment/hosted-dev-environment.md` — QA onboarding path, CF bypass policy,
  new env vars, the QA role.
- `docs/overlay/` — the QA build channel, version lock, `X-Client-Version`, `4010`.
- `docs/backend/` — the three new endpoints.
- `docs/realtime/` — `X-Client-Version` header + `4010 OUTDATED_BUILD` close code.

## Maintainer / infra steps (manual, not code)

1. Create the `QA` role in the dev Discord; set `DEV_QA_ROLE_ID` in the `fcm-dev`
   Dokploy env.
2. Add the CF Access path-bypass policy (§5) on `dev.falloutchatmod.com`.
3. Set `QA_ACTIVE_VERSION` / `QA_BUILD_LOCK` in the dev env.
4. Add a second Discord OAuth redirect URI for the QA callback if a distinct path is
   used.
5. Build + post the first golden QA build to the dev Discord updates channel; flip the
   active version via the admin endpoint.

## Open implementation details (bounded, resolved during planning)

- Confirm the exact token hand-back mechanism against the current `/auth/discord/link`
  flow in `main.js` (loopback redirect is the chosen approach; align with existing code).
- Decide the store for the active QA version (Redis key vs a small config row) — both
  satisfy D5; pick the one that matches existing config patterns.
- Confirm the precise `/api/*` sub-paths the overlay needs, to scope the CF bypass
  minimally while keeping `/api/admin/*` and `/api/internal/*` gated.
