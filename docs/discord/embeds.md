# Discord Bot — Embed Builder

Admins compose rich Discord embeds from the dashboard (CHAT → EMBEDS tab),
save them as reusable templates, and post them to any guild text channel via
the bot. Embeds can also configure reaction roles at send time.

**Source files:**
- Domain service: [`backend/src/services/discordEmbedService.ts`](../../backend/src/services/discordEmbedService.ts) — validation, preview, template CRUD, send/reaction-role orchestration, and audit
- Discord context service: [`backend/src/services/discordContextService.ts`](../../backend/src/services/discordContextService.ts) — text channels, assignable roles, and cached custom emoji metadata
- Discord transport: [`backend/src/services/discordService.ts`](../../backend/src/services/discordService.ts) — canonical `postEmbed` and `buildEmbed` implementation
- Controller: [`backend/src/controllers/moderationController.ts`](../../backend/src/controllers/moderationController.ts)
- Routes: [`backend/src/routes/moderation.ts`](../../backend/src/routes/moderation.ts)
- Managed image service: [`backend/src/services/embedAssetService.ts`](../../backend/src/services/embedAssetService.ts)

---

## Managed embed images

`POST /api/moderation/discord-embed-assets/import` lets owners and admins import an HTTPS image URL.
Its request body is `{ "sourceUrl": "https://…", "confirm": true }`; the explicit confirmation is
required and rejected before any network fetch or object-store write when it is absent or false.
The backend rejects URL credentials, non-default ports, private/reserved DNS answers, DNS rebinding,
more than three redirects, compressed responses, downloads over 10 MiB, and content that does not
sniff as PNG, JPEG, WebP, or GIF. Fetches have a 15-second total deadline. Accepted bytes are SHA-256
deduplicated in object storage and returned as an immutable same-origin URL under
`/embed-assets/:id/:digest.:ext`; request paths are never translated directly into object keys.

The OAuth MCP also provides `fcm_asset_upload` for direct base64 uploads. It accepts the four embed
image formats plus PDF, UTF-8 text, CSV, and JSON up to 10 MiB. Images use the same immutable public
URL and can be placed in embeds. Non-image files are served with forced-download, `nosniff`, and
sandbox headers; HTML, SVG, arbitrary binaries, MIME mismatches, and invalid text/JSON are rejected.
Object creation uses `If-None-Match: *`, so concurrent imports converge on one physical object. If
the digest is new, the importer first claims its unique metadata row as `pending`. Other importers
never adopt or serve that pending claim: they return an in-progress conflict until its owner marks it
`ready`. On failure, the owner atomically removes only its pending row and deletes storage only when
its request created the object. Public serving filters to `ready`, eliminating publication and cleanup
timing windows.
Pending claims carry a two-minute lease and an unguessable ownership token. After expiry, one caller
can atomically take over by matching the previous token and expiry. Every publish and cleanup query
also matches the current token, so a stale worker cannot mutate the replacement claim. A takeover
uses the same conditional object PUT, allowing recovery when the crashed owner already uploaded bytes.

The original host is retained for attribution and auditing, but URL paths, queries, credentials, and
image bodies are not persisted in metadata.

In the dashboard embed editor, each author-icon, thumbnail, main-image, and footer-icon URL field
keeps accepting a URL directly for previewing. Selecting **Import** sends that field's URL to the
managed-image endpoint for validation and storage, then replaces only that field with the returned
FCM public URL. Each field reports its own import progress or a safe, actionable error; errors never
display source URL credentials or query strings. A rejected import can be retried without clearing
the editor or changing the other image fields. Send and save actions remain disabled while an import
is active. Editing its field, selecting **New Embed**, or loading a template invalidates the pending
result, so a late response cannot overwrite newer editor state.

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
| All embed text combined (excluding `content`) | 6000 chars |
| URL fields | 2048 chars; absolute `http` or `https` only |

Known `EmbedData` properties are validated by type as well as size: text and URL
fields must be strings, `timestamp` and `fields[].inline` must be booleans, and a
numeric color must be an integer between `0` and `0xFFFFFF`. Unknown properties
are retained when a valid template is stored for forward compatibility, but are
not included in the canonical preview or Discord payload.

---

## Service functions

### `discordEmbedService`

This is the shared domain boundary for dashboard and MCP callers. Its CRUD
operations validate templates but preserve the submitted JSON exactly, including
omitted optional values and forward-compatible properties. `preview(data)` is a
separate, pure operation that returns a canonical `EmbedData` projection plus
warnings without writing to the database or Discord. `send(...)` delegates final
rendering to the single `discordService` embed builder and optional panel creation
to `reactionRoleService`.

### `discordContextService`

Provides the bot-visible text channels, assignable roles, and custom guild emoji.
Internal/MCP emoji records contain `id`, `name`, `animated`, Discord `tag` (for
example `<:vaultboy:123...>`), and the Discord CDN `url`. The public
`GET /api/discord-emojis` contract intentionally omits `tag` and continues to
return only `id`, `name`, `animated`, and `url`, with `stale: true` when the bot
cache is unavailable.

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

### `postReleaseAnnouncement(version, releaseNotes, hudMod?, { target, suppressNotifications? })` — `discordService.ts`

Posted to the **Updates** channel (`DISCORD_UPDATES_CHANNEL_ID`) by `publishRelease`
on every release. It is a **required** publish step — if it fails after retries the
publish 502s and no release is recorded.

- **Pings only opt-in update roles.** `target` is required: `overlay` mentions
  `OVERLAY_UPDATE_NOTIFICATION_ROLE_ID`, `hud` mentions
  `HUD_MOD_UPDATE_NOTIFICATION_ROLE_ID`, and `both` mentions both. The message
  uses `allowedMentions: { parse: [], roles: [...] }`; it never enables
  `@everyone` or `@here`. Missing target role configuration fails the publish
  before a release is recorded. `suppressNotifications: true` retains the
  visible role mention while setting Discord's Suppress Notifications flag.
- **Target-specific title and downloads.** The title explicitly says Overlay
  Update, HUD Mod Update, or Overlay + HUD Mod Update. HUD-only notices omit
  desktop-installer links; overlay-only notices omit the HUD package link.
- **Download field** — direct 🪟 Windows ZIP / 🐧 Linux AppImage / Linux `.deb` links, the
  Linux ZIP with install docs, the Download-page link, and the versioned **FCM HUD Mod ZIP**
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
| `id` | Integer PK | |
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
| `POST` | `/api/moderation/discord-embed-assets/import` | Confirm, validate, and store an external image URL |

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
reactions to the posted message and registers a reaction-role panel. Before
anything is posted, every role is checked against the reaction-role policy
(no configured staff/access/supporter roles, no moderation permissions, nothing
at or above the sender's highest Discord role); a refused role fails the send
with a readable reason and no embed is posted. See
[reaction-roles.md](./reaction-roles.md) for details.

Response: `{ data: { sent: true, messageId: "<snowflake>", reactionRoles: <count> } }`
## MCP management

Authorized production MCP clients can list, inspect, preview, create, replace, and delete embed templates, import remote HTTPS images into the FCM object store, and send an embed with optional reaction-role mappings. Write operations require the `fcm:discord:write` OAuth scope and `confirm: true`; reads require `fcm:read`.

Use `fcm_discord_context_get` immediately before composing reaction roles. It returns stable Discord channel, assignable-role, and custom-emoji IDs. Sending performs the same checks again and resolves custom emoji names/animation from the bot's current guild context, so stale or unassignable selections fail closed.

Reaction-role panel creation is strict after the message is posted: Discord must accept every configured reaction. If any Unicode or custom emoji is rejected (including an emoji deleted during the send), the panel database/cache entry is removed and message reactions are cleared best-effort. The posted message remains, and MCP reports `mutation_partially_applied` with its message ID instead of claiming success or retrying the send.
