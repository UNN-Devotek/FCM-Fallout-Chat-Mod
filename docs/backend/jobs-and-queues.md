# Jobs and Queues

---

## Failure tracking + escalation (`makeJobTracker`)

**Defined in:** `backend/src/jobs/jobTracker.ts`

Every recurring job (cron + setInterval) is wrapped with `makeJobTracker(label, threshold?)`.
The wrapper counts **consecutive** failures: each failing run logs `logger.warn`, but once
`FAILURE_THRESHOLD` (default **5**) consecutive failures is reached, the severity escalates to
`logger.error` so log-watching alerting (e.g. Uptime Kuma log monitors) fires. The counter
resets to `0` on the first successful run (and logs a one-line recovery `info`). This makes a
silently-stuck recurring job visible instead of drowning forever at warn level.

Two rules make the tracker actually work, and both are enforced:

1. **The tracked function must throw on real failure.** A job whose body catches everything and
   only logs `warn` (never re-throwing) makes escalation **dead code** — the tracker's promise
   always resolves and the error branch never runs. Jobs therefore re-throw genuine failures (an
   *expected* skip, e.g. a Redis lock held by a concurrent run, is swallowed and is **not** counted
   as a failure).
2. **The scheduler callback must return/await the tracker promise.** `cron.schedule('…', () => tracker(fn))`
   (returning the promise) is what lets node-cron **await** the run: the runner tracks the pending
   execution, its **overlap detection** sees the tick as still in-flight (emitting `execution:overlap`,
   and blocking the next fire when `noOverlap` is enabled), and — load-bearing here — the tracker
   actually **observes the outcome**. A non-returning callback (`() => { tracker(fn); }`) floats the
   promise: node-cron thinks the tick finished instantly and the tracker's failure count is the only
   thing that still works, but only if it's awaited. `setInterval` jobs have no built-in overlap
   detection, so they use an explicit `running` re-entrancy guard that skips a tick while the previous
   one is pending.

---

## Scheduled Jobs (node-cron / setInterval)

### 1. Message + Audit Log Purge (node-cron)

**Defined in:** `backend/src/server.ts` (inline cron schedule)

Runs daily at **03:00 UTC** (approximate — the exact expression is in `server.ts`). Purges:
- `messages` rows with `created_at` older than **90 days**.
- `audit_logs` rows with `created_at` older than **90 days**.

This is a hard delete. The 90-day window is intentional for GDPR-adjacent data hygiene and to keep table sizes bounded. The cron callback returns a `makeJobTracker('[retention-purge]')` promise, so repeated consecutive failures (e.g. a DB outage during purge) escalate warn → error, and the tick is properly awaited so overlap is detected.

### 2. Moderation Actions Sweep (node-cron)

**Defined in:** `backend/src/server.ts` (calls `sweepExpired` from `services/moderationActionsService.ts`)

Runs on a cron schedule to lift expired temporary bans and mutes. Auto-lift also runs inline in `requireAuth` and `requireDiscordRole` on each request that reads user status, so real-time unbanning does not depend solely on the sweep. The cron callback returns a `makeJobTracker('[mod-sweep]')` promise so repeated consecutive failures escalate warn → error, and the tick is awaited so overlap is detected.

### 3. Party Reap Job (setInterval)

**Defined in:** `backend/src/jobs/partyReap.ts`

Started from `server.ts` via `startPartyReapJob(deps)`. Runs every **60 seconds** (`REAP_INTERVAL_MS = 60_000`). Runs once immediately at startup as a reconciliation pass (in case the server restarted while parties were active).

**Three passes per tick:**

1. **Ephemeral parties** (`reapPolicy = 'ephemeral'`) with **0 online members** → soft-delete (`isDeleted = true`), write `party_reap` audit log entry, broadcast `party:deleted` to all former members' WebSocket connections.

2. **Persistent parties** (`reapPolicy = 'persistent'`) with **0 membership rows** → defensive GC soft-delete + audit log.

3. **Stale pending invites** older than **7 days** → status updated to `'expired'`.

The job is fully DI-injectable for testing (accepts `prisma`, `getOnlineUserIds`, `broadcastToPartyMembers`, optional `now` clock override via `PartyReapDeps`). The interval handle calls `.unref()` so it does not prevent graceful shutdown.

**Overlap guard:** a single `running` flag is shared by **both** the startup reconcile pass and every interval tick, so two passes never execute concurrently against the same rows. The startup reconcile runs through the same guard, so if the first interval fires before that reconcile finishes it is skipped (logged as warn: `previous tick still running`). This prevents the startup pass from racing the first interval tick.

**Failure propagation (escalation):** an error in a **single party row** is logged at warn and the
row is skipped — one bad party must not abort the tick. But if a **whole top-level pass** fails
(e.g. the DB is unreachable for the ephemeral scan, the persistent GC scan, or the invite-expiry
sweep), `runPartyReap` collects the failures and throws an `AggregateError` at the end. That
rejection is what the `makeJobTracker('[partyReap]')` wrapper counts toward consecutive-failure
escalation — without it, the tracker's `logger.error` escalation would never fire for partyReap.
Each guarded tick runs `runPartyReap` **through** the tracker (so failures are observed and escalate
warn → error) **inside** the shared `running` re-entrancy guard (so two reaps never overlap); the
tracker swallows the rejection, so the guard's `.finally` reliably clears `running`.

`startPartyReapJob` returns a stop function (`() => clearInterval(...)`) for clean teardown.

### 4. Online Snapshot Job (node-cron)

**Defined in:** `backend/src/jobs/onlineSnapshotJob.ts`

Started from `server.ts` via `startOnlineSnapshotJob()`. Two schedules:

- **Sampler — every 5 minutes (`*/5 * * * *`):** inserts the current WebSocket client count (`getClientCount()`) as a row in `online_snapshots`. Backs the `onlineOverTime` series of `GET /api/public/stats`.
- **Retention purge — daily at 04:07 UTC (`7 4 * * *`):** deletes `online_snapshots` rows older than **7 days** so the table stays small (~2016 rows steady state: 288/day × 7 days). The public stats `onlineOverTime` series only reads the last 7 days, so this retention is sufficient.

**Overlap guard:** `node-cron` does not await async callbacks, so each schedule has its own `running` flag — if a slow DB write/delete is still in flight when the next tick fires, that tick is skipped (logged as warn: `previous insert still running` / `previous purge still running`) rather than queuing a duplicate. Inside that guard each schedule runs its DB work **through** `makeJobTracker` (`[onlineSnapshot]` / `[onlineSnapshot:purge]`) and **returns** the tracker promise, so a single failing tick is non-fatal but repeated consecutive failures escalate warn → error (and node-cron's own overlap detection also sees the tick as in-flight); the guard's `.finally` clears the `running` flag once the tracker settles. `startOnlineSnapshotJob` accepts optional DI deps (`schedule`, `getClientCount`, `dbQuery`) for testing; production calls it with no args so the real `node-cron`/DB/WS deps are used.

### 5. Wiki Catalog Ingest Job (node-cron)

**Defined in:** `backend/src/jobs/wikiIngest.ts`

Started from `server.ts` via `startWikiIngestJob()`. Runs on a weekly schedule: **Sundays at 03:00 UTC** (`0 3 * * 0`). This is the **full** sync — walks all 7 seed categories.

Calls `runWikiIngestion()` from `services/wikiIngestionService.ts`. The service:
- Acquires a Redis distributed lock (`fo76:wiki:ingest:lock`, 3h TTL) before starting — concurrent runs (cron + admin trigger) are safe.
- Recursively walks 7 seed Fandom categories (depth cap 5) via `action=query&list=categorymembers`.
- **revId fast-skip**: fetches `prop=revisions` in the metadata call. If `wiki_entries.rev_id` matches the current Fandom revision AND an `image_url` is already stored, the expensive wikitext fetch is skipped entirely — only `ingested_at` and `is_stale` are touched. Falls back to the existing `content_hash` path for older rows with no `rev_id`.
- Fetches metadata + wikitext for changed pages; rejects non-FO76 / disambiguation pages.
- UPSERTs rows into `wiki_entries` on `page_id` (rename-safe), storing `rev_id`; mirrors primary image to MinIO.
- Fetches all page images (`prop=images` + `prop=imageinfo`), filters junk (SVG, sub-100px, icon/logo/marker names), mirrors each to MinIO, and replaces the `wiki_images` child rows (delete-then-insert ordered by position). Position 0 = primary. Map images tagged via `isMapImage()`. On individual mirror failure, falls back to storing the Fandom source URL directly.
- Fetches the Locations wiki section (`action=parse&prop=sections` → `action=parse&prop=wikitext&section=<index>`), parses bullet/list items, stores as `wiki_entries.locations` JSONB.
- Marks stale (`is_stale=true`) any row with `ingested_at < run_start`.
- Logs per-entity errors to `wiki_ingest_errors`; never aborts the whole run.

Can also be triggered on-demand via `POST /api/admin/wiki/ingest` (owner/admin only, 1h min re-trigger interval for full; no rate-limit for incremental).

The cron callback returns a `makeJobTracker('[wikiIngest]')` promise, so genuine failures are tracked and escalate warn → error after repeated consecutive runs, and the tick is awaited so overlap is detected. A **lock-held** skip (a concurrent admin trigger holds the Redis ingest lock — surfaced as the exported `WIKI_INGEST_LOCK_HELD_MESSAGE` error) is an expected non-error path: it is logged at info and **not** counted as a failure, so a normal concurrent run never falsely escalates.

### 5b. Wiki Incremental Sync Schedule (setInterval)

**Defined in:** `backend/src/jobs/wikiSyncSchedule.ts`

Started from `server.ts` via `startWikiSyncSchedule()`. **Disabled by default** (`WIKI_SYNC_INTERVAL_HOURS=0` or unset). When enabled, fires every N hours.

Calls `runIncrementalSync()` from `services/wikiIngestionService.ts`, which:
1. Queries Fandom `action=query&list=recentchanges&rcnamespace=0` since the last sync timestamp (`fo76:wiki:ingest:last-run`).
2. Filters to titles already in the local catalog or matching a FO76 signal pattern.
3. Calls `runWikiIngestion(titles)` — a targeted run that change-detects per page but does **not** mark all other entries stale.
4. Updates `fo76:wiki:ingest:last-run` and invalidates the update-status cache (`fo76:wiki:updates:cache`).

The Redis lock guards against overlap with a full sync; never crashes the server. The tick is wrapped with `makeJobTracker('[wikiSyncSchedule]')` behind a `running` re-entrancy guard, so genuine failures escalate warn → error after repeated consecutive runs, while a **lock-held** skip (`WIKI_INGEST_LOCK_HELD_MESSAGE`, concurrent full sync) is logged at info and **not** counted as a failure.

### 5c. CAMP Sync Schedule (setInterval)

**Defined in:** `backend/src/jobs/campSyncSchedule.ts`

Started from `server.ts` via `startCampSyncSchedule()`. **Disabled by default** (`CAMP_SYNC_INTERVAL_HOURS=0` or unset). When enabled, fires every N hours and calls `runCampSync()` which:
1. Re-fetches the 76-CAMPDatabase JSON and upserts all records.
2. Mirrors new/changed images to MinIO under `camp-images/<formid>.webp` (capped to 10 concurrent downloads).
3. Stores a content hash in Redis (`fo76:camp:last-sync-hash`) + sync timestamp (`fo76:camp:last-sync-at`).
4. Invalidates the update-status cache (`fo76:camp:update-status-cache`).

A Redis distributed lock (`fo76:camp:sync-lock`, 1h TTL) prevents overlapping runs; never crashes the server. The tick is wrapped with `makeJobTracker('[campSyncSchedule]')` behind a `running` re-entrancy guard. A lock-held skip returns normally (not a failure), but an inability to reach Redis to acquire the lock, or a `runCampSync()` error, is re-thrown so consecutive failures escalate warn → error.

| env var | default | notes |
|---------|---------|-------|
| `CAMP_SYNC_INTERVAL_HOURS` | `0` | Set >0 to enable (e.g. `168` = weekly) |

### 6. Role Re-verification (setInterval, roleVerificationService.ts)

**Defined in:** `backend/src/services/roleVerificationService.ts`

Runs every **5 minutes** (`VERIFICATION_INTERVAL_MS = 5 * 60 * 1000`). Re-fetches all rows from `admin_users`, queries the Discord guild API for each user's current roles, updates the DB and Redis cache (`role:verified:<discordId>`, 5-min TTL), and destroys sessions for users whose roles have been revoked.

---

## Queues (Bull)

### message-persist Queue

**Defined in:** `backend/src/queues/messagePersist.ts`

Built on **Bull** (Redis-backed). Used to persist chat messages to PostgreSQL without blocking the WebSocket hot path.

**Configuration:**
- Queue name: `message-persist`
- Redis connection: `env.REDIS_HOST` / `env.REDIS_PORT` / `env.REDIS_PASSWORD`
- `attempts: 3` with exponential backoff starting at 1 second
- `removeOnComplete: 100` (keeps last 100 completed jobs for debugging)
- `removeOnFail: 50`

**Worker:** calls `persistMessage(job.data)` from `services/messageService.ts`. The persist uses `INSERT ... ON CONFLICT (id, created_at) DO NOTHING` so retries are safe.

**Producer:** the WebSocket `chat:message` handler enqueues a job immediately after broadcasting the message to connected clients. This ensures the message is visible to other clients within milliseconds even if the DB write takes longer.

Failed jobs are logged at error level with `jobId`.

---

## Summary Table

| Job | Trigger | Interval | Action |
|-----|---------|----------|--------|
| Message + audit purge | node-cron | Daily 03:00 UTC | Hard-delete rows > 90 days |
| Moderation sweep | node-cron | Scheduled | Lift expired bans/mutes |
| Party reap | setInterval | Every 60s + startup | Soft-delete empty parties, expire invites |
| Online snapshot sampler | node-cron | Every 5 min | Insert current WS client count into online_snapshots |
| Online snapshot purge | node-cron | Daily 04:07 UTC | Delete online_snapshots rows > 7 days |
| Wiki full ingest | node-cron + on-demand | Weekly Sun 03:00 UTC | Walk Fandom categories, upsert wiki_entries, mirror images |
| Wiki incremental sync | setInterval (opt-in) | Every N hours (WIKI_SYNC_INTERVAL_HOURS) | recentchanges diff since last sync, targeted upsert |
| Role re-verification | setInterval | Every 5 min | Re-verify Discord roles, revoke stale sessions |
| message-persist | Bull (Redis) | Event-driven | Persist chat messages to Postgres |
