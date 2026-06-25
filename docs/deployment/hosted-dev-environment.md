# Hosted Development Environment

A safe, isolated development stack hosted on the same Dokploy VPS as production,
that external contributors can use **without** the ability to reach, break, or
affect production or any confidential data.

This document is the architecture + runbook for the hosted dev environment,
which is **live and deployed** as of 2026-06-11.

---

## Design goals

1. Contributors branch off `dev`, open PRs against `dev`, and the maintainer
   reviews **before** anything merges. (Policy — see [ci-cd-pipeline](../testing/ci-cd-pipeline.md)
   and the branch-protection note in [CLAUDE.md](../../CLAUDE.md).)
2. Contributors can develop against a realistic dataset: **real** wiki/camp
   reference data plus **fake** users, chat history, parties, and avatars.
3. Contributors can pull that dataset down (`pg_restore`) to a fully-local stack,
   **or** connect to the hosted dev DB / object store remotely.
4. None of the above can expose confidential production data or compromise the
   production VPS.

## The one hard rule

> **Developers connect to DEV only. They never touch production — not the
> database, not the object store, not production credentials.**

Production is the only place confidential data lives (real users, real chat, and
especially **ban/report evidence**). The bridge from prod to dev is a one-way
**sanitizing seed pipeline that only the maintainer runs** (see
[Seed pipeline](#seed-pipeline)). Confidential data never leaves prod; dev
receives only public reference data + generated fakes. Because the dev dataset is
non-confidential **by construction**, remote dev access is safe.

---

## Architecture

```
                        Cloudflare Edge
                              │
        ┌─────────────────────┼──────────────────────────┐
        │ (Access: SSO)       │ (Access: service token)   │ (Access: service token)
        ▼                     ▼                           ▼
  dev.falloutchatmod.com   dev-db.falloutchatmod.com   dev-s3.falloutchatmod.com
        │                     │  (TCP)                    │  (TCP)
        └─────────── cloudflared-dev (dedicated tunnel) ──┘
                              │
                    fcm-dev-network  (private — NOT dokploy-network)
        ┌─────────────┬───────┴────────┬──────────────────┐
        ▼             ▼                ▼                  ▼
   backend-dev    postgres-dev     redis-dev          minio-dev
   (NODE_ENV=     (own role,       (own password)     (own creds,
    development)   dev DB only)                         public prefixes
                                                        + fake avatars)
```

**Isolation boundaries — these are what protect production:**

| Boundary | Implementation |
|----------|----------------|
| Separate Dokploy project | `fcm-dev`, own compose (`deploy/dev/docker-compose.yml`) |
| Network | Private `fcm-dev-network`; **does not** join `dokploy-network`. Network membership is not transitive, so dev containers have no route to prod containers. |
| Data stores | Own `postgres-dev` / `redis-dev` / `minio-dev` containers + volumes. Never reuse prod's. |
| Credentials | Own dev DB password, Redis password, MinIO creds, `SESSION_SECRET`, Discord app. **Zero overlap with prod.** A full dev compromise leaks no prod secret. |
| Resource limits | Memory + CPU caps on every dev service so a runaway/abusive dev container cannot starve prod. |
| Ingress | Dedicated `cloudflared-dev` tunnel attached only to `fcm-dev-network`. |
| Access | Cloudflare Access in front of every dev hostname. Per-developer, logged, instantly revocable. |

Because contributors get **application-level access only** (no SSH, no Dokploy
rights, no container shell), the usual shared-VPS risk — hostile code execution →
container escape — does not apply. The only surface a malicious dev has is the
dev app's own API as a logged-in user, and the dev data behind it is all fake.

**Deploy mechanism:** `fcm-dev` tracks the **`dev`** branch and auto-deploys via
the Dokploy **GitHub App** integration (`autoDeploy=true`) — i.e. a push to `dev`
redeploys the stack. (It does **not** use a manual deploy-token webhook; the
per-app deploy token `…/api/deploy/compose/<token>` belongs to whichever compose
owns that token — do not point a GitHub repo webhook at the prod compose's token.)

---

## Secure remote access (the critical part)

**Do NOT publish Postgres or MinIO ports to the internet, even for dev.** A naked
public database port is an attack surface regardless of how good the password is.

Instead, expose them as **TCP routes through the dedicated Cloudflare tunnel,
gated by Access service tokens:**

- `cloudflared-dev` publishes:
  - `dev.falloutchatmod.com` → `backend-dev:7676` (HTTP, Access = email/SSO allowlist)
  - `dev-db.falloutchatmod.com` → `postgres-dev:5432` (TCP, Access = service token)
  - `dev-s3.falloutchatmod.com` → `minio-dev:9700` (TCP, Access = service token)
- Each contributor runs a local Cloudflare client to reach the DB/object store:

  ```bash
  # Authenticated, short-lived, revocable — no public DB port exists
  cloudflared access tcp --hostname dev-db.falloutchatmod.com --url localhost:5432
  # then, in another shell:
  psql postgresql://dev_user:<dev_pw>@localhost:5432/fo76_chat_dev
  pg_dump  ... / pg_restore ...
  ```

- Access tokens are issued per developer and can be **revoked instantly** in the
  Cloudflare Zero Trust dashboard the moment someone leaves or misbehaves.

The `postgres-dev` role is scoped to **only** the dev database (it is not a
cluster superuser), so even full DDL rights have a blast radius of "re-run the
seed script."

---

## Data classification

Derived from `backend/prisma/schema.prisma` (40 models). The seed pipeline copies
the first group verbatim and **generates** the second.

**Copy 1:1 — public reference data:**
- `WikiEntry`, `WikiImage`, `WikiAlias`, `CampItem` — synced game data
- `Channel`, `Release`, `ChatCommand` — structure / config
- Object store: wiki & camp image prefixes

**Generate fake — never copied from prod:**
- `User` (+ `UserAlias`, `Device`, `Session`, `WorldSession`) — PII
- `Message`, `PartyMessage`, `ServerMessage` — chat content
- `Report`, `PlayerReport`, `Ban`, `BanEvidence`, `AuditLog`, `StaffApplication`
  — moderation / evidence (the most sensitive data in the system)
- `Party`, `PartyMember`, `PartyInvite`, `Block` — private social graph
- Object store: avatars (regenerate placeholders); **evidence bucket never touched**

Anything not listed above defaults to **fake/empty** until explicitly classified
as public. When in doubt, fake it.

---

## Seed pipeline

`backend/scripts/seed-dev.ts` — **maintainer-run only.** Produces the safe dev
dataset and a portable dump artifact.

1. `pg_dump` the reference tables only (`-t wiki_* -t camp_items -t channels …`)
   from prod (read-only) or from the existing dev DB.
2. Generate fake users (extends the existing `SIM_NAMES` set in
   [`simUsers.ts`](../../backend/src/routes/simUsers.ts) + `faker`), fake chat
   history across channels, fake parties and memberships.
3. Mirror only the **public** object-store prefixes (wiki/camp images) into
   `minio-dev`; generate placeholder avatars. Never touch the evidence bucket.
4. Emit a sanitized `dev-seed.dump` artifact that contributors `pg_restore` into
   a fully-local stack.

Re-seeding the shared dev DB is a single command, so the dev DB is treated as
**disposable** — anything a dev breaks is recoverable by re-seeding.

### Live fake-chat stream

Extends the existing sim infrastructure: a dev-only, gated
`POST /api/admin/sim/stream` endpoint drips fake messages through the real
WebSocket broadcast path so contributors see a live, moving feed (the
long-ago fake-chat-stream test, reimplemented). It rides on the existing
sim-user accounts created by `POST /api/admin/sim/users`.

**Contract** (`backend/src/routes/simUsers.ts`, mounted only under the
`NODE_ENV === 'development' && ENABLE_DEV_LOGIN` guard at `server.ts:1039`):

```
POST /api/admin/sim/stream
Authorization: Bearer <ADMIN_API_KEY>        # constant-time check; 403 otherwise
Body: {
  count?: number       # default 20, clamped 1..200
  intervalMs?: number  # default 1500, clamped 100..30000
  channelId?: string   # default General channel 00000000-0000-0000-0000-000000000001
}
→ 200 { "data": { "started": true, count, intervalMs, channelId, authors } }
```

Returns immediately (fire-and-forget `setInterval`, `unref`'d so it never holds
the event loop open) and self-terminates after `count` messages. Each drip is a
synthetic, templated FO76-flavored line authored by a randomly-picked seeded sim
user, emitted through **the same `handlers.broadcast()` path the live
`chat:message` hot path uses** (so it fans out to every connected WS client and
the in-game HUD feed) and queued for write-behind persistence via the
`message-persist` queue — exactly like a real message. If no sim users have been
seeded yet, drips fall back to ephemeral authors and are broadcast-only (not
persisted). Tests: `backend/tests/simStream.test.js` (auth 403, SR-006
production-404 gate, happy-path drip + persistence).

---

## Migration strategy

**Local-only migration development** (chosen policy):

- Contributors develop migrations against their **own local restore** of
  `dev-seed.dump`. They iterate freely and cannot affect anyone else.
- The **shared dev DB** receives migrations only via the reviewed
  PR → CI → Dokploy deploy flow — never ad hoc from a contributor's machine.
- This avoids the "many devs, one shared DB, stomping migrations" failure mode
  while keeping the shared dev DB stable for everyone using it.

---

## Discord dev environment

A separate, throwaway Discord setup so the bot bridge is testable without any
risk to the live community:

- A **separate Discord application** — its own client ID / secret / **token**,
  redirect URI → `https://dev.falloutchatmod.com/auth/discord/callback`.
- A **throwaway dev Discord server** the dev bot lives in, with minimal intents
  and permissions.
- `backend-dev` holds the dev token; **contributors never hold it** — they test
  by *interacting* with the dev bot in the dev server. Worst-case malicious
  outcome is a wrecked disposable server, never the production community.
- `ENABLE_DEV_LOGIN=false` on the **hosted** `backend-dev`. Access to the hosted
  dev environment is gated by the dual Discord role check (see
  [Developer authorization](#developer-authorization--dual-discord-role-gate)),
  so the credential-less persona login must NOT be open on the hosted instance.
  Personas remain available only on contributors' **fully-local** stacks
  (`docker-compose.dev.yml`), where there is nothing to protect. The production
  boot guard already forbids dev-login when `NODE_ENV=production`.

---

## What is safe vs. what is explicitly forbidden

| Capability | Verdict |
|------------|---------|
| Devs pull/restore dev data to a local stack | Safe |
| Devs connect to dev DB / object store remotely | Safe — **via tunnel + Access tokens**, never open ports |
| Devs run migrations / `pg_dump` / `pg_restore` on dev | Safe — scoped role, fake data, one-command re-seed |
| Copy real wiki/camp data into dev | Safe — public reference data |
| Fake users + fake chat + live stream | Safe — built on existing sim infrastructure |
| Devs connecting to **production** DB / object store | **Forbidden** — maintainer-run sanitizing pipeline instead |
| Naked public Postgres / MinIO ports | **Forbidden** — tunnel + Access tokens |
| Copying real users / chat / **evidence** into dev | **Forbidden** — generated fakes only |
| Devs with SSH / Dokploy / container shell on the VPS | **Forbidden** — app-level access only |

---

## Security hardening requirements

These are mandatory controls surfaced by the security review of this design.
Treat them as part of the definition of done, not optional polish.

- **Dev-specific `ADMIN_API_KEY` (SR-001).** The dev stack MUST use its own
  `ADMIN_API_KEY` / `SESSION_SECRET`, never prod's. `ENABLE_DEV_LOGIN=true` plus a
  shared admin key would let a dev-login persona reach prod-equivalent admin
  surfaces. Dev keys are dev-only.
- **Read-only prod extract role (SR-002).** The seed pipeline connects to prod
  through a dedicated **read-only** Postgres role (SELECT on the reference tables
  only). Prod credentials live only on the maintainer's machine for the duration
  of the extract — never in the dev stack, repo, or Dokploy env.
- **Access service-token expiry (SR-003).** TCP routes (`dev-db`, `dev-s3`) use
  Access **service tokens with a bounded lifetime** (rotate on a schedule and on
  any contributor departure). Prefer per-developer tokens for attribution +
  instant revocation.
- **Generator uses zero real content (SR-004).** Fake users/messages MUST be
  synthesized (faker + the static `SIM_NAMES` set). The generator may NOT sample,
  echo, or derive from real prod usernames, message text, or any confidential
  column. Realism comes from templates, never from prod rows.
- **Object-store copy is a fail-closed allowlist (SR-005).** Mirror only an
  explicit allowlist of public prefixes (wiki/camp images). A new/unknown bucket
  or prefix is NOT copied by default. Strip EXIF/metadata on copy.
- **Sim routes stay `NODE_ENV`-gated (SR-006).** The existing sim routes are
  already mounted only under `NODE_ENV === 'development' && ENABLE_DEV_LOGIN`
  (`server.ts:1039`) — good. The new `/api/admin/sim/stream` MUST be added under
  that **same** guard (not mounted unconditionally), keeping the `ADMIN_API_KEY`
  check as a second layer. Add a test asserting the sim routes 404 when
  `NODE_ENV=production`, so a future refactor can't silently expose them.

### Untrusted fork PRs + self-hosted runners (SR-008) — label-gate approach

External contributors open PRs against `dev`, while CI runs on `[self-hosted, …]`
runners. Running fork-PR workflows on self-hosted runners is a remote-code-
execution vector. The chosen mitigation is a **maintainer-applied label gate**
(implemented in `.github/workflows/ci.yml` + `pr-gate-delabel.yml`):

- **Label-triggered, not open-triggered** — `ci.yml` fires on `pull_request:
  types: [labeled]` (plus `push` to prod/dev), never on PR open or a
  contributor's push. CI simply does not start for a PR until a label event.
- **`authorize` gate job** — every CI job `needs: authorize`. It passes for
  pushes to prod/dev, and for **any PR (fork or same-repo) only when the
  `ci-approved` label is present.** Until then, nothing runs on the runners.
- **Only maintainers can trigger it** — applying a label requires write/triage
  access, which fork authors do not have. "Only I can run it" is enforced by
  GitHub permissions; keep the triage+ collaborator set small.
- **TOCTOU guard (the must-have)** — `pr-gate-delabel.yml` removes the
  `ci-approved` label on every new push (`synchronize`), so a contributor cannot
  get a clean diff approved and then sneak a malicious commit in afterward. Each
  new commit disarms CI and forces re-review.
- **No false green** — `ci-summary` treats a *skipped* required job (unlabeled
  fork PR) as a failure, so an unreviewed fork PR can never show a green required
  check.

What the label gate does **not** cover (accepted risk): once you approve, the
code still runs on the self-hosted runner. Two residual controls:
- **Secrets**: the `pull_request` test jobs run with a read-only token and no
  release/deploy secrets. Keep all secret-bearing jobs (signing, publish, deploy)
  on `push: prod` / post-merge only — never on `pull_request`.
- **Runner isolation**: human review of the diff is the barrier before untrusted
  code executes. If stronger isolation is wanted later, move PR-validation to an
  ephemeral runner pool. See [Runner hardening](#runner-hardening-notes).

### Runner hardening notes

The runners stay as-is (self-hosted), relying on pre-merge review + the label
gate. Two low-cost hardening items — **both now applied**:

- **Actions pinned by commit SHA (done).** All actions across `ci.yml`,
  `pr-gate-delabel.yml`, and `build-windows.yml` are pinned to full commit SHAs
  with a `# vX.Y.Z` comment (checkout v4.3.1, setup-node v4.4.0, cache v4.3.0,
  upload-artifact v4.6.2, github-script v7.1.0), closing the moving-tag
  supply-chain hole. Re-pin when bumping versions.
- **`GITHUB_TOKEN` scoped (done).** `ci.yml` and `build-windows.yml` set a
  top-level `permissions: contents: read`; `pr-gate-delabel.yml` overrides with
  `pull-requests: write` (it only edits labels, checks out no code).

## CI consolidation

The CI workflow had accumulated many jobs. **Done** — the following consolidations
were applied to `.github/workflows/ci.yml` (job count 11 → 8) without changing
what is *covered*, only how work is grouped:

| # | Merge | From → To | Benefit |
|---|-------|-----------|---------|
| A | Unit (Vitest) jobs | `overlay-unit-component` + `dashboard-unit-component` → one matrix job `unit-vitest` (matrix: `cross-platform-overlay`, `admin-dashboard`) | 2 jobs → 1 |
| B | Linux overlay E2E | `overlay-launch-smoke` + `overlay-autoupdate-e2e` → one `overlay-e2e-linux` job running both as sequential steps (auto-update E2E since removed; job now only runs the launch-smoke step, renamed to `overlay-launch-smoke-linux`) | 2 jobs → 1, and **removes a duplicate renderer + electron build** |
| C | Dead placeholder | delete `dashboard-playwright` (`if: false`, never runs) | removes noise |

**Tradeoffs (accepted):**
- Merge B (historical): originally coupled launch-smoke and auto-update checks. The auto-update E2E step was subsequently removed when auto-update was retired; the job now runs only the launch-smoke.
- Merge A: a matrix job reports one check with two legs; a failure still names the
  failing workspace via the matrix leg.

**Constraints:**
- Every consolidated job keeps `needs: authorize` (fork-PR gate) and stays in the
  `ci-summary` required list under its new name.
- `overlay-build-windows-nsis` (renamed from `overlay-autoupdate-e2e-windows`) is the remaining Windows CI job; the native-Windows execution job (`overlay-autoupdate-e2e-windows-exec`) was removed when auto-update was retired.
- This is the fail-closed release gate — land it as one change and confirm a full
  green run on a same-repo PR before relying on it.

## Dev Discord provisioning (clone prod layout + roles)

Goal: stand up the throwaway dev server with the **same channel/role layout** as
production so testing is realistic, without copying members, messages, or any
confidential data.

Two complementary mechanisms:

1. **Discord Server Template (fastest, no code).** In the prod server:
   Server Settings → Templates → Create Template. Use the resulting URL to create
   the dev server. A template copies **roles** (names, colors, permissions,
   hierarchy), **channels/categories**, and **permission overwrites** — but
   **not** members, role assignments, messages, emojis, webhooks, integrations,
   or bans. This gets the structure in one click.

2. **Bot-driven provisioning script (repeatable + captures new IDs).**
   `backend/scripts/clone-discord-layout.ts` (discord.js) reads the source guild's
   roles/channels and recreates anything the template missed in the target guild,
   then **prints the new role-ID mapping**. This is necessary because cloned roles
   get **brand-new IDs** in the dev server, and the dev backend's
   `OWNER_ROLE_ID` / `ADMIN_ROLE_ID` / `MODERATOR_ROLE_ID` env vars must point at
   the **dev** server's IDs, not prod's. The script outputs ready-to-paste env
   lines for the dev Dokploy project.

The dev bot needs **Manage Roles / Manage Channels** in the dev server only.
It must NOT be added to the production server. As with all dev secrets, the dev
bot token lives only in `backend-dev` — contributors never hold it.

## Developer authorization — dual Discord role gate

**Requirement:** to log in to the hosted dev environment or use *any* dev tool
(dashboard, remote DB, `pg_dump`/`pg_restore`, migrations, object store), a user
MUST simultaneously hold the **developer role in BOTH** the production guild
**and** the dev guild. Either one alone grants nothing.

This is an **access** control (who may consume dev resources and run the DB
tools), not a data-confidentiality control — the dev dataset is fake by
construction, so a gate bypass would expose no secrets. Its job is to ensure only
vetted, active contributors can touch the environment, and that access drops the
moment you remove a role in either server.

### Identity and verification

The dev backend is the verification authority. A contributor authenticates with
the **dev Discord application** (OAuth2), and the backend confirms both roles
before issuing anything.

- **OAuth scopes:** `identify guilds.members.read`. With `guilds.members.read`
  the backend can read the calling user's own member object (roles included) in a
  specific guild via `GET /users/@me/guilds/{guild_id}/member`.
- **Dev-guild check (always local):** the dev bot is in the dev guild, so the
  backend reads the user's roles there directly and checks for `DEV_DEVELOPER_ROLE_ID`.
- **Prod-guild check — live implementation.** Discord's
  `guilds.members.read` endpoint (`GET /users/@me/guilds/{guild.id}/member`)
  **requires the application's bot to be a member of that guild.** Since the dev
  bot is deliberately NOT in the prod server, the OAuth-scope approach **cannot**
  read the prod-guild role (confirmed: the per-guild *member* endpoint is gated on
  bot presence, unlike the bot-free `/users/@me/guilds` list). The prod check uses:
  - **Narrow prod verification endpoint (deployed).** The prod backend exposes
    `GET /api/internal/verify-dev-role?discordId=…` — authenticated with a shared
    **service token**, rate-limited, returning **only** `{ "hasDevRole": boolean }`.
    The **prod bot** (already in the prod guild) performs the lookup via
    `GET /guilds/{guild.id}/members/{user.id}` (bot token). The prod bot token
    stays on prod; the dev side learns only a boolean. The dev app still uses
    OAuth to obtain the user's verified Discord ID, then asks prod about it.
  - The dev-guild check still uses the dev bot directly (it IS in the dev guild).
  - *(The 403-on-bot-absent behaviour was confirmed live: `GET /api/internal/verify-dev-role`
    returns `{ "hasDevRole": boolean }` from prod, verified returning 200 in production.)*

Both checks must return true. Configuration on the dev backend is **IDs + the
prod verification endpoint/token**, never prod secrets: `PROD_GUILD_ID`,
`PROD_DEVELOPER_ROLE_ID`, `DEV_GUILD_ID`, `DEV_DEVELOPER_ROLE_ID`, plus
`PROD_VERIFY_URL` + `PROD_VERIFY_TOKEN` (required, since the prod check must go
through the prod-bot endpoint per the research above).

### Broker: tying verification to tool access

Verification gates two things, both **short-lived** so role removal takes effect
quickly:

1. **App session.** The dev backend issues its dashboard/app session only after
   both roles verify. No persona login on the hosted instance
   (`ENABLE_DEV_LOGIN=false`).
2. **Infra credentials (DB / object store).** Currently, the maintainer issues the
   `fcm-dev-access` CF Access service token directly to vetted developers. The
   full broker (backend-minted short-lived credentials + `fcm-dev-cli login`) is
   **deferred** — the core `verifyDualRole` logic is built and tested, but the
   OAuth flow wiring and credential-issuance endpoints are not yet wired into
   `server.ts`. `pg_dump`/`pg_restore`/migrations run against the tunnel using the
   directly-issued service token today.

### Expiry and revocation

- All issued credentials are **short-TTL** (re-verify to refresh). Removing the
  developer role in **either** guild fails the next verification, so access lapses
  within the TTL — no manual cleanup needed.
- Issuance is **logged per developer**; Access tokens are revocable instantly in
  Cloudflare for immediate cutoff.
- Optional belt-and-braces: a periodic re-check that revokes active sessions when
  a role disappears mid-session, rather than waiting for TTL.

### Build surface

- **Built:** `verify-dual-role` pure core — `backend/src/services/devAuthService.ts`
  (`verifyDualRole` + `checkDeveloperAccess` with an injectable Discord-fetch
  boundary) + `backend/tests/devAuthService.test.js`. The four guild/role env vars
  + `PROD_VERIFY_URL`/`PROD_VERIFY_TOKEN` are declared in `environment.ts`.
- **Built (prod verification endpoint):** `GET /api/internal/verify-dev-role` on
  **prod** — `backend/src/controllers/verifyDevRoleController.ts` (handler +
  injectable `defaultProdMemberRolesFetcher`) and `backend/src/routes/verifyDevRole.ts`
  (mounted at `/api/internal` in `server.ts`, own 30/min/IP limiter). Auth is
  `Authorization: Bearer <PROD_VERIFY_TOKEN>` (constant-time). The **prod bot**
  (already in the prod guild) looks the member up via `GET /guilds/{guildId}/members/{userId}`
  with the bot token; a 404 (member not in guild) → `hasDevRole:false`, a transport
  failure → `502`. The response is **only** `{ "data": { "hasDevRole": boolean } }` —
  no roles/usernames leak. Tests: `backend/tests/verifyDevRole.test.js`.
- **Built (dev-side fallback path):** `makeDevSideDeps(prodVerify?, devBotToken?)`
  in `devAuthService.ts` — a `DevAuthDeps` impl where prod-guild reads delegate to
  the prod endpoint (`defaultProdVerifyClient` → `PROD_VERIFY_URL` +
  `PROD_VERIFY_TOKEN`) and dev-guild reads run locally via the dev bot. Both
  boundaries are injectable (unit-tested without network).
- **Deferred (not yet built):** dev OAuth flow wiring into `server.ts`; the broker that
  mints/returns short-lived Access + DB credentials; `fcm-dev-cli login`.

## QA tester access

External QA testers need access to the live hosted dev environment but are not developers.
They install a pre-built QA build of the overlay (the `dist:qa` artifact), log in with
Discord via the QA OAuth flow, and connect to `dev.falloutchatmod.com`. They never touch
the dev Discord application credentials, the database, or the object store.

### Cloudflare Access path-bypass policy

The overlay is a native application that makes unauthenticated (no browser cookie/SSO)
HTTP and WebSocket calls to the backend. Cloudflare Access uses its own HTTPS intercept
for SSO; that intercept breaks WebSocket upgrades and API calls from non-browser clients.
The fix is to add CF Access applications that **bypass** Access for the overlay surface
while keeping SSO enforcement on the human (dashboard) surface.

CF evaluates policies from most-specific path first. On `dev.falloutchatmod.com` configure:

| Policy | Path(s) | Action | Reason |
|--------|---------|--------|--------|
| Bypass | `/ws` | Bypass | WebSocket upgrade path |
| Bypass | `/auth/discord/qa/*` | Bypass | QA OAuth start + callback |
| Bypass | `/api/auth/qa-status/*` | Bypass | QA login polling endpoint |
| Bypass | `/api/*` | Bypass | All overlay REST calls (register, channels, messages, etc.) |
| Access (SSO) | `/api/admin/*` | Require "FCM Developers" group | Admin-only API |
| Access (SSO) | `/api/internal/*` | Require "FCM Developers" group | Internal endpoints |
| Access (SSO) | `/` (catch-all) | Require "FCM Developers" group | Dashboard root + static assets |

The `/api/admin/*` and `/api/internal/*` bypass-exceptions are evaluated before `/api/*`
because CF matches most-specific path first, so those paths stay SSO-gated even though
`/api/*` is bypassed.

**Verify WebSocket through the bypass:** after applying the policy, confirm that a WS
upgrade to `wss://dev.falloutchatmod.com/ws` with a valid `X-Auth-Token` header succeeds
(HTTP 101). If the upgrade receives HTTP 307 or an HTML redirect page, the `/ws` bypass
is not applied or the `*` path catch-all is overriding it.

### Security model on the bypassed surface

The overlay surface is bypassed at the CF layer; the application-level gate is the
security boundary. Two controls enforce it:

1. **QA role gate** - `GET /auth/discord/qa/callback` checks that the authenticated
   Discord user holds the `DEV_QA_ROLE_ID` role in the dev guild. No role = no session
   grant.
2. **Golden-build lock** - when `QA_BUILD_LOCK=true` the backend checks the
   `x-client-version` header on every WS upgrade and on `GET /api/auth/qa-status/:installToken`.
   A version that does not match `QA_ACTIVE_VERSION` receives close code `4003` (WS) or
   HTTP 426 (poll). This ensures only the currently-blessed QA build can connect.

The dev data is fake by construction (no real users, no real chat, no PII) so an attacker
who bypasses the application gate finds nothing confidential.

### Onboarding a QA tester

1. Invite the tester to the **dev Discord server** and assign them the **QA** role
   (`DEV_QA_ROLE_ID`).
2. Send them the `dist:qa` build artifact via the dev Discord updates channel.
3. They install and run it; the overlay opens the QA OAuth flow in-app.
4. The backend verifies their QA role and hands back a session token.

No CF Access group membership is needed for QA testers (they use the bypass path).
No email allowlist entry is needed.

**Revoke access:** remove the QA role from the tester in the dev Discord server. Their
next login attempt will fail the role check. Existing sessions expire at their natural
24-hour TTL.

### New env vars (dev backend only)

| Var | Purpose |
|-----|---------|
| `DEV_QA_ROLE_ID` | Discord role ID in the dev guild that grants QA tester access |
| `DISCORD_QA_REDIRECT_URI` | Explicit callback URI for QA OAuth; falls back to `<proto+host>/auth/discord/qa/callback` when empty |
| `QA_ACTIVE_VERSION` | The single currently-blessed QA build version string |
| `QA_BUILD_LOCK` | `true` to enforce the golden-build lock; `false` (default) to disable |

These vars are dev-only. The QA endpoints are only mounted when `NODE_ENV=development`
(see [dev-only endpoints](#dev-only-endpoints-nodeenvdevelopment) in the backend docs).

### Registering the QA OAuth redirect URI

In the Discord developer portal, add `https://dev.falloutchatmod.com/auth/discord/qa/callback`
as an allowed redirect URI on the **dev Discord application** (not the prod app). If
`DISCORD_QA_REDIRECT_URI` is set, use that value instead.

### Flipping the golden build

When a new QA artifact is ready, update the blessed version via the admin API:

```bash
curl -X POST https://dev.falloutchatmod.com/api/admin/qa/active-version \
  -H "x-admin-api-key: <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"version": "1.2.3"}'
```

Retrieve the current active version:

```bash
curl https://dev.falloutchatmod.com/api/admin/qa/active-version \
  -H "x-admin-api-key: <ADMIN_API_KEY>"
```

Post the new `dist:qa` artifact to the dev Discord updates channel so testers know to
reinstall before the old build stops connecting.

---

## Standup checklist

Code artifacts (in repo):
- [x] `deploy/dev/docker-compose.yml` — isolated dev stack (private `fcm-dev-network`,
      own volumes, resource limits, no `dokploy-network`)
- [x] `deploy/dev/.env.dev.example` — dev env template (placeholders only)
- [x] `backend/scripts/seed-dev.ts` — sanitizing seed + `dev-seed.dump` artifact
      (+ pure helpers `backend/src/utils/devSeedHelpers.ts`, tests
      `backend/tests/devSeedHelpers.test.js`)
- [x] `POST /api/admin/sim/stream` — live fake-chat-stream trigger (+ tests:
      `backend/tests/simStream.test.js`)
- [x] `backend/scripts/clone-discord-layout.ts` — recreate prod roles/channels in
      the dev guild + print the new role-ID env mapping
- [x] Dual-role auth core: `verify-dual-role` service + tests (OAuth/route wiring deferred)
- [x] `GET /api/internal/verify-dev-role` on prod + prod-bot lookup (only viable
      prod-guild check) — controller/route + dev-side `makeDevSideDeps` fallback +
      `backend/tests/verifyDevRole.test.js`
- [ ] Broker endpoints issuing short-lived Access + DB credentials; `fcm-dev-cli login`
      *(deferred — current onboarding uses the CF Access service token directly)*

Manual (maintainer) — **all done as of 2026-06-11:**
- [x] Created the `fcm-dev` Dokploy project; stack deployed and healthy
      (db / redis / discord all connected; builds from `dev` branch; autoDeploy off)
- [x] Dev secrets set in the Dokploy project env (never in the repo)
- [x] Dedicated `cloudflared-dev` tunnel stood up on `fcm-dev-network`
- [x] Cloudflare public hostnames + Access policies live:
      `dev.falloutchatmod.com` (HTTP → backend-dev:7676, Access: SSO / FCM Developers group),
      `dev-db.falloutchatmod.com` (TCP → postgres-dev:5432, Access: `fcm-dev-access` service token),
      `dev-s3.falloutchatmod.com` (TCP → minio-dev:9700, Access: `fcm-dev-access` service token)
- [x] Dev Discord application + throwaway dev server created; creds wired into Dokploy env
- [x] `developer` role created in BOTH guilds; `PROD_GUILD_ID`, `PROD_DEVELOPER_ROLE_ID`,
      `DEV_GUILD_ID`, `DEV_DEVELOPER_ROLE_ID`, `PROD_VERIFY_URL`, `PROD_VERIFY_TOKEN` set
      in the dev project env
- [x] Prod-guild check confirmed: `guilds.members.read` cannot read a bot-absent guild;
      prod-endpoint path (`GET /api/internal/verify-dev-role`) is the live implementation,
      verified returning 200 in production
- [x] `seed-dev.ts` run; dev DB / object store populated:
      channels 6, wiki_entries 10477, wiki_images 33044, wiki_aliases 11293,
      camp_items 5628, releases 224, chat_commands 32 (public reference data, copied from prod);
      60 fake users, 240 fake messages, 8 fake parties, 31 party_members (generated)
- [x] `fcm-dev-access` CF Access service token issued; revocation documented in Cloudflare
      Zero Trust dashboard

### Onboarding a new developer (canonical steps)

1. Grant the **developer role** in the **prod Discord server**.
2. Grant the **developer role** in the **dev Discord server**.
3. Add the developer's email to the **"FCM Developers" Cloudflare Access group**
   (Zero Trust → Access → Groups → FCM Developers → email allowlist).
4. If the developer needs direct DB / object-store access, share the `fcm-dev-access`
   **CF Access service token** and the `cloudflared access tcp` instructions above.

To revoke access: remove the role in either Discord server (blocks the next login/re-verify)
**and** remove the email from the CF Access group (blocks the overlay/dashboard immediately).
