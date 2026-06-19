# Service Modules

Service files live in `backend/src/services/`. They contain business logic called by controllers and WebSocket handlers. Services should not import from `routes/` or `controllers/`.

---

## messageService.ts

**Role:** Persists chat messages to PostgreSQL.

`persistMessage({ id, content, userId, channelId, parentChannelId, source, createdAt, metadata })` — writes a row to the `messages` table using a raw `INSERT ... ON CONFLICT (id, created_at) DO NOTHING` query. Idempotent. Called from the Bull `message-persist` queue worker (non-blocking on the WS hot path).

The `metadata` column accepts arbitrary JSONB (e.g. party invite embed data).

---

## deviceAuthService.ts

**Role:** ECDSA P-256 device keypair verification.

Key exports:
- `extractSignatureHeaders(headers)` — pulls `X-Device-Install`, `X-Device-Timestamp`, `X-Device-Nonce`, `X-Device-Signature` from the request headers.
- `verifySignedRequest(method, path, rawBody, hdrs)` — verifies the signature against the stored public key in the `devices` table. Enforces ±60s clock skew and single-use nonce (Redis, 120s TTL). Returns `{ ok: true, installToken }` or `{ ok: false, status, reason }`.
- `buildCanon(method, path, bodySha256Hex, timestamp, nonce)` — canonical string format (must match the .NET client exactly).

The `SKEW_WINDOW_MS = 60_000` and `NONCE_TTL_SECONDS = 120` constants are exported for test use.

See [auth.md](./auth.md#4-device-keypair-auth-ecdsa-p-256) for protocol details.

---

## roleVerificationService.ts

**Role:** Discord role resolution and background verification.

- `resolveRole(discordRoles[])` — maps Discord role IDs to `owner > admin > moderator > null` using env vars. Called at OAuth login time.
- `getCachedRole(discordId)` — reads `role:verified:<discordId>` from Redis (5-min TTL).
- `cacheRole(discordId, role)` — writes the verified role to Redis.
- `destroyAdminSessions(discordId)` — scans `sess:*` Redis keys and destroys sessions for a Discord user (used when a role is revoked).

A background interval (every 5 minutes) re-verifies all `admin_users` rows against the live Discord guild and updates/evicts stale roles. This is the mechanism that makes role verification per-request-resilient without a live API call on every request.

---

## userRoleService.ts

**Role:** Resolves the effective role label for a logged-in user combining DB `admin_users`, Redis cache, and session.

Called by `requireDiscordRole` as a layered fallback (Redis → DB → session). See [auth.md](./auth.md).

---

## avatarService.ts

**Role:** Downloads and stores Discord avatars in MinIO.

- `captureAvatar(discordId, discordAvatar)` — fire-and-forget: downloads the current Discord CDN avatar and stores it in MinIO at `avatars/<discordId>.png`. Called on every Discord auth callback.
- `buildAvatarUrl(discordId)` — returns the same-origin path `/avatars/<discordId>` served by `GET /avatars/:discordId` in `server.ts`. Returns `null` when no `discordId`.

The avatar is served from the backend's own domain so it resolves correctly in the Electron overlay and the web dashboard regardless of MinIO's public URL configuration.

---

## communityStatsService.ts

**Role:** Aggregates signup, message, version, and download counts for the admin dashboard.

Accepts a `StatsRange` (`all | 90d | 60d | 30d | 7d | 1d`). Returns daily bucketed counts and channel breakdowns using raw SQL queries for performance. Exposed via `GET /api/admin/community-stats`.

---

## commandService.ts

**Role:** Slash-command dispatch for in-chat commands (`/bug`, `/report`, `/help`, etc.).

- `getCommands()` — fetches command definitions from DB with a 60s in-memory cache.
- `handleCommand(trigger, args, userId, channelId)` — matches the trigger, enforces per-user cooldowns (Redis), and returns a typed `CommandResult` describing the action to take (post a bot message, relay, private notice, trigger a report, server-broadcast).

Commands are configured via `GET/POST/PATCH/DELETE /api/commands`. The WS handler calls `handleCommand` when a message starts with `/`.

**Code-constant built-ins** (handled before any DB lookup, never stored in `chat_commands`): `/help`, `/s` (disabled), the channel relays `/g /t /e /r`, `/report`, `/apply`, and the Fallout 76 data lookups **`/serverstatus`** (alias `/server-status`), **`/nukecodes`** (alias `/codes`), and **`/camp <item name>`**. These reply privately to the sender with a formatted card built from `serverStatusService` / `nukeCodesService` / `campService` (below). All built-in triggers are reserved in `commandsController` (`RESERVED_BUILTINS`) so admins can't shadow them with DB rows.

---

## serverStatusService.ts

**Role:** Fallout 76 server up/down status for the `/serverstatus` command.

- `getServerStatus()` — fetches Bethesda's semi-official, no-auth endpoint `https://api.bethesda.net/status/ext-server-status?product_id=8` (6s timeout), parses `platform.response.fallout76`, and caches the result in Redis (`fo76:serverstatus`, 60s TTL). Returns `{ status, checkedAt }` or `null` if both cache and live fetch fail.

---

## nukeCodesService.ts

**Role:** Current weekly nuke launch codes for the `/nukecodes` command.

- `getNukeCodes()` — fetches NukaCrypt's undocumented, no-auth endpoint `https://api.nukacrypt.com/api/codes` (6s timeout), and caches in Redis (`fo76:nukecodes`, 30min TTL). Returns `{ alpha, bravo, charlie, sinceEpoch, validUntil, fetchedAt }` (`validUntil = sinceEpoch + 1 week`) or `null` on failure. Undocumented endpoint — display attributes "Codes via NukaCrypt"; see [docs/roadmap/fan-site-integrations.md](../roadmap/fan-site-integrations.md) for the production caveat (confirm acceptable use with the site owner).

---

## campService.ts + campImageService.ts

**Role:** CAMP item lookup backed by the [76-CAMPDatabase](https://mrsblobby.github.io/76-CAMPDatabase/) — a community-maintained JSON database of all placeable CAMP items (~7,382 records). Serves the `/camp` slash command, the `/api/camp/search` autocomplete endpoint, and the `/api/camp/img/:id` image proxy.

### campService.ts

- `ingestCampDatabase()` — fetches the upstream JSON (30s timeout), upserts all rows into `camp_items` (upsert key: `(name, form_id)`), derives `source_type`/`source_label` from each record, mirrors per-item `.webp` images to MinIO, and after the upsert pass calls `atomPriceService.updateCampAtomPrices()` to enrich atom price fields. Returns `{ fetched, upserted, imagesAdded }`. Idempotent; max 10 concurrent image downloads.
- `runCampSync()` — wraps `ingestCampDatabase()`, then stores a content hash in Redis (`fo76:camp:last-sync-hash`) and the sync timestamp (`fo76:camp:last-sync-at`). Called by the admin ingest endpoint and the scheduled job.
- `getCampUpdateStatus()` — fetches the upstream JSON, computes a quick hash, and compares to the stored Redis hash. Returns `{ lastSyncAt, updatesAvailable: 0|1, checkedAt }`. Cached ~5 min in Redis (`fo76:camp:update-status-cache`).
- `searchCampItems(q, limit?)` — case-insensitive LIKE prefix/contains search over `lower(name)`, ordered exact → prefix → contains, returns `[{ id, name, category, subCategory, budgetCost, plan, imageUrl, sourceLabel, sourceType, atomPrice, atomBundle }]`. Default `limit` = 8.
- `getCampItem(name)` — resolves the best single match, returns `{ id, …, formId, imageUrl, sourceLabel, sourceType, atomPrice, atomBundle }` or `null`.
- `getCampMatchesForName(name)` — returns all rows matching the name exactly (case-insensitive), including `atomPrice`/`atomBundle`. Used by the wiki catalog `campData` join.
- `isCampTableEmpty()` — count guard used at boot to decide whether to run the initial ingest.

### atomPriceService.ts

**Role:** Fetches last-known Atomic Shop prices from the [Fallout wiki](https://fallout.fandom.com) and writes them to `camp_items.atom_price / atom_bundle / atom_checked_at`. Prices are "community-sourced, last known" — always stored exactly as the wiki reports, null for unknowns.

- `fetchAtomicShopPrices()` — enumerates all `Atomic Shop/CAMP/*` wiki subpages via `list=allpages&apprefix=Atomic Shop/CAMP`, fetches each page's wikitext, parses every `{{ATX table|row ...}}` block with a brace-counting parser (handles nested `{{atom|NNN}}`, `{{ID|XXXXXXXX}}` templates), and builds two lookup maps: `byFormId` (all hex variants) and `byName` (lowercase). Result cached in Redis `fo76:atom-prices:cache` for 24 h.
- `updateCampAtomPrices()` — calls `fetchAtomicShopPrices()`, then iterates all `camp_items` rows; tries form_id match first (most reliable), then case-insensitive name match. Writes `atom_price`, `atom_bundle`, `atom_checked_at`. Returns coverage stats.
- `invalidateAtomPriceCache()` — deletes the Redis cache key to force a fresh fetch on the next call.

**Matching strategy:** form_id variants are indexed with and without leading zeros (e.g. `588222` and `00588222`); the CAMPDatabase and wiki use slightly different padding. Name matching is lowercase-exact. Items in bundles that have a price in the wiki entry get `atom_bundle` set to the bundle name (e.g. `"Halloween C.A.M.P. Bundle"`).

**Coverage (initial run, 2026-06-05):** 326 / 5628 items (5.8%) got `atom_price`; 168 (3.0%) got `atom_bundle`. The wiki covers all currently-sold and historically-sold Atomic Shop CAMP objects; items from non-shop sources (events, bullion, seasons) remain null.

### campImageService.ts

- `campImageFormId(rec)` — derives the lowercase formid for the image URL (`ARTO_FormID ?? CNAM_FormID`, lowercased).
- `deriveCampSource(rec)` — resolves `{ sourceType, sourceLabel }` from a raw record. Resolution order: (1) ENTM_EDID prefix table (Atomic Shop / SCORE / F1 items), (2) BOOK_SOURCE_TAG multi-value tag map (BullionVendorX, DailyOps, event rewards, vendor caps, …), (3) BOOK_FULL present → `"Plan: <name>"`, (4) `"Default / free"`.
- `mirrorCampImage(formId, existingKey)` — downloads `Images/<formid>.webp` from mrsblobby GitHub Pages and stores it in MinIO under `camp-images/<formid>.webp`. Skips if already stored. Returns the MinIO key or `null` on failure (non-fatal).

**Image proxy:** `GET /api/camp/img/:id` — looks up `camp_items.image_key`, streams from MinIO, falls back to the upstream mrsblobby CDN. In-memory byte cache (≤400 entries). `Cross-Origin-Resource-Policy: cross-origin` so the Electron renderer can load images.

**Scheduled sync:** env `CAMP_SYNC_INTERVAL_HOURS` (default 0=off). When >0, `campSyncSchedule.ts` calls `runCampSync()` on the interval with a Redis distributed lock (`fo76:camp:sync-lock`, 1h TTL) to prevent overlap.

**Source type values:** `atomic_shop`, `score`, `fallout_1st`, `bullion`, `stamps`, `daily_ops`, `raid`, `workshop`, `seasonal_event`, `event`, `vendor`, `loot`, `unused`, `plan`, `default`.

---

## wikiService.ts + wikiParser.ts + wikiIngestionService.ts + wikiCatalogService.ts

**Role:** FO76 wiki catalog — ingest from Fandom, serve from local Postgres. See [docs/roadmap/wiki-lookup-build-plan.md](../roadmap/wiki-lookup-build-plan.md).

### wikiParser.ts (pure, no I/O)

All functions are side-effect-free and fully unit-tested (`npm run test:unit`).

- `cleanWikitextValue(raw)` — strips markup (templates, links, html, refs) to plain display text.
- `inferKind(templateName)` — maps an infobox template name to `weapon|armor|power_armor|creature|item|location|perk|character|other|null`.
- `isFo76Infobox(templateName)` — returns `true` when the template name contains the `\bFO76\b` word token (e.g. `"Infobox weapon FO76"`).
- `isFo76Content(parsed)` — **canonical FO76 ingest gate predicate**. Accepts a page when `parsed.kind !== null` AND either `isFo76` is true OR `parsed.fields.games` matches `\bFO76\b`. Rejects no-infobox pages, disambiguation pages, and cross-game pages with no FO76 signal. Shared-universe items (e.g. `{{Infobox item|games=FO76|…}}`) are accepted. Pure, unit-tested (11 cases including word-boundary, case-insensitivity, comma-list games).
- `parseInfobox(wikitext)` — extracts the first `{{Infobox …}}` block into `{ kind, templateName, isFo76, fields }`, respecting nested templates and pipes-inside-links.
- `filterPageImages(images)` — drops SVGs, sub-100px images, and junk-named files (icon/vault-boy/button/marker/emote/logo).
- `filterContentImages(images, wikitext)` — keeps only images directly referenced in the page source (not template-injected).
- `isMapImage(title, caption?)` — `true` when filename or optional caption contains "map" as a standalone word-boundary token (e.g. `Helvetia_map.png`, `Map_of_X.png`) or matches the legacy `loc[_-]` prefix. Uses `MAP_BOUNDARY = /(?:^|[_\-.\s])map(?:[_\-.\s]|$)/i` — does not match embedded tokens like "minimap" or "campmap".
- `parseLocationsSection(wikitext)` — extracts and cleans bullet/list items from a Locations wikitext section.

### wikiIngestionService.ts (I/O — ingestion job only)

**Never import this from a request controller.** Background ingest job: recursive category walk → FO76 gate → upsert → alias gen → image mirroring → stale cleanup.

**Category walk algorithm** (`walkCategory`): fully paginates each category via `cmcontinue` (500 members/page) and descends into every subcategory to unlimited depth. A `visitedCats` Set (passed by reference through all recursive calls) prevents revisiting the same subcategory via multiple paths and breaks cycles. Pages are collected into a shared `pages` Set (ns=0 only); subcategories are walked but never added to the result. The `MAX_CATEGORY_DEPTH = 5` guard is a safety valve only — the FO76 wiki category trees are typically 2–3 levels deep.

**Deferred-image mode (`WIKI_DEFER_IMAGES`):** Set this env var to any truthy value to skip all MinIO downloads during ingest. Instead of calling `mirrorWikiImage`, the ingest writes `wiki_images.url = <Fandom source URL>` (and `sourceUrl = <same>`). The image proxy (`GET /api/wiki/img/:id`) falls back to the Fandom CDN whenever `url` does not contain `wiki-images/`, so images remain functional immediately. After the ingest completes, run `npx tsx src/scripts/backfillWikiImages.ts` to mirror the deferred rows to MinIO. When `WIKI_DEFER_IMAGES` is not set, the original inline-mirror behaviour is unchanged.

Key exports:
- `runWikiIngestion(titlesOverride?)` — full catalog run or targeted retry. Redis distributed lock + 1h min-interval enforced. FO76 gate calls `isFo76Content(parseInfobox(wikitext))` — the single source of truth for what enters the catalog.
- `checkIngestAllowed()` — returns null if a run may be triggered, or a reason string if not.
- `generateAliases(name)` — pure helper: strips "(Fallout 76)" suffix, adds trivial plural/singular variants.

### backfillWikiImages.ts (script — `src/scripts/`)

**Purpose:** Mirror deferred `wiki_images` rows to MinIO after a `WIKI_DEFER_IMAGES` ingest run.

**Usage:** `npx tsx src/scripts/backfillWikiImages.ts`

**How it detects un-mirrored rows:** same logic as `wikiImageController.minioKey()` — a row is un-mirrored if `url.indexOf('wiki-images/') < 0` (i.e. still a Fandom CDN URL). Re-running the script is safe and efficient: only rows still pointing at a Fandom URL are processed.

**Behaviour:**
- Selects all un-mirrored `wiki_images` rows in one query.
- Calls `mirrorWikiImage(pageId, url, null, width, height)` for each.
- On success: updates `url`, `sourceUrl`, `mime`, `width`, `height`, `aspect` in the row.
- On failure: logs and skips the row — the Fandom CDN fallback keeps the image serving.
- Concurrency: 6 workers in parallel, 80ms throttle per worker.
- Progress logged every 200 images; final count (mirrored / failed / total) printed on exit.

### wikiCatalogService.ts (request path — Postgres only, never calls Fandom)

Serves the local catalog to controllers. All reads include `kind IS NOT NULL` as a safety filter (belt-and-suspenders: the ingestion gate already guarantees this, but rows that pre-date the gate or were manually inserted will not be served).

- `searchEntries(q, limit?)` — `pg_trgm` similarity search over `wiki_entries.name` + `wiki_aliases.alias`, parameterized `$queryRaw`. WHERE clause: `is_stale = false AND kind IS NOT NULL AND similarity > 0.1`.
- `bestMatch(q)` — returns the top `searchEntries` result or null.
- `getEntry(title)` — case-insensitive name match → alias fallback. Filters: `isStale: false, kind: { not: null }`. Returns full entry with per-kind infobox field subset (via `trimInfobox`) and proxied image URLs.
- `validateSearchQuery(raw)` — strips null bytes, enforces 1–100 char length (RFC 7807 400 otherwise).
- `trimInfobox(raw, kind)` — trims the raw JSONB to the per-kind allowed field set, caps values at 256 chars.

### wikiService.ts (ingestion-only — calls Fandom)

- `searchTitles()` — Fandom opensearch (Redis-cached). Ingestion use only.
- `getEntity()` — Fandom page image + infobox fetch (Redis-cached). Ingestion use only.

**Never wire these to a per-user request path.** The request path serves exclusively from the local catalog.

> **Unit tests:** TypeScript unit tests run via Node's built-in `node:test` + `tsx` (the repo's Jest is configured for compiled `tests/**/*.test.js`). Run with `npm run test:unit` — `src/testRunner.ts` recursively imports every `src/**/*.test.ts`. No extra dependencies.

---

## blockService.ts

**Role:** User-level block/unblock data management.

Provides CRUD for the `user_blocks` table and an in-memory cache (per-blocker `Set<blockedId>`) to avoid DB round-trips on every message broadcast. Cache is invalidated on add/remove.

- `blockUser(blockerId, blockedId)` / `unblockUser(blockerId, blockedId)` — persist and update cache.
- `getBlockedIds(blockerId)` — returns the cached set (load from DB on cache miss).
- `isBlocked(blockerId, blockedId)` — fast set lookup.

Enforcement of block filtering in WS broadcasts and message history is noted as a future pass in the source comments.

---

## nameBlacklistService.ts

**Role:** Manages the username blacklist used at registration time.

- `loadBlacklist()` — loads all blacklist patterns from DB into memory on startup.
- `subscribeBlacklistUpdates()` — subscribes to Redis pub/sub for live updates when an admin adds/removes a pattern, so all replicas stay in sync without a restart.
- `isBlacklisted(username)` — checks the in-memory pattern list.

---

## playerListService.ts

**Role:** Processes player list snapshots submitted by the desktop client.

The desktop client POSTs `{ players, endpoint }` every ~5s. This service stores the snapshot and drives same-server grouping logic (which players share the same FO76 server endpoint). See `routes/playerList.ts`.

---

## presenceClearedRegistry.ts

**Role:** In-memory set of user IDs whose presence was explicitly cleared in the current server session.

Prevents the "phantom endpoint" problem where a user disconnects without sending a `presence:update(null)` and the stale endpoint persists. The WS disconnect handler marks the user here; the periodic stale-presence sweeper skips re-clearing already-cleared users.

---

## banEvidenceStorage.ts

**Role:** Uploads ban evidence screenshots to MinIO under the `ban-evidence/` prefix.

Called from the moderation ban flow. See [../moderation/](../moderation/).

---

## reportImageService.ts

**Role:** Validates and stores player report images in MinIO under `report-images/`.

Performs magic-byte verification in addition to the MIME type check done at the multer layer. Called from `controllers/playerReportsController.ts`.

---

## welcomeDedup.ts

**Role:** Redis-based deduplication for "welcome" join announcements.

Uses a Redis NX set to ensure the same player's join announcement is only emitted once per presence session even if the desktop client re-registers or reconnects.

---

## autoMessages.ts

**Role:** In-memory ring buffer of recent `firePeerJoinAnnounce` events.

Exported `getRecentPeerAnnounceEvents(limit)` is used by `GET /admin/debug/peer-announce-events` to diagnose announce spam.

---

## wikiImageService.ts

**Role:** Downloads Fandom CDN images, computes sha256, derives `image_aspect`, and mirrors to MinIO.

Used exclusively by `wikiIngestionService.ts` — never imported by request controllers.

`mirrorWikiImage(pageId, sourceUrl, existingHash, width?, height?)` — downloads the image at `sourceUrl`, computes a sha256 hash, and uploads to MinIO under key `wiki-images/<pageId>-<hash8>.webp` (content-addressed; skips upload when hash is unchanged). Returns `WikiImageResult`: `{ imageUrl, imageMime, imageWidth, imageHeight, imageAspect, imageSourceUrl }`.

`deriveImageAspect(width, height)` — pure function returning `'ultrawide'` (w/h≥2.2), `'portrait'` (h/w≥1.3), `'square'`, or `'unknown'` (no dims).

On any failure (download, size cap, MinIO error): catches, logs a warn, and returns `imageUrl=null` with `imageSourceUrl` kept. Never throws.

---

## wikiIngestionService.ts

**Role:** Full ingestion pipeline for the local FO76 wiki catalog.

Ingestion-only — must not be imported by request controllers. All Fandom API calls are made here.

Key exports:

- `runWikiIngestion()` — acquires Redis lock, walks all seed categories recursively (depth cap 5), fetches metadata + wikitext for each page, rejects cross-game/disambiguation entries, computes `content_hash`, mirrors images, upserts into `wiki_entries` on `page_id`, auto-generates aliases in `wiki_aliases`, marks stale rows, and releases the lock. Returns `IngestResult`.
- `checkIngestAllowed()` — returns `null` if an ingestion may be triggered, or an error message string if the lock is held or the min interval (1h) has not elapsed.
- `generateAliases(name)` — pure function; auto-derives alias strings from a display name (strips "(Fallout 76)" suffix, trivial plural/singular).

Redis keys used:
- `fo76:wiki:ingest:lock` — distributed lock (NX, EX 10800).
- `fo76:wiki:ingest:last-run` — timestamp of last completed run (enforces 1h min re-trigger interval for the admin endpoint).

---

## wikiParser.ts

**Role:** Pure, side-effect-free wikitext/infobox parsing.

No I/O, no Redis, no logging. Safe to import in unit tests. See `src/services/__tests__/wikiParser.test.ts` (23 tests passing).

Key exports: `cleanWikitextValue`, `inferKind`, `isFo76Infobox`, `parseInfobox`.

---

## devAuthService.ts

**Role:** Dual Discord role gate for the hosted dev environment. Determines whether a contributor holds the developer role in **both** the production guild and the dev guild. Either role alone grants nothing.

Source: `backend/src/services/devAuthService.ts`  
Full design: [docs/deployment/hosted-dev-environment.md](../deployment/hosted-dev-environment.md)

### Key exports

**`verifyDualRole(input)`** — pure function (no I/O, no env access). Returns `{ authorized: boolean, reason?: string }`. Requires `prodMemberRoles` to include `prodRoleId` AND `devMemberRoles` to include `devRoleId`. Input shape:

```ts
{
  prodMemberRoles: string[];   // role IDs the user holds in the prod guild
  devMemberRoles: string[];    // role IDs the user holds in the dev guild
  prodRoleId: string;          // PROD_DEVELOPER_ROLE_ID
  devRoleId: string;           // DEV_DEVELOPER_ROLE_ID
}
```

**`checkDeveloperAccess(discordUserId, deps, accessToken?)`** — env-driven higher-level gate. Reads guild/role IDs from environment, fetches the caller's roles in both guilds via the injectable `DevAuthDeps` boundary, then calls `verifyDualRole`. Returns `DeveloperAccessResult` (`authorized`, `reason?`, `discordUserId`).

**`DevAuthDeps` interface** — injectable boundary for Discord HTTP:
- `fetchGuildMemberRoles(guildId, userId, accessToken)` — returns the user's role IDs in `guildId`; throws on failure so callers deny rather than silently treat as "no roles".

**`discordOAuthDeps`** — real `DevAuthDeps` implementation: calls `GET /users/@me/guilds/{guildId}/member` with the user's OAuth access token (`guilds.members.read` scope).

**`makeDevSideDeps(prodVerify?, devBotToken?)`** — alternative `DevAuthDeps` for the dev backend, where the dev bot is absent from the prod guild. For the prod guild, delegates to the prod backend's verify endpoint (via `ProdVerifyClient`); synthesizes a roles array containing just `PROD_DEVELOPER_ROLE_ID` when `hasDevRole` is true. For the dev guild, reads locally via the dev bot.

**`ProdVerifyClient` interface** — injectable boundary for the prod verify HTTP call: `(discordId: string) => Promise<boolean>`.

**`defaultProdVerifyClient`** — default `ProdVerifyClient`: HTTP GET `{PROD_VERIFY_URL}?discordId=<id>` with `Authorization: Bearer PROD_VERIFY_TOKEN`, parses `{ data: { hasDevRole } }`.

---

## Services Not Documented Here

The following services are documented by other agents:

- **discordService.ts** — Discord.js client, message bridge, embed builder, temp voice channel management → [../discord/](../discord/)
- **voiceService.ts** — join-to-create temp voice channels → [../discord/](../discord/)
- **reactionRoleService.ts** — reaction-role panels → [../discord/](../discord/)
- **autoModService.ts** / **autoModEngine.ts** — content moderation rules → [../moderation/](../moderation/)
- **moderationActionsService.ts** — ban/mute/kick execution → [../moderation/](../moderation/)
