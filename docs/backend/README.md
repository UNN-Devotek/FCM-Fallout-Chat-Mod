# Backend Overview

Node.js + Express + raw WebSockets + Prisma ORM + Discord.js.

Source root: `backend/src/`

## Folder Map

```
backend/src/
├── server.ts               # App entry point: middleware, route mounts, cron jobs
├── config/
│   ├── environment.ts      # Typed env-var loader (all env access goes through here)
│   ├── database.ts         # Raw pg query helper (used for bulk ops alongside Prisma)
│   ├── prisma.ts           # Singleton PrismaClient
│   ├── redis.ts            # Lazy Redis client (ioredis / node-redis)
│   ├── storage.ts          # MinIO client (avatars + party images)
│   ├── logger.ts           # Pino structured logger
│   └── features.ts         # Runtime feature flags (e.g. PARTIES_ENABLED)
├── controllers/            # HTTP handler functions — called by routes
├── routes/                 # Express Router definitions — wire middleware + controllers
├── services/               # Business logic — called by controllers (and WS handlers)
├── middleware/             # Express middleware (auth, rate-limit, error, validation)
├── jobs/                   # Scheduled background tasks (node-cron / setInterval)
├── queues/                 # Bull queue definitions (message persistence)
├── websocket/
│   └── handlers.ts         # Raw WS server logic (see ../realtime/ docs)
└── utils/                  # Pure helpers (clientIp, constantTimeEquals, mergeUser, …)
```

## Layer Order

```
Routes  →  Middleware (auth / rate-limit / validation)  →  Controllers  →  Services  →  Prisma / Redis / External
```

Error propagation goes the other way: services throw, controllers call `next(err)`, the `errorHandler` middleware renders the RFC 7807 response.

## How Routes Mount (`server.ts`)

All main API routes mount under `/api/` and are subject to `apiLimiter` (100 req/15min per session token, 500/15min per IP). Exceptions:

- `/admin/releases` — mounted at both `/admin/releases` and `/api/releases`
- `/admin/debug/*` — admin-key-only diagnostic mirrors (not under `/api/`, not rate-limited by `apiLimiter`)
- `/admin/migration/*` — gated by `requireMigrationKey`, 10 req/15min per IP
- `/admin/nuke-users` — gated by `requireAdminKey`
- `/auth/*` — Discord OAuth2 flows (not under `/api/`)
- `/avatars/:discordId` and `/party-images/:imageId` — public static-like asset streams

The dashboard SPA (`admin-dashboard/dist/`) is served as `express.static` from the same origin as the backend in production.

## Request / Response Envelope Conventions

**Success:** All JSON responses from controllers wrap data in a `data` key:
```json
{ "data": { ... } }
```

**Errors:** RFC 7807 Problem Details format (see `middleware/errorHandler.ts`):
```json
{
  "type": "https://fo76chat.app/errors/404",
  "title": "Not Found",
  "status": 404,
  "detail": "Human-readable explanation"
}
```
500-level `detail` is redacted in production ("An unexpected error occurred.").
Validation errors include an `errors` array: `[{ "field": "...", "message": "..." }]`.

## Rate Limiting Middleware

All rate limiters use `rate-limit-redis` backed by Redis and return RFC 7807 `429`
responses. The security-critical auth and registration limiters fail over to a
bounded per-process store if Redis is unavailable; the remaining limiters retain
their normal Redis-store failure behaviour. Defined in `middleware/rateLimiter.ts`.

| Limiter | Route(s) | Cap | Window | Key |
|---------|---------|-----|--------|-----|
| `apiLimiter` | `/api/*` (except routes with their own documented skip) and selected non-`/api/` app routes | 100 authed / 500 anon (500 / 1000 unpackaged dev overlay) | 15 min | IP |
| `channelsLimiter` | `GET /api/channels` | 500 | 15 min | token or IP |
| `authLimiter` | `POST /api/users` (register); Discord OAuth routes (`/auth/discord`, `/auth/discord/callback`, `/auth/discord/link`, `/auth/discord/link/callback`) | 20 (500 dev overlay) | 15 min | IP |
| `registerLimiter` | `POST /api/users` | 10/install-token (60 dev) | 1 min | installToken → IP fallback |
| `registerIpFloodLimiter` | `POST /api/users` | 30 | 1 min | IP |
| `playerListLimiter` | `POST /api/player-list` | 30 | 1 min | token or IP |
| `debugReportLimiter` | `POST /api/debug/overlay-report` | 10 | 1 min | IP |
| `applicationsLimiter` | `POST /api/applications` | 3 | 1 hour | IP |
| `partiesListLimiter` | `GET /api/parties`, public party list | 120 | 1 min | token or IP |
| `partyCreateLimiter` | `POST /api/parties` | 4 | 1 min | token |
| `partyJoinLimiter` | `POST /api/parties/:id/join` | 8 | 1 min | token |
| `partyInviteLimiter` | `POST /api/parties/:id/invite*` | 15 | 1 min | token |
| `partyImageUploadLimiter` | `POST /api/parties/upload-image` | 10 | 1 min | token |
| `cosmeticsWriteLimiter` | `PATCH /api/users/:id/chat-name` | 20 (200 unpackaged dev overlay) | 5 min | IP |
| `cosmeticsAppearanceLimiter` | cosmetic profile and Electron-overlay PATCH routes | 120 (500 unpackaged dev overlay) | 5 min | IP |

Unpackaged Electron sends `X-Overlay-Dev: 1` for registration **and every proxied
API request**, so a dev tester can compare appearance choices without consuming the
small production-sized bucket. This is a high but bounded allowance, never a bypass;
packaged builds never add the header. A token-gated `X-Dev-Bypass` header provides a
full skip when `DEV_RATELIMIT_BYPASS_TOKEN` is set.

## Security Headers

Helmet is applied globally with a Content Security Policy:

- `script-src 'self'`
- `connect-src 'self' wss://falloutchatmod.com https://cdn.discordapp.com` (+ localhost in dev)
- `frame-ancestors 'none'`
- `object-src 'none'`

CORS allows `env.CLIENT_ORIGINS` with credentials. The `trust proxy` setting is gated on `TRUST_PROXY` to prevent header spoofing on direct deployments.

## Dev-only endpoints (`NODE_ENV=development`)

The following endpoints are mounted **only** when `NODE_ENV=development`. They are absent
in production regardless of any other env var. They serve the QA tester workflow and the
golden-build version lock; see [hosted-dev-environment.md](../deployment/hosted-dev-environment.md#qa-tester-access).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/auth/discord/qa/start` | none | Initiates Discord OAuth for QA testers; redirects to Discord |
| `GET` | `/auth/discord/qa/callback` | none (state CSRF) | OAuth callback; verifies `DEV_QA_ROLE_ID`, stores a one-time session grant in Redis |
| `GET` | `/api/auth/qa-status/:installToken` | none | Polled by the QA overlay; enforces the golden-build lock (checks `x-client-version` header; returns 426 on mismatch); returns the session grant once and deletes it |
| `POST` | `/api/dev/login-as` | loopback or `X-Dev-Persona-Key`, DEV-only | Issues an immediate synthetic persona session for an unpackaged local or hosted DEV overlay (`{ persona, installToken }`) |
| `GET` | `/auth/discord/dev-login` | none (state CSRF + dual developer-role gate) | Legacy hosted DEV OAuth for a selected synthetic persona; not used by the overlay DevAccount buttons |
| `GET` | `/api/auth/dev-login-status/:installToken` | none | Legacy polling endpoint for the hosted OAuth persona flow |
| `POST` | `/api/admin/qa/active-version` | `x-admin-api-key` | Sets the active QA build version (`QA_ACTIVE_VERSION` in Redis) |
| `GET` | `/api/admin/qa/active-version` | `x-admin-api-key` | Returns the currently-active QA build version |

All eight routes are also subject to `apiLimiter` or `authLimiter` (same caps as their
equivalent non-QA paths). The routes are independent of `ENABLE_DEV_LOGIN` — the hosted
dev environment runs with `ENABLE_DEV_LOGIN=false` while still enabling these endpoints.

## Related Documentation

- [Auth model](./auth.md)
- [REST API Reference](./api-reference.md)
- [Service modules](./services.md)
- [Jobs and Queues](./jobs-and-queues.md)
- [Realtime / WebSocket](../realtime/) *(covers `websocket/handlers.ts`)*
- [Discord bot features](../discord/) *(covers `discordService.ts`, voice, reaction roles, embeds)*
- [Moderation system](../moderation/) *(covers ban/mute/kick/audit-log flows)*
- [Database schema](../database/) *(Prisma schema, migrations)*
