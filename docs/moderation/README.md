# Moderation Subsystem Overview

The moderation subsystem covers: role-based access control, content filtering (AI classifier + word filter + automod rules), spam detection, user reports, ban management with evidence storage, audit logging, and name validation.

> **AI content moderation:** chat, usernames, and party names are classified by the
> [OpenAI Moderation API](https://developers.openai.com/api/docs/guides/moderation). While enabled
> and reachable it is the **primary** content check, but chat enforcement is limited to
> high-confidence targeted attacks; ordinary Fallout profanity and gameplay violence are not
> chat violations by themselves. The keyword denylists become an offline fallback. This sends
> message text to a third party — see
> [ai-moderation.md](ai-moderation.md) for the privacy disclosure, the admin kill switch, and the
> shadow-mode rollout procedure.

> **Multi-surface chat moderation (kick / mute / ban):** for how these actions work across the
> dashboard, overlay, and the new in-game **chat.v1** `.ba2` under the Discord/Nexus/Steam auth lockdown —
> including the cross-surface eviction signal and the account-level ban target — see
> [kick-mute-ban.md](kick-mute-ban.md).

## Shared chat flood protection

Three messages per rolling thirty seconds, with repeated floods escalating from 35
seconds to five minutes. Sixty attempts in a rolling minute starts a hard
five-minute cooldown across connected Discord, HUD and overlay channel chat. See
[policy, permissions and retry behavior](chat-slowmode.md).

## Role Model

There are three staff roles, determined by Discord guild membership:

| Role | Privilege level | Environment variable |
|---|---|---|
| `owner` | Highest — all actions, cannot be moderated | `OWNER_ROLE_ID` |
| `admin` | Full mod actions, dashboard access | `ADMIN_ROLE_ID` |
| `moderator` | Kick, mute, ban, report resolution | `MODERATOR_ROLE_ID` |

Regular users default to `'user'`. A `'supporter'` level exists in the `EffectiveRole`
type definition (`userRoleService.ts:17`) but is **still not assigned by the role
verification flow, and deliberately so** — it survives only as a dev-login persona.

The paid supporter tier is tracked on a **separate, orthogonal axis** (`SupporterTier`
in `utils/supporterTier.ts`, persisted in `supporter_entitlements`), not through
`EffectiveRole` and not in `admin_users`. That table is reserved for elevated staff
identities, and `isPrivilegedRole()` must keep returning false for supporters: a paying
customer is not a moderator, and conflating the two would risk treating one as the
other. Supporter status gates cosmetics and nothing else.

See [Supporter tier](../product/supporter-tier.md) and
[monetization policy](../legal/monetization-policy.md).

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
- `backend/src/services/userRoleService.ts` — `getEffectiveRole(userId)` + `isProtectedTarget(userId)` + `isPrivilegedRole(role)` used by WS handlers and REST mod endpoints, and `resolveTargetProtection(userId)` (the fail-closed moderation check)

### Protected Targets

All mod actions (`kickUser`, `muteUser`, `createBan`) call `ensureNotProtected(targetId)` first. It uses `resolveTargetProtection(userId)`, which treats the target as staff (`moderator`, `admin`, `owner`) when **any** source says so: the verified-role Redis cache, the `admin_users` row, or a staff Discord role on the member in the bot's in-memory guild member cache (covers staff who never signed in to the dashboard and so have no `admin_users` row; no Discord API call is made, so a member missing from the gateway cache is only covered by the other two sources). A staff target throws `ProtectedTargetError` (code `ProtectedTarget`, HTTP 409).

The check **fails closed**: if the users/`admin_users` lookup fails, the action is refused with code `ProtectionCheckFailed` (HTTP 503) instead of treating the target as a normal user. `getEffectiveRole` keeps its fail-open `'user'` default for privilege grants elsewhere.

### Stable error codes

`backend/src/services/moderationErrors.ts` exports `ModerationError` (with `code`) and `httpStatusForModerationError`. REST controllers return RFC 7807 Problem Details with `title` = code and `type` = `https://fo76chat.app/errors/moderation/<code>`; the Discord `/moderate` command and relay handlers map the same codes.

| Code | HTTP | Meaning |
|---|---|---|
| `ProtectedTarget` | 409 | Target holds a staff role (`ProtectedTargetError`, `name` kept for the WS/relay handlers) |
| `ProtectionCheckFailed` | 503 | Staff-role lookup failed; action refused |
| `TargetNotFound` | 404 | No `users` row for the target |
| `AlreadyBanned` | 409 | Target already has an active ban; reverse it first |
| `NotBanned` | 409 | By-user unban with no active ban |
| `BanNotFound` | 404 | Ban id does not exist |
| `BanAlreadyReversed` | 409 | Ban was already reversed |
| `InvalidInput` | 400 | Missing kick reason or ban evidence |

## Moderation Actions

Core actions are implemented in `backend/src/services/moderationActionsService.ts`. Each action:

1. Validates the target is not protected (`ensureNotProtected`)
2. Mutates DB state (User flags + history rows in `bans`)
3. Mirrors to live WebSocket connections (`disconnectByUserId`, `markClientMuted`)
4. Propagates to Discord where applicable (timeouts, role stripping, guild ban)
5. Writes an `audit_logs` row
6. Posts a staff-only mod-log embed to Discord (#vault-security channel via `postModAlert`); no public chat message

**Kick** — 5-minute `kicked_until` cooldown. Sends `user:kicked` WS event before disconnecting with close code 4002.

**Mute** — Minimum 60 seconds, maximum 30 days. Optionally propagates as a Discord timeout (up to 28-day API ceiling). `skipDiscord=true` used by `MUTE_OVERLAY` auto-mod action. Calls `markClientMuted()` to update live WS client state.

**Ban** — Requires at least one piece of evidence. A target with an active ban (unreversed and permanent or not yet expired) is refused with `AlreadyBanned`. Applies Discord lockdown: strips all manageable roles (below bot's highest) and disconnects from voice. Only **permanent** bans apply a guild-level Discord ban; temporary bans (including Discord `/moderate ban` with a duration) never guild-ban, so the member stays in the guild and the expiry sweep can restore the roles. Stripped roles are saved in `users.saved_discord_roles`; a non-empty snapshot is never replaced by an empty one. Permanent bans also revoke the user's device keypair(s) in the `devices` table and deny-list the account's Discord, Steam and Nexus identities in `banned_identities`.

**Reverse Ban** — Marks the ban row reversed (atomic; a second reversal is `BanAlreadyReversed`). The user's flags are cleared, saved Discord roles restored and the guild ban lifted **only** when the reversed ban was still active and no other active ban remains for that user — reversing an old, expired or superseded ban never lifts a current one. Reversing a permanent ban removes the deny-listed identities when no other unreversed permanent ban remains.

**Sweep** — `sweepExpired()` runs via node-cron every 5 minutes (`server.ts`). It clears expired temp bans and mutes, restores Discord roles/timeouts, and clears `kicked_until` entries. Expired temp bans that were cleared lazily by the auth, link or WebSocket reconnect paths (flags reset, role snapshot left behind) also have their roles restored when the ban expired within the last 7 days; older leftover snapshots are dropped without re-granting roles.

**Legacy per-user routes** — `POST/DELETE /api/users/:id/mute`, `POST /api/users/:id/kick`, `POST /api/users/:id/ban` (permanent, reason stored as text evidence) and `DELETE /api/users/:id/ban` (reverses the user's active ban rows) call the same service functions, so they get the protected-target check, `bans`/evidence rows, audit + mod-log, live socket and relay eviction, and Discord propagation. The dashboard Users page shows Ban to admins and owners and Unban/Wipe/Delete to owners only, matching the route gates.

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

## OAuth MCP coverage

Production MCP exposes every moderation capability either as a dedicated Discord/embed tool or through
the bounded `fcm_actions_search` + `fcm_action_read`/`fcm_action_write` catalog. The catalog covers
users and aliases, message search/delete/scrub, reports, kicks/mutes/bans, evidence, audit history,
word filters, name blacklist, moderation/voice settings, Discord relay mappings, and AutoMod rules and
violations. Mutation schemas require `confirm: true` and `fcm:moderation:write`; reads require
`fcm:read`. Ban-evidence bodies are further restricted to owner/admin actors, while developers receive
metadata only. Discord embeds, managed uploads, custom emojis, and reaction-role panels remain
dedicated tools with `fcm:discord:write`.

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
