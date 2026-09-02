# Discord Bot — Embed Builder

Admins compose rich Discord embeds from the dashboard (CHAT → EMBEDS tab),
save them as reusable templates, and post them to any guild text channel via
the bot. Embeds can also configure reaction roles at send time.

**Source files:**
- Service: [`backend/src/services/discordService.ts`](../../backend/src/services/discordService.ts) — `postEmbed`, `listTextChannels`, `buildEmbed`
- Controller: [`backend/src/controllers/moderationController.ts`](../../backend/src/controllers/moderationController.ts)
- Routes: [`backend/src/routes/moderation.ts`](../../backend/src/routes/moderation.ts)

---

## Bot permissions required

- **Send Messages** — post the embed
- **Embed Links** — render rich embeds (Discord strips them without this)

---

## `EmbedData` shape

Defined at `discordService.ts:876`. This interface is the canonical shape for
embed data stored in `discord_embeds.data` (JSON column), sent in REST request
bodies, and consumed by `EmbedBuilder.tsx` on the frontend.

```ts
interface EmbedData {
  title?:         string;
  description?:   string;
  url?:           string;
  color?:         string | number;  // hex "#18FF62" or integer
  authorName?:    string;
  authorIconUrl?: string;
  authorUrl?:     string;
  thumbnailUrl?:  string;
  imageUrl?:      string;
  footerText?:    string;
  footerIconUrl?: string;
  timestamp?:     boolean;
  fields?:        Array<{ name: string; value: string; inline?: boolean }>;
  /** Optional plain-text content sent alongside the embed. */
  content?:       string;
}
```

### Discord limits applied by `buildEmbed()` (`discordService.ts:903`)

| Field | Limit |
|-------|-------|
| `title` | 256 chars |
| `description` | 4096 chars |
| `authorName` | 256 chars |
| `footerText` | 2048 chars |
| `fields[].name` | 256 chars |
| `fields[].value` | 1024 chars |
| `fields` count | 25 max |
| `content` (plain text) | 2000 chars |

---

## Service functions

### `postEmbed(channelId, data)` — `discordService.ts:938`

Posts the embed to the given Discord channel. Throws if the bot is not
connected or the target channel is not a text channel. Returns the sent
`discord.js Message` object (used by the reaction-role flow to get `messageId`).

### `listTextChannels()` — `discordService.ts:979`

Returns `{ id, name }[]` for all text channels in the configured guild, sorted
alphabetically. Used by the dashboard channel picker.

### `buildEmbed(data)` — `discordService.ts:903`

Internal helper. Converts `EmbedData` to a discord.js `EmbedBuilder` with all
Discord character limits applied.

### `postReleaseAnnouncement(version, releaseNotes, hudMod?, options?)` — `discordService.ts`

Posted to the **Updates** channel (`DISCORD_UPDATES_CHANNEL_ID`) by `publishRelease`
on every release. It is a **required** publish step — if it fails after retries the
publish 502s and no release is recorded.

- **Pings `@everyone` by default.** The message `content` is `@everyone` with
  `allowedMentions: { parse: ['everyone'] }`; the ping only fires if the bot holds
  **Mention Everyone** in that channel (otherwise it posts silently). Pass
  `{ mentionEveryone: false }` for a replacement or corrected announcement that keeps
  the embed but omits both the content and the mention permission.
- **Download field** — direct 🪟 Windows ZIP / 🐧 Linux AppImage / Linux `.deb` links, the
  Linux ZIP with install docs, the Download-page link, and the versioned **ZFE FCM HUD Mod ZIP**
  link when the release includes HUD metadata.
  The URLs are **environment-aware** (`utils/releaseAnnouncement.ts` →
  `releaseDownloadUrls.ts`, `RELEASE_DOWNLOAD_HOST`), so a dev/QA release links to the
  dev host instead of prod (where the dev artifacts would 404).
- **Endorse-on-Nexus field** — encourages a Nexus endorsement, linking
  `NEXUS_MOD_URL` (default `…/mods/4082`), with the caveat that Nexus only unlocks
  endorsing after the user has downloaded the mod there at least once.
- The copy + links are pure functions in `utils/releaseAnnouncement.ts` (unit-tested
  in `releaseAnnouncement.test.ts`).

---

## Database

The `discord_embeds` table stores named templates.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `name` | `String` | Display name in the dashboard |
| `data` | JSON | Serialised `EmbedData` |
| `createdAt` | DateTime | |
| `updatedAt` | DateTime | |

---

## REST endpoints

All endpoints require `owner`, `admin`, or `moderator` Discord role.
Declared in `backend/src/routes/moderation.ts:53-58`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/moderation/discord-embeds` | List all saved templates |
| `POST` | `/api/moderation/discord-embeds` | Save a new template `{ name, data }` |
| `PUT` | `/api/moderation/discord-embeds/:id` | Update a template |
| `DELETE` | `/api/moderation/discord-embeds/:id` | Delete a template |
| `POST` | `/api/moderation/discord-embeds/send` | Post an embed to a channel |
| `GET` | `/api/moderation/discord-channels` | List bot's text channels (for picker) |

### `POST /api/moderation/discord-embeds/send` request body

```json
{
  "channelId": "<discord channel snowflake>",
  "embed": { /* EmbedData */ },
  "reactionRoles": [          // optional — see reaction-roles.md
    { "emoji": "🎮", "roleId": "<snowflake>" }
  ]
}
```

When `reactionRoles` is provided (max 20 entries), the bot adds the configured
reactions to the posted message and registers a reaction-role panel. See
[reaction-roles.md](./reaction-roles.md) for details.

Response: `{ data: { sent: true, messageId: "<snowflake>", reactionRoles: <count> } }`
