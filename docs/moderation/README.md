# Moderation Subsystem Overview

The moderation subsystem covers: role-based access control, content filtering (word filter + automod rules), spam detection, user reports, ban management with evidence storage, audit logging, and name validation.

> **Multi-surface chat moderation (kick / mute / ban):** for how these actions work across the
> dashboard, overlay, and the new in-game **chat.v1** `.ba2` under the Nexus/Discord auth lockdown —
> including the cross-surface eviction signal and the account-level ban target — see
> [kick-mute-ban.md](kick-mute-ban.md).

## Role Model

There are three staff roles, determined by Discord guild membership:

| Role | Privilege level | Environment variable |
|---|---|---|
| `owner` | Highest — all actions, cannot be moderated | `OWNER_ROLE_ID` |
| `admin` | Full mod actions, dashboard access | `ADMIN_ROLE_ID` |
| `moderator` | Kick, mute, ban, report resolution | `MODERATOR_ROLE_ID` |

Regular users default to `'user'`. A `'supporter'` level exists in the type definition (`userRoleService.ts:17`) but is not currently assigned by the role verification flow.

### Server-Authoritative Roles

Roles are **server-authoritative** — they are determined by which Discord role IDs a user holds in the configured guild, not by any client-supplied claim. The role resolution hierarchy is defined in `backend/src/services/roleVerificationService.ts:14-19`:

```
owner > admin > moderator
```

If none of the three role IDs match, the user is treated as `'user'`.

### Role Verification Flow

1. **On login** — Discord OAuth2 callback checks guild membership and resolves the role via `resolveRole()`.
2. **Per request** — Every authenticated admin dashboard request re-checks the role. Redis cache (`role:verified:<discordId>`, 5-minute TTL) is checked first to avoid a Discord API call on every request.
3. **Background sweep** — `roleVerificationService.start()` runs a verification cycle every 5 minutes. It calls `GET /guilds/{id}/members/{discordId}` for each `admin_users` row. If the user left the guild or lost their qualifying Discord role, their `admin_users` row is deleted, all their Redis sessions are destroyed, and the role cache entry is cleared. This is logged as an `admin_role_revoked` audit entry.

Source files:
- `backend/src/services/roleVerificationService.ts` — background sweep + cache management
- `backend/src/services/userRoleService.ts` — `getEffectiveRole(userId)` + `isProtectedTarget(userId)` + `isPrivilegedRole(role)` used by WS handlers and REST mod endpoints

### Protected Targets

`isProtectedTarget(userId)` returns true for `moderator`, `admin`, and `owner`. All mod actions (`kickUser`, `muteUser`, `createBan`) call `ensureNotProtected(targetId)` first and throw `ProtectedTargetError` if the target holds a protected role. This prevents staff members from being moderated via the REST API.

## Moderation Actions

Core actions are implemented in `backend/src/services/moderationActionsService.ts`. Each action:

1. Validates the target is not protected (`ensureNotProtected`)
2. Mutates DB state (User flags + history rows in `bans`)
3. Mirrors to live WebSocket connections (`disconnectByUserId`, `markClientMuted`)
4. Propagates to Discord where applicable (timeouts, role stripping, guild ban)
5. Writes an `audit_logs` row
6. Posts a public system message into the General channel announcing the action
7. Posts a mod-log embed to Discord (#vault-security channel via `postModAlert`)

**Kick** — 5-minute `kicked_until` cooldown. Sends `user:kicked` WS event before disconnecting with close code 4002.

**Mute** — Minimum 60 seconds, maximum 30 days. Optionally propagates as a Discord timeout (up to 28-day API ceiling). `skipDiscord=true` used by `MUTE_OVERLAY` auto-mod action. Calls `markClientMuted()` to update live WS client state.

**Ban** — Requires at least one piece of evidence. Applies Discord lockdown: strips all manageable roles (below bot's highest), disconnects from voice, and for permanent bans applies a guild-level Discord ban. Strips roles are saved in `users.saved_discord_roles` for restoration on unban. Permanent bans also revoke the user's device keypair(s) in the `devices` table.

**Reverse Ban** — Clears `users.is_banned` flags, restores saved Discord roles, and lifts the guild ban if one was applied.

**Sweep** — `sweepExpired()` runs via node-cron every 5 minutes. It clears expired temp bans and mutes, restores Discord roles/timeouts, and clears `kicked_until` entries.

## Content Moderation

See [automod.md](./automod.md) for the full engine description.

## Reports

## Party Chat Visibility (Moderation)

Users with role `owner`, `admin`, or `moderator` receive **all party chat messages from every party** over their WebSocket connection — including parties they are not members of. This is enforced entirely server-side.

### How it works

- At connect-time the backend calls `getEffectiveRole(userId)` (Redis-cached) and stores the result on the `ClientEntry`. Default is `'user'` if resolution fails (fail-safe).
- When a `party:send` frame is processed, members receive the normal `chat:message` frame. After that, the handler walks the local `clients` map and delivers the same frame to any connected privileged non-member with `_modObserver: true` added at the top level.
- On multi-instance deployments: the Redis pub/sub party-scope subscriber on each instance performs the same local privileged fan-out, so no privileged client is missed.
- **Double-send prevention:** if a privileged user IS a member, the member path delivers the message (without `_modObserver`) and the observer path skips them.

### Hard authorization boundaries

- Privileged observers are **never** inserted into `party_members`.
- They **never** appear in `party:member-update` frames.
- They **never** appear in `GET /api/parties/:id/members`.
- `GET /api/parties` returns ALL parties (including private) for privileged users so party names can be resolved for moderation; regular users see only their own/public/invited parties.

See [`docs/realtime/websocket-protocol.md`](../realtime/websocket-protocol.md) — Party Chat section — for the full wire contract and `_modObserver` flag specification.

See [reports-and-evidence.md](./reports-and-evidence.md) for player reports, ban evidence, audit logs, and name blacklist.

## REST API Endpoints

Key moderation REST routes (all require `requireDiscordRole` middleware):

| Method | Path | Description |
|---|---|---|
| POST | `/api/moderation/kick` | Kick a user |
| POST | `/api/moderation/mute` | Mute a user |
| POST | `/api/moderation/unmute` | Unmute a user |
| POST | `/api/moderation/bans` | Create a ban with evidence |
| POST | `/api/moderation/bans/:id/reverse` | Reverse a ban |
| GET/PUT | `/api/moderation/voice-settings` | Temp VC config |
| GET/POST/PUT/DELETE | `/api/moderation/discord-embeds` | Embed templates |
| GET | `/api/moderation/discord-roles` | Available Discord roles |
| GET/DELETE | `/api/moderation/reaction-role-panels` | Reaction role panels |
| GET | `/api/moderation/audit-logs` | Audit log viewer |
| GET/POST/PUT/DELETE | `/api/admin/name-blacklist` | Name blacklist management |
| GET/POST/PUT/DELETE | `/api/admin/automod-rules` | AutoMod rule management |
