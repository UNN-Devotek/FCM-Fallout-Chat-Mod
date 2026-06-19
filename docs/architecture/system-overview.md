# System Overview

## Components

| Component | Tech | Role |
|-----------|------|------|
| `backend` | Node.js 20, Express, raw `ws`, Prisma ORM, Discord.js, Bull, node-cron | Auth, messaging, Discord bridge, REST API; also serves the dashboard SPA |
| `admin-dashboard` | React 18, Vite, Tailwind CSS, TanStack Query, React Router v6 | Admin/moderation portal **and** the single `ChatOverlay` component |
| `cross-platform-overlay` | Electron (Windows + Linux), React renderer via `@dashboard/*` alias | Transparent in-game overlay; window management in `shell.ts` + `main.js` |
| PostgreSQL | via Prisma + `pg` | Primary data store — messages, users, channels, moderation, parties |
| Redis | `ioredis` / `connect-redis` | Session store, rate-limit counters, Bull job queue, pub/sub fan-out |
| MinIO | S3-compatible object store | Discord avatar cache, party chat images |
| Discord.js bot | Attached to the backend process | Bi-directional relay bridge, temp voice channels, embed builder, reaction roles |

---

## Backend Tech Stack

| Library | Purpose |
|---------|---------|
| `express` | HTTP server, route mounting |
| `helmet` | Secure HTTP headers (CSP, HSTS, clickjacking protection) |
| `cors` | Cross-origin policy (controlled by `CLIENT_ORIGINS` env var) |
| `express-session` + `connect-redis` | Cookie-based sessions backed by Redis (4 h TTL) |
| `ws` | Raw WebSocket server (no Socket.IO) |
| `prisma` | ORM for PostgreSQL; migrations in `backend/prisma/migrations/` |
| `bull` | Redis-backed job queue for async message persistence |
| `node-cron` | Scheduled cleanup (purge messages + audit logs > 90 days, sweep expired mutes/bans) |
| `zod` | Input validation schemas (live in backend, not a shared package) |
| `pino` / `pino-pretty` | Structured JSON logging |

---

## Request / Response Conventions

### Success envelope

All successful REST responses wrap their payload:

```json
{ "data": { ... } }
```

Arrays follow the same shape: `{ "data": [ ... ] }`.

### Error envelope (RFC 7807 Problem Details)

All error responses use the [Problem Details](https://datatracker.ietf.org/doc/html/rfc7807) format:

```json
{
  "type":   "https://fo76chat.app/errors/400",
  "title":  "Bad Request",
  "status": 400,
  "detail": "Human-readable explanation."
}
```

Rate-limit responses use status `429` with `type` = `https://fo76chat.app/errors/429`.

The error handler is mounted as the **last** Express middleware (`backend/src/middleware/errorHandler.ts`).

---

## Backend Layer Order

```
Incoming HTTP request
        │
        ▼
  helmet (security headers)
        │
        ▼
  cors
        │
        ▼
  express-session (Redis store)
        │
        ▼
  apiLimiter  ← 100 req / 15 min per session token; 500 / 15 min per IP
        │
        ▼
  Route-specific middleware (auth, role checks, per-route rate limits)
        │
        ▼
  Controller  ← validates input, calls service(s)
        │
        ▼
  Service     ← business logic, Prisma queries, Redis ops
        │
        ▼
  errorHandler (RFC 7807)
```

### Rate Limiters (all Redis-backed, fail-open on Redis outage)

| Limiter | Limit | Key |
|---------|-------|-----|
| `apiLimiter` | 100 req / 15 min (authed) · 500 / 15 min (IP) | `x-auth-token` or IP |
| `channelsLimiter` | 500 req / 15 min | token or IP |
| `authLimiter` | 20 req / 15 min | IP |
| `registerLimiter` | 10 req / min per install token (60 dev) | install token or IP |
| `playerListLimiter` | 30 req / min | token or IP |
| `WS chat:send` | 5 frames / sec sliding window (Redis sorted set) | userId |

See `backend/src/middleware/rateLimiter.ts` for full definitions.

---

## WebSocket Protocol

Connections are raw WSS. Every frame is a JSON envelope:

```json
{ "type": "domain:action", "payload": { ... }, "timestamp": "ISO8601", "userId": "uuid" }
```

### Key event types

| Direction | Type | Description |
|-----------|------|-------------|
| Client → Server | `chat:send` | Send a chat message |
| Server → Client | `chat:message` | A message delivered to the client |
| Server → Client | `chat:history` | Bulk history on connect / channel switch |
| Server → Client | `rate:status` | Rate-limit status frame |
| Server → Client | `user:muted` | Mute status update |
| Server → Client | `message:ack` | Delivery acknowledgement |
| Both | `presence:update` | User presence heartbeat |

WS client identity (username, displayName) is cached in the in-memory `clients` Map at connection time. Use `refreshClientIdentity()` (`backend/src/websocket/handlers.ts`) to push updated display names to open sockets without a reconnect.

Multi-instance fan-out uses Redis pub/sub on the `chat:broadcast` channel (`PUBSUB_CHANNEL` in `handlers.ts:704`).

---

## Admin Debug Mirror Pattern

Discord-OAuth-only admin endpoints are not reachable from CLI tooling. Every such endpoint has a mirror at `/admin/debug/*` gated by `X-Admin-API-Key` (`requireAdminKey` middleware). Both paths use identical request/response shapes. Example:

- `/api/admin/community-stats` — requires Discord OAuth admin session
- `/admin/debug/community-stats` — requires `X-Admin-API-Key` header

---

## Dashboard State Architecture

| Layer | Library |
|-------|---------|
| Server state (API data, caching) | TanStack Query |
| UI / ephemeral state | React Context |
| Client routing | React Router v6 |
| Feature structure | `admin-dashboard/src/features/[featureName]/components` + `/hooks` |

---

## Related docs

- [README.md](./README.md) — system overview and three-surface parity rule
- [data-flow.md](./data-flow.md) — end-to-end message and auth flows
- [glossary.md](./glossary.md) — domain term definitions
- [../backend/](../backend/) — backend-specific docs (TODO)
