# FCM integration with ZFE `chat.v1`

This document describes the current FCM adapter for ZFE's `chat.v1` API. It is
used by the optional `FCMChatWidget.ba2` HUDModLoader widget; it does not change
the EULA-safe desktop overlay.

## Boundaries

- The widget uses ZFE's sanctioned outbound API only: `chat.v1.connect`,
  `chat.v1.pollEvents`, `chat.v1.sendMessage`, `chat.v1.subscribe`, and
  `chat.v1.getAuthState`.
- It reads only data already published to the game HUD by `BSUIDataManager`.
  It does not read game memory, inject code, modify game files at runtime, or
  scan networks/ports.
- The backend route is `wss://<host>/relay`. `/zfe-relay` is not a relay route.
- `FCMChatWidget.ba2` is an explicit, user-installed mod. The Electron overlay
  remains the default non-mod track.

## Connection and authentication

The backend upgrade router dispatches `/relay` to `relayHandler`. A ZFE client
registers or resumes with an opaque relay token; `verifyToken` establishes the
relay `userId`, linked-account state, and display data. Every operation derives
its actor from this verified token, never from a client-supplied ID.

`getAuthState` is used by the widget to show authenticated chat or its limited,
receive-only linking state. The token can be linked after a web device-code flow;
the normal relay event flow then refreshes the widget state.

Successful relay-token verification uses a short-lived in-process cache keyed by a one-way token
digest, while repeated invalid-token Argon2 checks are throttled. The cache is invalidated on
token link, revoke, or display-name update. This reduces reconnect load without exposing the raw
token in logs or cache keys.

## Operations

| Operation | Purpose |
| --- | --- |
| `chat.v1.getRuntimeInfo` | Capability check (`zfe-chat-online-v1`) before use |
| `chat.v1.connect` | Register/resume and get initial state |
| `chat.v1.pollEvents` | Cursor-based event polling |
| `chat.v1.subscribe` | Register a live subscriber and enqueue bounded static/current-world history after its initial cursor |
| `chat.v1.sendMessage` | Send a static-channel message or a reserved server control |
| `chat.v1.getAuthState` | Refresh linked/limited state |

Static FCM channels use the slugs `global`, `trade`, `events`, `infests`, and
`raids`. The backend maps them to the owned channel IDs, applies normal auth,
moderation and rate-limit rules, persists messages, and assigns a monotonic relay
cursor. The `server` slug is reserved for ephemeral in-game rooms and is not a
normal database channel.

## Ephemeral `server` rooms

The widget periodically observes nearby names from approved HUD data sources and
sends a printable roster control on `channel: 'server'`:

```text
FCMCTL/1/ROSTER:<name>|<name>...
```

It can also send printable compatibility controls:

```text
FCMCTL/1/WORLD:<worldId>
FCMCTL/1/LEAVE
```

The relay continues to accept legacy NUL-framed controls from older widget
builds, but current builds never place control bytes in the distributable SWF.

Controls are intercepted before ordinary channel validation and are never stored
or broadcast as chat. The backend associates them with the authenticated relay
token, rejects oversized or malformed bodies, and applies a short Redis-backed
per-user control limit. There is deliberately no client HMAC: any secret placed
inside the distributable SWF is forgeable and cannot authenticate the sender.
Each accepted control returns a non-empty, synthetic UUID in `messageId`. ZFE's
`chat.v1.sendMessage` contract requires a message ID for every successful send;
the UUID acknowledges the operation only and does not represent a persisted chat
message.

`worldRosterService` stores short-lived rosters and builds connected components
from mutually observed names. The stable room key feeds the existing Redis
history, cross-instance rebind, and subscriber fan-out machinery. A room is
ephemeral: it has no `channels` row and expires naturally. Normal `server`
messages are delivered only to subscribers bound to the same current room.

The roster scan uses Redis `SCAN`, not `KEYS`, caps active roster processing, and
normalizes input lengths before it participates in room calculation.

Roster-derived rooms require mutual sightings: A must report B and B must report A. This prevents
one stale or malicious roster from placing an unrelated player into a shared server room. Live
subscriber fan-out is backpressure-aware; a socket with more than 1 MiB buffered is closed with
WebSocket status 1013 and removed from the subscriber set. Duplicate or concurrent `subscribe`
frames on one connection receive `already_subscribed`.

The widget treats the relay response to a roster/world control as the membership
acknowledgement. It does not expose or send to the `server` tab merely because
the game HUD reports nearby players: it waits for `{ "success": true }`. A
rejected control keeps `server` unavailable, records the relay error, and retries
on the normal world timer. An empty but received roster is valid for a solo world,
so it is also acknowledged and bound. This prevents a stale or mismatched relay deployment
from presenting a selectable but unusable Server channel.

## Widget resilience rules

The widget performs low-rate cursor polling. Three consecutive poll failures
mark the relay as disconnected, stop the poll timer, and schedule a reconnect;
a successful response resets the failure counter. Its event splitter is
string-aware, so braces or escaped quotes inside a JSON message body cannot split
subsequent events incorrectly.

The channel row is rendered once as static text. Rebuilding it on room changes
must call `renderSubTabs()` only; HUDButton overlays at the same coordinates are
forbidden because they duplicate and overlap the visible labels.

## Production gate

`RELAY_PRODUCTION_ENABLED=false` is the default. In `NODE_ENV=production`, the
relay rejects connections until that setting is explicitly `true`. This makes a
reviewed backend deploy and an authenticated production handshake a prerequisite
to exposing the production endpoint; building a BA2 does not enable production.
When enabled, the relay caps frames at 8 KiB, allows at most five concurrent
connections per client IP, requires a first frame within 10 seconds, and limits
anonymous registrations to three per IP per minute.

## Verification

Run the widget/config anchor checks, its focused JavaScript parser tests, and the
backend relay tests listed in
[the widget build guide](../../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md).
Before a release, validate in game that the tab row is single-rendered after a
world transition, a message with JSON-looking text does not break later events,
and the reconnect state recovers after a temporary relay outage.
