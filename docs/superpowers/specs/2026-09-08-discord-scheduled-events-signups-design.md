# SPEC — Discord Scheduled Events + FCM Signup Mirror

Status: Locked

Version: 0.1

Date: 2026-09-08

## Why

Community events are authored in one place but discovered and used across several surfaces, so members lack one dependable view of event timing, current participation, lifecycle changes, and attendance state. The goal is a single event experience that preserves the author's content, lets eligible members express interest, keeps participation state consistent, and remains understandable in both rich and text-only clients.

## Capabilities

CAP-001 — Event creators can publish a scheduled event that becomes discoverable with its original author content intact.

  ↳ Test: Create, edit, cancel, and delete one event; verify one discoverable announcement exists for each state and the author content is unchanged.

CAP-002 — Community members can view the event name, status, time, location, summary, Interested count, and public event link.

  ↳ Test: Open the event in each supported client at every lifecycle state; verify the same current public details are present or intentionally omitted.

CAP-003 — A community member can mark attendance through native event controls, and community surfaces mirror that state.

  ↳ Test: Mark one event Interested and then Not Interested in the native event UI; verify one add and one remove in the mirrored roster, with no duplicate subscriber.

CAP-004 — Community members can see current native attendance state without seeing another member's private identity.

  ↳ Test: Compare two accounts viewing the same event; verify each sees only their own Interested state and the shared count.

CAP-005 — Members can understand an event in both a rich card and a constrained text row.

  ↳ Test: Render the same event in the full card, compact feed item, and text-only row; verify status, timing, and participation remain recognizable within each layout.

CAP-006 — Event state remains coherent when an event is edited, starts, completes, is canceled, or is deleted.

  ↳ Test: Apply every lifecycle transition, including repeated and out-of-order notifications; verify all projections converge on one final state and terminal attendance is read-only.

CAP-007 — Maintainers can recover a partial or interrupted event publication without creating duplicates.

  ↳ Test: Interrupt publication after each externally visible step, restart reconciliation, and verify the missing step is repaired without modifying unrelated messages.

CAP-008 — Client surfaces remain read-only for attendance, including for unlinked, unauthenticated, and unauthorized users.

  ↳ Test: Open the event from each identity state; verify current attendance is visible when allowed, no native attendance is changed, and link guidance appears where identity is needed.

CAP-009 — Maintainers can operate the always-on projection with explicit guild, channel, permission, and identity configuration.

  ↳ Test: Start with valid configuration and with each required value missing or mismatched; verify valid startup and fail-closed invalid startup.

## Constraints

### Source, channel, and role boundaries

- The source of truth MUST be a Discord Scheduled Event. FCM MUST mirror it; FCM MUST NOT become a competing event-authoring surface in this release.
- The mirror MUST use the existing FCM Events channel and its existing static channel mapping. A second FCM event channel MUST NOT be introduced for the MVP.
- The bot MUST use the explicitly configured Discord Events channel ID. It MUST NOT discover a channel by name or create a channel automatically.
- The production Event Creator role is the human authoring prerequisite: role name Event Creator, role ID 1546926647054311454, permissions Create Events and Manage Events.
- The Event Creator role MUST NOT be assigned automatically by the event feature.
- Signup MUST NOT create, remove, or mutate a Discord role.
- The bot's permissions MUST be audited separately from the Event Creator role's permissions.
- The ordinary inbound message relay MUST NOT be the publication path for bot-authored event announcements.
- Every mirror lookup MUST be scoped by guild ID and scheduled-event ID.

### Discord announcement contract

The bot MUST publish one bot-authored embed in the configured Events channel for each eligible source event. It MUST edit that message on source updates rather than posting a second announcement.

The announcement MUST contain:

- Status: Upcoming, Live, Ended, Canceled, or Deleted.
- Event name.
- Start time, with a localized Discord timestamp where available.
- End time when the source event has one.
- Location or voice channel name when available.
- Current Discord Interested count.
- A bounded summary of the creator-authored description.
- Stable event code.
- Native Discord event URL when available.
- A valid source image only when the URL is allowed and renderable.

The target visual hierarchy is:

    +----------------------------------------------------------+
    | ◈ EVENT · UPCOMING                                      |
    |   Moonshine Jamboree                                    |
    |                                                          |
    | WHEN       Sep 8, 2026 · 8:00 PM – 9:00 PM              |
    | WHERE      Appalachia                                    |
    | INTERESTED  6                                             |
    |                                                          |
    | Join the group for the public event.                     |
    |                                                          |
    | [Open Discord Event]                                     |
    +----------------------------------------------------------+

The component contract MUST be:

- Native Interested and Not Interested controls remain on the Discord Scheduled Event itself.
- Open Discord Event opens that native event page so the member can change attendance there.
- The bot announcement MUST NOT pretend its own button can change native attendance.
- Terminal events show no FCM attendance mutation controls.
- Any link button MUST contain only the validated event URL.

The MVP MUST use one Open Discord Event link button rather than Join/Leave component buttons or a generic reaction-role panel. The official Discord API documents subscriber-list reads and subscriber add/remove gateway notifications, but does not document a bot endpoint for marking an arbitrary member Interested. Native attendance therefore flows Discord → FCM; FCM does not write attendance back to Discord.

Reference: [Guild Scheduled Event API](https://docs.discord.com/developers/resources/guild-scheduled-event) and [Gateway event reference](https://docs.discord.com/developers/events/gateway-events).

### Description preservation and event-details link

The bot MUST make the FCM event details announcement discoverable from the Discord event description.

The generated suffix MUST have this visible form:

    <creator-authored description>

    FCM event details [EVENT-CODE]: <announcement message URL>

The implementation MUST:

- Preserve creator-authored bytes before the suffix on the first append.
- Store enough state to identify and replace only the generated suffix.
- Never duplicate the generated suffix.
- Never rewrite unrelated creator text.
- Never write a placeholder or dead URL after an announcement-post failure.
- Retry suffix insertion after the announcement exists.
- Use a deterministic length-limit policy.

Length-limit policy:

- Creator-authored content has priority over generated content.
- The implementation MUST reserve space for the generated suffix before writing it.
- If the combined text exceeds Discord's limit, it MUST leave creator text unchanged and mark the mirror degraded.
- The degraded state MUST include an actionable repair record containing the working announcement URL.

### Native attendance authority and identity

Discord's native Interested state MUST be authoritative. FCM stores a mirror of Discord's current subscriber set.

The synchronization contract MUST:

- Consume Discord Scheduled Event User Add and User Remove notifications.
- Reconcile against Discord's Get Guild Scheduled Event Users endpoint at startup, reconnect, and bounded intervals.
- Store one current subscriber record per mirror and Discord user.
- Store Discord user IDs as strings.
- Store a linked FCM user ID when available; allow it to be null.
- Store subscribed and last-synced timestamps in UTC.
- Enforce uniqueness on mirror ID plus Discord user ID.
- Derive the public count from the reconciled native subscriber set.
- Expose count and viewer-specific Interested state, not attendee names, in default projections.
- Treat overlay and HUD attendance as read-only.
- Link an FCM user to a native subscriber only when the Discord identity is verified.
- Never infer native attendance from an FCM button, role, chat message, or HUD command.
- Never reassign one Discord user's native attendance to another Discord identity.

Recommended shared update message:

    event:attendance-updated
      eventCode
      status
      interestedCount
      updatedFields

Authenticated sessions MAY receive a viewer-specific attendance update:

    event:attendance-viewer
      eventCode
      isViewerInterested

isViewerInterested MUST be computed for the authenticated viewer. It MUST NOT be stored in shared event metadata or a public cache.

Exact wire names MUST be reconciled with the existing WebSocket protocol before implementation and documented in the same change.

### Shared overlay presentation

The overlay MUST use the existing shared ChatOverlay component. A second event-only overlay component is prohibited.

Event visibility MUST be compact in both the Events view and aggregate feeds. Reuse the existing ChatEmbedCard shell, spacing, fields, and action row already used for Nuke codes and related structured cards.

Compact card:

    + EVENT · UPCOMING                       [OPEN ↗] +
    | ◈ Moonshine Jamboree                         |
    | WHEN       Sep 8 · 8:00 PM – 9:00 PM          |
    | INTERESTED 6                                  |
    |                                              |
    | [OPEN DISCORD EVENT]                          |
    +----------------------------------------------+

The compact card MUST:

- Use the existing event/activity accent token and card treatment.
- Use semantic styling for Upcoming, Live, Ended, Canceled, and Deleted.
- Keep title and status visible at the narrowest supported width.
- Show local time with UTC fallback.
- Show a relative countdown only for upcoming events with a valid client clock.
- Show native Interested count as the participation signal.
- Show a bounded summary only when space permits.
- Show Open Discord only when the URL is valid.
- Use a native, keyboard-operable link button with visible focus.
- Wrap the action instead of clipping it.
- Show a read-only label such as You are Interested when the authenticated viewer is a native subscriber.
- Announce attendance synchronization and lifecycle changes through the existing accessible feedback path.

Overlay MUST NOT show Join, Leave, or FCM-only RSVP controls. A member changes attendance through Discord's native event page.

Action states MUST be:

- Open Discord Event when a valid event URL exists.
- You are Interested when the linked viewer is in the native subscriber set.
- Not Interested when the linked viewer is not in the native subscriber set.
- Unlinked when viewer-specific native state cannot be associated with a Discord identity.
- Read-only status after completion, cancellation, or deletion.
- Read-only in public mode.

The shared event metadata projection MUST contain:

- kind: scheduled_event
- eventCode
- scheduledEventId
- name
- status
- startUtc
- endUtc
- location
- descriptionSummary
- announcementUrl
- discordEventUrl
- interestedCount

isViewerInterested MUST be computed for the authenticated requesting viewer and MUST NOT be stored in shared event metadata or a public cache.

When an event appears in an aggregate feed outside the Events view, the compact projection MUST use the existing inline pattern and MUST NOT repeat the full card:

    ◈ Moonshine Jamboree [EVENT] · starts 8:00 PM · 6 interested · [OPEN]

The aggregate projection MAY expose one Open Discord action. It MUST remain compact and MUST NOT expose FCM-only attendance controls.

Public mode MUST remain read-only, MUST NOT open the authenticated event mutation path, and MUST NOT expose private account or attendee identity data.

### HUD presentation

The optional HUD mod MUST use the existing FCMHUD/1 feed and current FCMChatWidget row geometry. Event visibility MUST remain compact. The MVP MUST NOT add clickable HUD buttons, a new BA2/SWF wire format, game-memory access, or a second event panel.

Required row forms:

    [EVENTS] [EVENT] FCM: Moonshine Jamboree | 20:00 UTC | 6 interested

    [EVENTS] [EVENT] FCM: Moonshine Jamboree | LIVE | 6 interested

    [EVENTS] [EVENT] FCM: Moonshine Jamboree | ENDED | 6 interested

    [EVENTS] [EVENT] FCM: Moonshine Jamboree | CANCELED

HUD rows MUST:

- Appear in the existing Events tab and normal history/live ordering.
- Use the existing Events channel and feed color.
- Put a stable EVENT marker before the source label.
- Preserve status and time before truncating a long name.
- Use the existing safe-character escaping.
- Respect the existing 70-character server line budget.
- Use the same formatter for live delivery and history.
- Exclude raw Discord markup, mentions, button syntax, and unescaped delimiters.
- Remain informational. HUD MUST NOT mutate native attendance.
- Include event code only when it fits within the line budget; code supports lookup in Discord but is not an RSVP control.

The MVP MUST NOT expose /event join or /event leave commands. A future command may open or deep-link to the native event page, but it MUST NOT claim to change Discord attendance unless Discord documents a supported bot or client flow.

### Lifecycle contract

The source lifecycle MUST converge through these states:

    Discord create
        -> mirror created
        -> announcement posted
        -> FCM event message posted
        -> description link appended

    Discord native Interested
        -> subscriber add/remove notification
        -> native subscriber mirror updated
        -> Interested count and viewer state broadcast

    Discord update
        -> mirror updated
        -> announcement edited
        -> FCM projection updated
        -> generated link reconciled if needed

    Discord start
        -> status becomes Live
        -> announcement and FCM projection update

    Discord complete
        -> source status becomes COMPLETED
        -> public status becomes Ended
        -> final Interested count retained
        -> attendance display becomes read-only

    Discord cancel
        -> source status becomes CANCELED
        -> public status becomes Canceled
        -> attendance display becomes read-only

    Discord delete
        -> public status becomes Deleted
        -> final announcement retained when possible
        -> attendance display becomes read-only

Public status mapping MUST be:

- Discord SCHEDULED → Upcoming.
- Discord ACTIVE → Live.
- Discord COMPLETED → Ended.
- Discord CANCELED → Canceled.
- Deleted source event → Deleted.

Plain-language definition: a terminal event is an event that cannot transition to another active state. In this feature, that means Ended, Canceled, or Deleted. Terminal does not mean hidden; it means the card remains visible as a final read-only record, with no countdown and no attendance mutation.

The service MUST:

- Listen for create, update, delete, and available subscriber lifecycle notifications.
- Treat native subscriber add/remove notifications as the only attendance mutations.
- Reconcile active and upcoming source events at startup and after reconnect.
- Coalesce concurrent updates for one event.
- Use bounded retries for transient external and database failures.
- Prevent a stale event or subscriber update from reactivating a terminal event.
- Retain terminal records visibly; this feature MUST NOT auto-hide or auto-delete them.
- Stop countdowns and reject attendance mutations for terminal events.

### Reconciliation and failure policy

Reconciliation MUST run at startup and through a bounded interval or explicit maintenance command. It MUST:

- Fetch active and upcoming events for the configured guild.
- Compare source events, mirrors, announcements, and FCM event messages.
- Repair missing mirrors, announcements, FCM messages, and generated links.
- Mark mirrors for source events that no longer exist.
- Avoid re-posting when a known announcement message ID is still valid.
- Report permission, rate-limit, invalid-channel, malformed-state, and authorization failures.
- Never mass-delete messages or overwrite unrelated channel content.

Failure behavior MUST follow this table:

| Failure | Required behavior |
| --- | --- |
| Missing feature configuration | Fail closed, log actionable configuration error, do not write elsewhere |
| Missing scheduled-events intent | Do not start live mirroring; surface startup error |
| Missing channel permission | Mark integration degraded and retry at a bounded interval |
| Discord rate limit | Respect retry metadata, coalesce pending sync, never duplicate |
| Discord 401 or 403 | Mark degraded, alert a maintainer, do not loop rapidly |
| Announcement post succeeds but DB write fails | Reconcile by event ID and message marker before posting again |
| DB write succeeds but announcement edit fails | Keep last known projection, mark pending sync, retry |
| Announcement message deleted | Recreate only the known event announcement and update its message ID |
| FCM message missing | Recreate the event projection and update the mirror |
| Event deleted at source | Mark mirror Deleted and retain a read-only final record |
| User opens an event after terminal transition | Return current terminal state; keep attendance read-only |
| User has no linked Discord identity | Hide viewer-specific state or return link-account guidance; never infer attendance |
| Malformed source event | Reject unsafe fields, record validation failure, do not publish partial data |
| Duplicate gateway delivery | Treat as an idempotent no-op |

### Persistence contract

The implementation MUST add an event mirror and subscriber record with idempotent migrations.

DiscordEventMirror fields:

- id
- guildId
- scheduledEventId
- eventCode
- announcementChannelId
- announcementMessageId
- fcmMessageId
- announcementUrl
- generatedDescriptionLink
- sourceStatus
- finalInterestedCount
- sourceFingerprint
- lastSyncedAt
- createdAt
- updatedAt

Mirror constraints:

- Unique guildId plus scheduledEventId.
- Event code collision handling MUST be deterministic and stable.
- Announcement message ID MUST be scoped to the configured channel.
- Discord identifiers MUST be stored as strings.
- Source fingerprint MUST permit no-op update detection.

DiscordEventSubscriber fields:

- mirrorId
- discordUserId
- linkedFcmUserId, nullable
- subscribedAt
- lastSyncedAt

Signup constraints:

- Composite primary key on mirrorId plus discordUserId.
- Foreign key to the mirror.
- Rows represent the current native subscriber set. A native remove event removes or deactivates the row.
- Cleanup MUST preserve the terminal Interested count before deleting or archiving subscriber rows.
- Attendee display names are not required for the MVP.

### Configuration and permission contract

Configuration MUST include:

- DISCORD_EVENTS_CHANNEL_ID, pointing at the existing Discord Events channel.
- Existing DISCORD_SERVER_ID.
- Existing DISCORD_TOKEN.

When the bot starts, it MUST:

- Request the Discord Gateway scheduled-events intent.
- Validate configured guild and channel ownership at startup.
- Verify the channel is the intended Events channel.
- Fail closed on missing or ambiguous configuration.
- Avoid creating channels or permissions automatically.

The bot MUST have only the permissions needed for its actual actions:

- View Channel.
- Send Messages.
- Embed Links.
- Read Message History.
- Manage Events where required by the Discord API.
- Manage Messages only if the approved repair policy needs it.

### Security, privacy, and EULA boundaries

- All Discord snowflakes MUST be treated as untrusted external identifiers.
- Every component, command, and socket action MUST verify guild, event, status, and caller context.
- Public projections MUST contain count but not attendee identity.
- Viewer-specific state MUST be computed after authentication.
- The default overlay MUST remain EULA-safe: no game-memory reads, game-file changes, code injection, or port scanning.
- The HUD mod MUST remain an optional separate BA2 track, never bundled with or required by the default overlay.
- The HUD MUST use only the existing sanctioned FCMBridge/ZFE transport.
- Event mirroring MUST NOT add game-state reads, memory inspection, injection, or network scanning.

### Locked decisions

Locked decisions:

- D-01 — Native Discord Interested is authoritative. FCM mirrors subscriber add/remove notifications and reconciles the native subscriber list. FCM surfaces do not mutate attendance.

- D-02 — Event visibility is compact in the overlay and HUD. Overlay reuses the existing Nuke-code-style ChatEmbedCard; HUD uses the existing compact feed row.

- D-03 — Terminal event records remain visible. Discord COMPLETED displays as Ended; Discord CANCELED displays as Canceled; a deleted source event displays as Deleted. Final count remains visible; countdowns and attendance mutations stop.

No implementation plan may silently change D-01, D-02, or D-03.

## Non-goals

- Replacing the existing event-authoring surface.
- Creating a new community channel automatically.
- Creating a new role for each event.
- Assigning roles when a member joins or leaves.
- Letting client-only controls mutate native attendance.
- Publishing attendee names, avatars, or private RSVP notes by default.
- Allowing anonymous attendance changes from the overlay or in-game feed.
- Adding clickable controls to the text-only client in the MVP.
- Adding a second event renderer instead of extending the shared chat presentation.
- Reading game memory or game state.
- Modifying game files from the default client.
- Installing or bundling the optional in-game client with the default client.
- Exposing private parties, account data, or moderation data through event projections.
- Backfilling arbitrary historical events without an explicit migration policy.
- Adding a side-channel event-authoring admin interface in the first release.

## Success Signal

SS-1: 100% of eligible event creations in the acceptance suite produce exactly one discoverable announcement with preserved author text and a current Interested count within 60 seconds.

SS-2: At least 95% of completed native Interested or Not Interested changes show matching participation state and count across all supported surfaces within 5 seconds.

SS-3: 100% of lifecycle, restart, duplicate-delivery, and repair scenarios in the acceptance suite finish with no duplicate announcement and no active attendance controls on terminal events.

### Acceptance criteria

The feature is ready for implementation handoff when:

- One Discord event created by an Event Creator produces one embed in the configured Events channel.
- The original Discord description remains intact and contains one stable FCM event-details link.
- Native Interested and Not Interested changes update the count and viewer state.
- The same native attendance state is reflected in the authenticated overlay.
- The HUD shows an escaped compact row without introducing a second attendance system.
- Edits, start, completion, cancellation, deletion, restart, duplicate delivery, and message repair have deterministic outcomes.
- Public mode is read-only and does not expose viewer-specific state.
- No event-specific roles, game-memory access, or new HUD wire format are introduced.

### Test matrix

Backend Jest coverage MUST include:

- Event projection and lifecycle status mapping.
- Stable event-code generation and guild scoping.
- Description-link preservation and idempotent replacement.
- Mirror upsert and duplicate gateway delivery.
- Native subscriber upsert/remove, count reconciliation, and terminal read-only behavior.
- Component custom-ID parsing and authorization.
- Retry and reconciliation behavior.
- Bot-authored announcement isolation from ordinary message relay.
- Public projection exclusion of attendee identity and viewer-only fields.

Admin dashboard Vitest coverage MUST include:

- Event metadata normalization.
- Full ChatEmbedCard rendering for every state.
- Compact ChatInlineEmbed rendering.
- Open Discord, linked/unlinked viewer state, and terminal read-only states.
- Keyboard focus and activation.
- Narrow responsive layout.
- Public-mode lockdown.
- Viewer-specific state isolation.

HUD coverage MUST include:

- Event row formatting for upcoming, live, ended, canceled, and deleted states.
- 70-character budget behavior.
- Safe-character escaping and no double escaping.
- Live/history parity.
- Native subscriber add/remove handling and linked-identity projection.

CI MUST run the new backend, dashboard, and HUD tests in existing required jobs or add the smallest focused job and include it in the required CI Summary gate.

### Manual smoke test

Against a non-production guild or an explicitly approved production maintenance window:

1. Create an event with the Event Creator role.
2. Verify one embed appears in the configured Events channel.
3. Verify the description retains creator text and contains one FCM event-details link.
4. Mark Interested in Discord; verify count and overlay state.
5. Mark Not Interested in Discord; verify count and Discord embed state.
6. Inspect the compact Events card and HUD row; verify placement, wrapping, escaping, and native count.
7. Edit time and description; verify the existing announcement and projections update.
8. Cancel or complete the event; verify Canceled or Ended status, read-only state, and retained final count.
9. Restart the bot; verify native subscriber reconciliation produces no duplicates.
10. Delete the announcement and run reconciliation; verify only the known event message is repaired.

### Implementation sequence

1. Add the scheduled-events intent, configuration validation, and startup validation.
2. Add mirror and subscriber persistence with idempotent migrations.
3. Implement pure projection, description-link, event-code, and HUD-formatting functions.
4. Implement lifecycle and native subscriber mirroring.
5. Implement Discord event link components and subscriber reconciliation.
6. Extend the shared overlay metadata and card/inline projections.
7. Add the compact HUD row through the existing FCMHUD/1 path.
8. Add tests and CI coverage in the same change.
9. Update documentation and run the manual smoke test.

### Documentation changes required with implementation

The implementation MUST update these areas in the same change:

- docs/discord/README.md for permissions, intent, configuration, and Event Creator workflow.
- A new docs/discord/scheduled-events.md for lifecycle, announcement format, native Interested synchronization, and reconciliation.
- docs/frontend/chat-overlay.md for event metadata, card states, aggregate projection, and public-mode behavior.
- docs/realtime/websocket-protocol.md for attendance and event-update messages.
- docs/realtime/hud-push.md for event row formatting and HUD commands.
- docs/database/schema.md and migration notes for mirror and subscriber records.
- The relevant backend service reference for configuration and error behavior.
- The deployment runbook for enabling the production gate and validating the configured channel.

### Handoff state

Current baseline:

- Discord-native Interested synchronization.
- Compact event cards in the overlay and compact event rows in the HUD.
- Ended, Canceled, and Deleted records remain visible and read-only.

Spec is locked. Proceed to implementation planning.
