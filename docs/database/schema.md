# Schema Reference

All models are defined in `backend/prisma/schema.prisma`. The initial DDL bootstrap lives in `backend/db/init.sql`. Models are listed below grouped by domain.

---

## Users & Identity

### `users` (`User`)

Central user record created at first overlay registration.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `username` | TEXT UNIQUE | FO76 in-game name; validated against `name_blacklist` |
| `install_token` | TEXT UNIQUE | Per-install anonymous identity token (24h ephemeral sessions in Redis) |
| `discord_id_link` | TEXT UNIQUE | Discord user ID after OAuth link |
| `discord_username` / `discord_display_name` / `discord_avatar` | TEXT | Updated on every Discord OAuth callback |
| `discord_authed_at` | TIMESTAMPTZ | Last OAuth; gate re-requires auth after 30 days |
| `is_banned` / `is_muted` | BOOLEAN | Current-state flags; history lives in `bans` / `audit_logs` |
| `mute_expires_at` | TIMESTAMPTZ | Null = indefinite |
| `ban_reason` / `ban_category` | TEXT | Denormalized from most recent `bans` row for fast enforcement |
| `banned_until` | TIMESTAMPTZ | Null on `is_banned=true` = permanent |
| `kicked_until` | TIMESTAMPTZ | 5-minute cooldown after a kick |
| `saved_discord_roles` | JSON | Role IDs stripped at ban time; restored on unban |
| `created_at` / `updated_at` | TIMESTAMPTZ | Standard audit fields |

Display-name priority (applied in code, not a DB column): `username` if set and not `'Wanderer'`, then `discord_display_name`, then `discord_username`.

### `sessions` (`Session`)

DB copy of active auth sessions (primary store is Redis `sess:` prefix).

| Column | Notes |
|---|---|
| `token` UUID PK | 24-hour session token issued at registration |
| `user_id` FK → `users` | CASCADE delete |
| `expires_at` | 24 hours from creation |

### `admin_users` (`AdminUser`)

Persistent Discord-authenticated staff records. The source of truth for role resolution — the `roleVerificationService` background job verifies these against the live Discord guild every 5 minutes and deletes rows where the Discord role was revoked.

| Column | Notes |
|---|---|
| `discord_id` TEXT UNIQUE | Discord user ID |
| `username` TEXT | Display name at last login |
| `role` TEXT | `'owner'` \| `'admin'` \| `'moderator'` |

### `user_aliases` (`UserAlias`)

History of previous FO76 in-game names when a user renames.

### `devices` (`Device`)

Per-install ECDSA P-256 public keys for request signing (planned keypair auth). One active row per `install_token`. `revoked_at` is the admin kill-switch; also set on permanent ban.

### `blocks` (`Block`)

User-level block list. `blocker_id` → `blocked_id`. Enforcement (broadcast/history/member-list filtering) is applied in a subsequent pass.

---

## Channels & Messages

### `channels` (`Channel`)

Seeded default channels (hardcoded UUIDs):

| UUID | Name | Parent |
|---|---|---|
| `00000000-0000-0000-0000-000000000001` | General | — (main) |
| `00000000-0000-0000-0000-000000000002` | Trading | General |
| `00000000-0000-0000-0000-000000000003` | Events | General |
| `00000000-0000-0000-0000-000000000004` | Raids | General |

Key columns:

| Column | Notes |
|---|---|
| `parent_id` FK → `channels` | Null = top-level main channel; non-null = sub-channel |
| `sort_order` | Display order among siblings |
| `color` | CSS hex for combined-feed channel tag (default `#18FF62` Phosphor Green) |
| `discord_relay` / `discord_channel_id` | Whether the channel bridges to Discord |
| `allow_gifs` / `allow_emojis` | Per-channel permission flags |
| `is_archived` | Soft archive; archived channels not shown in UI |

**Combined feed rule:** clicking a main-channel tab renders that channel's messages AND all its sub-channels, each prefixed `[ChannelName]`. Clicking a sub-channel tab shows only that sub's messages.

### `messages` (`Message`)

TimescaleDB hypertable (`init.sql:94`). Composite PK `(id, created_at)` required by TimescaleDB.

| Column | Notes |
|---|---|
| `channel_id` FK → `channels` | RESTRICT on delete |
| `parent_channel_id` | Denormalized for combined-feed queries |
| `source` | `'game'` \| `'discord'` |
| `is_deleted` | Soft delete; message content retained for moderation |
| `metadata` | Optional JSON payload (e.g. party invite embeds) |

Note: Prisma cannot model the FK from `reports.message_id` to `messages` due to the composite PK. Use raw queries for report-message lookups (`schema.prisma:216-218`).

### `discord_relay_mappings` (`DiscordRelayMapping`)

Maps in-game channel UUIDs to Discord channel IDs. Unique composite `(in_game_channel_id, discord_channel_id)`.

---

## Party System

### `parties` (`Party`)

User-created community chat rooms.

| Column | Notes |
|---|---|
| `is_private` | Public parties feed the overlay public-mode combined feed |
| `reap_policy` | `persistent` \| `ephemeral` (enum `party_reap_policy`) |
| `owner_id` FK → `users` | RESTRICT on delete |
| `last_message_at` | Updated on new `party_messages` row for activity sorting |
| `is_deleted` | Soft delete |

### `party_members` (`PartyMember`)

Role values: `owner` \| `comod` \| `member` (enum `party_role`). Unique `(party_id, user_id)`.

### `party_invites` (`PartyInvite`)

Status: `pending` \| `accepted` \| `declined` \| `expired`. Unique `(party_id, invitee_id)`.

### `party_messages` (`PartyMessage`)

Composite PK `(id, created_at)` (TimescaleDB candidate). Denormalizes `username` for read performance.

---

## Moderation

### `reports` (`Report`)

User-to-user reports from the overlay.

| Column | Notes |
|---|---|
| `reporter_user_id` / `target_user_id` FK → `users` | CASCADE on delete |
| `message_id` | UUID reference only — no FK (composite PK limitation) |
| `status` | Enum `report_status`: `open` \| `resolved` \| `dismissed` \| `escalated` |
| `resolved_by` FK → `users` | Staff member who resolved |

### `player_reports` (`PlayerReport`)

In-game `/report` submissions (distinct from `reports` — these are free-text reports with optional screenshot attachments).

| Column | Notes |
|---|---|
| `report_type` | `'player'` \| `'bug'` |
| `image_urls` | JSON `string[]` of MinIO URLs (via `reportImageService.ts`) |
| `status` | `'open'` \| `'reviewed'` \| `'closed'` |

### `bans` (`Ban`)

Full ban history. One row per ban event (including reversed ones). `users.is_banned` is the current-state flag; this table is the complete audit trail.

| Column | Notes |
|---|---|
| `banned_by_id` FK → `users` | RESTRICT on delete |
| `reason_category` | `Harassment` \| `HateSpeech` \| `Spam` \| `Cheating` \| `NSFW` \| `Threats` \| `Doxxing` \| `Other` |
| `banned_until` | Null = permanent |
| `reversed_at` / `reversed_by_id` / `reverse_reason` | Set when a ban is reversed |

### `ban_evidence` (`BanEvidence`)

One-to-many with `bans`. Text content stored inline; images stored in MinIO (`ban-evidence` bucket) referenced by `object_key`. Served via backend-proxied route — no public URLs.

| Column | Notes |
|---|---|
| `type` | `'text'` \| `'image'` |
| `object_key` | MinIO object key; null for text evidence |
| `mime` | Magic-byte-verified MIME (PNG/JPEG/GIF/WebP) |

### `audit_logs` (`AuditLog`)

TimescaleDB hypertable. Composite PK `(id, created_at)`. `target_id` is **polymorphic** — it intentionally has no FK (targets can be users, parties, messages, etc.). The FK to `users` was removed in migration `20260601_drop_audit_target_fkey` to prevent P2003 errors on party/message audit entries.

| Column | Notes |
|---|---|
| `actor_id` FK → `users` | SET NULL on delete; null = system action |
| `action` | String action label, e.g. `'ban'`, `'mute'`, `'automod_violation'` |
| `target_type` | `'user'` \| `'party'` \| `'message'` etc. |
| `metadata` | JSONB; action-specific detail |

Purged after 90 days via TimescaleDB retention policy (`init.sql:172-177`).

### `moderation_settings` (`ModerationSetting`)

Key-value store for admin-configurable thresholds. Seeded defaults:

| Key | Default value |
|---|---|
| `spam_message_limit` | `6` (messages per window) |
| `spam_window_ms` | `10000` (10-second window) |
| `voice.enabled` | Voice feature toggle |
| `voice.lobby_channel_id` | Discord join-to-create lobby |
| `voice.category_id` | Discord category for temp VCs |
| `voice.name_template` | Template for new VC names |

### `word_filter` (`WordFilter`)

Admin-configurable phrase/regex denylist for chat content. `test_mode=true` rows log matches but do not block. The baseline hardcoded denylist in `autoModService.ts:15-31` always runs regardless of whether this table has rows.

### `name_blacklist` (`NameBlacklistEntry`)

Patterns (v1.1.73) that must never be accepted as a user's FO76 in-game name.

| Column | Notes |
|---|---|
| `pattern` TEXT UNIQUE | The pattern to match |
| `match_type` | `'exact'` \| `'contains'` \| `'regex'` (all case-insensitive) |
| `enabled` | Toggle without deletion |
| `note` | Human description (e.g. `'FO76 item — observed latched 2026-05-10'`) |

### `automod_rules` (`AutoModRule`)

Admin-configured auto-moderation rules.

| Column | Notes |
|---|---|
| `trigger_type` | `KEYWORD` \| `SPAM` \| `KEYWORD_PRESET` \| `MENTION_SPAM` \| `LINK` |
| `trigger_metadata` | JSON: `{ keyword_filter[], regex_patterns[], allow_list[], mention_total_limit, presets[] }` |
| `actions` | JSON array: `[{ type: 'BLOCK'\|'ALERT'\|'TIMEOUT'\|'MUTE_OVERLAY', metadata: {...} }]` |
| `exempt_channel_ids` | Overlay channel UUIDs exempt from this rule |
| `exempt_roles` | Discord role IDs exempt from this rule |

### `automod_violations` (`AutoModViolation`)

One row per triggered rule event.

| Column | Notes |
|---|---|
| `rule_id` FK → `automod_rules` | CASCADE on delete |
| `message_content` | Capped at 4000 chars |
| `actions_taken` | JSON `[{ type, success, detail }]` |

---

## Discord Features

### `discord_embeds` (`DiscordEmbed`)

Rich embed templates built in the admin dashboard. `data` JSON stores title/description/color/fields/footer. See `../discord/` for the bot-side `postEmbed()` function.

### `reaction_role_panels` (`ReactionRolePanel`)

Posted Discord messages whose reactions grant/remove roles. PK is `message_id` (Discord snowflake). `mappings` JSON: `[{ emoji, matchKey, reactValue, roleId, roleName? }]`.

### `voice_channels` (`VoiceChannel`)

"Join-to-Create" temp VC ownership. Persisted so the bot can sweep orphaned channels on restart. PK is `discord_channel_id` (Discord snowflake).

---

## Releases & Telemetry

### `releases` (`Release`)

Overlay release history. Persisted across container redeploys (previously written to a JSON file inside the container). The `version` field is unique; `download_url` points to the Windows ZIP on the VPS.

### `telemetry_settings` (`TelemetrySetting`)

Remote per-user and global toggle for world-trace telemetry. `scope = 'global' | 'user:<uuid>'`.

### `client_metrics` (`ClientMetric`)

Self-reported performance telemetry from desktop clients. `install_token` is a loose reference — no FK constraint so history survives user deletion.

### `online_snapshots` (`OnlineSnapshot`)

Periodic samples of the live WebSocket client count, written every 5 minutes by the online-snapshot cron (`onlineSnapshotJob.ts`). Backs the `onlineOverTime` series of `GET /api/public/stats`.

| Column | Notes |
|--------|-------|
| `id` BIGSERIAL PK | Auto-increment |
| `captured_at` TIMESTAMPTZ | Defaults to `now()`; indexed |
| `online_count` INT | WS client count at capture time |

**Aggregation:** `GET /api/public/stats` `onlineOverTime` reads the **last 7 days**, daily-bucketed (UTC midnight via `generate_series`), value = `max(online_count)` per day (daily peak), zero-filled for days with no snapshot.

**Retention:** purged daily at 04:07 UTC; rows older than **7 days** are deleted (matches the 7-day read window of the public stats query). Steady-state size ~2016 rows.

### `staff_applications` (`StaffApplication`)

Public `/apply` page submissions. `user_id` is nullable (public, logged-out submissions may have no resolved game user). Status: `pending` \| `approved` \| `rejected`.

### `chat_commands` (`ChatCommand`)

Admin-defined slash commands. `action_type`: `message` \| `form` \| `event` etc. `form_fields` is a JSON `FormField[]` used only when `action_type = 'form'`.

---

## CAMP Items

Populated by `campService.ingestCampDatabase()` — fetches a single JSON file from the community-maintained [76-CAMPDatabase](https://mrsblobby.github.io/76-CAMPDatabase/) (~7.4 MB, ~7,382 records). Auto-ingest runs on first boot if the table is empty; re-ingest available via `POST /api/admin/camp/ingest`.

Migrations: `backend/prisma/migrations/20260605010000_add_camp_items/` (base) + `20260605030000_add_camp_atom_price/` (Atomic Shop price columns).

### `camp_items` (`CampItem`)

One row per placeable CAMP item. Upsert key is `(name, form_id)`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `gen_random_uuid()::text` |
| `name` | TEXT NOT NULL | Display name (e.g. "Wood Stove") |
| `category` | TEXT NOT NULL | Top-level category (e.g. "Furniture", "C.A.M.P. Pieces") |
| `sub_category` | TEXT NOT NULL | Sub-category (e.g. "Appliances", "Doors") |
| `budget_cost` | DOUBLE PRECISION | CAMP budget cost; null if unknown |
| `plan` | TEXT | Required plan name (e.g. "Plan: Wood Stove"); null = no plan required |
| `form_id` | TEXT | COBJ FormID hex string from the game files |
| `image_key` | TEXT | MinIO object key: `camp-images/<formid>.webp`; null until first ingest |
| `source_type` | TEXT | Machine tag: `atomic_shop`, `bullion`, `daily_ops`, `seasonal_event`, `vendor`, `plan`, `default`, … |
| `source_label` | TEXT | Human-readable unlock label (e.g. "Atomic Shop Item", "Sold by Grahm") |
| `atom_price` | INTEGER | Last-known Atomic Shop price in Atoms from the Fallout wiki; null = not sold / price unknown |
| `atom_bundle` | TEXT | Bundle name when sold as part of a bundle (e.g. "Halloween C.A.M.P. Bundle"); null = standalone or no price |
| `atom_checked_at` | TIMESTAMPTZ | Timestamp of the last `atomPriceService` update pass |
| `created_at` | TIMESTAMPTZ | Row creation timestamp |
| `updated_at` | TIMESTAMPTZ | Last upsert timestamp |

**Atom price notes:** Sourced from `fallout.fandom.com/wiki/Atomic_Shop/CAMP/*` via the MediaWiki API. "Last known, community-sourced" — stored exactly as reported by the wiki, null when the wiki shows the item was given free, earned via seasons/score, or has no listed price. Updated by `atomPriceService.updateCampAtomPrices()` on every CAMP sync. Redis cache key `fo76:atom-prices:cache` (24 h TTL).

**Indexes:**
- `camp_items_name_lower_idx` — `lower(name)` — fast case-insensitive LIKE search
- `camp_items_category_idx` — `category` — category browse/filter
- UNIQUE `(name, form_id)` — upsert deduplication key

---

## Wiki Catalog

Populated by the `wikiIngestionService` background cron (weekly + admin on-demand). Serves the in-overlay `/wiki` lookup feature via local `pg_trgm` fuzzy search — **never** calls Fandom at request time.

Migration: `backend/prisma/migrations/20260604010000_add_wiki_catalog/migration.sql`

**Required extension:** `pg_trgm` — first DDL statement in the migration. Must be creatable by the migration user on the Dokploy Postgres image (verify once on first deploy).

### `wiki_entries` (`WikiEntry`)

One row per canonical Fandom page. Upsert key is `page_id` (Fandom numeric id — stable across title renames).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `wiki_title` | TEXT | Raw Fandom page title (may include "(Fallout 76)") |
| `page_id` | INTEGER UNIQUE | Fandom numeric page id — the upsert key |
| `name` | TEXT | Normalized display name (suffix stripped) |
| `kind` | TEXT | `weapon`\|`armor`\|`power_armor`\|`creature`\|`item`\|`location`\|`perk`\|`character`\|`other`; null = rejected |
| `infobox` | JSONB | Parsed infobox fields; `{}` if no infobox |
| `image_url` | TEXT | Backend-proxied MinIO URL; null if not yet mirrored |
| `image_mime` | TEXT | MIME from CDN response header (often `image/webp` even at a `.png` URL) |
| `image_width` / `image_height` | INTEGER | Pixel dimensions |
| `image_aspect` | TEXT | `ultrawide`\|`portrait`\|`square`\|`unknown` — drives UI image-area height |
| `image_source_url` | TEXT | Fandom CDN fallback (used when MinIO unavailable) |
| `content_hash` | CHAR(64) | sha256 of raw wikitext — fallback change detection for older rows |
| `rev_id` | INTEGER | Fandom revision id (`revisions[0].revid`). When non-null and unchanged, the wikitext fetch is skipped entirely (fast-skip path). Nullable: populated from migration `20260605000000_add_wiki_rev_id` onward. |
| `is_stale` | BOOLEAN | Set true for rows not touched in the latest ingest run; hard-deleted after N weeks |
| `ingested_at` | TIMESTAMPTZ | Touched on every ingest pass (even if content unchanged) |
| `created_at` / `updated_at` | TIMESTAMPTZ | Standard audit fields |

| `locations` | JSONB | Array of spawn/find location strings e.g. `["Whitespring Resort"]`; `[]` if unknown |

**Indexes:** `page_id` UNIQUE; `name` GIN trgm; `kind` B-tree; `infobox` GIN `jsonb_path_ops`.

**Reserved:** `embedding VECTOR(1536)` is kept as a SQL comment for P4 pgvector — not a live column until pgvector is installed.

### `wiki_images` (`WikiImage`)

One row per image asset associated with a `wiki_entry`. Enables the multi-image carousel and map/spawn-location overlays. The legacy `wiki_entries.image_url` field remains for back-compat and equals `images[0].url`.

Migration: `backend/prisma/migrations/20260604020000_add_wiki_images_locations/migration.sql`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `wiki_entry_id` | UUID FK → `wiki_entries` | CASCADE on delete |
| `url` | TEXT | Backend-proxied MinIO URL |
| `source_url` | TEXT | Fandom CDN fallback |
| `mime` | TEXT | MIME type (e.g. `image/webp`) |
| `width` / `height` | INTEGER | Pixel dimensions |
| `aspect` | TEXT | `ultrawide`\|`portrait`\|`square`\|`unknown` |
| `position` | INTEGER | Sort order; `0` = primary (shown first in carousel) |
| `is_map` | BOOLEAN | `true` for map/spawn-location overlay images |
| `created_at` | TIMESTAMPTZ | |

**Indexes:** `(wiki_entry_id, position)` B-tree.

### `wiki_aliases` (`WikiAlias`)

Alternative search terms for a wiki entry (e.g. "Fixer" for "The Fixer (Fallout 76)"). Auto-generated at ingest or curated by admins.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `alias` | TEXT | Normalized alternate name |
| `wiki_entry_id` | UUID FK → `wiki_entries` | CASCADE on delete |
| `source` | TEXT | `'auto'` (derived by ingestion) \| `'curated'` (human-added) |
| `created_at` | TIMESTAMPTZ | |

**Indexes:** `(alias, wiki_entry_id)` UNIQUE; `alias` GIN trgm; `wiki_entry_id` B-tree.

### `wiki_ingest_errors` (`WikiIngestError`)

Per-entity error log from the ingestion job. A failed entity is written here and the job continues — errors are isolated, the run is never aborted. Admins can retry individual entries.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `page_id` | INTEGER | Fandom page id that failed |
| `error` | TEXT | Error message / stack |
| `attempted_at` | TIMESTAMPTZ | When the attempt was made |

**Indexes:** `page_id` B-tree; `attempted_at DESC` B-tree.
