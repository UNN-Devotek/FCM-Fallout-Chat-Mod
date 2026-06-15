# Fallout Chat Mod

A real-time community chat platform for Fallout 76. No Script Extender required — works with any version of the game (Steam, Bethesda Launcher, Game Pass). The client does **not** read game memory, modify game files, or scan network connections. It only detects whether the game process is running (to show/hide the overlay) and opens a WebSocket to the relay.

Chat is organised into community channels (General / Trading / Events / Raids) with a bidirectional Discord bridge, moderated through a browser-based admin dashboard.

**Platforms:** Windows and Linux/Proton (Electron-based overlay).

> **Disclaimer:** Fallout Chat Mod is an unofficial fan project. It is not affiliated with, endorsed, or sponsored by Bethesda Softworks or ZeniMax Media. Fallout® is a trademark of ZeniMax Media, Inc.

---

## Architecture

```
+---------------------------+        WebSocket (wss://)
|  Electron Overlay          |------->|                           |
|  cross-platform-overlay/   |        |  Node.js Backend          |
|                            |        |  Express + ws + Prisma    |
|  - React renderer (Vite)   |        |  + Discord.js             |
|  - main.js (Electron main) |        |                           |
|  - preload.js (IPC bridge) |<-------|  REST  /  WebSocket       |
|  - Auto-updater            |        +--------+------------------+
|  - Onboarding flow         |                 |
+---------------------------+            Postgres 16
                                          Redis 7
+---------------------------+            (sessions, pub-sub,
|  React Admin Dashboard    |             rate-limit counters)
|  admin-dashboard/         |
|  (Vite + Tailwind v4)     |<-----------  REST API  (HTTPS)
|  Discord OAuth2 gated     |              Admin endpoints
+---------------------------+

+---------------------------+
|  Discord Bot              |<------- bidirectional message relay
|  (discord.js v14)         |         (backend/src/services/
+---------------------------+          discordService.ts)
```

The **Electron overlay** ships a React renderer bundled by Vite. The Electron main process (`main.js`) manages the transparent always-on-top window, forwards IPC to the renderer via `preload.js`, watches for the Fallout 76 process, and drives `electron-updater` for silent auto-updates. The **backend** handles authentication, real-time message sync via raw WebSocket, Redis pub/sub broadcast, Bull queue for async Postgres persistence, and the bidirectional Discord bridge. The **admin dashboard** is authenticated via Discord OAuth2 with per-request role re-verification.

---

## Monorepo Layout

```
/
├── backend/                  Node.js + Express + Prisma + ws
│   ├── prisma/               Schema and migrations
│   └── src/
│       ├── controllers/
│       ├── routes/
│       ├── services/         discordService, autoMod, communityStats, …
│       ├── middleware/
│       └── websocket/
├── admin-dashboard/          React 18 + Vite + Tailwind v4
│   └── src/
│       └── features/         chat, system, moderation, …
├── cross-platform-overlay/   Electron + React + Vite
│   ├── main.js               Electron main process
│   ├── preload.js            Context bridge
│   ├── updater.js            electron-updater wiring
│   ├── src/                  React renderer + bridge + shell + onboarding
│   └── assets/               App icons, KWin rule, platform plists
├── shared/                   Shared TypeScript types and Zod schemas
├── db/                       Postgres init SQL
├── pgbouncer/                PgBouncer config template
├── docs/                     Public documentation (TERMS, CODE-SIGNING)
├── docker-compose.yml        Production compose
├── docker-compose.dev.yml    Development overrides
└── .env.example              Environment variable template
```

---

## Tech Stack

| Layer              | Technology                                                    |
|--------------------|---------------------------------------------------------------|
| Overlay (desktop)  | Electron 31, React 18, Vite 6, Tailwind v4, electron-updater |
| Admin Dashboard    | React 18, Vite 6, Tailwind v4, TanStack Query, React Router v6 |
| Backend            | Node.js, Express, `ws` (raw WebSocket), Discord.js v14, Pino |
| ORM / migrations   | Prisma 5 (Postgres 16)                                        |
| Message queue      | Bull (async Postgres persistence)                             |
| Input validation   | Zod (shared schemas), Joi (backend REST)                      |
| Rate limiting      | express-rate-limit + rate-limit-redis                         |
| Cache / pub-sub    | Redis 7                                                       |
| Connection pooling | PgBouncer (transaction mode)                                  |
| Infrastructure     | Docker / Docker Compose, Dokploy (self-hosted VPS)            |
| CI/CD              | GitHub Actions                                                |

---

## Prerequisites

**All contributors:**
- Node.js 18 or later
- Docker Desktop (for the Postgres + Redis stack)
- A Discord application with a bot token and OAuth2 credentials (see [Discord Setup](#discord-setup))

**Overlay development (Windows or Linux):**
- Node.js 18+ (Electron is installed via npm)

**Overlay distribution builds:**
- Windows: electron-builder handles NSIS packaging (`dist:win`)
- Linux: electron-builder produces an AppImage (`dist:linux`)

---

## Dev Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd fallout-chat-mod

# Install workspace-level dev deps (Playwright, etc.)
npm install

# Install each package
cd backend && npm install && cd ..
cd admin-dashboard && npm install && cd ..
cd cross-platform-overlay && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

**The defaults in `.env.example` boot a fully working local stack with no extra setup — no Discord bot required.** In development:

- **Discord is optional.** Leave `DISCORD_TOKEN` / `DISCORD_CLIENT_*` / role IDs empty — the bot bridge detects the missing token and disables itself (the rest of the app runs normally). Sign in via **dev-login** instead of Discord OAuth (`ENABLE_DEV_LOGIN=true`, already set — see step 3).
- `APP_CLIENT_KEY` is pre-set to the overlay's default so the Electron overlay can register out of the box.
- `SESSION_SECRET` / datastore passwords have throwaway dev values.

**Production is stricter:** with `NODE_ENV=production` the backend's boot guard *requires* real `SESSION_SECRET`, `DB_PASSWORD`, `DISCORD_CLIENT_ID`/`SECRET`, non-default MinIO creds, and a non-wildcard `CLIENT_ORIGINS` — it refuses to start otherwise. So Discord + real secrets are mandatory for prod, optional for dev.

### 3. Start backend services (Docker)

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

This starts Postgres (host port 7077), Redis (7078), MinIO, the Node.js backend (**port 7076**), and the dashboard dev server at **http://localhost:3200**. The Prisma schema is synced automatically on boot via `prisma db push` (so the dev DB always matches `schema.prisma`). Open http://localhost:3200, sign in (see dev-login below), and you can message in chat against your fully local stack.

> The dev override resets the production hardening from `docker-compose.yml` (the external `dokploy-network`, read-only rootfs, dropped caps) so the stack comes up cleanly on any machine — no Cloudflare/Dokploy setup required.

**Verify:**
```bash
curl http://localhost:7076/api/health
```

**Sign in locally (dev-login — no Discord needed):** set `ENABLE_DEV_LOGIN=true` (and `NODE_ENV=development`) in `backend/.env`, then hit `http://localhost:7076/auth/dev-login/admin` (personas: `user`, `mod`, `admin`, `supporter`). This mints a session without Discord OAuth so you can use the dashboard and chat immediately. These routes are gated off unless `ENABLE_DEV_LOGIN=true`, so they can never appear in production.

### 4. Run each package independently

**Backend (hot reload):**
```bash
cd backend
npm run dev        # tsx watch — restarts on file change
```

**Admin dashboard:**
```bash
cd admin-dashboard
npm run dev        # Vite dev server at http://localhost:3000
```

**Electron overlay — develop against your LOCAL backend:**

For development, always run the overlay against your **own local backend** (`http://localhost:7076`). The `:local` scripts wire this up for you:

```bash
cd cross-platform-overlay

# Hot reload — ONE command: starts the Vite renderer + launches Electron against
# your local backend. Edit ChatOverlay.tsx / shell.ts → the overlay live-reloads.
npm run dev:local

# Built (no HMR), still against your local backend:
npm run start:local
```

> **⚠️ Platform caveat (Windows + WSL):** the overlay's `node_modules` contains native binaries (`rollup`, `electron`) for the OS you ran `npm install` on. Run the overlay tooling on **that same OS** — building/serving from WSL against a Windows-installed `node_modules` fails with `Cannot find module @rollup/rollup-linux-x64-gnu`. The backend + dashboard can stay in Docker/WSL; just run the **overlay** on Windows (PowerShell).

Unpackaged dev runs automatically send an `X-Overlay-Dev` header so your local backend's rate limiter doesn't throttle repeated registrations.

> `npm start` / `npm run dist:*` build the **shipped, end-user binary**, which connects to the production relay — they are **not** a development workflow. Develop only against your local stack with the `:local` scripts above; don't point a dev build at production.

### Hot reload — all three surfaces
| Surface | Command | Reloads on |
|---|---|---|
| **Backend** | `cd backend && npm run dev` (or the Docker dev stack) | `tsx watch` restarts on any `backend/src` change |
| **Dashboard (website)** | `cd admin-dashboard && npm run dev` | Vite HMR |
| **Overlay** | `cd cross-platform-overlay && npm run dev:local` | Vite HMR (shares `ChatOverlay.tsx` with the dashboard) |

### 5. Build the overlay for distribution

```bash
cd cross-platform-overlay
npm run dist:win    # Windows NSIS installer → dist/
npm run dist:linux  # Linux AppImage → dist/
```

### 6. Run backend tests

```bash
cd backend
npm test            # Jest + Supertest
```

---

## Environment Variables

### For local development — you generate **nothing**

`cp .env.example .env` and you're done. The example ships working local defaults for every variable the stack needs to boot, and **Discord is entirely optional** in dev (the bot bridge disables itself when `DISCORD_TOKEN` is empty; sign in with dev-login instead of Discord OAuth). The same applies on **Linux, macOS, and Windows** — no OS-specific variables.

Pre-filled dev defaults (don't change them to run locally):

| Variable | Dev default | Purpose |
|----------|-------------|---------|
| `NODE_ENV` | `development` | enables dev-login, relaxed guards |
| `ENABLE_DEV_LOGIN` | `true` | `/auth/dev-login/<persona>` — sign in with no Discord |
| `DB_PASSWORD` / `REDIS_PASSWORD` | dev values | datastore auth (compose reads these) |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` / `MINIO_BUCKET` | dev values | object storage (avatars) |
| `APP_CLIENT_KEY` | `fo76-chat-desktop-v1` | matches the overlay default so it can register |
| `SESSION_SECRET` | throwaway string | session cookies |
| `DISCORD_*`, `*_ROLE_ID`, `ADMIN_API_KEY`, `ADMIN_RELEASE_TOKEN` | empty | optional in dev |

### Required for **production** (you must generate these)

With `NODE_ENV=production` the backend's boot guard **refuses to start** unless these are set to real, non-default values:

| Variable | Description |
|----------|-------------|
| `SESSION_SECRET` | random 32+ char secret |
| `DB_PASSWORD`, `REDIS_PASSWORD` | strong datastore passwords |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | **non-default** object-storage creds |
| `CLIENT_ORIGINS` | explicit allow-list (no `*` wildcard) |
| `DISCORD_TOKEN` | bot token (chat bridge + voice/embeds/reaction-roles) |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` / `DISCORD_REDIRECT_URI` | OAuth2 app for admin-dashboard login |
| `DISCORD_CHANNEL_ID` / `DISCORD_SERVER_ID` | bridge channel + guild for role verification |
| `OWNER_ROLE_ID` / `ADMIN_ROLE_ID` / `MODERATOR_ROLE_ID` | Discord roles → dashboard access tiers |
| `APP_CLIENT_KEY` | shared key desktop clients present to register |
| `ADMIN_API_KEY` | `X-Admin-API-Key` for CLI/debug admin endpoints |
| `ADMIN_RELEASE_TOKEN` | bearer token for `POST /admin/releases` |

Other optional knobs: `LOG_LEVEL` (`info`), `MESSAGE_RETENTION_DAYS` (`90`).

---

## Discord Setup

### Chat Bridge Bot

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. Bot tab → Add Bot → copy token → set `DISCORD_TOKEN`
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. OAuth2 URL Generator → Scopes: `bot` → Permissions: Send Messages, Read Message History, View Channels
5. Invite the bot, then copy the target channel ID → set `DISCORD_CHANNEL_ID`

The bot also supports:
- **Join-to-Create voice channels** (temp voice rooms) — configure the lobby channel in the dashboard under CHAT → TEMP VOICE
- **Reaction Roles** — set up via CHAT → EMBEDS; the bot posts the embed and handles reactions
- **Rich Embeds** — build and post Discord embeds from the dashboard

### Admin Dashboard OAuth2

1. Same application → OAuth2 tab → add redirect URI (`http://localhost:7076/auth/discord/callback` for dev)
2. Copy Client ID → `DISCORD_CLIENT_ID`, Client Secret → `DISCORD_CLIENT_SECRET`
3. Set `DISCORD_SERVER_ID`, `OWNER_ROLE_ID`, `ADMIN_ROLE_ID`, `MODERATOR_ROLE_ID`

---

## Port Scheme

Ports follow a "76" theme.

| Service    | Development | Production |
|------------|-------------|------------|
| Backend    | 7076        | 7676       |
| PostgreSQL | 7077        | 7677       |
| Redis      | 7078        | 7678       |

---

## Authentication Model

**Overlay (desktop client)**
1. Client calls `POST /api/users` with `{ username, installToken }`.
2. Server returns a 24-hour ephemeral session token stored in Redis.
3. Client connects to WebSocket with `X-Auth-Token: <token>`. Invalid tokens → close code 4001.

**Admin Dashboard**
1. Discord OAuth2 → backend verifies guild membership + role.
2. Role is re-verified on every protected request. Revoking the Discord role immediately blocks access.

---

## Rate Limiting

| Layer     | Limit                                    |
|-----------|------------------------------------------|
| REST API  | 100 requests / 15 min per IP             |
| WebSocket | 2 messages / second per socket           |
| Auto-mod  | Word filter + spam detection per message |

---

## Display Mode (Windows)

The overlay requires Fallout 76 to run in **Windowed Borderless** or **Windowed** mode. In Exclusive Fullscreen the GPU presents frames directly — no external window can render above it.

FO76: Options → Display → Display Mode → **Windowed Borderless** (recommended).

## Display Mode (Linux / Proton)

See `cross-platform-overlay/assets/install/INSTALL-LINUX.txt` for the KDE Plasma / Wayland setup. Short version: run FO76 in **WINDOWED** mode (not Borderless) and set the taskbar to Auto-Hide.

---

## Antivirus / SmartScreen

Unsigned binaries trigger SmartScreen and some AV heuristics by reputation alone — not because of behavior. Fallout Chat Mod does not read game memory, modify game files, inject code, or scan network connections. The only potentially flagged behavior is the global low-level keyboard hook used for hotkeys (classic keylogger heuristic — a migration to `RegisterHotKey` is tracked in `docs/CODE-SIGNING.md`).

Code signing is planned (Azure Trusted Signing). Until signed, if your AV blocks the overlay, add exclusions for:
- `%LocalAppData%\Programs\Fallout Chat Mod\`
- `%LocalAppData%\FalloutChatOverlay\`

Code signing is on the roadmap to remove these reputation-based warnings.

---

## EULA Compliance

Fallout Chat Mod ships in two clearly separated forms:

1. **Desktop overlay (default, EULA-safe).** The transparent overlay does **not** read game memory, modify game files, inject code, or scan network connections. Its only game-process interaction is checking whether `Fallout76.exe` is running (via the public OS process list) to show or hide the overlay.

2. **In-game HUD mods (`.ba2`, optional opt-in).** A separate install that renders chat inside the game HUD by swapping UI assets only. It is never bundled into or required by the overlay — you choose to install it at your own discretion. Even here, no game memory is read, no code is injected, and no networks are scanned.

Character names are entered manually during onboarding (or via the Settings page).

---

## Hosted Dev Environment

A shared, isolated dev stack runs at **`dev.falloutchatmod.com`** (separate Dokploy
project `fcm-dev`, fully isolated from prod — real wiki/camp reference data + **fake**
users/chat, never confidential data). Full design + runbook:
[docs/deployment/hosted-dev-environment.md](docs/deployment/hosted-dev-environment.md).

### Onboarding a developer

Access requires the **developer role in BOTH Discord servers** plus a Cloudflare Access
allowlist entry. To grant a new developer access (maintainer steps):

1. **Prod Discord server** — assign them the **`developer`** role.
2. **Dev Discord server** — assign them the **`developer`** role.
   *(Both are required — the app's dual-role gate denies anyone missing either.)*
3. **Cloudflare Access** — add their email to the **"FCM Developers"** Access group
   (Zero Trust → Access → Groups → *FCM Developers* → Include → add email). This gates
   `dev.falloutchatmod.com`; they sign in via One-time PIN (email code).
4. **(Only if they need direct DB / object-store access)** give them the Cloudflare Access
   **service token** (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) so they can run
   `cloudflared access tcp --hostname dev-db.falloutchatmod.com ...`.

To **revoke**: remove the `developer` role in either Discord server (gate denies within the
token TTL) and/or remove their email from the "FCM Developers" group (instant).

Most contributors don't need any of this — they run the **fully-local stack** (see
[Dev Setup](#dev-setup)) and submit PRs against `dev`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

Licensed under the [MIT License](LICENSE).

Copyright (c) 2026 Devotek.

---

## Disclaimer

Fallout Chat Mod is an unofficial fan project. It is not affiliated with, endorsed by, or
sponsored by Bethesda Softworks LLC or ZeniMax Media Inc. Fallout® is a registered trademark
of ZeniMax Media Inc. All related marks, characters, and intellectual property are property of
their respective owners.

The MIT License covering this project applies only to its own original source code. It does not
grant any rights to Bethesda or ZeniMax IP. Users who install in-game HUD mods (e.g. FCMBridge)
do so at their own risk and are responsible for ensuring compliance with the game's End User
License Agreement.
