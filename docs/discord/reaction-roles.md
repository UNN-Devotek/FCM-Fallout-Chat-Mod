# Discord Bot — Reaction Roles

Members react to a bot-posted message ("panel") to self-assign a role.
Removing the reaction removes the role (toggle mode, matching Carl-bot/MEE6
defaults).

**Source file:** [`backend/src/services/reactionRoleService.ts`](../../backend/src/services/reactionRoleService.ts)

---

## Requirements

- **Gateway intent:** `GuildMessageReactions` (declared in `discordService.ts:299`)
- **Partials:** `Message`, `Channel`, `Reaction` (declared in `discordService.ts:302-303`)  
  Without partials, reactions on messages posted before the last bot restart
  do not fire events.
- **Bot permission:** Manage Roles
- **Role hierarchy:** The bot's highest role **must sit above every role it
  grants**. Discord enforces this server-side; attempts to assign a role at or
  above the bot's position fail with a permissions error
  (`reactionRoleService.ts:188` logs `'check Manage Roles + hierarchy'`).

---

## Role policy (what a panel may hand out)

A reaction panel is self-service, so it must never grant a staff or gated role.
`reactionRoleRefusal()` in `reactionRoleService.ts` refuses a role when it:

- is a configured staff, access or entitlement role: `OWNER_ROLE_ID`,
  `ADMIN_ROLE_ID`, `MODERATOR_ROLE_ID`, `DEVELOPER_ROLE_ID`,
  `PROD_DEVELOPER_ROLE_ID`, `DEV_DEVELOPER_ROLE_ID`, `DEV_QA_ROLE_ID`,
  `SUPPORT_ROLE_ID`, `SUPPORTER_ROLE_ID`, or `OVERSEER_CIRCLE_ROLE_ID`;
- carries a moderation permission: Administrator, Manage Server, Manage Roles,
  Ban Members, Kick Members, Timeout Members (Moderate Members), Manage Messages,
  or Manage Channels;
- is `@everyone` or managed by an integration; or
- sits at or above the creating moderator's highest Discord role (the guild
  owner has no ceiling; panels sent without a known actor, such as MCP, skip
  only this rule).

The check runs three times:

1. **Before posting** — `discordEmbedService.send()` calls
   `assertPanelRolesAllowed(channelId, roleIds, actorId)`, which throws
   `ReactionRoleNotAllowedError` with a readable reason and posts nothing.
2. **At panel creation** — `createPanel()` re-checks (without the actor rule)
   and refuses to persist a panel offering a refused role.
3. **At click time** — `messageReactionAdd` re-checks the role (panels created
   before this policy, or whose role later gained permissions, still cannot
   grant it) and refuses members whose linked FCM account has an active ban
   (`checkPostingStanding`; a failed lookup also refuses). A refused click has
   its reaction removed and no role is granted, so an FCM-banned member cannot
   reclaim roles the ban stripped. Mutes and kick cooldowns do not block
   reaction roles.

---

## Configuration

Reaction-role panels are configured through the embed builder at send time. See
[embeds.md](./embeds.md). There is no separate UI; you compose the embed,
add `reactionRoles` mappings, and send — the bot posts the embed, adds the
configured emoji reactions, and registers the panel in one operation
(`moderationController.ts:475-521`).

Production MCP clients can perform the same workflow with
`fcm_embeds_send`. Call `fcm_discord_context_get` first and pass the returned
stable role and custom-emoji snowflake IDs; the server revalidates both against
the live bot context at send time. Custom emoji input uses `customEmojiId`, not
a caller-supplied name or Discord tag. Reads require `fcm:read`; sending and
panel deletion require `fcm:discord:write` plus `confirm: true`.

---

## Emoji matching (`matchKey`)

Each mapping stores a `matchKey` used to look up the correct role when a
reaction event fires (`reactionRoleService.ts:162-164`):

```ts
function emojiKey(reaction): string {
  return reaction.emoji.id ?? reaction.emoji.name ?? '';
}
```

- **Custom server emoji:** `matchKey` = the emoji's Discord snowflake id
- **Unicode emoji:** `matchKey` = the unicode character (e.g. `🎮`)

The `parseEmoji()` helper at `reactionRoleService.ts:47` normalises raw input
(e.g. `<:name:id>`, `name:id`, or a bare unicode char) into `{ matchKey,
reactValue }`. `reactValue` is the string passed to `message.react()`.

When `customEmojiId` is explicitly provided in the input (the dashboard
custom-emoji flow), it takes precedence over the emoji string field and the
display format is built as `<:name:id>` (or `<a:name:id>` for animated)
(`reactionRoleService.ts:67-84`).

---

## In-memory cache

All panels are cached in a `Map<messageId, PanelRecord>` at startup (warmed by
`reactionRoleService.ts:218-229`) and lazily on first access. This means role
assignments survive a redeploy without a DB round-trip per reaction event.

---

## Database

The `reaction_role_panels` table (`messageId` PK) stores one row per panel.

| Column | Type | Notes |
|--------|------|-------|
| `messageId` | `String` (PK) | Discord message snowflake |
| `channelId` | `String` | Discord channel snowflake |
| `guildId` | `String` | Discord guild snowflake |
| `mappings` | JSON | Array of `ReactionRoleMapping` objects |
| `createdAt` | DateTime | |

### `ReactionRoleMapping` shape (stored in `mappings` JSON)

```ts
{
  emoji:      string;   // display string (unicode or <:name:id>)
  matchKey:   string;   // emoji.id for custom, unicode char for standard
  reactValue: string;   // value passed to message.react()
  roleId:     string;   // Discord role snowflake
  roleName?:  string;   // resolved at panel-creation time, for display only
}
```

---

## REST endpoints

All endpoints require `owner`, `admin`, or `moderator` Discord role.
Declared in `backend/src/routes/moderation.ts:59-61`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/moderation/discord-roles` | List roles the bot can assign |
| `GET` | `/api/moderation/reaction-role-panels` | List all active panels |
| `DELETE` | `/api/moderation/reaction-role-panels/:messageId` | Delete a panel (bot also removes its reactions) |

`GET /api/moderation/discord-roles` calls `listAssignableRoles()`
(`discordService.ts:959`) which filters out `@everyone`, managed/integration
roles, and any role at or above the bot's own highest role position — the same
set of roles that Discord will actually allow the bot to assign.

---

## Event flow

### Reaction added (`messageReactionAdd`)

`reactionRoleService.ts:177`

1. Ignore bot users.
2. Look up the panel by `message.id` (cache → DB fallback).
3. Resolve partials (fetch if needed).
4. Match `emojiKey(reaction)` against `mapping.matchKey`.
5. Apply the click-time role policy and FCM ban check (`reactionClaimRefusal`);
   on refusal remove the member's reaction and stop.
6. Fetch the guild member and call `member.roles.add(roleId)`.

### Reaction removed (`messageReactionRemove`)

`reactionRoleService.ts:195` — identical flow but calls `member.roles.remove(roleId)`.

---

## Deleting a panel

`deletePanel(messageId)` at `reactionRoleService.ts:131`:

1. Deletes the DB row.
2. Removes from the in-memory cache.
3. Best-effort: fetches the original message and calls
   `reactions.removeAll()` so the emoji buttons no longer invite clicks.

The MCP equivalent, `fcm_reaction_role_panels_delete`, deactivates the panel
but preserves the posted Discord message. MCP panel creation is strict: if any
reaction fails, the database/cache panel is rolled back and reactions are
cleared best-effort. The already-posted message remains and the tool returns a
partial result containing its message ID, so callers must not blindly retry.
