# QA Builds and the Golden-Build Lock (Runbook)

How to build, bless, distribute, and retire **QA builds** — the packaged "golden"
overlay that vetted QA testers run against the hosted **dev** environment.

This is the maintainer workflow. Architecture and Cloudflare detail live in
[hosted-dev-environment.md](hosted-dev-environment.md); build-channel internals in
[../overlay/README.md](../overlay/README.md); the wire protocol in
[../realtime/README.md](../realtime/README.md).

## What it is and why

QA testers are vetted **end users** (not developers). They run a packaged QA build that
connects to `dev.falloutchatmod.com` as a regular chat `user`, gated by a dev-guild
Discord **QA role**. This is deliberately lighter than developer onboarding: **no
Cloudflare Access email allowlist and no dual developer-role gate**. A version-string
**golden-build lock** ensures only the single currently-blessed build can connect, so an
outdated (or exploitable) build can be retired instantly.

## How it works — three independent controls

- **QA role gate (who).** The build signs in via Discord OAuth against the **dev** Discord
  app (scopes `identify guilds.members.read` — no `email` scope, so testers never give an
  email). The dev backend grants a session only if the user holds the QA role in the dev
  guild. Fail-closed; per-person; revoked by removing the role.
- **Golden-build lock (which version).** The backend holds `QA_ACTIVE_VERSION`; the overlay
  sends an `x-client-version` header. A mismatch is rejected: **HTTP 426** on the
  `GET /api/auth/qa-status/:installToken` poll and **WS close `4003`** on the relay
  handshake. Dev-only, active only when `QA_BUILD_LOCK=true` (fails open if no active
  version is set).
- **Edge reachability (2026-06-29: CF Access removed from the dev website).** `dev.falloutchatmod.com`
  is now **open at the edge** — the CF Access gate + per-path bypass apps were deleted — so QA testers
  reach the overlay paths (`/ws`, `/auth/*`, `/api/*`) **and** the `/link` page directly. App-level auth
  is the only security boundary (acceptable because the dev dataset is fake by construction). No CF Access
  apps or bypasses are needed for the website anymore; only `dev-db` / `dev-s3` stay service-token gated.

## The cycle: build -> bless -> distribute -> retire

### 1. Build

**Linux** (from this repo, on a Linux host):

```bash
cd cross-platform-overlay
npm run dist:qa
```

Produces `dist-electron/Fallout Chat Mod QA-<version>.AppImage` + `.deb` and prints the
line to bless, e.g. `QA_ACTIVE_VERSION=1.3.91-qa.20260626014530`.

**Windows** (Wine cannot build Electron 31+, so use the self-hosted runner): run the
**Build Windows QA** workflow — GitHub Actions -> *Build Windows QA* -> *Run workflow*
(`workflow_dispatch`, owner-only, runs on `[self-hosted, windows, unn]`). It runs
`dist:qa` and uploads the unsigned-by-intent NSIS installer + portable `.exe` as the
artifact `fcm-overlay-qa-windows`.

```bash
gh workflow run build-windows-qa.yml --ref dev -f version=<optional-pinned-version>
```

**Versioning.** `dist:qa` (`scripts/build-qa.mjs`) auto-stamps a **unique**
`<base>-qa.<UTC-timestamp>` version so the lock can tell a fresh build from a retired one.
To ship Linux **and** Windows as ONE golden build, pin the same version on both so a single
`QA_ACTIVE_VERSION` admits both platforms:

```bash
FCM_BUILD_VERSION=1.3.91-qa.20260626 npm run dist:qa        # Linux
gh workflow run build-windows-qa.yml --ref dev -f version=1.3.91-qa.20260626   # Windows
```

### 2. Bless (make it the active golden build)

Flip the active version live (no redeploy), with `QA_BUILD_LOCK=true`:

```bash
curl -X POST https://dev.falloutchatmod.com/api/admin/qa/active-version \
  -H "x-admin-api-key: <ADMIN_API_KEY>" -H "Content-Type: application/json" \
  -d '{"version": "1.3.91-qa.20260626"}'
```

Or set `QA_ACTIVE_VERSION` (and `QA_BUILD_LOCK=true`) in the `fcm-dev-stack` env and
redeploy. The four QA env vars on `backend-dev`: `DEV_QA_ROLE_ID`, `QA_BUILD_LOCK`,
`QA_ACTIVE_VERSION`, `DISCORD_QA_REDIRECT_URI`.

### 3. Distribute

Post the artifact(s) to the **dev Discord updates channel**. Testers download and
(re)install. Linux = AppImage or `.deb`; Windows = the NSIS `Setup` `.exe` (or portable).

### 4. Retire

Cutting a new golden build yields a new unique version. Bless it (step 2) and every older
build is rejected on its next connect (426 / 4003) — testers get an "update required"
prompt and reinstall. No separate de-list step.

## Onboarding / revoking a QA tester

- **Onboard:** invite the tester to the **dev** Discord server and assign the `QA` role.
  That is all — no Cloudflare Access email entry, no developer roles. Then hand them the
  build link from the dev Discord updates channel.
- **Revoke:** remove the `QA` role. Access lapses on the next login / within the session TTL.

## Build internals and signing

- `dist:qa` -> `scripts/build-qa.mjs`: sets `BUILD_CHANNEL=qa` (renderer `__BUILD_CHANNEL__`),
  `-c.extraMetadata.fcmChannel=qa` (packed `package.json`, read by `main.js` to target dev +
  the QA login), `-c.extraMetadata.version=<version>`, and `productName "Fallout Chat Mod QA"`
  (distinct from the stable build, so both can coexist on one machine).
- **Signing:** QA builds are unsigned by intent (testers are vetted; QA builds are never
  published to the release registry or Nexus). On the Windows runner electron-builder's
  default certificate auto-discovery may still invoke `signtool` with a cert in the runner's
  store. To force deterministic-unsigned, set `CSC_IDENTITY_AUTO_DISCOVERY=false` in the
  workflow's build step.

## Troubleshooting

- **Tester can't connect / "update required":** their build's version != `QA_ACTIVE_VERSION`.
  Re-bless or redistribute the current build. Confirm: `GET /api/admin/qa/active-version`.
- **"You need the QA role":** the account lacks the `QA` role in the **dev** guild.
- **"503 / connection blocked by edge (CF challenge)":** a needed overlay path is not
  CF-bypassed (see [hosted-dev-environment.md](hosted-dev-environment.md) -> CF Access
  path-bypass).
- **Build rejected at WS but not the poll (or vice-versa):** both enforce the same lock via
  `buildLock.ts:evaluateBuildGate`; a split usually means a stale deploy — redeploy `fcm-dev`.

## Endpoints (dev-only, gated on `NODE_ENV==='development'`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/auth/discord/qa/start` | install token | Begin QA OAuth |
| GET | `/auth/discord/qa/callback` | Discord OAuth | Role check + mint session + store grant |
| GET | `/api/auth/qa-status/:installToken` | `x-client-version` | Poll for the session grant (426 if stale) |
| POST/GET | `/api/admin/qa/active-version` | `x-admin-api-key` | Flip / read the active golden version |
