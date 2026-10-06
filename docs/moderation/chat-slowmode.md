# Shared chat slowmode

Human senders may submit three messages in a rolling 60-second window. The fourth
attempt is rejected and starts a 35-second cooldown shared across connected
Discord channels, dashboard/overlay channel chat, native HUD channel chat and
Server chat (both native and desktop bridge paths). Attempts during cooldown do
not extend it. After cooldown expires, the sender gets a fresh burst. Staff follow
the same rule; bot/webhook relay cards are exempt.

The backend owns this policy in `chatSlowmodeService.ts`. An atomic Redis Lua
operation uses Redis time and one short-lived `chat_slowmode:discord:<discordId>`
key for linked identities. Accounts without Discord use
`chat_slowmode:account:<userId>`. Changing channel, device, native provider or backend
replica does not reset the allowance. Channel-send handlers re-read the verified
account Discord identity instead of trusting the connection-time snapshot. Normal socket/server flood guards still apply.
Private messages and party chat retain their existing separate flood guards.

This is a submission allowance: valid channel submissions consume a slot before
content moderation, so filtered submissions still count. Discord human posts in
mapped channels count even if their content is later trimmed or rejected. Native
control traffic (roster, authentication, history, browser/settings controls),
receipt replays and server heartbeats do not consume chat slots. If Redis cannot
validate the allowance, new sends fail closed with a five-second retry notice.

## Discord behavior and permissions

The bot checks every channel resolved by the relay mappings and the configured
default relay channel. Unrelated Discord channels are unaffected. It does not
change Discord's native channel slowmode setting, which applies a delay after
every message rather than a burst allowance.

Discord delivers typed-message events after the post is visible. A blocked post
is deleted and the author is privately DMed "You are in cooldown" with the
remaining wait. Typed Discord messages do not support ephemeral channel replies;
this notice is a DM, never a public channel post. Human posts containing the
relay echo watermark still undergo cooldown checks before echo suppression. **Manage Messages**
is required in every connected channel to remove those posts. Closed DMs or
missing deletion permission are logged; neither failure permits relay to the
HUD/overlay. This is not a guild-wide timeout and does not restrict unrelated
Discord conversation.

## Client feedback

Dashboard/overlay sends receive `rate:status` with `scope: "chat"`, `remaining: 0`
and the actual `retryAfterMs`, followed by an `error` with a seconds-to-wait notice.
The shared ChatOverlay displays a sender-only error toast: "You are in cooldown.
Please wait 35 seconds before sending another message." It is never broadcast,
stored as chat history or relayed to other users. Server bridge sends use
the same frames. Backend enforcement remains authoritative after reconnect.

HUD sends receive the existing `rate_limited` code with explanatory `message` and
additive `error.retryAfterMs`. Updated retry-capable HUDs keep the queued message,
show the local cooldown notice with the remaining seconds and retry with the same
receipt ID. The notice lives in the local prompt, never in shared chat history.
Rate-limit rejections release the receipt claim before publication; completed
receipt replays do not consume another slot. Older HUD builds retain their generic
slow-down/retry notice; rebuilding the updated widget is required for the explicit
private cooldown wording. Both retry-capable and legacy paths in the updated
widget use the local prompt. No HUD asset update is required for enforcement.

## Regression coverage

`chatSlowmode.test.js` covers identity, wire status and fail-closed behavior.
`chatSlowmodeRedis.test.js` exercises the actual Lua script against an isolated
Redis service, including concurrent sends, shared client identity, window expiry,
cooldown expiry, isolation and retries that cannot extend the timer. CI supplies
`CHAT_SLOWMODE_TEST_REDIS_URL` from its Redis service so this suite runs in the
required backend Jest job. Locally, supply that variable to run the Redis cases.
Adapter regressions cover Discord deletion/DM failure, ingestion rejection, HUD
retry timing and native/desktop Server rejection before publication.

The compiled Ruffle `cooldown` scenario runs on both xScal and ZFE. It checks
sender-local seconds-to-wait text, foreign receipt isolation, unchanged chat
records/outbound sends, retained retry queues and the non-retry notice path.
Pure outbox tests reject malformed or unbounded timing fields and never display
server-supplied HTML. Providers that omit retry timing receive the generic local
"You are in cooldown" notice.

Native acceptance remains required: with two accounts on each supported provider,
trigger a cooldown from Discord and from HUD/overlay, verify the affected sender
sees the private notice and the other user receives no cooldown chat message, then
verify delivery resumes after 35 seconds. The updated HUD source has not been
installed or published; existing packaged HUDs retain their older generic notice.

Live Discord and Linux Electron results are recorded in
[the hosted Dev acceptance report](../testing/chat-slowmode-dev-2026-10-05.md).

Discord application commands that publish human chat (including event shortcuts and
`/fcm command` channel relays) use this same shared budget before publication. A blocked
interaction receives an ephemeral cooldown reply and does not publish or send success
feedback. Private lookups and structured bot cards remain exempt.
