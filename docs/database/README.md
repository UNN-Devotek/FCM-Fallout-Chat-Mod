# Database Overview

Fallout Chat Mod uses **PostgreSQL 16 + TimescaleDB** as its primary store, **Prisma** as the ORM, and **Redis** for ephemeral state. All backend database access goes through `backend/src/config/prisma.ts` (the shared Prisma client singleton).

## PostgreSQL via Prisma

Schema source of truth: `backend/prisma/schema.prisma`.
Bootstrap DDL (idempotent): `backend/db/init.sql`.
Startup sync: `backend/baseline-migrations.sh` — see [migrations.md](./migrations.md).

TimescaleDB hypertables are used for the two highest-volume time-series tables:

| Table | Hypertable chunk | Retention policy |
|---|---|---|
| `messages` | 7 days | 90 days (via `add_retention_policy`) |
| `audit_logs` | 7 days | 90 days |

These are set up in `backend/db/init.sql` (lines 94-105, 166-177). The Prisma schema treats them as ordinary models; the hypertable configuration lives in the SQL bootstrap only.

## Naming Conventions

| Layer | Convention | Example |
|---|---|---|
| DB tables / columns | `snake_case` plural | `chat_rooms`, `moderation_logs` |
| Prisma models | `PascalCase` via `@@map` / `@map` | `User` maps to `users`; `isBanned` maps to `is_banned` |
| REST routes | `kebab-case` | `/api/moderation-logs` |
| React components | `PascalCase` | `MessageHistory.tsx` |
| TypeScript modules | `camelCase` | `authService.ts` |
| JSON keys (API payloads) | `camelCase` | `{ isBanned: true }` |
| Socket events | `domain:action` | `chat:message`, `room:join` |
| Dates | ISO 8601 UTC strings | always |

Every column named in the Prisma schema carries an explicit `@map("snake_case_name")` so the generated client uses camelCase while the DB stores snake_case. Tables carry `@@map("plural_snake_case")`.

User-authored channel, party, and private messages persist an optional `edited_at` timestamp.
The overlay displays this as an `(edited)` marker; ownership and moderation checks remain
server-side.

Bridged public channel messages also use `discord_message_links` to retain the Discord
message/channel snowflakes and the bot-message prefix. Human-authored Discord rows are
linked for inbound `messageUpdate` events; bot-authored relay rows are eligible for
outbound overlay edits.

## Redis Role

Redis is accessed via `backend/src/config/redis.ts` using the `redis` npm package. It serves three purposes:

**1. Session store** — Express sessions for the admin dashboard are persisted in Redis under the `sess:` key prefix (connect-redis). Admin sessions expire naturally; `roleVerificationService.ts` also manually deletes sessions when it revokes an admin user's role (see `backend/src/services/roleVerificationService.ts:51-80`).

**2. Rate-limit counters** — Spam detection uses a Redis sorted-set sliding window per user: key `spam:<userId>`, score = message timestamp (ms). Each `chat:send` call adds the current timestamp, prunes entries older than the window, and checks the member count against the configured limit (`spam_message_limit` / `spam_window_ms` from `moderation_settings`). See `backend/src/services/autoModService.ts:181-206`.

**3. Role verification cache** — Verified admin/moderator/owner roles are cached under `role:verified:<discordId>` with a 5-minute TTL to avoid hitting the Discord API on every authenticated request. See `backend/src/services/roleVerificationService.ts:25-44`.

Additional Redis keys used:
- `spam:immunity:<userId>` — 60-minute immunity window granted when a moderator reverses a spam penalty (`autoModService.ts:212-218`).
- `name-blacklist:updated` pub/sub channel — cross-instance cache invalidation for the name blacklist (`nameBlacklistService.ts:40-146`).

## Related Docs

- [schema.md](./schema.md) — full table/model catalog
- [migrations.md](./migrations.md) — idempotency rules for contributors
- [../moderation/README.md](../moderation/README.md) — moderation subsystem overview
