# Spec: Remove Telemetry & Client Performance Metrics

- **Date:** 2026-06-18
- **Status:** Approved (design) — ready for implementation planning
- **Author:** Devotek
- **Scope owner:** FCM backend + admin-dashboard + cross-platform-overlay

## Context & Motivation

Fallout Chat Mod currently ships two systems that collect data from the app and its users:

1. **World-Trace Telemetry Control** — an admin toggle (global + per-user) that enables/disables
   client telemetry capture, pushed to clients over a `telemetry:set` WebSocket event.
2. **Client Performance Metrics** — the desktop overlay and a "monitor" process self-report
   memory/CPU/FPS snapshots to `POST /api/client-metrics`, stored in `client_metrics` and surfaced
   on an admin dashboard.

We are removing both. Motivation is **mixed**: reduce maintenance surface area **and** adopt an
explicit no-telemetry privacy stance (we do not collect data from users). A separate **Device
Keypair Auth** system (the `/devices` page) is auth infrastructure, **not** telemetry, and is
**kept**.

## Goals

- Remove all collection of telemetry/performance data from the app and users.
- Destroy already-collected data (drop the tables).
- Stop already-installed overlays from collecting, without breaking them.
- Make the no-telemetry stance explicit in user-facing documentation.
- Guarantee no other service or feature regresses.

## Non-Goals (explicitly kept)

- **Device Keypair Auth** (`devices` table, `deviceAuthService.ts`, `devicesController.ts`,
  `requireSignedDevice()`, `/devices` page) — security/auth, not telemetry.
- Health/Prometheus server metrics, rate-limit counters, WebSocket heartbeat, and the EULA-safe
  `Fallout76` process check — none are telemetry.

## Decisions (locked)

| # | Decision |
|---|----------|
| Scope | Remove systems #1 (telemetry control) and #2 (client performance metrics). Keep #3 (device keypair auth). |
| Motivation | Both simplification and privacy → full privacy posture. |
| Client side | Remove the overlay/monitor emit + `telemetry:set` handling; keep a `410 Gone` shim at `POST /api/client-metrics`; keep emitting `telemetry:set { enabled: false }` on connect as a permanent kill-switch for old installs. |
| Privacy posture | Full: drop tables (purges data at deploy), update internal docs, **and** add a user-facing "no telemetry collected" statement. |
| Data | Dropping the tables destroys all collected rows at deploy. No export. |
| communityStats | Drop the `versionDistribution` field (sourced only from `client_metrics`; no alternative source; informational only). |
| Rollout | Single atomic PR to `dev`, promoted `dev → prod` with a **merge commit**. |

## Key Insight: privacy goal is achieved at *server* deploy

The server stack and the overlay are separate deploy artifacts (server auto-deploys via Dokploy on
merge to `prod`; the overlay ships as a manually-cut packaged release). Telemetry collection
**stops the moment the server deploys**: the `410 Gone` endpoint stores nothing and the
`telemetry:set { enabled: false }` kill-switch tells already-installed overlays to stop. **No
overlay release is required to achieve the privacy goal** — the overlay code removal is cleanup for
future builds.

## Detailed Design

### 1. Backend

**Delete:**
- `backend/src/services/telemetryService.ts`
- `backend/src/routes/adminTelemetry.ts`
- `backend/src/services/clientMetricsService.ts`
- `backend/src/routes/clientMetrics.ts` (replaced by the 410 shim — see below)
- `backend/src/jobs/clientMetricsPurge.ts`

**Edit `backend/src/server.ts`:** remove the imports, the route mounts (`/api/admin/telemetry`,
`/api/client-metrics`, the `/admin/debug/telemetry` + `/admin/debug/client-metrics` mirrors), the
`(global as any).broadcastTelemetrySet` registration, and the `startClientMetricsPurgeJob()` call.

**Edit `backend/src/websocket/handlers.ts`:** drop the `getEffectiveTelemetryFor` import and the
per-user lookup on connect; **replace with a hardcoded `telemetry:set { enabled: false }` emit on
connect** (old-client kill-switch). Remove `broadcastTelemetrySet` and its export.

**Edit `backend/src/services/communityStatsService.ts`:** remove `getVersionDistribution()` and the
`versionDistribution` field from the `CommunityStats` type and response. `/api/admin/community-stats`
and the MCP-admin variant keep working without that field.

**Backward-compat shim:** `POST /api/client-metrics` returns **`410 Gone`** with no DB write
(minimal handler; no auth/rate-limit machinery needed) so old clients stop cleanly without
log-noise.

**Leave intact (shared infra):** `requireClientAuth`, `requireDiscordRole`, `requireAdminKey`,
Redis client, logger, the job-tracker/cron registry. Redis keys `telemetry:effective:*` and
`rl_cmetrics:*` auto-expire — no cleanup.

### 2. Database & migration

- Remove `TelemetrySetting` and `ClientMetric` models from `backend/prisma/schema.prisma`.
- New **idempotent** migration (hard rule): `DROP TABLE IF EXISTS telemetry_settings CASCADE;` and
  `DROP TABLE IF EXISTS client_metrics CASCADE;`. No FKs in/out — nothing orphans. This purges all
  collected data at deploy.

### 3. Frontend (admin-dashboard)

- **Delete:** `src/features/moderation/Telemetry.tsx`, and the entire
  `src/features/client-performance/` folder (`pages/ClientPerformancePage.tsx`,
  `components/MetricLineChart.tsx`, `components/OutliersTable.tsx`, `hooks/useClientMetrics.ts`).
- **Edit `src/App.tsx` + `src/components/AdminLayout.tsx`:** remove the `/telemetry` and
  `/client-performance` imports, route definitions, `ROUTE_TITLES` entries, and the two SYSTEM-tab
  nav entries. No other page imports these.

### 4. Overlay / client

- Remove the metric-collection logic + `POST /api/client-metrics` sender and any `telemetry:set`
  handling from the overlay **and** the monitor process. **Verify first** that the monitor has
  duties beyond emitting metrics, and strip only its emit code.
- New overlay builds emit nothing; the server kill-switch covers existing installs.

### 5. Privacy statement + docs

- **User-facing statement** that the app no longer collects telemetry/performance data (placement:
  overlay docs `docs/overlay/` + top-level/README privacy wording — finalize in plan).
- **Internal docs to update:** `docs/architecture/`, `docs/backend/api-reference.md`,
  `docs/backend/services.md`, `docs/backend/jobs-and-queues.md`, `docs/database/schema.md`,
  `docs/realtime/websocket-protocol.md` (re-document `telemetry:set` as a deprecated always-off
  kill-switch, not removed), `docs/frontend/`.

### 6. Tests & CI (hard rule)

- Delete any telemetry/client-metrics-specific tests (sweep — none found in initial scan).
- **Add** regression tests:
  - `POST /api/client-metrics` → `410`.
  - `GET /api/admin/community-stats` → `200`, response omits `versionDistribution`.
  - WS connect still emits `telemetry:set { enabled: false }`.
  - Server boots cleanly with the routes/job removed.
- Wire into the existing Vitest (overlay/dashboard) / Jest (backend) CI jobs.

## Blast-Radius Safeguards (the only 3 external touch-points)

1. **WS connect handler** (`websocket/handlers.ts`) → replaced with hardcoded off-emit (above).
2. **`communityStatsService.getVersionDistribution()`** → field dropped (above).
3. **Dashboard nav/routes** (`App.tsx`, `AdminLayout.tsx`) → entries removed (above).

Everything else is internal to the two removed systems. No Discord-bot, public-website, or env/
docker-compose consumers. Tables have no foreign keys.

## Rollout & Sequencing

1. Frontend: remove pages, routes, nav.
2. Backend: delete routes/services/job; edit `server.ts`; edit WS handler (kill-switch); add 410
   shim; edit communityStats.
3. DB: schema edit + idempotent drop migration.
4. Overlay/monitor: remove emit + `telemetry:set` handling (verify monitor's other duties).
5. Docs + privacy statement.
6. Tests + CI.
7. Single PR → `dev`; verify on dev stack; promote `dev → prod` via **merge commit**.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Old overlay hangs waiting for `telemetry:set` | Keep emitting `telemetry:set { enabled:false }` on connect. |
| Old client `POST` errors / log-noise | `410 Gone` shim. |
| `community-stats` 500 after table drop | Remove the `versionDistribution` query/field, not just the table. |
| Migration not idempotent (baseline runs `db push` then `migrate deploy`) | `DROP TABLE IF EXISTS … CASCADE`. |
| Stripping monitor process breaks its other duties | Verify monitor responsibilities before editing; remove only emit code. |
| Docs drift | Doc updates included in the same PR (hard rule). |

## Acceptance Criteria

- No `telemetry_settings` / `client_metrics` tables; models removed from schema; idempotent drop
  migration present.
- `/telemetry` and `/client-performance` dashboard pages and nav entries gone; dashboard builds.
- `POST /api/client-metrics` returns `410`; no telemetry/client-metrics routes, services, or purge
  job remain; server boots.
- WS connect emits `telemetry:set { enabled:false }`; no `broadcastTelemetrySet`.
- `community-stats` returns `200` without `versionDistribution`.
- Overlay + monitor no longer collect or send metrics; monitor's other duties intact.
- User-facing no-telemetry statement present; internal docs updated.
- Device Keypair Auth (`/devices`) untouched and functional.
- New + existing tests pass in CI.
