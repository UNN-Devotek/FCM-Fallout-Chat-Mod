# Discord Scheduled Events

FCM Scheduled Event mirroring is an always-on projection from Discord into the
existing FCM `Events` channel. Discord remains authoritative for event
creation, lifecycle, and native Interested state. FCM does not create events,
create channels, assign event roles, or infer attendance from chat/HUD input.

## Configuration and permissions

Set these values in the Dokploy environment for the bot deployment:

| Variable | Required behavior |
| --- | --- |
| `DISCORD_SERVER_ID` | Guild containing the source events |
| `DISCORD_EVENTS_CHANNEL_ID` | Explicit guild text channel receiving one announcement per source event |

The bot always requests `GuildScheduledEvents`. At gateway ready it validates the
configured guild/channel ownership and text permissions. Missing or ambiguous
configuration leaves event mirroring waiting for repair; the ordinary chat bridge
is not redirected to another channel.

The human authoring prerequisite is the existing `Event Creator` role
(`1546926647054311454` in production), with Create Events and Manage Events.
The event mirror never assigns this role and signup never changes roles. Audit
the bot's View Channel, Send Messages, Embed Links, Read Message History, and
Manage Events permissions separately from that human role. Manage Events is
required because the bot appends the announcement URL to the source event
description; Manage Messages is not required by this feature.

## Announcement contract

Each eligible source event gets one bot-authored embed in the configured
channel. Create and update notifications edit the known message; a missing
known message is recreated only for that event. Unrelated messages are never
overwritten. The embed contains:

- `Upcoming`, `Live`, `Ended`, `Canceled`, or `Deleted` status;
- event name, localized Discord timestamp(s), location when available;
- current native Interested count;
- bounded creator-authored summary, stable event code, and a validated native
  Discord event link;
- one `Open Discord Event` link button while the source event still exists.

The bot appends the following generated suffix to the source description after
the announcement message exists:

```text
<creator-authored description>

FCM event details [EVT-...]: <announcement message URL>
```

The generated suffix is replaced idempotently using stored mirror state. Creator
text has priority; if the combined description exceeds Discord's limit, creator
text is left unchanged and the working announcement URL remains in the mirror
for repair/retry.

## Native Interested synchronization

Discord's native Interested roster is the only attendance authority. The bot
consumes Scheduled Event User Add/Remove gateway notifications and reconciles
the subscriber endpoint at startup, reconnect, and a bounded five-minute
interval. Subscriber rows are keyed by `(mirrorId, discordUserId)` and may carry
an optional verified FCM user ID.

FCM projections expose only the shared count by default. Attendee names and
private identity data are not published. Overlay and HUD surfaces are
read-only: their only event action is opening Discord's native event page.
Authenticated overlay sessions may request a private viewer-state frame after
history; an unlinked FCM account receives `isViewerInterested: null`.

The shared WebSocket update is:

```json
{
  "type": "event:attendance-updated",
  "payload": {
    "eventCode": "EVT-...",
    "status": "Upcoming",
    "interestedCount": 6,
    "updatedFields": ["interestedCount"]
  }
}
```

## Lifecycle and terminal records

Discord `SCHEDULED` maps to `Upcoming`, `ACTIVE` to `Live`, `COMPLETED` to
`Ended`, `CANCELED` to `Canceled`, and a deleted source to `Deleted`.
Ended, Canceled, and Deleted records remain visible with their final Interested
count. Countdown and attendance mutation controls stop at the terminal state.
The bot never silently hides or auto-deletes a terminal FCM record.

Gateway deliveries are coalesced per scheduled-event ID. Reconciliation repairs
missing mirrors, announcements, FCM projections, and generated links without
mass-deleting or rewriting unrelated channel content. Transient failures are
logged and retried by the bounded reconciliation pass.
