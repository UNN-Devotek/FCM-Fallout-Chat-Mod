# Design Proposal — Developer Experience: Dual Onboarding Paths + Self-Service MCP

**Status:** PLANNING (design doc — not yet implemented)
**Scope:** Two standard developer onboarding paths + dev/prod MCP servers with
user-bound, self-service API tokens, configured for Claude Code, Codex, and
Antigravity.

## Locked decisions

- **Dev MCP capability:** read **+ dev-safe mutations** (sim chat stream, sim
  users, dev message send, etc.). Dev data is fake → low risk.
- **Credentials:** **per-developer from day one** — each dev mints their own MCP
  token. (No Cloudflare Access service tokens are issued — see below.)
- **MCP auth model:** **user-bound, self-service Personal Access Tokens.** A dev
  mints a token from their profile on the dev site; the token acts **on behalf of
  that user** (their permissions, their attribution in audit logs). The **MCP
  token is the only gate** — the MCP API is exposed on a non-Cloudflare-Access
  path. Default token expiry **90 days**.
- **Prod MCP:** **owner-only, CLI-minted, kept secret.** Only the maintainer ever
  has a prod token; it's minted via an owner-run CLI (not self-service), lives only
  in the maintainer's user-level config, and the prod MCP setup is **not described
  in the committed/contributor-facing docs** (owner-only/private notes). Locked down
  so no contributor knows how to obtain or use one.

---

## Part 1 — Two developer onboarding paths

Both paths are fully documented in a new `docs/deployment/developer-onboarding.md`
(decision table → Path A → Path B → shared git/PR flow → credential matrix).

### Path A — Local client → cloud dev backend

Run the **dashboard**, **Electron overlay**, and/or **game mod** locally, pointed
at `dev.falloutchatmod.com`. The dev works in their own branch and PRs against `dev`.

**The Cloudflare Access problem (and the fix).** `dev.falloutchatmod.com` is
behind Cloudflare Access SSO, so a local client's REST/WS calls hit the login
wall. Fix = the **CF Access service token** (`CF-Access-Client-Id` /
`CF-Access-Client-Secret` headers, the existing `fcm-dev-access` token, issued
**per-developer**):
- **Dashboard:** `vite.config.ts` proxy injects the headers server-side; the
  browser never sees them. Activated only when `VITE_API_URL` is non-localhost.
- **Overlay:** `main.js` attaches the headers to its relay HTTP/WS calls
  (`RELAY_HTTP`/`RELAY_WS` → `https://dev.falloutchatmod.com` / `wss://…/ws`). A new
  `dev:cloud` npm script. Additive — no effect when the CF vars are absent, so the
  prod path is untouched.
- **Game mod:** unchanged — the HUD TCP socket is always local (`127.0.0.1:4001`)
  and inherits the overlay's CF headers via the relay.

**Required code changes (the only blockers):** `vite.config.ts` proxy headers +
`main.js` CF-header support + `dev:cloud` script + a
`cross-platform-overlay/.env.local.example`. All additive.

**Credentials a Path-A dev needs:** dev-guild Discord account with the `developer`
role + their email in the "FCM Developers" CF Access group + their own CF service
token. They do **not** need the bot token or OAuth app secret (auth happens at the
dev backend).

### Path B — Full local stack

The existing flow, documented cleanly:
`docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d` → backend
(7076), dashboard (3200), Postgres/Redis/MinIO. Dev-login personas
(`ENABLE_DEV_LOGIN=true`), no Discord needed. Overlay via `npm run dev:local`.
Document the **7076 (Docker) vs 7177 (standalone) overlay port gotcha**.

### Path C — Local containers + cloud dev DB/object store (DEFERRED)

Run the app containers locally but use the **remote** dev Postgres + MinIO instead
of local ones (a compose override that omits the local data stores and points
`DATABASE_URL` / `MINIO_ENDPOINT` at dev). **Deferred** — a local backend reaching
a *remote* raw Postgres/MinIO needs a network-level gate (no app-token gates a raw
DB connection): either the Cloudflare Access service token on the `dev-db`/`dev-s3`
routes, or a VPN (Tailscale/WireGuard). Both conflict with or add to the
"no Cloudflare credentials" posture, and this mode must also disable the boot-time
`prisma db push` (so it can't mutate the shared dev schema). Revisit later; ship
Path A + Path B first.

### Credential distribution

| Secret | Path A | Path B | How shared |
|--------|--------|--------|------------|
| CF Access service token (per-dev) | required | — | secure share (1Password/Bitwarden), never git |
| Dev-guild membership + `developer` role | required | — | maintainer grants in Discord |
| CF "FCM Developers" group email | required | — | maintainer adds in Zero Trust |
| MCP token | self-service (profile) | self-service | minted by the dev themselves |
| Local DB/Redis/MinIO passwords | — | dev invents | their own `.env` |
| Bot token / OAuth secret / `PROD_VERIFY_TOKEN` | never | never | stays server-side |

---

## Part 2 — MCP servers (dev + prod)

### Architecture

- **Two stdio MCP servers** compiled from one `mcp/` package (peer to `backend/`),
  acting as **thin REST clients** to the existing API — zero new business logic,
  so every call still flows through existing auth, rate limiting, and audit.
- Dev MCP base URL **hardcoded** to `https://dev.falloutchatmod.com`; prod MCP to
  `https://falloutchatmod.com`. No knob to repoint dev → prod.
- One server binary, three client configs (see [Client configuration](#client-configuration)).

```
mcp/
  package.json  tsconfig.json
  src/
    shared/{client.ts, errors.ts, schema.ts}   # REST wrapper, RFC7807→McpError, zod schemas
    dev/{index.ts, tools/}                       # DEV entry (stdio) + tool defs
    prod/{index.ts, tools/}                      # PROD entry (stdio)
```

### Authentication — user-bound, self-service Personal Access Tokens

This is the core change from the maintainer-minted-key model.

**Self-service minting (dev dashboard profile).** A logged-in dev opens their
profile → **API Tokens** → "Generate token" (optional label; **default expiry 90
days**). The plaintext token is shown **once** (`fcm_mcp_<32 hex>`). They paste it
into their MCP client config. List + **revoke** from the same profile panel.

**Token = identity.** The token is bound to the minting user's Discord identity.
Every MCP request authenticated by it runs **as that user** — the backend resolves
token → `owner_id` → loads that user + their role, and the existing
role/permission middleware applies. A plain `developer` gets read + dev-safe
tools; a dev who is also a mod/admin in the dev env gets correspondingly more.
**Authorization is the user's real role, not a flat token scope.**

**Attribution.** Every MCP call writes an `AuditLog` row with `actorId = owner_id`,
`action = "mcp.<tool>"`, sanitized input, and the token label — so "who did what"
is always answerable.

**Backend pieces:**
- `mcp_api_keys` table: `id, key_hash (SHA-256, unique), label, owner_id (Discord
  id), env ('dev'|'prod'), created_at, last_used_at, expires_at, revoked_at`.
  Plaintext stored never; only the hash. (Idempotent Prisma migration per the
  migration hard rule.)
- `requireMcpToken` middleware: hash the presented `X-MCP-Token`, look up an
  active row for **this environment**, attach the resolved user as `req.user`
  (so downstream role guards work), bump `last_used_at`, reject revoked/expired.
- Self-service endpoints (Discord-session auth, on the dashboard):
  `GET/POST/DELETE /api/me/mcp-tokens` (list / mint / revoke own tokens).
- `mcpLimiter` rate limiter keyed on token hash; MCP audit-log writes.

**Environment firewall.** Dev tokens live only in the dev backend's
`mcp_api_keys`; prod tokens only in prod's. A dev token presented to prod has no
matching row → rejected. Two independent firewalls (hardcoded URL + per-env table).

**No Cloudflare Access for the MCP (decided).** The MCP API is exposed on a
**dedicated path/hostname that is NOT behind Cloudflare Access** (e.g.
`/api/mcp/*` with an Access *bypass* rule, or a `dev-mcp.falloutchatmod.com`
tunnel route with no Access policy). The **MCP token is the only gate** — no CF
Access service tokens are issued to developers. This is acceptable because: the
token is per-user, hashed-at-rest, 90-day-expiring, revocable from the profile,
rate-limited, fully audited, the dev data is fake, and the exposed tools are
capped at the user's own role + the dev-safe set (no destructive/admin endpoints).
A leaked dev token's blast radius = dev-safe actions as that one dev in a fake-data
environment, until revoked.

### Tool surface (from the endpoint inventory)

The full API surface (~34 route groups + the WS message set) was catalogued and
tagged read-only / mutating / **destructive** / admin-only — see
[Endpoint inventory](#endpoint-inventory-reference). Tools map from it:

- **Dev MCP (read + dev-safe mutations):** health/version, wiki/camp search,
  channels (read), messages (read + `messages_send`), parties (read), commands
  (read), user profile/search (reads), **sim** (`sim_stream_start`,
  `sim_users_create`), releases (read). Naming: `fcm_<noun>_<verb>`.
- **Prod MCP (owner-only, broader):** all reads + moderation (bans/mutes/kicks,
  reports resolve), audit-log read, releases create/update, name blacklist,
  Discord bridge status, MCP-key management. **Never exposed in any MCP:**
  `/admin/nuke-users`, `/admin/migration/*`, raw SQL.
- **Mutation guard:** every mutating tool requires an explicit `confirm: true`
  input field so Claude/Codex/Antigravity must surface the action first;
  irreversibility called out in the tool `description`.

### Security model

Per-user token + per-user CF service token + hardcoded dev URL + per-env table +
`confirm:true` on mutations + per-token rate limit + full audit attribution. Prod
token never committed, owner-only. The user's real role is the authorization
ceiling — the MCP can never exceed what that user could do in the dashboard.

### Client configuration

One stdio server, three clients. The token is passed via env (`FCM_MCP_TOKEN`) —
no CF Access env vars (the MCP path is not behind Access).

- **Claude Code** — committed `.mcp.json` (project) for `fcm-dev`:
  ```jsonc
  { "mcpServers": { "fcm-dev": {
      "command": "node", "args": ["mcp/dist/dev/index.js"],
      "env": { "FCM_MCP_TOKEN": "${FCM_MCP_TOKEN}" } } } }
  ```
- **Codex CLI** — `~/.codex/config.toml` (user-level; provide a committed snippet
  + setup note since Codex config is TOML, not in-repo JSON):
  ```toml
  [mcp_servers.fcm-dev]
  command = "node"
  args = ["mcp/dist/dev/index.js"]
  env = { FCM_MCP_TOKEN = "..." }
  ```
- **Antigravity** — JSON `mcpServers` block in its MCP settings (same shape as
  Claude Code's). **Exact config path/format to verify during implementation.**

Provide a committed `mcp/clients/` folder with a ready snippet per client + a
short setup script, so "configure for all three in this repo" is one step. The
prod MCP (`fcm-prod`) is **never** in any committed config — it exists only in the
maintainer's user-level config, and its setup is kept private (owner-only).

---

## Endpoint inventory reference

The complete catalog (method · path · auth tier · purpose · read/mutate/destructive)
covers ~34 groups: Auth/Session, Health, Users, Devices, Channels, Messages,
Reports, Moderation (filters/settings/embeds/automod), Moderation actions
(kick/mute/ban/evidence), Audit log, Admin users, Releases, Name blacklist,
Presence, Commands, Parties, Block list, Wiki, Camp, HUD feed, Player reports,
Applications, Player list, Telemetry, Client metrics, Community stats,
Verify-dev-role, Emojis/Tenor, Public endpoints, Debug/admin, Sim (dev-only),
Game bridge (dev-only), Migration — plus the full client→server / server→client
WS message set. **Never-in-MCP:** `/admin/nuke-users`, `/admin/migration/*`,
`MIGRATION_KEY` endpoints, the game bridge. The full tables live with the
implementation (or a generated `docs/mcp/tool-reference.md`).

---

## Phased build plan

1. **Backend foundation:** `mcp_api_keys` migration; `requireMcpToken` middleware
   (resolves token → user, attributes); self-service `GET/POST/DELETE
   /api/me/mcp-tokens`; `mcpLimiter`; MCP audit-log writes; tests (valid/expired/
   revoked/wrong-env, attribution).
2. **Dashboard profile UI:** "API Tokens" panel (mint → show-once, list, revoke) —
   dev-mode/profile only.
3. **Path A enablement:** `vite.config.ts` proxy headers + overlay `main.js` CF
   headers + `dev:cloud` script + `.env.local.example`.
4. **MCP package (dev):** scaffold `mcp/`, shared client, dev tools (health →
   channels → messages → wiki/camp → users → sim → parties); `mcp/clients/`
   config snippets for Claude Code / Codex / Antigravity.
5. **Prod MCP + remaining tools:** moderation, audit, releases, blacklist, key
   mgmt; owner-only registration.
6. **Polish:** pagination, RFC7807→readable errors, tool descriptions, CI
   type-check for `mcp/` (never deployed to the server).

Each phase ships with tests (HARD RULE) and its doc updates.

## Documentation structure

- `docs/deployment/developer-onboarding.md` — Path A + Path B (canonical).
- `docs/mcp/` — `README.md`, `dev-mcp.md` (incl. self-service token + 3-client
  setup), `tokens.md` (mint/rotate/revoke from profile), `tool-reference.md`,
  `security.md`. **No `prod-mcp.md` in the committed tree** — the prod MCP setup
  (CLI minting + owner config) lives only in a private, owner-only note (e.g.
  session memory or a gitignored maintainer doc), so contributors can't learn how
  to obtain or use a prod token.
- Add the dev-facing docs to the CLAUDE.md documentation map.

## Decisions (resolved)

- **MCP auth = MCP token only, no Cloudflare Access.** Expose the MCP API on a
  non-Access path; the per-user token is the sole gate. ✅
- **Token expiry = 90 days** (default). ✅
- **Prod token = CLI-only, owner-only, kept secret/undocumented.** ✅

## Open questions

1. **Path A overlay vs Cloudflare Access.** The MCP no longer needs CF Access — but
   Path A's *overlay* still hits the Access-gated dev site for its REST/WS. Do you
   also want the dev API/WS reachable on a **non-Access path** (app-auth only:
   install-token/session) so the overlay needs no CF service token either? If yes,
   that unifies "no CF credentials for anyone"; the dashboard UI can keep its SSO
   login. (Browser SSO via the FCM Developers group stays — that's a login, not a
   handed-out credential.)
2. **Antigravity MCP config** — confirm exact config location/format.
3. **WS-only data** (live presence, connected count) — add REST shims for MCP, or
   exclude from v1?
