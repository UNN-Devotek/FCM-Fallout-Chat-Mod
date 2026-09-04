# FCM integration with ZFE `chat.v1` and xScal `chatInterface`

This document describes the current FCM adapter for ZFE's `chat.v1` API and xScal's
equivalent `chatInterface` surface under `__SFECodeObj` or `__SFCodeObj`. Current xScal
builds may also expose a generic call-only `__SFCodeObj.call` callback object for other
callbacks; it is not the chat surface.
It is used by the optional
`FCMChatWidget.ba2` HUDModLoader widget; it does not change
the EULA-safe desktop overlay.

## Boundaries

- The widget uses ZFE's sanctioned outbound API only: `chat.v1.connect`,
  `chat.v1.pollEvents`, `chat.v1.sendMessage`, `chat.v1.subscribe`,
  `chat.v1.report`, and `chat.v1.getAuthState`.
- It reads only data already published to the game HUD by `BSUIDataManager`.
  It does not read game memory, inject code, modify game files at runtime, or
  scan networks/ports.
- The backend route is `wss://<host>/relay`. `/zfe-relay` is not a relay route.
- `FCMChatWidget.ba2` is an explicit, user-installed mod. The Electron overlay
  remains the default non-mod track.

## Automatic provider selection

The same SWF supports either script extender. It probes the Scaleform objects already exposed
by the active HUD movie, preferring a validated ZFE dispatcher and falling back to a validated
xScal `chatInterface` with `connect`, `pollEvents`, and `sendMessage`, whether it is under
`__SFECodeObj` or `__SFCodeObj`. A call-only `__SFCodeObj` is accepted as ZFE only after a
positive capability probe, and xScal's
`GetXSRuntimeInfo` marker is checked first so xScal never receives a ZFE chat probe. No DLL is
loaded or inspected by the SWF. The adapter maps FCM's canonical `chat.v1.*` verbs to xScal's
unprefixed methods, including `getAuthState`, `reportMessage`, `moderationAction`, and
`clearChatAuth`.

xScal does not provide ZFE's native chat editor commands. Both providers therefore use the
SharedHUDTools input path first: its host-domain `TextEdit` owns the balanced game-control lock.
ZFE's native editor is retained only as a no-lock fallback when SharedHUDTools is unavailable or
cannot open. The child widget never dispatches `ControlMap` events itself. The relay payloads,
channel slugs, server-room controls, auth gate, and cursor polling remain shared.

The provider lifecycle is not identical: xScal's `connect` is asynchronous and may return
`{"success":true,"status":"connecting"}` while its worker performs hello/register. FCM records
that as an accepted-but-pending transport, does not immediately reconnect, and refreshes
`getAuthState` during the normal poll loop. `authenticated` enables chat; `connecting`/`pending`
are retained as intermediate states; only explicit terminal states (`rejected`, `disconnected`,
token failure, or equivalent) tear down the session. This prevents a three-second reconnect loop.
The generic xScal `__SFCodeObj.call` callback is optional diagnostics only: FCM routes `log` there
when exposed, while all `chat.v1.*` verbs go exclusively to `chatInterface`.

## Connection and authentication

The backend upgrade router dispatches `/relay` to `relayHandler`. A ZFE client
registers or resumes with an opaque relay token; `verifyToken` establishes the
relay `userId`, linked-account state, and display data. Every operation derives
its actor from this verified token, never from a client-supplied ID.

`getAuthState` is used by the widget to show authenticated chat or its limited,
receive-only linking state. The token can be linked after a web device-code flow;
the normal relay event flow then refreshes the widget state.

### Explicit relink/reset

Widget v2.10.30 accepts the standalone `/relink` command and the matching FCM HUDModLoader menu
action. Relinking is intentionally a local ZFE operation: the widget calls the top-level
`clearChatAuth` command with `{}` and never attempts to write `Data/ZFE/chat-auth.bin` through
FCM's vendor-scoped settings storage. When ZFE returns success, the widget reconnects with
`autoRegister:true`, causing the relay to issue a new limited-session link code.

`clearChatAuth` is an FCM/ZFE extension and is not a `chat.v1` relay operation. It must delete the
ZFE-owned local token atomically and return either bare `true` or a success envelope containing
`cleared:true`; it must not return the token to the SWF. If an older ZFE rejects the command, the
widget leaves the existing token untouched and shows the manual recovery path: exit Fallout 76,
delete `Data/ZFE/chat-auth.bin`, and restart. This fail-closed fallback prevents a false “relinked”
state and is required until the current ZFE build exposes the command.

The widget resolves `displayName` from HUD-published `BSUIDataManager` data.
`AccountInfoData.name` (or the older nested `account.name` shape) is authoritative because it is
the public Fallout/Bethesda account handle. `PlayerListData` and `CharacterInfoData` contain local
character labels and cannot satisfy the handshake gate. HUD data can arrive late, so the widget
waits and retries until the account handle is available before its first relay handshake. It never
connects with the `Wanderer` placeholder or a character-name substitute, and never issues a second
native `chat.v1.connect` from a late HUD update. Empty reads never replace a known name, punctuation
is preserved, and the actual name is not written to diagnostics.

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
| `chat.v1.sendMessage` | Send a static-channel message or an authenticated reserved server control |
| `chat.v1.getAuthState` | Refresh linked/limited state |
| `clearChatAuth` (top-level ZFE extension) | Delete ZFE's local relay token for explicit relink |
| `chat.v1.report` | Submit a report for a persisted chat message |
| `chat.v1.moderationAction` | Submit a staff-gated delete, kick, mute, unmute, ban, or unban |

`chat.v1.report` requires a linked relay identity, a valid persisted message UUID,
and a non-empty reason. The backend derives the reported user from the message,
rejects self-reports and deleted messages, persists the report in `reports`, writes
an audit record, and sends moderation notifications only after persistence succeeds. Each linked
account is limited to five reports per ten minutes, and repeated reports for the same message are
rejected idempotently.

`chat.v1.moderationAction` requires a linked account whose verified Discord role is `moderator`,
`admin`, or `owner`. Delete, kick, mute, unmute, ban, and unban reuse
`moderationActionsService`, including its protection checks, audit entries, and live notifications.
That means HUD-originated mute, ban, and unban actions receive the same Discord timeout/lockdown/
role-restoration behavior as dashboard actions. In-game bans attach the bounded reason as text evidence.
`setSlowMode` is intentionally unavailable
until FCM has a per-channel slow-mode primitive; auth state reports `canSetSlowMode: false`.

The optional HUD widget exposes the actions only to a staff identity. It accepts an exact visible
player name (quote multi-word names) or the short `[#XXXXXXXX]` reference beside visible messages,
for example `/mod Alice mute 15 spam`. The widget resolves either input locally to the relay event's
immutable message and account IDs; it never sends the display name as a moderation target. Duplicate
visible names are rejected and require the reference. See the widget [build and verification guide]
(../../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md#in-game-acceptance-checklist).

Static FCM channels use the slugs `global`, `trade`, `events`, `infests`, and
`raids`. The backend maps them to the owned channel IDs, applies normal auth,
moderation and rate-limit rules, persists messages, and assigns a monotonic relay
cursor. The `server` slug is reserved for ephemeral in-game rooms and is not a
normal database channel.

## HUD identity cosmetic extension

Widget v2.10.16 understands three optional, additive FCM fields on `chat.message`
events, including subscribe-time history:

```json
{
  "tag": "X",
  "supporterStar": true,
  "starColor": "#58FDFD"
}
```

The relay emits these fields on every chat event. Raw relay consumers retain the additive JSON
members, but ZFE's native bridge strips unknown members before Scaleform sees them. To cross that
boundary, v2.10.16 advertises support and receives the stable message ID plus the same validated projection in an
`FCMHUD/1;...` envelope carried by the existing known `targetUserId` field. For ordinary channel
messages that field is an empty transport slot, not a real recipient. The relay emits the
envelope only to v2.10.16+; older widgets receive no envelope. The relay records `clientVersion`
beside a short-lived one-way token digest in Redis so separate connect and subscribe sockets use
the same capability decision. `tag` and `starColor` are already validated by the cosmetics
service, and `supporterStar` is derived only from an active Supporter or Overseer entitlement.
Widget v2.10.46 renders supporter fields with a fixed five-point vector `Shape` in a row-local
`Sprite` containing separate channel and message fields. The row measures the channel field,
reserves the marker slot, places the marker 5px after the channel tag, and centers it on
the first message line with a 2px visual down-nudge. There is no `getCharBoundaries()`, document-index search, or global/local
transform, so Scaleform's mixed-font coordinate ambiguity cannot move a marker into the header or
top-left corner. The feed clip moves the complete row, including its marker, and keeps off-screen
history out of the header/input area. It uses the validated `starColor` and never trusts a Unicode
glyph, bitmap, HTML image, or substitution token from the wire. The desktop/web `nameColor` and
effect fields remain outside this HUD extension. A self-authored in-game message creates one
canonical local send transaction before the synchronous native send RPC runs, so a slow TLS/socket
call cannot block the first visible feedback. The successful ACK carries the server-resolved
cosmetics and stable message ID, so the widget decorates the exact row immediately. A live event
may win the race and complete that same row before the ACK; it is never appended as a second row.
On old Dev bridges that strip both the transport carrier and usable identity alias, the widget
uses only one unambiguous historical own-cosmetics snapshot for the optimistic row and then permits
one ACK-accepted, 15-second display-name/channel/body fallback. Ambiguous or stale events stay
separate rather than being guessed. Runtime logs report only provider/field-presence and count
diagnostics (`ownEchoId`, `ownEchoFallback`, `ownEchoAmbiguous`, and record counts), never raw IDs
or message text.

Successful static and server `chat.v1.sendMessage` responses also include the same
HUD-safe `tag`, `supporterStar`, and `starColor` fields when present. For v2.10.16+
widgets, the message ID and those fields are also mirrored in an `FCMHUD/1;...` envelope carried by the
known `targetUserId` member. The carrier preserves the stable message ID through the native RPC
boundary, so the widget can reconcile the local row using the asynchronous subscriber echo; the
authoritative event then replaces it exactly once with the supporter cosmetics. The backend direct-
fans out finalized static-channel events to same-process native subscribers before publishing to
Redis for other instances; a shared instance guard prevents the direct event and Redis fallback
from producing two HUD events. The provider RPC itself is queued one timer tick after the local
render because both ZFE and xScal expose a synchronous call surface; this avoids making a socket
timeout look like a missing local message. The matching backend deployment is required for the
same-process latency path.
The shared finalizer passes the server-resolved supporter tier to the outbound Discord
relay, which renders the immutable `★` beside the author; Discord cannot reproduce the
web/HUD star colour in ordinary message text.

Before a valid HUD message is decorated, the relay asks Discord for the linked user's
current member roles at most once per minute per deployment, coordinated by a Redis
`SET NX EX` slot (with a local fallback if Redis is temporarily unavailable). The
Discord ID comes from the linked FCM account resolved by the relay token; the HUD cannot
provide or forge it. A successful role read updates the shared supporter entitlement and
clears the tier/cosmetics read caches even when the effective tier is unchanged, so a
stale pre-reenable `none` value cannot hide a current role. Gateway events, the immediate
startup reconcile, and the 15-minute bulk reconcile remain in place for changes that do
not coincide with a HUD send; login, link-status polling, and overlay/dashboard reads use
the same bounded check. Discord timeouts, rate limits, and other transient failures
preserve the last known entitlement; only a successful no-role read or definitive member
removal can lapse it.

## Verified HUD regressions and input handoff

The v2.10.43 HUD regression fixes and the v2.10.46 input ownership fix are now part of the
v2.10.46 package contract:

- a send creates one optimistic row before the synchronous provider call and reconciles the
  authoritative ACK/live event into that row, so one send produces one feed row;
- the supporter marker is owned by the same row `Sprite` as the channel and message fields,
  immediately after the measured channel tag and vertically aligned with the first message line;
- the tag and marker are available on the optimistic self-row as soon as the ACK/live projection is
  available, without waiting for a later regular poll;
- Insert gates feed scrolling, Arrow Up/Down scroll only during the open input session, Home/End
  return to the newest row, and Page Up/Page Down switch channels without discarding the draft.
- the roster/world observer refreshes the current cached `BSUIDataManager` provider values on each
  world poll because `Subscribe()` adds a `CHANGE` listener but does not replay the cached value;
  this ensures a newly joined world can create the `SERVER` tab and trigger history replay even when
  no second provider event is emitted;
- each provider contributes a replaceable snapshot instead of an ever-growing name cache. An empty
  or completely disjoint snapshot is treated as a world-session boundary: the widget clears local
  ephemeral server rows, sends `FCMCTL/1/LEAVE`, then submits a fresh roster and waits for its ACK;
- a successful fresh roster/world bind invokes the existing relay server-history backfill. Static
  channel history remains durable; `server` history remains the bounded recent Redis history
  described below, not permanent Postgres history.

Widget v2.10.46 also closes the input owner before Fallout opens another modal input surface. The
HUDModLoader event path delivers the in-game Ctrl+Tab shortcut as the named `OpenSocial` action
(with `OpenFriendList`, quick-action aliases, and `Escape`/`Cancel` handled by the same rule). The
widget's `FCMChatWidget.hx` classifies that action before normal navigation: the no-lock native
fallback is cleared/deactivated; the SharedHUDTools primary path calls the public `EndTextEdit()`
cancellation API. The local input state is closed before `HUDMenu.ProcessUserEvent` continues into
the game's social-menu handler. Only SharedHUDTools owns the engine's `ControlMap::StartEditText`
gate; the child widget does not synthesize a matching event pair.

The v2.10.45 input regression was different: its native-first path dynamically dispatched
`ControlMap::StartEditText` from the child SWF. The in-game HUDModLoader error surface reported
repeated `FCMChatWidget: [UncaughtErrorEvent ... Error #1014]` lines immediately after the lock was
acquired, leaving player controls unavailable. v2.10.46 removes that child dispatch and restores
the known host-domain ownership model. Raw physical keyboard events are not a reliable HUD-layer
input contract; the named `OpenSocial` event is the supported boundary. The pure policy is covered
by `TestFcmCommand.hx` / `test-command.hxml`, and `test_package.py` plus `test_anchors.py` assert
that the widget uses SharedHUDTools first and contains no child `ControlMap` dispatch.

## Ephemeral `server` rooms

The widget periodically observes nearby names from approved HUD data sources and
sends a printable roster control on `channel: 'server'`:

```text
FCMCTL/1/ROSTER:<name>|<name>...
```

It can also send these controls:

```text
FCMCTL/1/WORLD:<worldId>
FCMCTL/1/LEAVE
FCMCTL/1/RESYNC
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

`RESYNC` is emitted once after widget initialization. It replays the bounded static
history to the long-lived native subscriber, including when the SWF was recreated but
ZFE retained and drained that subscriber. The relay marks server-room history pending
and releases it only after the next accepted roster/world bind. This keeps the previous
world's ephemeral messages out of a newly joined world. Replay records are deduplicated
by `messageId` in the widget.

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
rejected control keeps `server` unavailable, records the relay error, and backs
off retries for 60 seconds; it does not issue the same synchronous native call
on every 5-second world tick. Roster controls are also suppressed while the
account is unlinked or not authenticated. An empty but received roster is valid
for a solo world, so it is also acknowledged and bound. This prevents a stale or
mismatched relay deployment from presenting a selectable but unusable Server
channel, and prevents a slow relay timeout from repeatedly stalling the HUD.

Widget v2.10.46 also pulls the current values of `PlayerListData`, `TeamMarkers`,
`PartyMenuList`, and `VoiceChatAreaData` after subscribing. This is intentional: the upstream
`BSUIDataManager.Subscribe()` implementation only attaches the callback and does not invoke it for
the provider value already in the cache. Provider snapshots are replaced on every refresh, so a
previous world's names cannot live in the next roster merely because its TTL has not expired. When
the new snapshot is empty or has no name in common with the last acknowledged roster, the widget
performs a real leave-before-rebind and clears only local `server` rows. The next accepted roster
bind causes the relay to backfill that current room's recent history, which restores the `SERVER`
sub-tab and its available history after a world change without leaking the previous room.

## Widget resilience rules

The widget performs low-rate cursor polling. Three consecutive poll failures
mark the relay as disconnected, stop the poll timer, and schedule a reconnect;
a successful response resets the failure counter. Its event splitter is
string-aware, so braces or escaped quotes inside a JSON message body cannot split
subsequent events incorrectly.

The channel row is rendered once as static text. Rebuilding it on room changes
must call `renderSubTabs()` only; HUDButton overlays at the same coordinates are
forbidden because they duplicate and overlap the visible labels.

## Configuration — `FCM_PUBLIC_BASE_URL`

The in-game **link-required** system notice tells the player where to go to link their account:

```
LINK REQUIRED - visit <host>/link, sign in, and enter code: XXXX-XXXX (expires 10m)
```

That host is **not hardcoded**. It comes from `FCM_PUBLIC_BASE_URL` via `deriveLinkUrl()` in
`backend/src/services/relay/relayHandler.ts`, which strips the scheme and any trailing slash and
appends `/link` — so the notice shows a bare host, matching the in-game format.

| Var | Default | Purpose |
| --- | --- | --- |
| `FCM_PUBLIC_BASE_URL` | `https://falloutchatmod.com` | Canonical public base URL for this deployment. Controls the host shown in the device-link notice. **No trailing slash.** |

**Set it to `https://dev.falloutchatmod.com` on the hosted dev stack** (already wired in
`deploy/dev/docker-compose.yml`). Without it a dev-stack player is told to visit the *production*
site, where their dev link code does not exist — the code is issued against the dev backend.

Existing production deploys need no change: the default is the production site.

Covered by `deriveLinkUrl` unit tests in `backend/tests/relayHandler.test.js`.

## Production gate

`RELAY_PRODUCTION_ENABLED=false` is the default. In `NODE_ENV=production`, the
relay rejects connections until that setting is explicitly `true`. This makes a
reviewed backend deploy and an authenticated production handshake a prerequisite
to exposing the production endpoint; building a BA2 does not enable production.
When enabled, the relay caps frames at 8 KiB, allows at most five concurrent
connections per client IP, requires a first frame within 10 seconds, and limits
anonymous registrations to three per IP per minute.

The production deployment must set `RELAY_PRODUCTION_ENABLED=true` in the
production backend environment before distributing a production-configured HUD
package. This is an operational rollout setting, not a build-time default. Verify
the deployed backend health/logs and complete an authenticated production
`/relay` handshake before announcing the package; if the flag is absent or the
handshake fails, the HUD must remain undistributed.
Request/response sockets are closed after 250 ms of inactivity once their response
has been queued; this grace window preserves sequential frame reuse while ensuring
ZFE's separate `poll`, `send`, and world-control calls do not accumulate against
the connection cap. `subscribe` is the only operation that keeps a socket open.
Discord-originated feed messages receive the same relay cursor as HUD/WS messages,
so they are delivered live and included in subscribe-time history. On startup, the
backend idempotently assigns cursors to older chat rows that predate this contract
before accepting relay traffic.

## Verification

Run the widget/config anchor checks, its focused JavaScript parser tests, and the
backend relay tests listed in
[the widget build guide](../../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md).
Before a release, validate in game that the tab row is single-rendered after a
world transition, a message with JSON-looking text does not break later events,
and the reconnect state recovers after a temporary relay outage.
