# Discord Bot — Temporary Voice Channels (Join-to-Create)

VoiceMaster/MEE6-style personal voice channels. When a member joins the
configured lobby voice channel the bot creates a private voice channel for them,
moves them in, and posts an interactive control panel. The channel is
automatically deleted when it empties.

**Source file:** [`backend/src/services/voiceService.ts`](../../backend/src/services/voiceService.ts)

> **Filename note:** the service lives in `voiceService.ts` (imported as
> `./voiceService` at `discordService.ts:7` and `discordService.ts:308`). There
> is no `tempVoiceService.ts` in this repo despite the VoiceMaster-style naming.

---

## Requirements

- **Gateway intent:** `GuildVoiceStates` (declared in `discordService.ts:298`)
- **Bot permissions:** Manage Channels, Move Members, Manage Roles, View
  Channel, Connect

---

## Flow

```
Member joins lobby VC
  └─ voiceStateUpdate (voiceService.ts:174)
       └─ createTempChannelFor() (voiceService.ts:202)
            ├─ create GuildVoice channel under category
            ├─ set permission overwrite for member (ManageChannels, MoveMembers,
            │  Connect, ViewChannel)
            ├─ move member into the new channel
            ├─ persist owner to voice_channels table
            └─ post control panel to channel's built-in text chat
```

The channel name is rendered from the `nameTemplate` setting using
`renderName()` at `voiceService.ts:167`; `{user}` is replaced with the
member's display name (max 100 chars).

---

## Control panel

Posted as a discord.js embed with three rows of buttons (prefix `tv:`).
Built by `buildPanel()` at `voiceService.ts:103`.

| Button | Custom ID | Action |
|--------|-----------|--------|
| Lock | `tv:lock` | Deny `Connect` for `@everyone` |
| Unlock | `tv:unlock` | Clear `Connect` override for `@everyone` |
| Hide | `tv:hide` | Deny `ViewChannel` for `@everyone` |
| Show | `tv:show` | Clear `ViewChannel` override for `@everyone` |
| Limit | `tv:limit` | Modal — set user limit (0-99) |
| Rename | `tv:rename` | Modal — rename the channel (max 100 chars) |
| Permit | `tv:permit` | User-select — grant Connect + ViewChannel |
| Reject | `tv:reject` | User-select — deny Connect + disconnect if present |
| Kick | `tv:kick` | User-select — voice-disconnect the selected member |
| Transfer Owner | `tv:transfer` | User-select — reassign ownership |
| Claim | `tv:claim` | Available to anyone when the owner has left |
| Region | `tv:region` | String-select — RTC region (or Automatic) |
| Bitrate | `tv:bitrate` | Modal — bitrate in kbps (8-384) |

Only the channel owner can use controls except for **Claim**, which is available
to any member when the owner is no longer in the channel.

All responses are ephemeral (visible only to the interacting user).

---

## Auto-delete

Three mechanisms ensure empty channels are cleaned up:

1. **Leave event** — `voiceStateUpdate` calls `deleteIfEmpty()` whenever a
   member leaves a tracked channel (`voiceService.ts:179-181`).
2. **60-second periodic sweep** — `periodicSweep()` at `voiceService.ts:501`
   iterates `owners` in-memory map and calls `deleteIfEmpty()` on every tracked
   channel.
3. **Startup reconcile** — `startupSweep()` at `voiceService.ts:483` reads all
   rows from the `voice_channels` table, re-hydrates the `owners` map, and
   deletes any channel that is now empty (handles bot offline during last leave).

Additionally, `periodicLobbyReconcile()` polls the lobby every 15 seconds to
create channels for any members stranded there by a missed gateway event or a
previously-failing permission error.

---

## Configuration

Settings are stored as key/value rows in the `moderation_settings` table and
cached for 60 seconds (`voiceService.ts:57-82`).

| DB key | TypeScript field | Default |
|--------|-----------------|---------|
| `voice.enabled` | `VoiceConfig.enabled` | `false` |
| `voice.lobby_channel_id` | `VoiceConfig.lobbyChannelId` | `null` |
| `voice.category_id` | `VoiceConfig.categoryId` | `null` |
| `voice.name_template` | `VoiceConfig.nameTemplate` | `{user}'s Channel` |

### REST endpoints

All endpoints require `owner`, `admin`, or `moderator` Discord role.

| Method | Path | Handler |
|--------|------|---------|
| `GET` | `/api/moderation/voice-settings` | `getVoiceSettings` |
| `PUT` | `/api/moderation/voice-settings` | `updateVoiceSettings` |

Declared in `backend/src/routes/moderation.ts:51-52`.

After a `PUT`, `invalidateVoiceCache()` (`voiceService.ts:85`) is called so the
next config read fetches fresh values immediately.

---

## Database

The `voice_channels` table persists ownership across restarts.

| Column | Type | Notes |
|--------|------|-------|
| `discordChannelId` | `String` (PK) | Discord channel snowflake |
| `guildId` | `String` | Discord guild snowflake |
| `ownerId` | `String` | Discord user snowflake |

Row is upserted on channel creation (`persistOwner`, `voiceService.ts:138`) and
deleted on channel removal (`forgetChannel`, `voiceService.ts:148`).
