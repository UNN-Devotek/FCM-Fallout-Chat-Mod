# Discord Bot — Overview

The Fallout Chat Mod Discord bot is a single discord.js `Client` instance
started by `discordService.start()` in
[`backend/src/services/discordService.ts`](../../backend/src/services/discordService.ts).
All bot features — the chat bridge, temp voice channels, embed builder, and
reaction roles — attach their listeners to this shared client at startup; there
is **no second login**.

---

## Required gateway intents

Declared in `discordService.ts` when the shared client is created:

| Intent | Used by |
|--------|---------|
| `Guilds` | All features |
| `GuildMessages` | Chat bridge (inbound relay) |
| `GuildMessageTyping` | Discord → overlay typing indicators |
| `MessageContent` | Chat bridge — reading message text |
| `GuildVoiceStates` | Temp voice channels (Join-to-Create) |
| `GuildMessageReactions` | Reaction roles |

**Partials** (`Message`, `Channel`, `Reaction`) are also enabled so that
reaction events fire for messages posted before the last restart (i.e. messages
that are no longer in the discord.js cache). Without partials, reaction roles
stop working after a redeploy.

---

## Bot permissions required

| Permission | Needed for |
|------------|-----------|
| Read Messages / View Channels | All features |
| Send Messages | Chat bridge outbound, embed builder |
| Embed Links | Embed builder |
| Manage Messages | Chat bridge — deleting over-length or media-only messages |
| Manage Channels | Temp voice — creating/deleting channels |
| Move Members | Temp voice — moving members into their channel |
| Manage Roles | Temp voice channel overrides, reaction roles |
| Connect | Temp voice — bot joins the lobby briefly |
| Manage Nicknames | Nickname sync (FO76 character name) |

---

## Chat bridge (community channels ↔ Discord)

Direction is **bidirectional**. A `discord_relay_mappings` table maps each
in-game `channel_id` to a Discord channel snowflake.

### Discord → overlay (inbound)

Handled by the `messageCreate` listener at `discordService.ts:348`.

1. Bot and webhook messages are ignored (echo-loop prevention).
2. Messages carrying the zero-width-space watermark (`​`) are dropped
   (defense-in-depth — these are our own outbound relay messages bouncing back).
3. The relay mapping is looked up; if no explicit mapping exists for the Discord
   channel, the message falls back to the `DISCORD_CHANNEL_ID` env var mapped
   to the General channel.
4. Messages longer than 255 characters are **deleted** from Discord and the
   author is notified by DM. The DM **echoes the original text back** so the
   author can copy-paste and trim instead of retyping it. The echo is wrapped in
   a fenced code block so mentions inside it cannot ping a second time, and the
   fence is widened past any backtick run in the content so it can't be escaped.
   If notice + content would exceed Discord's 2000-character message cap the
   echo is truncated with an explicit marker (never split across multiple DMs —
   a burst reads as spam). Built by `buildOverLengthDm` in
   `backend/src/utils/overLengthDm.ts`, unit-tested in
   `backend/src/services/__tests__/overLengthDm.test.ts`.
5. Images are never relayed to main channels. GIFs are allowed only if the
   destination channel has `allowGifs = true`.
6. User-mention tokens (`<@id>`) are resolved to readable names: FO76 name from
   the DB if linked, otherwise the Discord server display name.
7. The automod engine is run on the content. Blocked messages are silently
   dropped (author is notified by DM).
8. The message is decorated with the author's current supporter cosmetics using
   the shared `attachCosmetics()` resolver, then broadcast via WebSocket to
   connected overlay clients and queued for DB persistence (`messages` table,
   `source = 'discord'`). This applies to every mapped Discord channel; history
   resolution remains the fallback for reconnects and reloads.

Discord `typingStart` events use the same relay mapping and emit an ephemeral
`chat:typing` frame to the mapped overlay channel. They are ignored for bots,
unmapped channels, other guilds, and Discord members without a linked FCM
identity. The event is throttled per Discord user/channel; the overlay's normal
four-second timeout clears the indicator because Discord does not send a typing-
stopped event.

### Overlay → Discord (outbound)

Handled by `relayToDiscord()` at `discordService.ts:747`. Called from the WS
`chat:send` handler and the shared HUD relay finalizer when the destination channel
has `discord_relay` enabled.

- Outbound messages are rate-limited to 4 msg/sec through an in-memory queue
  drained by a 250 ms interval timer.
- Raw Discord mention syntax is stripped (abuse guard).
- In-app `@name` tokens are converted to real `<@discordId>` Discord mentions
  for linked users.
- A zero-width-space watermark is appended to prevent the inbound handler from
  re-relaying the message.
- Format: `**[ChannelName]** **Username**: content`. When the server-resolved author
  is a Supporter or Overseer, the immutable `★` is included beside the username;
  arbitrary badge text is never accepted. The HUD send acknowledgement and live
  event use the same server-resolved identity, so a supporter message typed in-game
  is marked consistently in the HUD, overlay, and Discord relay.

---

## Service registration order (`discordService.start()`)

```
discordClient created (intents + partials)
  └─ voiceService.register(client)         ← temp voice channels
  └─ reactionRoleService.register(client)  ← reaction roles
  └─ emoji cache-invalidation listeners
  └─ ready handler (presence, logging)
  └─ messageCreate handler (chat bridge)
  └─ typingStart handler (Discord → overlay typing)
  └─ discordClient.login()
```

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `DISCORD_TOKEN` | Bot token — if unset, the bridge is disabled entirely |
| `DISCORD_SERVER_ID` | Guild snowflake (assignable-roles, nickname sync) |
| `DISCORD_CHANNEL_ID` | Default relay channel fallback |
| `DISCORD_UPDATES_CHANNEL_ID` | Release announcement channel (default `1479531502567166066`) |
| `DOWNLOAD_PAGE_URL` | Release embed/download-page URL; dev overrides this to `https://dev.falloutchatmod.com` |
| `RELEASE_DOWNLOAD_HOST` | Host for release artifact links; prod defaults to `falloutchatmod.com`, dev uses `dev.falloutchatmod.com` |

---

## Supporter tier + `/cosmetics`

`supporterSyncService` keeps supporter entitlements in lockstep with Discord tier roles
(and treats the configured `ADMIN_ROLE_ID` plus authenticated owner/admin identities as an
Overseer-level cosmetics bypass). The bypass grants appearance benefits only and does not
change moderation authorization or paid entitlement records.
Discord Server Subscriptions grant/revoke the role on purchase/cancellation, so the
role IS the entitlement signal and no payment webhook exists). `cosmeticsCommandService`
registers the guild-scoped `/cosmetics` command.

**Requires the `GuildMembers` PRIVILEGED intent**, enabled per Discord application in
the Developer Portal — dev and prod are separate applications, so this must be done
twice. Without it the gateway connection is rejected outright.

Both are gated on `SUPPORTER_TIER_ENABLED` (default `false`): with the tier off the
command is never registered and no listener attaches.

The appearance subcommands are `/cosmetics color`, `/cosmetics star`,
`/cosmetics effect`, `/cosmetics tag`, `/cosmetics show`, `/cosmetics clear`, and
`/cosmetics help`. `/cosmetics star` changes only the supporter marker colour; the
marker itself is always the fixed `★` glyph. `/cosmetics clear field:star` resets only
that colour, while an unqualified `/cosmetics clear` resets all appearance fields.

`chatNameCommandService` separately registers `/name`, a free account setting that is
available whether supporter cosmetics are enabled or not. It opens an ephemeral modal;
leaving it blank restores the ordinary Fallout 76 / Discord-derived name.

### Supporter guild nicknames

For an active Supporter or Overseer's Circle member, the bot mirrors their resolved FCM
appearance into the **FCM server nickname** as `★ Name` or `★ [TAG] Name`. The tag is
the same moderated four-character Overseer tag configured through the website or
`/cosmetics tag`; changes from either surface update the nickname. The bot cannot and
does not change a member's global Discord username.

The star/tag is added on an entitlement transition, name/tag edit, and reconciliation;
it is removed when the tier role is removed. A missing **Manage Nicknames** permission,
server ownership, or Discord role hierarchy only skips the nickname update — it never
blocks a cosmetic save or entitlement change.

### Appearance roles

When a user saves a colour or effect, the bot mirrors the effective selection to the
configured FCM guild. A colour preset adds its matching colour role (which supplies
Discord's displayed name colour); a selected effect adds only its matching effect role.
The previous role in each family is removed. Selecting `None` removes all effect roles.
Custom hex colours have no corresponding Discord role, so they continue to render in
FCM while any preset colour role is cleared. The effect role is a Discord marker only:
the actual glow/animation still renders on the website and desktop overlay, not inside
Discord or the Fallout 76 HUD.

The supporter star is not a user-editable Discord role or text field. Its glyph is
server/client guarded as `★`, its colour comes from the shared catalog, and the in-game
HUD receives the same validated colour through the additive relay fields.

The role names must exactly match the labels in `cosmetics/presets.ts`. The provisioning
script creates missing roles, and no per-role environment variables are required:

- Colour roles: all labels in `COLOR_PRESETS` (23 roles).
- Effect roles: `Soft Glow`, `Hard Glow`, `Heavy Outline`, `Chroma Split`, `Pulse Glow`,
  `CRT Phosphor`, `Glitch`, and `Shimmer` (8 roles; no role for `None`).

Roles must remain below the bot's highest role and the bot needs **Manage Roles**. A
missing role is non-fatal to the FCM save, but the Discord presentation will remain at
its previous value until the role is provisioned.

Full design record: [docs/product/supporter-tier.md](../product/supporter-tier.md).

## Related docs

- [voice-channels.md](./voice-channels.md) — Join-to-Create temp voice channels
- [embeds.md](./embeds.md) — Embed builder
- [reaction-roles.md](./reaction-roles.md) — React-to-get-role
- [github-tickets.md](./github-tickets.md) — Discord ⇄ GitHub bug/suggestion ticketing
