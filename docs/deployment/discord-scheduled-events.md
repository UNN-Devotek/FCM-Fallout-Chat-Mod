# Discord Scheduled Events Deployment Runbook

This feature is an always-on Discord → FCM projection whenever the Discord bot is
running. Set the configured guild/channel and bot permissions before releasing
the code to production.

## Dokploy configuration

Set the following in the persistent environment store for the backend service;
do not edit only the generated checkout or running container:

```text
DISCORD_SERVER_ID=<production guild snowflake>
DISCORD_EVENTS_CHANNEL_ID=<production Events text-channel snowflake>
```

The bot token must belong to the application installed in that guild. The bot
requests the `Guild Scheduled Events` gateway intent at startup. The bot must be able to view the
guild/channel, send messages, embed links, read message history, and Manage
Events. Manage Events is required because the bot appends the announcement URL
to the source event description. Manage Messages is not required by this
feature. Do not grant or automate the human `Event Creator` role from this
feature.

## Safe rollout

1. Verify `DISCORD_EVENTS_CHANNEL_ID` belongs to `DISCORD_SERVER_ID` and is the
   intended existing Events channel. The backend never discovers channels by
   name or creates a channel.
2. Release the code and restart the bot. The bot validates the channel at gateway ready;
   invalid configuration fails only the event feature closed and logs the
   actionable guild/channel error.
3. Create one test event with the Event Creator role. Confirm exactly one embed,
   one FCM Events card, and one description suffix containing the working
   announcement URL.
4. Mark native Interested and Not Interested in Discord. Confirm the shared
   count and `event:attendance-updated` arrive in the overlay; verify no FCM
   Join/Leave control or role mutation exists.
5. Edit the event, then complete/cancel it. Confirm the existing announcement
   is edited, the FCM record remains visible as Ended/Canceled, and countdown/
   attendance mutation controls stop.
6. Restart the backend and confirm reconciliation repairs missing projections
   without duplicate announcements.

If the event channel is temporarily unavailable, repair the channel ID or bot
permissions and the periodic validation/reconciliation will recover without
redirecting the ordinary bridge. Existing mirrored terminal records remain in
FCM history.
