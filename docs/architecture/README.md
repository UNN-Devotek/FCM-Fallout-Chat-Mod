# Architecture Overview

Fallout Chat Mod is a governed, real-time community chat platform for Fallout 76. It is **EULA §4(F) compliant** — no game-memory reading, no game-file modification, no code injection, no network/port scanning. The desktop client only checks whether the `Fallout76` process is running (to show/hide the overlay); it does not read game state.

---

## Monorepo Structure

```
/Fallout Chat Mod/
├── backend/               # Node.js + Express + raw WebSockets + Prisma + Discord.js
│   ├── src/server.ts      # Express app, WS server, all route mounts, cron jobs
│   ├── src/websocket/     # WS connection handler, broadcast, pub/sub
│   ├── src/services/      # Business logic (message, discord, voice, moderation, …)
│   ├── src/routes/        # Express route modules (one file per domain)
│   ├── src/controllers/   # Request handlers
│   ├── src/middleware/     # Auth, rate limiting, error formatting
│   ├── src/queues/        # Bull job queues (message persistence)
│   ├── src/jobs/          # Scheduled cron workers
│   └── db/init.sql        # Idempotent Postgres bootstrap
├── admin-dashboard/       # React 18 + Vite + Tailwind
│   └── src/features/chat/ChatOverlay.tsx   # THE single chat overlay component
├── cross-platform-overlay/ # Electron app (Windows + Linux)
│   ├── shell.ts / main.js  # Window chrome, keybinds, IPC, game-gate
│   └── (renders ChatOverlay via @dashboard/* alias)
├── Packaging/             # Build + publish scripts (PS1)
└── docs/                  # This documentation tree
```

---

## The Three Surfaces

All three surfaces render the **same** `ChatOverlay` React component from `admin-dashboard/src/features/chat/ChatOverlay.tsx`. They differ only in the runtime context the component detects:

| Surface | Route / Entry | Auth model | Real-time |
|---------|--------------|------------|-----------|
| **Auth dashboard** | `/chat` (React Router) | Discord OAuth2 session | WebSocket (`chat:history` / `chat:message`) |
| **Public website** | Landing-page CHAT tab | None — `isPublicMode=true` | REST poll every ~3 s |
| **Electron overlay** | Loaded by `cross-platform-overlay` via `@dashboard/*` alias | Provider-linked install token (Discord or Steam) → 24 h Redis session token | WebSocket |

### ONE component, three surfaces (parity rule)

`ChatOverlay.tsx` is the **single source of truth** for the chat UI. Changes to it are automatically reflected on all three surfaces. **Never fork or duplicate it.** Window chrome (drag/resize, click-through, z-order, idle-collapse, hotkeys) lives in `shell.ts` and `main.js` — outside React.

Branching within the component is limited to:

- `overlayShell` — truthy when running inside Electron; gates window-chrome IPC calls.
- `isPublicMode` — `!user && !getOverlayShell()`; enforces read-only mode (no input, no moderation, public REST only).

See [glossary.md](./glossary.md) for term definitions and [data-flow.md](./data-flow.md) for the end-to-end message path.

---

## Infrastructure at a Glance

```
Internet
    │
    ▼
Cloudflare (CDN + DDoS)
    │
    ▼
cloudflared tunnel
    │
    ▼
Docker Compose on VPS (Dokploy)
    ├── backend   (Node.js — port 7177 internally)
    │       ├── serves admin-dashboard SPA (express.static)
    │       ├── REST API   /api/*
    │       ├── Auth       /auth/*
    │       └── WebSocket  wss://<host>/ws
    ├── postgres  (port 5432 → 7077 locally)
    ├── redis     (port 6379 → 7078 locally)
    └── minio     (object storage: avatars, party images)
```

The backend serves the compiled `admin-dashboard/dist` SPA as static files from the same origin, so the dashboard and API share a domain (no cross-origin WebSocket or cookie issues).

Auto-deploy: every push to `prod` triggers Dokploy to rebuild and redeploy. Pushing code **is** deploying.

---

## Related docs

- [system-overview.md](./system-overview.md) — component table, tech stack, request/response conventions
- [data-flow.md](./data-flow.md) — end-to-end message flow, auth flow, Discord bridge
- [glossary.md](./glossary.md) — domain term definitions
- [../backend/](../backend/) — backend-specific docs (TODO)
- [../realtime/](../realtime/) — WebSocket protocol reference (TODO)
- [../overlay/](../overlay/) — Electron overlay build + release (TODO)
- [../discord/](../discord/) — Discord bot features: voice, embeds, reaction roles (TODO)
- [../database/](../database/) — schema, migrations, idempotency rules (TODO)
