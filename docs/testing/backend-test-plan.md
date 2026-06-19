# Backend Test Plan

> **Status (2026-06-06):** Infrastructure complete. 20/21 Jest suites pass; 136/136 TS unit tests
> pass. Coverage is thin — only the 4 wiki-catalog services have meaningful unit tests. The 47
> controllers, 40 routes, and most services are untested.

## What exists today

### Jest + supertest (`backend/tests/`)

Runs against compiled `dist/` (`npm run build` first). All infrastructure is mocked — no live DB or
Redis needed for most suites.

| Suite | What it covers |
|-------|---------------|
| `autoMessages.test.js` | `firePeerJoinAnnounce`/`fireWelcome` Redis dedup logic |
| `autoModService.test.js` | `filterContent` phrase/regex matching, `detectSpam` sliding-window |
| `broadcastToPartyMembers.test.js` | Party broadcast fanout |
| `endpointNormalize.test.js` | `normalizeWorldEndpoint` / `isCanonicalWorldEndpoint` |
| `errorHandler.test.js` | RFC 7807 error shape + middleware chain |
| `fsmAuthority.test.js` | `firePeerJoinAnnounce` name-overlap trigger + FSM gate predicate |
| `health.test.js` | `GET /api/health` + `GET /api/version` response shapes |
| `integration.test.js` | Auth middleware contract, rate-limit headers, input validation |
| `partiesController.test.js` | Party create/join/leave/invite HTTP contracts |
| `partyReap.test.js` | Ephemeral + persistent party GC logic; `startPartyReapJob` overlap guard (startup reconcile + interval ticks never run concurrently) |
| `onlineSnapshotJob.test.js` | Snapshot sampler + retention purge overlap guards (skip while previous run pending) and schedule registration |
| `phase4SameServer.test.js` | Same-server matching (4-phase endpoint overlap) |
| `presence-flow.test.js` | `presence:update` → endpoint-update flow |
| `registerNameBlacklist.test.js` | Name blacklist matching (static + DB-backed) |
| `stalePresence.test.js` | Stale presence reaper (TTL eviction) |
| `users.test.js` | `POST /api/users` registration (device auth + Discord gate) |
| `validation.test.js` | Joi schema validate middleware |
| `welcomeDedup.test.js` | Welcome dedup Redis keys |
| `wiki.test.js` | `/api/wiki/*` public search + `/api/admin/wiki/ingest` |
| `worldSessionService.test.js` | Session mint/attach/leave/stale — Prisma in-memory mock |
| `worldTrace.test.js` | _All tests skipped — route removed in v1.3.69_ |
| `wsFlap.test.js` | WS connect/disconnect churn throttle |

### TS unit runner (`backend/src/services/__tests__/`)

Run via `npm run test:unit` (node:test + tsx, no build needed).

| Suite | What it covers |
|-------|---------------|
| `wikiCatalogService.test.ts` | `trimInfobox` per-kind field filtering, `bestMatch` selection rule |
| `wikiImageService.test.ts` | Image dedup, S3 key derivation, infobox image extraction |
| `wikiParser.test.ts` | Wikitext parsing — `extractInfobox`, `isMapImage`, `filterPageImages` |

---

## What needs tests

The gaps below are ordered roughly by risk and value. None are blocking the current CI gate (which
is report-only for `backend-jest`), but they represent real correctness blind spots.

### Priority 1 — business-critical services (no tests at all)

These services run on every message, every login, or every moderation action. Bugs here affect all
users and are hard to catch in review.

| Target | What to test |
|--------|-------------|
| `services/messageService.ts` | Content filtering pipeline (automod → shadowMute → persist queue); message length/rate enforcement; `buildChatFrame` payload shape |
| `services/deviceAuthService.ts` | P-256 signature verification; TOFU enrolment path; revocation reject; replay window; `extractSignatureHeaders` parsing |
| `services/moderationActionsService.ts` | Mute/ban/kick/wipe with correct audit log entries; expiry sweep; role-check gate |
| `services/automodService.ts` (deeper) | Word filter cache invalidation; `shadowMute` path; `setSpamImmunity` effect; `findProhibitedPhrase` |
| `services/nameBlacklistService.ts` | DB-backed + static blacklist merge; pattern match types (prefix/regex/exact); `loadBlacklist` cache |
| `services/commandService.ts` | `/camp`, `/roll`, `/me`, `/w`, invalid command → correct response frame |
| `services/worldSessionService.ts` (deeper) | Co-location threshold (≥5 vs ≥3 overlap); `endStaleSessions` TTL; hot-swap FK migration |

### Priority 2 — HTTP endpoint contracts

The Jest integration suites cover middleware patterns but not per-route semantics. Each controller
needs a contract test that asserts: correct status code, response envelope shape, auth gating, and
validation rejection.

**High traffic / security-sensitive (do first):**

| Endpoint group | Key behaviors to assert |
|----------------|------------------------|
| `POST /api/users` (register) | Discord gate 403; device-key gate 403/422; success 201 with `{data:{userId,token}}`; installToken UUID validation |
| `GET /api/channels` | Returns `{data:[...]}` with id/name/color; auth required; 401 shape |
| `POST /api/messages` | Body validation (content, channelId); automod block → 403 with reason; success 201 |
| `GET /api/messages` | Pagination (cursor/limit); channel filter; blocked-user exclusion |
| `POST /auth/discord/callback` | State+code validation; links discordId; 400 on bad state |
| `GET /api/public/stats` | Unauthenticated; returns `{data:{onlineNow,totalUsers,totalMessages,...}}`; 30s cache |

**Moderation (moderator-role gated):**

| Endpoint group | Key behaviors to assert |
|----------------|------------------------|
| `POST /api/moderation/mute/:id` | Requires moderator+; creates audit log; 403 for member |
| `POST /api/moderation/ban/:id` | Requires admin+; blocks future logins; correct 403/409 shapes |
| `DELETE /api/moderation/ban/:id` | Requires owner; unbans; clears session |
| `GET /api/moderation-logs` | Paginates; filters by userId/action/room; moderator-gated |
| `POST /api/automod-rules` | Creates word filter; validates phrase/is_regex; clears cache |

**Admin / rarely-hit but high-blast-radius:**

| Endpoint group | Key behaviors |
|----------------|---------------|
| `POST /api/admin/camp/ingest` | Same pattern as wiki — rate-limit check for full mode, 202/409 |
| `GET /api/admin/world-traces` | Admin-key gated; userId required; paginates |
| `GET /api/releases` | Returns ordered release list; unauthenticated |
| `POST /admin/releases` | Owner-only; validates version/notes/downloadUrl/size; purges old YML |

### Priority 3 — WebSocket handler units

`backend/src/websocket/handlers.ts` is the real-time core. It's partially covered by the flow
tests (`presence-flow`, `wsFlap`, `worldSessionService`), but the handler functions themselves
have no isolated unit tests.

| Behavior | Approach |
|----------|----------|
| `chat:message` frame validation + broadcast | Inject mock WS client set + mock Prisma; assert frame fanout excludes sender and blocked users |
| `presence:update` endpoint normalization | Inject stub `normalizeWorldEndpoint`; assert endpoint stored only when valid; matchmake-only short-circuit |
| `room:join` / `room:leave` subscription state | In-memory subscription map; assert correct join/leave accounting and empty-room cleanup |
| `getClientCount()` accuracy | Registered vs de-registered clients; concurrent joins/leaves |
| `syncClientEndpointFromAuthority` | Authority-write path; assert DB update called when endpoint differs |

### Priority 4 — jobs / cron

Background jobs run silently. A bug here means data rot (stale sessions, uncleaned parties, missed
snapshots) with no visible error.

| Job | What to test |
|-----|-------------|
| `jobs/partyReap.ts` | Covered by `partyReap.test.js` (ephemeral + persistent GC, invite expiry, overlap guard). Still TODO: last-member end-session. |
| `jobs/onlineSnapshotJob.ts` | Overlap guards covered by `onlineSnapshotJob.test.js`. Still TODO: assert `dbQuery` called with correct `online_count` payload; non-fatal on DB error path. |
| `jobs/wikiSyncSchedule.ts` | Delegates to `runIncrementalSync`; errors swallowed without crashing. |
| `jobs/campSyncSchedule.ts` | Same pattern as wiki sync. |

### Priority 5 — services with no path to existing tests

Services that haven't been touched by any test at all:

- `services/campService.ts` — item search, image mirror, upsert logic
- `services/discordService.ts` — guild fetch, role ID resolution, relay bridging (hard to unit-test; mock discord.js client)
- `services/voiceService.ts` — temporary voice channel lifecycle
- `services/reportImageService.ts` — file-type validation, S3 upload, MIME guard
- `services/publicStatsService.ts` — query + 30s cache behavior
- `services/sameServerService.ts` — `sameServerUserSet` Redis read; `resolveEffectiveEndpoint` fallback chain (partially covered by phase4SameServer)
- `services/presenceClearedRegistry.ts` — cleared-endpoint TTL; dedupe

---

## Infrastructure notes

### Two test runners — must run both

```bash
# 1. Jest (compiled .js — requires build first)
npm run build
npm test

# 2. TS unit runner (node:test via tsx — no build needed)
npm run test:unit
```

CI runs both in `backend-jest` (`continue-on-error: true` — informational, not a gate yet). Once
backend coverage is meaningful, promote to the required `CI Summary` gate.

### Test database

Jest integration tests mock Prisma/db; they don't need a live database. For any future test that
DOES need a real DB (e.g. migration smoke tests), use the Docker Postgres on port 7077
(`DATABASE_URL` from `.env.local`) with a separate `fcm_test` schema to avoid trashing dev data.

### Adding a controller contract test

Pattern — mirrors what `health.test.js`, `users.test.js`, `integration.test.js` do:

```js
'use strict';
jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), pool: { on: jest.fn() }, healthCheck: jest.fn().mockResolvedValue(true) }));
jest.mock('../src/config/redis', () => ({ getRedisClient: jest.fn().mockResolvedValue({ get: jest.fn(), set: jest.fn(), del: jest.fn(), on: jest.fn() }), healthCheck: jest.fn().mockResolvedValue(true) }));
jest.mock('rate-limit-redis', () => ({ RedisStore: jest.fn().mockImplementation(() => ({ increment: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }), localKeys: true })) }));
jest.mock('../src/services/discordService', () => ({ start: jest.fn(), setBroadcast: jest.fn(), getStatus: jest.fn().mockReturnValue('disconnected') }));

const { app } = require('../src/server');
const request = require('supertest');

describe('GET /api/<endpoint>', () => {
  it('returns correct shape', async () => {
    const res = await request(app).get('/api/<endpoint>').set('X-Auth-Token', '<test-session>');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('<field>');
  });
});
```

The `tests/setup/prisma-stub.js` module provides a comprehensive Prisma mock with all models. Override
specific methods per test via `prismaStub.<model>.<method>.mockResolvedValueOnce(...)`.
