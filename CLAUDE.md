# CLAUDE.md

## Project Overview

Fallout Chat Mod is a governed, real-time community chat platform for Fallout 76 — community channels
(General / Trading / Events / Raids) with a Discord bridge and a browser-based moderation portal,
rendered through a transparent in-game overlay. The desktop client only checks whether the `Fallout76`
process is running (to show/hide the overlay) — it does not read game state.

Full architecture and how the pieces connect: **[docs/README.md](docs/README.md)** and
[docs/architecture/](docs/architecture/README.md).

## Documentation Map

| Topic | Where |
| ----- | ----- |
| System overview, data flow, glossary | [docs/architecture/](docs/architecture/README.md) |
| Backend API reference, services, auth, jobs/queues | [docs/backend/](docs/backend/README.md) |
| WebSocket relay protocol, presence, sessions | [docs/realtime/](docs/realtime/README.md) |
| Dashboard, the shared ChatOverlay component, theming | [docs/frontend/](docs/frontend/README.md) |
| Electron overlay: window mgmt, keybinds, update notification, building | [docs/overlay/](docs/overlay/README.md) |
| Overlay diagnostics: log file, levels, `--fcm-debug`/`FCM_DEBUG`, rotation | [docs/overlay/diagnostics-logging.md](docs/overlay/diagnostics-logging.md) |
| In-game HUD feed (ZFE/FCMBridge): wire format, events, env vars | [docs/overlay/zfe/](docs/overlay/zfe/README.md) |
| Discord bot: bridge, voice, embeds, reaction roles | [docs/discord/](docs/discord/README.md) |
| Prisma schema, migrations, Redis usage | [docs/database/](docs/database/README.md) |
| Automod, reports/evidence, role model | [docs/moderation/](docs/moderation/README.md) |
| AI content moderation (OpenAI), thresholds, kill switch, privacy | [docs/moderation/ai-moderation.md](docs/moderation/ai-moderation.md) |
| Local dev, release pipeline, packaging, code signing, deploy | [docs/deployment/](docs/deployment/README.md) |
| QA-tester builds: golden-build lock, build/bless/distribute runbook | [docs/deployment/qa-builds.md](docs/deployment/qa-builds.md) |
| Marketing assets (Remotion GIFs/stills), re-export commands | [docs/marketing/](docs/marketing/README.md) |

## CI Infrastructure

### PR CI is label-gated (fork-safety)
`ci.yml` triggers on `pull_request: types: [labeled]` (+ push to `prod`/`dev`), **not** on PR
open. An `authorize` gate job runs first and every job `needs: authorize`; it passes for
pushes and for any PR **only when the `ci-approved` label is present**. Applying a label needs
write/triage access, so **only maintainers can run CI on a PR** — the `ci-approved` label gate
is the security boundary, not the runner type. `pr-gate-delabel.yml` strips the label on
every new push (TOCTOU guard), so re-review is forced. To run a PR's CI: review it, then add
`ci-approved`. Jobs were consolidated (matrix `unit-vitest`; the Linux overlay job is now
`overlay-launch-smoke-linux` and the Windows job `overlay-build-windows-nsis` after auto-update was
retired), plus a non-blocking `osv-scan` (OSV dependency vuln scan) = 8 jobs total; Dependabot version+security updates
are configured in `.github/dependabot.yml`;
actions are SHA-pinned with a `permissions: contents: read` default.

CI defaults to **GitHub-hosted runners** (`ubuntu-latest` / `windows-latest`). Self-hosted runners
are a documented fallback via repo variables `CI_RUNNER` and `CI_RUNNER_WINDOWS` (JSON runner
label strings). Toggle: `gh variable set CI_RUNNER '["self-hosted","linux","unn"]'` to use
self-hosted; `gh variable delete CI_RUNNER` to revert to GitHub-hosted. Full detail:
[docs/testing/ci-cd-pipeline.md](docs/testing/ci-cd-pipeline.md).

### Windows Build
Windows builds run on a **native Windows runner** — no Docker/Wine. The old Wine-based
`win-electron-builder` Docker image has no current CI role; Electron 31+ Chromium/Crashpad triggers a
`STATUS_BREAKPOINT` crash under Wine64 that cannot be worked around.

- **Manual release build:** `.github/workflows/build-windows.yml` — `workflow_dispatch` with `version` + `publish` inputs; runs on the **self-hosted** `[self-hosted, windows, unn]` runner by design. Release workflows (`build-windows.yml`, `build-linux.yml`) are NOT affected by the CI runner migration — they keep the self-hosted runners for consistent release toolchains.
- **CI gate (build):** `overlay-build-windows-nsis` in `ci.yml` — builds the NSIS installer **natively on `windows-latest`** (no Wine, no Docker, no docker-cp; switchable to self-hosted via `CI_RUNNER_WINDOWS`); runs on every PR and `prod`/`dev` push; asserts absence of `app-update.yml`/`latest*.yml` (the overlay no longer auto-updates, so no feed files are generated)
- **CI gate (execution):** the former native-Windows execution smoke (`overlay-autoupdate-e2e-windows-exec`) was removed when auto-update was retired; the build gate above is the Windows CI coverage (manual `.exe` testing can still be done on the Windows VM)
- **Full failure history and fix rationale:** [`docs/testing/windows-nsis-ci-fixes.md`](docs/testing/windows-nsis-ci-fixes.md) — the Wine/Docker failures documented in order, then the migration to native `windows-latest` (which superseded Wine/DinD entirely for CI). Read this before debugging any future Windows CI failure.

## Hosted Dev Environment

An isolated dev stack (`fcm-dev` Dokploy project) serves `dev.falloutchatmod.com` — separate
DB/Redis/MinIO, dedicated Cloudflare tunnel, **never** prod data (real wiki/camp reference +
**fake** users/chat). It tracks the `dev` branch. Full runbook:
[docs/deployment/hosted-dev-environment.md](docs/deployment/hosted-dev-environment.md).

**Access = dual Discord role gate (app-level), like prod.** As of 2026-06-29 the **Cloudflare
Access edge gate on the dev *website* was removed** — `dev.falloutchatmod.com` (and `dev-hud`)
are now open at the edge and protected only by the app's own auth, exactly like prod. The raw
data stores (`dev-db` / `dev-s3`) are **still** CF-Access service-token gated. To onboard a
developer (maintainer steps):

1. Assign the **`developer`** role in the **prod** Discord server.
2. Assign the **`developer`** role in the **dev** Discord server. *(BOTH required — the app's
   dual-role gate denies anyone missing either; the prod-guild check goes through
   `GET /api/internal/verify-dev-role` since the dev bot can't read the prod guild.)* This
   app-level dual-role gate is now the **sole** gate for the dev dashboard/API.
3. Only if they need direct DB/object-store access: share the CF Access **service token** for
   `cloudflared access tcp` to `dev-db`/`dev-s3` (these remain edge-gated).

Revoke by removing the `developer` role in either server. Most contributors never need this —
they run the local stack and PR against `dev`. *(History: the dev website used to also sit
behind a "FCM Developers" CF Access group + One-time PIN; that edge gate was removed because the
app-level auth already protects all data and the gate was breaking the in-game `/link` flow.)*

**QA testers — a lighter, separate path (NOT the developer onboarding above).** Vetted
end-users run a packaged "golden" QA build against dev, gated by a dev-guild **`QA`** Discord
role only — **no Cloudflare Access email, no dual `developer` role**. A version-string
golden-build lock (`QA_BUILD_LOCK` + `QA_ACTIVE_VERSION`, enforced via `x-client-version` →
HTTP 426 / WS 4003) retires stale builds; the dev website is now open at the edge (no CF Access
gate — see above), so QA testers reach the overlay + the `/link` page directly, with app-level
auth as the only gate (no CF Access email needed). The QA build channel is `npm run dist:qa` (Linux) / the
**Build Windows QA** Actions workflow (self-hosted runner). Full build/bless/distribute
runbook: [docs/deployment/qa-builds.md](docs/deployment/qa-builds.md).

---

## Hard Rules

These are non-negotiable. Each links to the doc with the full context.

- **Keep the docs in sync with the code (HARD RULE).** After every code change, take a moment to ask:
  "does this change how something documented in [`docs/`](docs/README.md) works?" If yes, update the
  relevant doc(s) in the **same** change — new/changed endpoints, socket message types, env vars,
  schema/migrations, auth/session behavior, keybinds, release steps, config keys, file moves/renames,
  and any rule or convention above. Treat the documentation update as part of "done," not a follow-up.
  When in doubt, check the [Documentation Map](#documentation-map) for the owning doc and reconcile it.
- **Every feature ships with unit tests + CI coverage (HARD RULE).** It is imperative that when you
  build or change a feature, you write unit tests for it in the **same** change and ensure they run in
  the CI pipeline (`.github/workflows/ci.yml`). A feature is not "done" until its tests exist and pass
  in CI. New testable logic → add/extend the appropriate Vitest suite (overlay/dashboard) or Jest suite
  (backend); if a CI job doesn't yet cover the new surface, wire it in and, when stable, promote it into
  the required `CI Summary` gate. Prefer extracting pure functions to keep logic testable. Follow the
  [testing strategy](docs/testing/README.md) and the prioritized backlog in
  [docs/testing/overlay-test-plan.md](docs/testing/overlay-test-plan.md).
- **EULA §4(F) — two tracks, kept strictly separate.** The product ships in two forms:
  1. **Default overlay (EULA-safe).** The transparent desktop overlay is the default, EULA-safe path.
     It only checks whether the `Fallout76` process is running (to show/hide the overlay) — it never
     reads game memory, never modifies game files, never injects code, and never scans
     networks/ports. This track must stay clean of all game intrusion.
  2. **In-game HUD mods (`.ba2`) — explicit opt-in.** The FCMBridge / FCMChatWidget `.ba2` files render
     chat inside the game HUD. These are an **additional, separate install option** the user chooses
     and installs at their own discretion — never bundled into or auto-installed by the overlay, and
     always clearly presented as the modding track. Even here the hard limits hold: **no game-memory
     reading, no code injection, no network/port scanning** — the `.ba2` mods swap UI assets and may
     read the game's own UI-layer data that the HUD already renders (e.g. `worldId` / nearby-player
     roster from `BSUIDataManager`) via ZFE's sanctioned outbound channel. This is not game-memory
     reading, injection, or network/port scanning — it is reading data the game itself surfaces to its
     own HUD, forwarded through the approved ZFE channel.
  Never blur the two: the EULA-safe overlay must never gain game-file modification, and the `.ba2`
  install must never be presented as required or default.
- **One ChatOverlay component — never fork it.** `admin-dashboard/src/features/chat/ChatOverlay.tsx`
  renders on all three surfaces (auth dashboard, public website, Electron overlay). Branch only on
  `overlayShell` and `isPublicMode` — never duplicate the component. See
  [docs/frontend/chat-overlay.md](docs/frontend/chat-overlay.md).
- **Public mode is a hard lockdown.** When `isPublicMode`, never expose private parties/members/
  invites/account data and never open the authed WebSocket. Public REST endpoints are read-only and
  hard-filtered. See [docs/frontend/chat-overlay.md](docs/frontend/chat-overlay.md).
- **Prisma migrations MUST be idempotent.** `baseline-migrations.sh` runs `db push` before
  `migrate deploy`, so use `IF NOT EXISTS`, the `DO $$ … END $$` constraint guard, and
  `ON CONFLICT DO NOTHING` seeds (with all NOT NULL columns). See
  [docs/database/migrations.md](docs/database/migrations.md).
- **Releasing the overlay — filenames must match.** `productName` is `"Fallout Chat Mod"` **with
  spaces**; publish **both** platforms every release; verify the served file size matches the local
  build artifact size (`(Get-Item $artifact).Length`) before `POST /admin/releases`; release `.ps1`
  scripts must stay **ASCII-only** (PowerShell 5.1 mis-tokenizes Unicode dashes). Always confirm
  version + notes with the user first. See
  [docs/deployment/releasing-the-overlay.md](docs/deployment/releasing-the-overlay.md).
  **No auto-update.** Update awareness is a passive OS notification; the latest version arrives over
  the chat WebSocket (`app:update-available`); no dedicated update network call — Nexus Mods ToS
  compliance. `electron-updater`, `build.publish`, `latest*.yml`, and `app-update.yml` are removed.
  **Re-running the installer is now the update/patch path** — and it is a full, idempotent
  fast-forward: a user many versions behind (e.g. 5 releases old) lands on latest in one run.
  Installers always fetch the newest version (CLI → `GET /api/releases`, ZIPs → bundled artifact);
  there is **no minimum-version / forced-upgrade gate** (old clients always patch forward); Windows
  NSIS overwrites in place (`installer.nsh` taskkills the running app) and Linux writes to a stable
  version-agnostic path; the userData-rename + keybind-reset startup migrations are any-to-any
  idempotent; `userData` is outside the package so settings survive. The CLI installers detect the
  installed version and **prompt reinstall-or-cancel when already current** (Windows reads the exe's
  `ProductVersion`; Linux reads the `$XDG_DATA_HOME/FalloutChatMod/.fcm-version` marker). The Linux
  ZIP now also ships a `.deb` (apt-managed alternative to the AppImage). See
  [docs/overlay/auto-update.md](docs/overlay/auto-update.md) → "Updating / patching from an old version".
- **Overlay releases are FAIL-CLOSED — never ship an untested or unscanned build (HARD RULE).** Before
  ANY publishing (`POST /admin/releases`, Nexus), the build MUST pass BOTH gates, in order:
  (1) **smoke test** — `Packaging/smoke-test.ps1 -Version X.Y.Z` launches the packaged app and asserts
  a clean startup (no `Cannot find module` / `[uncaught]`, relay registers); (2) **VirusTotal gate** —
  `Packaging/vt-gate.ps1 -Version X.Y.Z` uploads + **waits for the scan to complete** and blocks the
  release on detections. If EITHER gate fails, publish **nothing, anywhere**. A crash before
  `app.whenReady()` bricks users who cannot reinstall themselves (v1.3.82 crashed this way — a missing
  `overlay-core.js` in `build.files` was the cause; since auto-update is gone, those users would need a
  manual reinstall). The `__tests__/build-files.test.js` / `__tests__/no-autoupdate.test.js` Vitest
  guards back gate #1 at CI time. See the release doc's Critical Rules.
- **Local dev process hygiene (HARD RULE).** When you kill an overlay/front-end you launched via
  `Start-Process powershell -NoExit -File …`, also close the PowerShell window it ran in (match by the
  launcher script — never blanket-kill all `powershell`). Stale `-NoExit` windows conflict on ports.
  One launcher window at a time. See [docs/deployment/local-dev.md](docs/deployment/local-dev.md).
- **Overlay processes — DEV vs PROD are distinct; only ever touch DEV (HARD RULE).** The developer
  runs BOTH overlays at the same time, distinguished by process name:
  - **DEV overlay = `electron` / `electron.exe`** — launched via `cd cross-platform-overlay && npm run
    dev:local`, points at the LOCAL backend (`localhost:7177`). **This one is yours to manage** —
    fine to stop/launch/restart while iterating:
    `Get-Process -Name 'electron' -EA SilentlyContinue | Stop-Process -Force`
  - **PROD overlay = `Fallout Chat Mod` / `Fallout Chat Mod.exe`** — the packaged/installed app
    connected to PROD (`falloutchatmod.com`). This is the developer's live, everyday overlay.
    **NEVER kill, launch, or touch it.** Do NOT lump it into a `Stop-Process` with `electron`.
  - **NEVER kill `Fallout76`** — that's the game.
  Dev features (e.g. wiki/camp) are LOCAL-ONLY until explicitly deployed — they don't exist on the
  prod overlay, so test them only on the dev surface (dev overlay → 7177, or the dashboard 7075→7177).

## Nexus release state — Windows installer OFF Nexus (signing did NOT help, since 2026-06-21)

The Windows installer is **code-signed** (Azure Trusted Signing, `CN=Lance Strickland`) — which
killed the SmartScreen "unknown publisher" warning on the **website** download. But signing does
**NOT** get the `.exe` onto Nexus: Nexus **still quarantines installer `.exe` files** (a file-type
policy, not a real detection). v1.3.91's signed `.exe` reported `state=available` at upload, then
Nexus's downstream virus scan flagged it and it was pulled — so the Windows installer stays **off
Nexus**. In `Packaging/publish-nexus-release.ps1`: the `Windows` platform-loop entry is **commented
out** (Linux-only publish); the Linux zip is renamed `Fallout Chat Mod <ver>.zip` (no `…AppImage
(Linux)`) and bundles `READ ME FIRST (Windows users).txt` pointing Windows users to
`falloutchatmod.com`, with the same Windows-download + VT link in its description. The website
(`falloutchatmod.com`) is the canonical Windows download — the signed `.exe` is built + uploaded
there every release, and `https://falloutchatmod.com/virustotal` redirects to the current scan
(v1.3.91 = 0/67). **Re-enable the `Windows` entry only if Nexus lifts the `.exe` quarantine**
(support ticket). See
[docs/deployment/releasing-the-overlay.md](docs/deployment/releasing-the-overlay.md) → Step 7.

> Aside: Nexus's `Compress-Archive`-zip → "scan failed" issue was a *separate, fixed* problem (the
> Linux release path now zips with the `zip` tool, see #242).

## Conventions

| Layer | Convention | Example |
| ----- | ---------- | ------- |
| DB tables/columns | `snake_case` plural | `chat_rooms`, `moderation_logs` |
| Prisma models | `camelCase` via `@map` | mapped from DB columns |
| REST routes | `kebab-case` | `/api/moderation-logs` |
| React components | `PascalCase` | `MessageHistory.tsx` |
| TS modules | `camelCase` | `authService.ts` |
| JSON keys | `camelCase` | all API payloads |
| Socket events | `domain:action` | `chat:message`, `room:join` |
| Dates | ISO 8601 UTC strings | always |
| Discord embeds | brand color **`#F1C40F`** (RGB 241,196,15) | every embed uses `BRAND_EMBED_COLOR` |

Backend layer order is `Controllers → Services → Middleware`; errors use RFC 7807 Problem Details,
success responses wrap in `{ "data": { … } }`. Details in [docs/backend/README.md](docs/backend/README.md).

## Commands

```bash
# Local stack (Postgres + Redis + MinIO) — start this first
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

cd backend && npm run dev                          # tsx watch; loads .env.local over .env
cd admin-dashboard && npm run dev                  # Vite dev server → http://localhost:7075
cd cross-platform-overlay && npm run dev:local     # renderer (5290) + Electron → local backend

npx prisma migrate dev                             # apply schema changes
npx prisma studio                                  # visual DB browser
npm test                                           # Jest + Supertest (in backend/)
```

Per-platform setup (Linux / Windows / WSL2 mixed, and the "never mix Docker+Node across the WSL2
boundary" rule) is in [docs/deployment/local-dev.md](docs/deployment/local-dev.md).

### Dev Port Map

| Service | Port | Notes |
| ------- | ---- | ----- |
| Backend | 7177 | `.env.local` overrides prod `.env`; Discord bot token empty locally. 7076 is reserved by Docker Desktop internals. |
| Admin dashboard | 7075 | Vite dev server |
| Electron renderer | 5290 | `strictPort: true` — fails immediately if taken, never drifts |
| Docker Postgres | 7077 | Mapped from container's 5432 |
| Docker Redis | 7078 | Mapped from container's 6379 |
