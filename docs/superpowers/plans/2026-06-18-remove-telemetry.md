# Remove Telemetry & Client Performance Metrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the World-Trace Telemetry Control and Client Performance Metrics systems from FCM (keeping Device Keypair Auth), destroying collected data and adopting an explicit no-telemetry stance, with zero regression to other services.

**Architecture:** Backend-only behavioral removal. The desktop client never shipped emit code, so the privacy goal is achieved entirely at server deploy: `POST /api/client-metrics` becomes a `410 Gone` tombstone, the WS connect handler emits a hardcoded `telemetry:set { enabled:false }` kill-switch, and the `telemetry_settings` + `client_metrics` tables are dropped via an idempotent migration.

**Tech Stack:** Node/Express + TypeScript backend (Jest + supertest), Prisma/Postgres, React + Vite admin dashboard (Vitest), WebSocket relay.

## Global Constraints

- Migrations MUST be idempotent — use `DROP TABLE IF EXISTS … CASCADE` (baseline runs `db push` then `migrate deploy`).
- Docs MUST be updated in the same change (hard rule): see Task 7.
- Every change ships with tests in CI (hard rule): Jest backend tests added in Tasks 1–3.
- Keep intact (shared infra): `requireClientAuth`, `requireDiscordRole`, `requireAdminKey`, Redis client, logger, job-tracker.
- Device Keypair Auth (`devices` table, `deviceAuthService`, `requireSignedDevice`, `/devices` page) is OUT OF SCOPE — do not touch.
- Backend test command (run from `backend/`): `npm test` (`jest --runInBand --forceExit`).
- Commit messages: conventional-commit style, NO AI attribution.
- Branch: work on `dev`; promote `dev → prod` via a **merge commit** (never squash/rebase).

---

### Task 1: Client Performance Metrics backend removal + 410 tombstone

**Files:**
- Modify: `backend/src/routes/clientMetrics.ts` (replace entire file with 410 shim)
- Modify: `backend/src/server.ts:69-73` (imports), `:1071-1073` (mounts), `:1668` (job start)
- Delete: `backend/src/services/clientMetricsService.ts`
- Delete: `backend/src/jobs/clientMetricsPurge.ts`
- Test: `backend/tests/clientMetricsRemoved.test.js` (new)

**Interfaces:**
- Produces: `ingestRouter` (Express Router) exported from `clientMetrics.ts`, mounted at `/api/client-metrics`, returns `410` for all methods.

- [ ] **Step 1: Write the failing test** — `backend/tests/clientMetricsRemoved.test.js`

```javascript
'use strict';
const request = require('supertest');

jest.mock('../src/config/database', () => ({
  healthCheck: jest.fn().mockResolvedValue(true),
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  withTransaction: jest.fn().mockImplementation(async (cb) => cb({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) })),
  pool: { on: jest.fn() },
}));
jest.mock('rate-limit-redis', () => ({
  RedisStore: jest.fn().mockImplementation(() => ({
    init: jest.fn().mockResolvedValue(undefined),
    increment: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }),
    decrement: jest.fn().mockResolvedValue(undefined),
    resetKey: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: new Date() }),
    localKeys: true,
  })),
}));
jest.mock('../src/config/redis', () => ({
  getRedisClient: jest.fn().mockResolvedValue({
    get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1), ping: jest.fn().mockResolvedValue('PONG'),
    connect: jest.fn().mockResolvedValue(undefined), on: jest.fn(),
    sendCommand: jest.fn().mockResolvedValue('OK'),
  }),
  healthCheck: jest.fn().mockResolvedValue(true),
}));

const { app } = require('../src/server');

describe('Client metrics endpoint removed', () => {
  it('POST /api/client-metrics returns 410 Gone', async () => {
    const res = await request(app).post('/api/client-metrics').send({ source: 'overlay' });
    expect(res.status).toBe(410);
  });
  it('GET /api/admin/client-metrics is no longer registered (404)', async () => {
    const res = await request(app).get('/api/admin/client-metrics');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest tests/clientMetricsRemoved.test.js -i`
Expected: FAIL — POST returns 204 (current ingest) / GET returns 401|200, not 410/404.

- [ ] **Step 3: Replace `backend/src/routes/clientMetrics.ts` entirely**

```typescript
/**
 * Client Performance Metrics — REMOVED (privacy + simplification).
 *
 * Telemetry/performance collection has been removed. This endpoint is retained
 * ONLY as a 410 Gone tombstone so already-installed desktop clients stop posting
 * cleanly without error noise. No data is stored, no auth/rate-limit needed.
 */
import { Router, Request, Response } from 'express';

const ingestRouter = Router();

ingestRouter.all('/', (_req: Request, res: Response): void => {
  res.status(410).json({
    type: 'https://fo76chat.app/errors/410',
    title: 'Gone',
    status: 410,
    detail: 'Client metrics collection has been removed.',
  });
});

export { ingestRouter };
```

- [ ] **Step 4: Edit `backend/src/server.ts`**

Replace lines 69-73:
```typescript
import {
  ingestRouter as clientMetricsIngestRouter,
  adminRouter as clientMetricsAdminRouter,
  debugRouter as clientMetricsDebugRouter,
} from './routes/clientMetrics';
import { startClientMetricsPurgeJob } from './jobs/clientMetricsPurge';
```
with:
```typescript
import { ingestRouter as clientMetricsIngestRouter } from './routes/clientMetrics';
```

Remove lines 1072-1073 (keep 1071, the ingest mount → now 410):
```typescript
app.use('/api/admin/client-metrics', clientMetricsAdminRouter);
app.use('/admin/debug/client-metrics', clientMetricsDebugRouter);
```

Remove line 1668:
```typescript
startClientMetricsPurgeJob();
```

- [ ] **Step 5: Delete the now-orphaned files**

```bash
git rm backend/src/services/clientMetricsService.ts backend/src/jobs/clientMetricsPurge.ts
```

- [ ] **Step 6: Run test + typecheck**

Run: `cd backend && npx jest tests/clientMetricsRemoved.test.js -i && npx tsc --noEmit`
Expected: PASS, no TS errors. (If `tsc` flags an unused import elsewhere, fix it.)

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/clientMetrics.ts backend/src/server.ts backend/tests/clientMetricsRemoved.test.js
git commit -m "feat(backend): remove client performance metrics ingest/admin + purge job (410 tombstone)"
```

---

### Task 2: communityStats — drop the `versionDistribution` field

**Files:**
- Modify: `backend/src/services/communityStatsService.ts` (lines 24-27, 63-64, 223-238, 312, 322, 336)
- Test: `backend/tests/communityStatsNoVersionDist.test.js` (new) OR extend if a community-stats test exists

**Interfaces:**
- Produces: `CommunityStats` type WITHOUT `versionDistribution`; `getCommunityStats(range)` returns the same object minus that field.

- [ ] **Step 1: Confirm `VersionCount` has no other consumers**

Run: `cd backend && grep -rn "VersionCount" src/ | grep -v communityStatsService.ts`
Expected: no output (safe to remove the interface). If there ARE other consumers, leave the `VersionCount` interface in place and only remove the field/function.

- [ ] **Step 2: Write the failing test** — `backend/tests/communityStatsNoVersionDist.test.js`

```javascript
'use strict';
// getVersionDistribution must no longer exist and the shape must omit it.
const svc = require('../src/services/communityStatsService');

describe('communityStats version distribution removed', () => {
  it('does not export getVersionDistribution', () => {
    expect(svc.getVersionDistribution).toBeUndefined();
  });
});
```

Run: `cd backend && npx jest tests/communityStatsNoVersionDist.test.js -i`
Expected: FAIL (the function still exists, but it's not exported anyway — so this guards the source). If it passes trivially, also assert the source text via the build/typecheck in Step 5.

- [ ] **Step 3: Edit `communityStatsService.ts` — remove the interface field**

Delete lines 63-64:
```typescript
  /** Overlay app_version distribution */
  versionDistribution: VersionCount[];
```

Delete the `VersionCount` interface (lines 24-27) IF Step 1 showed no other consumers:
```typescript
export interface VersionCount {
  version: string;
  count: number;
}
```

- [ ] **Step 4: Edit `communityStatsService.ts` — remove the query + wiring**

Delete the `getVersionDistribution` function (lines 223-238 — the whole `async function getVersionDistribution(cfg)…{…}` block).

In `getCommunityStats` (lines 305-325), remove `versionDistribution,` from the destructuring array and `getVersionDistribution(cfg),` from the `Promise.all([...])`.

In the returned object (lines 327-339), remove the `versionDistribution,` line.

- [ ] **Step 5: Run test + typecheck**

Run: `cd backend && npx jest tests/communityStatsNoVersionDist.test.js -i && npx tsc --noEmit`
Expected: PASS, no TS errors (no dangling `VersionCount` / `getVersionDistribution` references).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/communityStatsService.ts backend/tests/communityStatsNoVersionDist.test.js
git commit -m "feat(backend): drop versionDistribution from community-stats (sourced from removed client_metrics)"
```

---

### Task 3: Telemetry Control backend removal + WS kill-switch

**Files:**
- Modify: `backend/src/websocket/handlers.ts:8` (import), `:1384-1392` (connect block), `:2236-2249` (broadcast fn), `:2265` (export)
- Modify: `backend/src/server.ts:59` (import), `:86` (handlers import), `:1125-1150` (mount + debug handlers), `:1646` (global reg)
- Delete: `backend/src/routes/adminTelemetry.ts`, `backend/src/services/telemetryService.ts`
- Test: `backend/tests/telemetryRemoved.test.js` (new); WS assertion mirrors `backend/tests/wsUpdateHandshake.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: WS connect emits `{ type: 'telemetry:set', payload: { enabled: false } }` unconditionally; `broadcastTelemetrySet` no longer exists.

- [ ] **Step 1: Edit `handlers.ts` connect block (lines 1384-1392)** — replace with hardcoded kill-switch

```typescript
  // Telemetry collection was removed. Emit a one-time telemetry:set{enabled:false}
  // on connect as a permanent kill-switch so any already-installed client that
  // listens for it stops collecting. No DB lookup; always off.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'telemetry:set', payload: { enabled: false } }));
  }
```

- [ ] **Step 2: Edit `handlers.ts`** — remove the import (line 8) and the broadcast fn + export

Delete line 8: `import { getEffectiveTelemetryFor } from '../services/telemetryService';`
Delete the `broadcastTelemetrySet` function (the `export function broadcastTelemetrySet(...) { … }` block, lines ~2228-2249, including its doc comment).
Delete `broadcastTelemetrySet,` from the export list (line 2265).

- [ ] **Step 3: Edit `server.ts`** — remove telemetry wiring

Line 86: remove `broadcastTelemetrySet,` from the destructured `from './websocket/handlers'` import.
Line 59: delete `import adminTelemetryRouter from './routes/adminTelemetry';`
Lines 1125-1150: delete the entire block (the `/api/admin/telemetry` mount + comment AND both `/admin/debug/telemetry` GET/POST handlers).
Line 1646: delete `(global as any).broadcastTelemetrySet = broadcastTelemetrySet;`

- [ ] **Step 4: Delete the orphaned files**

```bash
git rm backend/src/routes/adminTelemetry.ts backend/src/services/telemetryService.ts
```

- [ ] **Step 5: Write the test** — `backend/tests/telemetryRemoved.test.js`

Open `backend/tests/wsUpdateHandshake.test.js` and copy its mock + WS-connect harness verbatim (DB/redis/ws-server setup). Then add a route assertion + a WS assertion:

```javascript
// (mirror the mocks + app/ws boot from wsUpdateHandshake.test.js)
describe('Telemetry control removed', () => {
  it('GET /api/admin/telemetry is no longer registered (404)', async () => {
    const request = require('supertest');
    const { app } = require('../src/server');
    const res = await request(app).get('/api/admin/telemetry');
    expect(res.status).toBe(404);
  });

  it('WS connect pushes telemetry:set { enabled:false }', async () => {
    // Using the same WS connect harness as wsUpdateHandshake.test.js, collect
    // messages received on connect and assert the kill-switch frame is present:
    // expect(messages).toContainEqual({ type: 'telemetry:set', payload: { enabled: false } });
  });
});
```

Implement the WS assertion concretely using the connect harness from `wsUpdateHandshake.test.js` (it already authenticates a socket and reads frames). If WS-connect testing proves too heavy in this harness, keep the `404` route assertion and add a unit assertion that `require('../src/websocket/handlers').broadcastTelemetrySet` is `undefined`.

- [ ] **Step 6: Run test + typecheck**

Run: `cd backend && npx jest tests/telemetryRemoved.test.js -i && npx tsc --noEmit`
Expected: PASS, no TS errors.

- [ ] **Step 7: Commit**

```bash
git add backend/src/websocket/handlers.ts backend/src/server.ts backend/tests/telemetryRemoved.test.js
git commit -m "feat(backend): remove telemetry control; WS emits telemetry:set{false} kill-switch"
```

---

### Task 4: Prisma schema + idempotent drop migration

**Files:**
- Modify: `backend/prisma/schema.prisma` (delete `TelemetrySetting` 391-399, `ClientMetric` 488-504)
- Create: `backend/prisma/migrations/20260618000000_drop_telemetry_and_client_metrics/migration.sql`

- [ ] **Step 1: Remove the two models from `schema.prisma`**

Delete the `model TelemetrySetting { … @@map("telemetry_settings") }` block (lines 391-399) and the `model ClientMetric { … @@map("client_metrics") }` block (lines 488-504). Leave `model Device` (line 512+) intact.

- [ ] **Step 2: Create the migration SQL**

`backend/prisma/migrations/20260618000000_drop_telemetry_and_client_metrics/migration.sql`:
```sql
-- Drop telemetry & client performance metrics (retired feature — privacy + simplification).
-- Neither table is referenced by any foreign key, so a plain idempotent drop is safe.
-- Idempotent: baseline-migrations.sh runs `db push` before `migrate deploy`.
DROP TABLE IF EXISTS "telemetry_settings" CASCADE;
DROP TABLE IF EXISTS "client_metrics" CASCADE;
```

- [ ] **Step 3: Validate schema + migration against the local DB**

Run (with the local docker stack up):
```bash
cd backend && npx prisma validate && npx prisma migrate deploy
```
Expected: schema valid; migration applies; `\dt` shows neither `telemetry_settings` nor `client_metrics`; `devices` still present. Re-run `migrate deploy` once more → no error (idempotent).

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260618000000_drop_telemetry_and_client_metrics/
git commit -m "feat(db): drop telemetry_settings and client_metrics tables (idempotent migration)"
```

---

### Task 5: Frontend (admin-dashboard) page + nav removal

**Files:**
- Modify: `admin-dashboard/src/App.tsx` (lines 28, 44, 107, 118)
- Modify: `admin-dashboard/src/components/AdminLayout.tsx` (lines 20, 27, 98, 102)
- Delete: `admin-dashboard/src/features/moderation/Telemetry.tsx`
- Delete: `admin-dashboard/src/features/client-performance/` (entire folder)

- [ ] **Step 1: Edit `App.tsx`**

Delete line 28: `import Telemetry from './features/moderation/Telemetry';`
Delete line 44: `import ClientPerformancePage from './features/client-performance/pages/ClientPerformancePage';`
Delete line 107: `{ path: '/telemetry', element: <RoleGuard allowedRoles={MOD_ROLES}><Telemetry /></RoleGuard> },`
Delete line 118: `{ path: '/client-performance', element: <RoleGuard allowedRoles={MOD_ROLES}><ClientPerformancePage /></RoleGuard> },`

- [ ] **Step 2: Edit `AdminLayout.tsx`**

Delete the `ROUTE_TITLES` entries (line 20 `'/telemetry': 'Telemetry',` and line 27 `'/client-performance': 'Client Performance',`).
Delete the SYSTEM-tab nav entries (line 98 `{ path: '/client-performance', label: 'CLIENT PERF' },` and line 102 `{ path: '/telemetry', label: 'TELEMETRY' },`).
Leave `/devices` and `/server-health` entries intact.

- [ ] **Step 3: Delete the feature files**

```bash
git rm admin-dashboard/src/features/moderation/Telemetry.tsx
git rm -r admin-dashboard/src/features/client-performance
```

- [ ] **Step 4: Typecheck + build the dashboard**

Run: `cd admin-dashboard && npx tsc --noEmit && npm run build`
Expected: no TS errors (no dangling imports of `Telemetry`, `ClientPerformancePage`, `useClientMetrics`, `MetricLineChart`, `OutliersTable`); build succeeds.

- [ ] **Step 5: Commit**

```bash
git add admin-dashboard/src/App.tsx admin-dashboard/src/components/AdminLayout.tsx
git commit -m "feat(dashboard): remove Telemetry and Client Performance pages + nav entries"
```

---

### Task 6: Verify overlay/monitor has no emit code (confirmation, expected no-op)

**Files:** none expected (exploration found no client-side emit code).

- [ ] **Step 1: Grep the overlay for any emit / telemetry handling**

Run:
```bash
cd /home/devotek/Documents/Projects/Unnamed/FCM
grep -rniE "client-metrics|clientMetrics|workingSetMb|gcHeapMb|telemetry:set|recordMetric|reportMetric" cross-platform-overlay/src || echo "NONE FOUND"
```
Expected: `NONE FOUND`. If anything IS found, remove that collection/send code + `telemetry:set` handler in this task and add a Vitest guard under `cross-platform-overlay/`, then commit. Otherwise no code change.

- [ ] **Step 2: Record the finding (no commit if nothing found)**

Note in the PR description that the overlay had no telemetry emit code — the backend changes fully achieve the removal.

---

### Task 7: Documentation + user-facing privacy statement

**Files (update — remove telemetry/client-metrics sections, keep device-auth sections):**
- `docs/backend/api-reference.md` (remove Telemetry + Client Metrics endpoint tables incl. `/admin/debug/*` mirrors)
- `docs/backend/services.md` (remove `telemetryService` + `clientMetricsService` sections)
- `docs/backend/jobs-and-queues.md` (remove the Client Metrics Purge job section)
- `docs/database/schema.md` (remove `telemetry_settings` + `client_metrics` sections)
- `docs/realtime/websocket-protocol.md` (re-document `telemetry:set` as a deprecated, always-`false` kill-switch — emitted once on connect, never toggled)
- `docs/architecture/` README + `docs/frontend/` README/features (remove client-performance + telemetry page references)
- `docs/overlay/README.md` + top-level `README.md` (ADD the user-facing no-telemetry statement)

- [ ] **Step 1: Remove telemetry/client-metrics from internal docs**

Edit each file above to delete the telemetry/client-metrics content. Grep to find sections:
```bash
grep -rniE "telemetry|client.?metrics|client-performance|versionDistribution|clientMetricsPurge" docs/ | grep -v superpowers/
```
Address every hit except device-auth references. For `websocket-protocol.md`, rewrite the `telemetry:set` section to: "Emitted once on connect with `{ enabled: false }`. Telemetry was removed; this is a permanent kill-switch and is never toggled."

- [ ] **Step 2: Add the user-facing privacy statement**

Add to `docs/overlay/README.md` and the top-level `README.md` a short section, e.g.:
> **Privacy — no telemetry.** Fallout Chat Mod does not collect telemetry or performance data from the app or its users. The desktop overlay only checks whether the `Fallout76` process is running (to show/hide the overlay); it does not read game state, and it reports nothing back about your device or usage.

- [ ] **Step 3: Verify no stale references**

Run: `grep -rniE "/telemetry|/client-performance|client_metrics|telemetry_settings" docs/ | grep -v superpowers/`
Expected: only the intentional `telemetry:set` kill-switch mention remains.

- [ ] **Step 4: Commit**

```bash
git add docs/ README.md
git commit -m "docs: remove telemetry/client-metrics references; add no-telemetry privacy statement"
```

---

### Task 8: Full verification

- [ ] **Step 1: Backend test suite**

Run: `cd backend && npm test`
Expected: all pass (including the 3 new tests). Fix any test that asserted on removed routes.

- [ ] **Step 2: Backend typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Dashboard typecheck + build**

Run: `cd admin-dashboard && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Final repo grep for orphans**

Run:
```bash
cd /home/devotek/Documents/Projects/Unnamed/FCM
grep -rniE "telemetryService|clientMetricsService|adminTelemetry|clientMetricsPurge|broadcastTelemetrySet|getEffectiveTelemetryFor|getVersionDistribution" backend/src admin-dashboard/src || echo "NO ORPHANS"
```
Expected: `NO ORPHANS`.

- [ ] **Step 5: Open the PR (single PR to `dev`)**

```bash
git push origin dev
```
Then open/confirm the PR, run CI (add `ci-approved` label), and after green, promote `dev → prod` with a **merge commit** (`gh pr merge <n> --merge`). The prod deploy drops the tables and activates the 410 + kill-switch.
