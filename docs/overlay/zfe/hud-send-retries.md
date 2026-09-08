# HUD send receipts and retry safety

The chat.v1 backend advertises `getAuthState.permissions.canRetryHudSend` for linked
identities. A compatible HUD can retry an ambiguous send using the **same** local
message ID in the native-preserved `targetUserId` member:

```text
FCMOUT/1;i=<local-message-id>;r=<URI-encoded-server-room>
```

IDs are 16–96 ASCII letters, digits, underscores or hyphens. The room is empty for
static channels; SERVER sends require the confirmed room (up to 128 characters).
The backend checks that room against authenticated membership before publishing a
new SERVER message. A completed receipt may still acknowledge delivery to the old
room after a world change; it never republishes the message in the new world.

The receipt key includes both authenticated relay device identity and linked FCM
account, never a client-supplied sender. Its fingerprint binds channel, exact
repaired body and pinned room. Redis `SET NX` chooses one sender across backend
instances. Duplicate completed requests replay the original response without
repeating governance, ingestion, history insertion or broadcast. Authentication
and current ban/mute checks still run. Both the RPC ACK and private subscriber receipt carry `q=<local-message-id>` in
`FCMHUD/1` inside `targetUserId`, preserving any cosmetic metadata. Live/history
messages retain their existing message-ID transport; the retry receipt reconciles
the local queued row. Because asynchronous xScal workers may discard RPC responses,
every authenticated outbox response is also pushed as a private `system` event
from sender `system`, with body `FCMACK/1;<URI-encoded full response JSON>` and the
same `targetUserId`. The HUD intercepts this body before chat rendering. Initial
results, completed receipt replays, pending/uncertain results and terminal errors
all use this path. Redis control fanout follows the authenticated device **and**
linked account across replicas; another device on the same account receives none.
These control events are never persisted as messages, added to server history or
sent to Discord. They can be lost during disconnection; retrying the same request
re-emits its stored result, so RPC delivery is not required. An invalid token
cannot produce a private receipt because no trusted subscriber identity exists. Reusing an ID with changed content returns `send_conflict`.

Receipts and incomplete claims remain for seven days. The current HUD expires its
queue after 30 minutes; compatible clients must always expire their queue within 24 hours and must never retry an expired item automatically. A
concurrent/incomplete operation returns `send_in_progress` for two minutes, then
`send_uncertain`. The latter requires checking history before manually submitting
a new message: an abandoned claim is **never** taken over automatically. Explicit
`rate_limited` rejections release the claim because those exits occur before any
queue/publish side effect; other deterministic rejections are cached.

This is retry deduplication, not an exactly-once transaction. Redis receipts,
static-message queue submission and SERVER publication are separate operations.
A process crash between delivery and receipt completion can leave delivery
uncertain; Redis data loss/failover can lose receipts. Static success continues to
mean durable queue acceptance, not completed database persistence or confirmed
Discord delivery. A Redis outage fails closed before a new retry-enabled send.
The legacy send path remains compatible and does not gain automatic ambiguous
retries without the negotiated capability.
