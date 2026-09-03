# Local Development Setup

---

## Starting the Local Stack

The local stack runs Postgres, Redis, MinIO, and the backend in Docker. Start it before any Node processes:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

`docker-compose.dev.yml` overrides the production compose file: it publishes host ports for Postgres and Redis, replaces the backend image with `node:20-alpine`, volume-mounts the `backend/` source tree, and starts `tsx watch` automatically. The dashboard also runs as a hot-reload Vite container.

The dev backend container:
- Runs `apk add openssl && npm install && npx prisma generate && npx prisma db push && npx tsx watch src/server.ts`
- Sets `DISCORD_TOKEN: ""` so the local backend cannot connect the live Discord bot
- Exposes `ALLOWED_ORIGINS` for localhost (ports 7076, 3200, 5180, 3000)

---

## Dev Port Map

| Service | Host port | Notes |
|---------|-----------|-------|
| Backend | **7076** | `docker-compose.dev.yml` fixed mapping; loads `.env.local` over `.env` when run outside Docker |
| Admin dashboard | **3200** (Vite container) / **7075** (standalone `npm run dev`) | Vite dev server |
| Electron renderer | **5290** | `strictPort: true` — fails immediately if taken |
| Docker Postgres | **7077** | Mapped from container 5432 |
| Docker Redis | **7078** | Mapped from container 6379 |

> Port 7076 is the Docker-mapped backend; the backend listen port inside the container is also 7076 in dev (overriding the prod default of 7676). Do NOT use `${PORT}` on the host-mapping side of the Docker port directive — that variable is the app's internal listen port and would produce the wrong host mapping.

---

## Running Individual Services (outside Docker)

```bash
# Backend (tsx watch, uses backend/.env.local over .env)
cd backend && npm run dev

# Admin dashboard
cd admin-dashboard && npm run dev   # → http://localhost:7075

# Electron overlay (renderer on port 5290 + Electron shell, targets local backend)
cd cross-platform-overlay && npm run dev:local
# On Linux KDE-Wayland, use dev:linux instead (forces --ozone-platform=x11 so the
# app doesn't self-relaunch to XWayland — single clean process, tray works in dev):
cd cross-platform-overlay && npm run dev:linux
```

> Always use `dev:local` (or `dev:linux` on Linux KDE-Wayland) for the overlay — it targets the local backend. `npm start` targets production. Add `--fcm-debug` (or `FCM_DEBUG=1`) for verbose diagnostic logging; see [../overlay/diagnostics-logging.md](../overlay/diagnostics-logging.md).

### Hosted Dev overlay

To test against the isolated hosted Dev environment instead of the local backend:

```bash
cd cross-platform-overlay
npm run dev:cloud
```

`dev:cloud` loads the Dev-only `DEV_PERSONA_LOGIN_SECRET` from the Linux desktop
keyring (`secret-tool`, attributes `service=fcm-overlay` and
`environment=dev`) or the macOS Keychain. Windows/CI may provide the variable in
the process environment. The script deliberately removes `ELECTRON_RUN_AS_NODE`,
which can make Electron run as a plain Node process, and gives the Dev overlay a
separate `~/.fcm/hosted-dev` profile so it cannot reuse or modify the installed
Prod overlay's session. Never copy this key into the repository or use it with a
packaged production build.

---

## Per-Platform Setup

### Linux (native)

Everything runs in the same environment. No special handling.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
cd backend && npm run dev
cd admin-dashboard && npm run dev
cd cross-platform-overlay && npm run dev:local
```

Hot-reload works natively (inotify). No WSL boundary issues.

---

### Windows (no WSL)

Run everything from PowerShell or Windows Terminal. Docker Desktop required.

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
cd backend; npm run dev
cd admin-dashboard; npm run dev
cd cross-platform-overlay; npm run dev:local
```

Hot-reload works natively on the Windows filesystem.

---

### Windows + WSL2 (mixed)

**The core constraint:** WSL2 Docker ports bind to the WSL2 network interface, not Windows localhost. Node processes must run in the same environment as Docker (either both Windows or both WSL2).

**Option A — Run everything from PowerShell (recommended)**

Use Docker Desktop (starts Docker on Windows localhost, not WSL2). Run all Node processes from PowerShell. Hot-reload works; no WSL2 boundary issues.

**Option B — Run everything from WSL2**

Start Docker from WSL2. Run backend and dashboard from a WSL2 terminal. Electron must still run from PowerShell (it is a Windows binary), but the overlay's `dev:local` can target the WSL2 backend if you update `RELAY_HTTP` to the WSL2 IP.

**Never mix environments.** Starting Docker from WSL2 and the backend from PowerShell means the backend cannot reach the database. Starting Docker from PowerShell (Docker Desktop) and the backend from WSL2 means `tsx` is extremely slow on `/mnt/d`.

WSL2 is fine for: `git`, file edits, `curl` tests, `prisma migrate`, `npm test`.

> **Symptom: blank chat / "no history loads" + the overlay log spamming
> `[ws-gate] closed code=1006 — retry…`.** This is almost always **more than one
> backend running**, not a code bug (the same code serves prod fine). The local
> backend is `npm run dev` = **`tsx watch`**, and it's easy to end up with two
> instances — e.g. launching it from multiple shells, or **orchestrating the
> Windows backend from WSL/bash** (background `&`, `Start-Process`, repeated
> `npm run dev`). Two backends fight over port **7177**: one binds it, the other
> crashes on `EADDRINUSE` and `tsx`/npm restarts it, ping-ponging the port. **Every
> restart (and every `tsx` hot-reload) RSTs the WebSocket → code 1006 → the overlay
> reconnects → repeat**, and the `chat:history` frames are dropped mid-flight before
> the feed ever fills. Fix: run **exactly one** backend, start it in **PowerShell**,
> and leave it alone — don't drive it from WSL/bash. Verify only one process owns
> 7177: `Get-NetTCPConnection -LocalPort 7177 -State Listen | Select OwningProcess -Unique`
> (a lingering `svchost` TIME_WAIT entry is harmless). Kill strays with
> `Get-CimInstance Win32_Process -Filter "name='node.exe'" | ? { $_.CommandLine -like '*\backend*' } | % { Stop-Process -Id $_.ProcessId -Force }`.
>
> **TL;DR for contributors:** run the whole local stack **on Windows, in PowerShell,
> one instance each, started once** (Docker Desktop + one `npm run dev` backend +
> one `npm run dev:local` overlay). Use WSL only for editing/git/tests.

---

## Process Hygiene (Hard Rule)

When you kill an overlay or front-end that was started with `Start-Process powershell -NoExit -File ...`, you **must also close the PowerShell window it ran in**. The `-NoExit` window and its child processes (`concurrently`, Vite) survive killing Electron and pile up, conflicting on ports (especially 5290).

Kill Electron and matching launcher windows together:

```powershell
Get-Process electron -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Get-CimInstance Win32_Process -Filter "name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'fcm-overlay-dev|fcm-build-win|fcm-nexus' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
```

To kill a running installed overlay (not `electron.exe`):

```powershell
Get-Process -Name 'Fallout Chat Mod','electron' -EA SilentlyContinue | Stop-Process -Force
```

**Never kill `Fallout76` — that is the game.**

One launcher window at a time; close it when its job is done.

### Stale portproxy rules can black-hole a dev port (2026-06-10 incident)

**Symptom:** a dev port (e.g. the dashboard's 7075) is "in use" but every request times out;
`Get-NetTCPConnection -LocalPort 7075 -State Listen` shows the owner is **`svchost`** (service
`iphlpsvc`), not `node`. A freshly launched Vite then silently drifts to the next port
(7076 — which conflicts with Docker Desktop internals), so you end up with a dev server on a
port nothing else expects.

**Cause:** a leftover `netsh interface portproxy` rule from a previous *WSL-side* dev-server
session (added so Windows could reach a Vite running inside WSL). WSL2 gets a new IP on every
restart, so the rule keeps forwarding to a dead address forever. Portproxy rules are
**persistent** — they survive reboots and silently squat the port until deleted.

**Diagnose:**

```powershell
netsh interface portproxy show all                      # any rule on a dev port = suspect
Get-NetTCPConnection -LocalPort 7075 -State Listen      # owner svchost/iphlpsvc = portproxy
```

**Fix (elevated, e.g. via gsudo):**

```powershell
gsudo netsh interface portproxy delete v4tov4 listenport=7075 listenaddress=127.0.0.1
```

**Prevention:**
- **Don't create portproxy rules for dev servers.** Run the dev server on the same side
  (Windows) as whatever needs to reach it — same rule as the Docker/Node boundary above.
  If a portproxy is ever truly needed, delete it in the same session that created it.
- When a dev port misbehaves, check `netsh interface portproxy show all` **before** assuming
  a stuck process — `Stop-Process` cannot fix a portproxy squat.
- Watch Vite's startup output for `Port 7075 is in use, trying another one...` — port drift
  means two instances or a squatter; stop and investigate rather than using the drifted port.
- When launching a dev server in a new window from a script/agent, prefer
  `Start-Process ... -WorkingDirectory "<dir>"` over embedding `cd '<path with spaces>'` in
  the command string — nested-quote mangling makes the launch fail silently and the `-NoExit`
  window sits there looking alive with nothing running in it.

---

## Database Tools

```bash
npx prisma migrate dev       # apply schema migrations
npx prisma studio            # visual DB browser
npm test                     # Jest + Supertest
```

All Prisma migrations must be idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`). See the "Prisma Migrations" section in `CLAUDE.md` for full rules.
