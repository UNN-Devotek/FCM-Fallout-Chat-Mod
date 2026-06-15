# Discord Bot — Overview

The Fallout Chat Mod Discord bot is a single discord.js `Client` instance
started by `discordService.start()` in
[`backend/src/services/discordService.ts`](../../backend/src/services/discordService.ts).
All bot features — the chat bridge, temp voice channels, embed builder, and
reaction roles — attach their listeners to this shared client at startup; there
is **no second login**.

---

## Required gateway intents

Declared at `discordService.ts:294-303`:

| Intent | Used by |
|--------|---------|
| `Guilds` | All features |
| `GuildMessages` | Chat bridge (inbound relay) |
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
   author is notified by DM.
5. Images are never relayed to main channels. GIFs are allowed only if the
   destination channel has `allowGifs = true`.
6. User-mention tokens (`<@id>`) are resolved to readable names: FO76 name from
   the DB if linked, otherwise the Discord server display name.
7. The automod engine is run on the content. Blocked messages are silently
   dropped (author is notified by DM).
8. The message is broadcast via WebSocket to connected overlay clients and
   queued for DB persistence (`messages` table, `source = 'discord'`).

### Overlay → Discord (outbound)

Handled by `relayToDiscord()` at `discordService.ts:747`. Called from the WS
`chat:send` handler when the destination channel has `discord_relay` enabled.

- Outbound messages are rate-limited to 4 msg/sec through an in-memory queue
  drained by a 250 ms interval timer.
- Raw Discord mention syntax is stripped (abuse guard).
- In-app `@name` tokens are converted to real `<@discordId>` Discord mentions
  for linked users.
- A zero-width-space watermark is appended to prevent the inbound handler from
  re-relaying the message.
- Format: `**[ChannelName]** **Username**: content`

---

## Service registration order (`discordService.start()`)

```
discordClient created (intents + partials)
  └─ voiceService.register(client)         ← temp voice channels
  └─ reactionRoleService.register(client)  ← reaction roles
  └─ emoji cache-invalidation listeners
  └─ ready handler (presence, logging)
  └─ messageCreate handler (chat bridge)
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

---

## Related docs

- [voice-channels.md](./voice-channels.md) — Join-to-Create temp voice channels
- [embeds.md](./embeds.md) — Embed builder
- [reaction-roles.md](./reaction-roles.md) — React-to-get-role
