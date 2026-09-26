# Discord Bot — Overview

Online counts include Discord-only participants for 15 minutes after a human
message in a linked channel. See [shared community presence](../realtime/README.md#community-online-count)
for deduplication, expiry, failure behavior and refresh cadence.

The Fallout Chat Mod Discord bot is a single discord.js `Client` instance
started by `discordService.start()` in
[`backend/src/services/discordService.ts`](../../backend/src/services/discordService.ts).
All bot features — the chat bridge, temp voice channels, embed builder, and
reaction roles — attach their listeners to this shared client at startup; there
is **no second login**.

Production OAuth MCP clients reuse these same embed, channel/role/emoji context,
and reaction-role services; see [embeds](./embeds.md),
[reaction roles](./reaction-roles.md), and [MCP OAuth](../backend/mcp-oauth.md).

## Overlay and moderation slash commands

`discordOverlayCommandService` registers guild-scoped application commands for
every environment configured with `DISCORD_SERVER_ID` (Dev, Ant, and Production).
It provides `/fcm command:<overlay command>` as the compatibility surface for
the full server-side overlay command catalog, including configured custom commands,
so a new enabled overlay command does not require a separate Discord command
registration change.

The card-bearing Fallout lookups also have first-class public commands:
`/wiki query:`, `/camp item:`, `/minerva`, `/nukecodes`, and
`/serverstatus`.
They call `commandService` and convert its returned metadata—not a second lookup
or duplicate data model—into a public Discord embed. This keeps Discord fields,
attribution, image URL, sale dates, codes, and status in step with the overlay
card data. Other command results are ephemeral to avoid flooding the relay
channel. `/fcm` accepts only slash-prefixed input, for example
`/fcm command:"/g hello"` or `/fcm command:"/help"`.

`/giveaway command:` is also available directly in Discord; for example use
`/giveaway command:list` or `/giveaway command:"join <id>"`. A started raffle
publishes one bot embed in the Discord channel mapped to the FCM channel where
the command was sent. A channel without a relay mapping has no Discord card. Its
Join, Leave, and Stop buttons require a linked FCM account and call the same
giveaway service as overlay commands. Stop remains creator/moderator only.
Entry count edits the original embed; completion or cancellation removes its
buttons and posts a separate result embed. Interaction confirmations are
private to the person clicking the button. Discord notifications do not ping
the host or winner automatically. On bot reconnect, active cards and results
from giveaways that ended in the preceding 24 hours are restored from giveaway
state; stored Discord message links prevent repeat result posts.

`/wiki query:` and `/camp item:` search the local FCM catalog as the user types;
choosing a result then produces the same public rich card used by the overlay,
including its stored thumbnail when available. Discord's autocomplete picker is
text-only, so it cannot render images or an overlay inside the picker itself.
`/report bug description:` files a bug report, while `/report player user: description:`
searches linked FCM, Discord, and Steam identities before filing a player report.

`/help` is an ephemeral copy of the complete overlay command reference, including
all built-in and enabled dynamic commands that apply in Discord. Party-only shortcuts
are omitted because they are overlay-local. The response is one Discord embed when it
fits (with private continuation embeds only if future command growth requires them).
`/appearance` explains
the private `/name` and `/cosmetics` controls. `/events` without an option lists
every currently enabled overlay command whose action is an event announcement;
`/events command:"/ss"` runs one. The event message is finalized through the
same relay path as the overlay, so it appears in the mapped event channel and
in FCM history rather than merely as a Discord interaction response.
Every enabled event announcement is also registered as its own Discord slash
command (for example `/gu`, `/dc`, `/lits`, `/mj`, `/nw`, `/sbq`, and `/ss`).
Those shortcuts run the exact same finalization path, so the Events channel,
overlay, and HUD all receive the same announcement.

First-class FCM slash commands can be invoked from any Discord channel where the
bot can send messages; the invoking channel does not need an FCM relay mapping.
`/g`, `/t`, `/e`, `/r`, and `/i` still deliver to their named FCM channels.
Normal lookup cards and `/help` are public in the invoking channel, while
moderation actions, `/apply`, and `/report` remain private to the invoker.
Public lookup and sale cards never include an invocation mention. They remain
Discord-only when invoked in an unmapped Discord channel (including the
bot-commands channel), so they never fall back into FCM General. When invoked
in a linked Discord↔FCM channel, the public Discord embed is also finalized as
the matching overlay/HUD card in that paired FCM channel. Overlay-originated
commands retain their compact response text and source hyperlink (for example,
Minerva's “More info at …” link).

`/keybinds` posts the default Electron-overlay and optional HUD-mod controls as
a public embed. `/giveaway` replies privately in the invoking Discord channel;
the public card and result appear in the mapped Events channel and the FCM
Events history, including the optional HUD feed.

### Optional bot-commands channel

Set `DISCORD_BOT_COMMANDS_CHANNEL_ID` to designate a Discord channel as the
bot-command entry point. On startup, and after each human message in that
channel, the bot removes its previous help card and posts a fresh compact embed
that directs users to `/help` and `/events`. User messages are retained. The bot
needs **Read Message History** and **Manage Messages** there. Leave the setting
blank to disable the sticky help card.

`/moderate` is a separate command group: `kick`, `mute`, `unmute`, `ban`,
`unban`, and `delete-message`. Discord's Moderate Members permission is only an
initial UI gate. Each invocation also requires a linked FCM account whose
effective FCM role is `moderator`, `admin`, or `owner`; otherwise it is rejected
ephemerally. Actions call the same `moderationActionsService` methods used by the
dashboard, retaining target protection, session eviction, Discord propagation,
audit logging, public FCM announcement, and ban-evidence requirements. `/moderate
ban` therefore requires an evidence summary and `/moderate unban` requires the
FCM ban ID. The Discord slash variants also enforce the equivalent Discord
action: `kick` removes the linked member from the guild, `mute` applies a native
Discord timeout, and `ban` creates a guild ban even when the FCM ban has an
expiry (the FCM unban/expiry flow removes that guild ban again). If Discord
rejects an action because of bot permissions or role hierarchy, the response is
explicitly marked as FCM-only rather than claiming success.

The `user` box for `/moderate kick`, `/moderate mute`, `/moderate unmute`, and
`/moderate ban` is an FCM-backed autocomplete. Moderators can search by FCM chat
name, Discord display name or ID, Steam name, or SteamID, then choose the linked
account from the resulting list. Interaction confirmations are ephemeral; FCM
does not broadcast a public General-channel moderation message. Every moderation
action instead writes its audit record and posts a staff-only embed through the
configured `mod_log_channel_id` (the Vault Security channel by default).

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
| `GuildScheduledEvents` | Scheduled-event lifecycle and native Interested synchronization; always requested by the bot |

**Partials** (`Message`, `Channel`, `Reaction`) are also enabled so that
reaction events fire for messages posted before the last restart (i.e. messages
that are no longer in the discord.js cache). Without partials, reaction roles
stop working after a redeploy.

---

## Bot permissions required

| Permission | Needed for |
|------------|-----------|
| Read Messages / View Channels | All features |
| Read Message History | Bot-commands sticky help card |
| Send Messages | Chat bridge outbound, embed builder |
| Embed Links | Embed builder |
| Manage Messages | Chat bridge — deleting over-length or media-only messages |
| Moderate Members | `/moderate mute` Discord timeout |
| Kick Members | `/moderate kick` guild removal |
| Ban Members | `/moderate ban` guild ban |
| Manage Channels | Temp voice — creating/deleting channels |
| Move Members | Temp voice — moving members into their channel |
| Manage Roles | Temp voice channel overrides, reaction roles |
| Connect | Temp voice — bot joins the lobby briefly |
| Manage Nicknames | Nickname sync (FO76 character name) |
| Manage Events | Scheduled-event mirror validation/repair where required by the Discord API |

---

## Chat bridge (community channels ↔ Discord)

Direction is **bidirectional**. A `discord_relay_mappings` table maps each
in-game `channel_id` to a Discord channel snowflake.

### Discord → overlay (inbound)

Handled by the `messageCreate` listener at `discordService.ts:348`.

1. Messages from the FCM bot itself are ignored (echo-loop prevention). Compatible
   FCM card embeds from other bots or webhooks are instead normalized into bounded
   `wiki_share`, `camp_item`, `minerva`, `nuke_codes`, or `server_status` metadata.
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
   destination channel has `allowGifs = true`. The five recognized FCM cards are
   the narrow exception: their public HTTPS image URL is preserved as card metadata
   (wiki maps remain the large image; other card art remains a thumbnail) rather
   than being relayed as free-form media.
6. User (`<@id>`), role (`<@&id>`), and channel (`<#id>`) mentions are
   normalized to readable `@name` / `@role` / `#channel` text. Their Discord
   snowflakes are retained in `metadata.entities`; channel entities also carry a
   canonical Discord URL.
   User mentions prefer a linked real Fallout 76 username. Placeholder account
   names (`Wanderer`, `pending-*`, `discord:*`, and generated `Overlay<digits>`
   handles) are never rendered; when no real Fallout name exists, the bridge uses
   the mentioned member's Discord server display name, global display name, or
   username in that order.
   Identity is therefore paired by ID rather than inferred from a display name.
   Sharing a known `discord.com/events/...` URL resolves to the existing
   `scheduled_event` metadata and renders the standard event card in FCM.
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
- In-app autocomplete selections carry `{name, discordId}` and are converted to
  real `<@discordId>` Discord mentions. The same ID-backed entity is persisted
  with the FCM message so every overlay client renders the same mention label.
- A typed `@Role Name` is resolved to an actual Discord role mention only when
  the FCM bot can assign that role. Notification roles also accept their
  channel-style shortcut: `@events`, `@infestations`, `@raids`, and `@trading`.
  Raw Discord markup, managed roles, roles at or above the bot, and `@everyone`
  / `@here` remain blocked. Discord receives an explicit allow-list containing
  only these resolved user and role IDs.
- A zero-width-space watermark is appended to prevent the inbound handler from
  re-relaying the message.
- Format: `**[ChannelName]** **Username**: content`. When the server-resolved author
  is a Supporter or Overseer, the immutable `★` is included beside the username;
  arbitrary badge text is never accepted. The HUD send acknowledgement and live
  event use the same server-resolved identity, so a supporter message typed in-game
  is marked consistently in the HUD, overlay, and Discord relay.
- Structured `wiki_share`, `camp_item`, `minerva`, `nuke_codes`, and
  `server_status` metadata is sent as a native Discord embed instead of the text
  prefix. The card has no actor mention, maps are clickable full-size images, and
  other images are clickable thumbnails. The FCM wire still carries compact text
  plus the metadata, so the HUD can display a readable line while the overlay
  renders its native rich-card treatment.

---

## Service registration order (`discordService.start()`)

```
discordClient created (intents + partials)
  └─ voiceService.register(client)         ← temp voice channels
  └─ reactionRoleService.register(client)  ← reaction roles
  └─ discordOverlayCommandService.register(client) ← /fcm, lookup cards, /moderate
  └─ discordCommandHelpService.register(client) ← bot-commands sticky /help card
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
| `DISCORD_BOT_COMMANDS_CHANNEL_ID` | Optional channel that maintains the compact `/help` and `/events` sticky card |
| `DISCORD_EVENTS_CHANNEL_ID` | Existing Discord text-channel snowflake for event announcements; must belong to `DISCORD_SERVER_ID` |
| `DISCORD_UPDATES_CHANNEL_ID` | Release announcement channel (default `1479531502567166066`) |
| `OVERLAY_UPDATE_NOTIFICATION_ROLE_ID` | Opt-in role pinged only for Overlay and combined releases |
| `HUD_MOD_UPDATE_NOTIFICATION_ROLE_ID` | Opt-in role pinged only for HUD Mod and combined releases |
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

Both are gated on `SUPPORTER_TIER_ENABLED` (default `false` outside production): with
the tier off the command is never registered and no listener attaches. Production must
declare the switch explicitly. When enabled, the startup
reconcile runs immediately after the gateway is ready; linked login/link-status,
overlay/dashboard refreshes, and `/cosmetics` interactions also perform a bounded
live role check, so roles granted while the feature was off do not depend on a
replayed gateway event.

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
- [scheduled-events.md](./scheduled-events.md) — Scheduled Event mirroring and native Interested synchronization
- [github-tickets.md](./github-tickets.md) — Discord ⇄ GitHub bug/suggestion ticketing
