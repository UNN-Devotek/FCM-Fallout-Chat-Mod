# Shared chat flood protection

Human senders may submit eight messages in a rolling ten-second window. The ninth
attempt starts a 35-second cooldown shared across connected Discord channels,
dashboard/overlay channel chat, native HUD channel chat and Server chat (both native
and desktop bridge paths). This replaces the former three-messages-per-minute
rule; ordinary conversation has no minute quota.

Fresh flood episodes after a cooldown escalate the next wait to 70, 140, 280, then
300 seconds. The maximum is five minutes. Fifteen minutes without a new flood
violation resets this history; normal conversation during that period is allowed.
After each cooldown the sender gets a fresh burst. Routine rejected retries return
the existing deadline and do not add strikes or extend it.

The sixtieth counted send attempt in a rolling minute triggers a five-minute hard
cooldown, including attempts rejected during a shorter cooldown. It can escalate
that shorter wait once. Further attempts cannot move the hard-cooldown deadline;
continued extreme flooding after expiry may start another five-minute cooldown.
Only eligible human sends reaching this guard count; earlier authentication,
validation and transport flood guards still apply. Staff follow the same rule;
bot/webhook relay cards are exempt.

The backend owns this policy in `chatSlowmodeService.ts`. An atomic Redis Lua
operation uses Redis time and one short-lived `chat_slowmode:v2:discord:<discordId>`
key for linked identities. Accounts without Discord use
`chat_slowmode:v2:account:<userId>`. Changing channel, device, native provider or backend
replica does not reset the allowance. Channel-send handlers re-read the verified
account Discord identity instead of trusting the connection-time snapshot. Normal socket/server flood guards still apply.
Private messages and party chat retain their existing separate flood guards.

The versioned key isolates this policy from older backend writers during rollout;
the old three-message state expires separately and cannot overwrite adaptive
penalties. Redis retains at most eight burst timestamps and the most recent sixty
attempt timestamps per identity. Keys expire after their active window or penalty
history, at most fifteen minutes after the last flood violation unless new activity
needs a fresh sixty-second attempt window. All bot/backend replicas must finish
updating before the old rule is fully retired.

Channel and Server moderation calls select `spamPolicy: "shared-chat"` internally.
This replaces the legacy six-in-ten-seconds check and its one-hour spam mute on
these paths. AI/word filtering and configured content rules still run. PM, party
and message-edit moderation keep the default legacy policy. No client payload can
select or bypass moderation policy.

This is a submission allowance: ordinary channel text consumes a slot before
content moderation, so filtered ordinary submissions still count. Socket command
relays are checked after command resolution and the existing content filter;
private results and bot cards do not consume slots. Discord human posts in
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
show the local cooldown notice with the remaining seconds (up to 300) and retry
with the same receipt ID. Synchronous rejection, private receipts and asynchronous
ZFE completions defer this sender's existing queued chat retries until the supplied
deadline. Private giveaway controls remain available. Malformed or unbounded timing
uses the generic notice and existing backoff. The notice lives in the local prompt,
never in shared chat history.
Rate-limit rejections release the receipt claim before publication; completed
receipt replays do not consume another slot. Older HUD builds retain their generic
slow-down/retry notice; rebuilding the updated widget is required for the explicit
private cooldown wording. Both retry-capable and legacy paths in the updated
widget use the local prompt. No HUD asset update is required for enforcement.

## Regression coverage

`chatSlowmode.test.js` covers identity, wire status and fail-closed behavior.
`chatSlowmodeRedis.test.js` exercises the actual Lua script against an isolated
Redis service, including concurrent eight-message bursts, normal conversation
beyond three messages per minute, window/cooldown expiry, escalation/reset, bounded
recent-attempt history, hard-cap deadlines, rolling-deploy isolation and shared
client identity. CI supplies
`CHAT_SLOWMODE_TEST_REDIS_URL` from its Redis service so this suite runs in the
required backend Jest job. Locally, supply that variable or
`CHAT_SLOWMODE_TEST_REDIS_SOCKET` for an isolated Unix socket to run the Redis cases.
Adapter regressions cover Discord deletion/DM failure, ingestion rejection, HUD
retry timing and native/desktop Server rejection before publication.

The compiled Ruffle `cooldown` scenario runs on both xScal and ZFE. It checks
sender-local seconds-to-wait text, foreign receipt isolation, unchanged chat
records/outbound sends, retained retry queues, 70/140/280/300-second notices,
shared queue deferral and the non-retry notice path.
Pure outbox tests reject malformed or unbounded timing fields and never display
server-supplied HTML. Providers that omit retry timing receive the generic local
"You are in cooldown" notice.

Native acceptance remains required: with two accounts on each supported provider,
trigger the ninth-message cooldown from Discord and from HUD/overlay, verify the affected sender
sees the private notice and the other user receives no cooldown chat message, then
verify delivery resumes after the indicated deadline. Also verify repeated flood
episodes escalate, fifteen quiet minutes reset strikes, and extreme flooding starts
a bounded five-minute wait. This adaptive HUD candidate is native-unverified;
older HUDs keep their generic notice for waits exceeding their parser's bound.

Live Discord and Linux Electron results are recorded in
[the original hosted Dev acceptance report](../testing/chat-slowmode-dev-2026-10-05.md).
That report covers the superseded three-message rule, not adaptive-policy acceptance.

Discord application commands that publish human chat (including event shortcuts and
`/fcm command` channel relays) use this same shared budget before publication. A blocked
interaction receives an ephemeral cooldown reply and does not publish or send success
feedback. Private lookups and structured bot cards remain exempt.

The authenticated overlay/dashboard handlers also exempt handled private commands,
bot cards, and reports. Human command relays and unknown slash text that falls
through to ordinary chat still consume the shared allowance. A command rejected
before publication releases its per-command cooldown reservation, so a pending
HUD retry does not become a terminal “wait before using this command” response.
Native event announcements rejected by slowdown return `success: false` with
`rate_limited` and `retryAfterMs`, and release the receipt claim for a same-ID
retry. They never acknowledge or cache an unpublished announcement as successful.
