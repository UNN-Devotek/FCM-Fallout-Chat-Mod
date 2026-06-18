# Reports, Evidence, and Audit Logs

## Player Reports (`player_reports` table)

Submitted via `/report` in the overlay, the website **Report a Player** form, **or
the Discord "🚩 Report a Player" button** (see
[docs/discord/github-tickets.md](../discord/github-tickets.md#report-a-player) — opens
a private lockdown thread, pings moderators + overseers, and attaches thread
screenshots to the report). Distinct from the `reports` table — these are free-text
submissions with optional screenshot attachments.

| Field | Notes |
|---|---|
| `report_type` | `'player'` (default) or `'bug'` |
| `report_number` | Sequential case number (Postgres sequence) — assigned to every report (Discord + web); shown in the portal and the Discord thread title |
| `content` | Free-text description |
| `involved_players` | Optional: comma-separated player names |
| `image_urls` | JSON `string[]` of MinIO public URLs (up to 3 images) |
| `discord_thread_id` | Set when filed from Discord — the lockdown thread for evidence |
| `status` | `'open'` \| `'reviewed'` \| `'closed'` |

### Report Image Upload (`reportImageService.ts`)

Images are uploaded to MinIO via `uploadReportImages(buffers[])` (`backend/src/services/reportImageService.ts`).

Security properties:
- Maximum 3 images per report, 5 MB each
- File type validated from **magic bytes** via the `file-type` npm package — the client-supplied filename and Content-Type header are ignored
- Allowed types: JPEG, PNG, WebP, GIF only
- Object keys are random UUIDs (`report-images/<uuid>.<ext>`) — no user-supplied filename reaches storage

## User-to-User Reports (`reports` table)

In-overlay right-click reports against specific messages or users. Managed in the admin dashboard Reports view.

| Status | Meaning |
|---|---|
| `open` | Awaiting staff review |
| `resolved` | Actioned (e.g. ban/mute applied) |
| `dismissed` | Reviewed but no action taken |
| `escalated` | Flagged for senior staff |

`message_id` is a UUID reference only — there is no FK constraint because `messages` has a composite PK `(id, created_at)` that Prisma cannot model as a single-column FK (see `schema.prisma:216-218`). Use raw SQL for report-message joins.

## Ban Evidence Storage (`banEvidenceStorage.ts`)

Ban creation (`createBan`) requires at least one piece of evidence. Evidence is stored in the `ban_evidence` table with a MinIO backend for images.

**MinIO bucket:** `ban-evidence` (separate from the general-purpose bucket so it has its own ACL and lifecycle policy).

**Evidence types:**

| `type` | Storage | Notes |
|---|---|---|
| `'text'` | `text_content` column (inline) | Plaintext statement, chat log excerpt, etc. |
| `'image'` | MinIO object referenced by `object_key` | Screenshot, photo of screen, etc. |

**Image security:** `uploadEvidence(buf, _clientMime)` in `banEvidenceStorage.ts` ignores the client-declared MIME entirely. It inspects the first 12-16 bytes for magic numbers to detect PNG/JPEG/GIF/WebP and throws if the bytes do not match a whitelisted format. The detected MIME is stored in the `ban_evidence.mime` column as ground truth.

**Image serving:** Evidence images are served via a backend-proxied route (`/api/moderation/bans/:id/evidence/:fileId`). No public URLs, no signed-URL juggling. The route streams the object from MinIO through the backend.

**Evidence access control (per-ban scoping):** The moderation routes are gated by `requireDiscordRole(OWNER, ADMIN, MODERATOR)`, but evidence (`text_content` + image `object_key`) is **further scoped per-ban** so a moderator cannot read the evidence of bans issued by other staff. The rule lives in `assertBanEvidenceAccess()` / `isEvidencePrivileged()` (`moderationActionsController.ts`):

- **Owners and admins** see all evidence for every ban.
- **Every other persona** (moderator, supporter, developer, and any future non-privileged role admitted to the route) may only see evidence for bans where `ban.banned_by_id` equals their own internal user id — i.e. bans they personally issued. The check is role-set based, not a literal `'moderator'` string match, so a supporter/developer cannot slip through.

This is enforced on all three evidence surfaces:

| Endpoint | Non-owner/admin behaviour |
|---|---|
| `GET /api/moderation/bans/:id/evidence/:fileId` (image stream) | Streams only if the caller issued the ban; otherwise **404** (not 403 — avoids a ban-existence oracle) and the object is never read from storage. |
| `GET /api/moderation/bans/:id` | The ban metadata still returns, but the `evidence` relation is **stripped to `[]`** unless the caller issued the ban. |
| `GET /api/moderation/evidence` (gallery) | `findMany` is filtered with `where: { ban: { bannedById: <actor> } }`; owners/admins get the full, unfiltered list. |

`GET /api/moderation/bans` (the ban list) intentionally exposes evidence **metadata only** (`id`, `type`, `mime`, `sizeBytes`) to all moderators — never `text_content` or `object_key` — so ban existence is not secret, only the evidence content is.

**Evidence deletion:** When a `bans` row is deleted (cascade), the `ban_evidence` DB rows are deleted, but the corresponding MinIO objects are NOT automatically removed — cleanup must be triggered explicitly via `deleteEvidence(objectKey)`.

## Audit Logs (`audit_logs` table)

TimescaleDB hypertable (`backend/db/init.sql:154-177`). Composite PK `(id, created_at)`. **90-day retention** policy via `add_retention_policy`.

`actor_id` is `NULL` for system-generated entries (auto-mod, sweeps). `target_id` is **polymorphic** — it can reference a user, party, message, or other entity. There is **no FK constraint** on `target_id` (the FK was dropped in `20260601_drop_audit_target_fkey` to prevent P2003 errors when the target was a party or message). `target_type` identifies the entity class.

Common `action` values:

| Action | Triggered by |
|---|---|
| `kick` | `moderationActionsService.kickUser()` |
| `mute` | `moderationActionsService.muteUser()` |
| `unmute` | `moderationActionsService.unmuteUser()` |
| `ban` | `moderationActionsService.createBan()` |
| `unban` | `moderationActionsService.reverseBan()` |
| `automod_violation` | `autoModEngine.engineEvaluate()` |
| `auto_shadow_mute` | `autoModService.shadowMute()` |
| `auto_mod_test_match` | `autoModService.filterContent()` (test mode) |
| `admin_role_revoked` | `roleVerificationService.runVerificationCycle()` |

## Name Blacklist (`name_blacklist` table / `nameBlacklistService.ts`)

Added in v1.1.73. Rejects username candidates at the register/refresh boundary.

### Match Types

All matching is case-insensitive.

| `match_type` | Behavior |
|---|---|
| `exact` | `trim().toLowerCase() === pattern.toLowerCase()` |
| `contains` | `lower.includes(pattern.toLowerCase())` |
| `regex` | Compiled with `i` flag via `compileUserRegex()` (ReDoS-protected) |

### Caching

The full `name_blacklist` table (enabled entries only) is loaded into process memory on server start via `loadBlacklist()`. Cache is invalidated by:
1. **Explicit `refreshBlacklist()` call** — made by the admin controller after every create/update/delete.
2. **Redis pub/sub** — `refreshBlacklist()` publishes to `name-blacklist:updated`; all instances subscribe via `subscribeBlacklistUpdates()` on startup and reload their cache when any publish arrives.

`isBlacklisted(name)` returns `false` (fail-open) if the cache has not yet loaded, to avoid blocking legitimate registrations during startup.

### Seeded Entries

The `20260510000000_add_name_blacklist` migration seeds 26 entries covering common FO76 item names, consumables, menu labels, and placeholder values (e.g. `'Wanderer'` as `exact`, `'Plan:'` as `contains`). Inserted idempotently via `ON CONFLICT ("pattern") DO NOTHING`.
