# Server room continuity

The shared native HUD/desktop bridge coordinator retains server-generated room
affinity on each live roster session. Peer departure no longer changes the
survivor's canonical room/history key simply because the departed peer was the
union-find root. A new mutual member can join an existing room without renaming it.

Affinity is internal Redis metadata, never supplied by clients. Ordinary roster
refreshes preserve it for the same request/session generation. HUDMenu is also
reconstructed by normal game transitions such as raid-stage and score-screen
completion. A replacement starts with a new delivery request nonce and can publish
an empty MapMenuData snapshot before the game's UI data sources recover.

For the native HUD path only, a changed nonce plus an empty roster no longer replaces
a fresh nonempty roster. The relay leaves the prior mutual-sighting evidence and its
original Redis TTL untouched and deliberately withholds `SERVER-READY`; therefore a
permanently blank or dead client cannot renew stale membership. The widget's normal
retry supplies a later roster. If that nonempty roster overlaps the prior roster, the
existing same-world heuristic keeps the backend session, room affinity and age while
adopting the new delivery nonce. A recovered roster that is disjoint from the client's
own pre-reload roster receives one additional continuity check while the room coordinator
lock is held: it may match only current peers already assigned to the same canonical room,
using the same three-name, 75%-of-the-larger-roster and unexpired direct-evidence rules.
If any peer qualifies, only the delivery nonce rotates; the old observation session,
room affinity, age and nonrenewable direct-evidence timestamp survive. Otherwise the
replacement remains an immediate new world generation. This works whether or not the
separate history-recovery `FCMCTL/1/RESYNC` was necessary.

An explicit leave, expired/missing roster, rejected replacement, or desktop export
world-generation change still discards affinity. RESYNC cannot recreate a cleared or
expired roster and never extends observation freshness. Coordination writes use XX
and KEEPTTL for the same reason. The room-stability correction needs no HUD, bridge,
overlay protocol, or client binary change. A replacement comparison reads peer evidence
without writing peer records or extending their Redis TTLs. HUD 2.10.116 and bridge 0.2.4
remain unchanged.

If surviving members of an old room split into disconnected components, exactly
one component retains the canonical room: the component containing the most
members who previously owned it, then the oldest continuously observed session,
then a deterministic root tie-break. Every other component receives an independent
room immediately, so disconnected users never continue sharing live publication
authority. This prevents one incomplete observation from renaming the room for an
otherwise stable group while retaining fail-closed isolation. Roster inference
remains non-authoritative; there is no trusted game-world ID.

A partial same-session roster update retains each newly missing sighting for a
10-second, per-name grace. Repeating the incomplete roster cannot renew that
deadline, restored names remove their grace immediately, and expired grace is not
used for clustering. For an already established room, a fresh empty same-session
roster instead retains the last mutually verified names until 60 minutes after the
original direct sighting. Repeated empty observations do not renew that deadline,
and the retained names are discarded as soon as a populated observation arrives.
Explicit leave, expiry, account change and new generations receive no grace.
Reconciliation is event-driven, so an expired edge is
applied on the next serialized roster mutation; it never renews Redis observation
freshness or the client lease.

Daily Ops and similar instanced activities can remove the party members themselves
from `MapMenuData` while every participant continues to report the same surrounding
public-world population. After direct mutual-sighting grace expires, the coordinator
retains an existing canonical room when two unchanged sessions with that same
server-owned room affinity share at least three roster names and at least 75% of the
larger roster. The server records the receipt time of actual roster observations and
advances a separate direct-evidence timestamp only when both current rosters mutually
identify each other. Cached recomputation, shared-population matches, heartbeats and
history never renew that timestamp. Shared-population continuity expires 60 minutes
after the last direct evidence. This evidence is continuity-only: it cannot join
previously separate rooms, restore cleared/expired affinity, survive an account change,
or cross an explicit leave or new observation generation. Disjoint world rosters and
expired fallback windows therefore remain hop boundaries.

Raid-stage HUD reconstruction can briefly replace the background bridge export file. The desktop
watcher now holds its last validated sample through a transient unreadable poll without renewing
the thirty-second observation deadline. Initial attachment still requires repeated advancement;
after attachment, a paused writer can retain only its original nonrenewable evidence window. This
prevents a raid-completion HUD reconstruction from emitting `bridge:leave` and discarding room affinity, while a
stopped writer, persistent invalid file, explicit inactive snapshot, game exit or real generation
change still retires authority.

Desktop local-export leaves carry a fixed reason. `observation_timeout` is the only soft reason: the
backend revokes the socket's Server binding immediately, but retains its existing room affinity for a
nonrenewable 30-second recovery window. A fresh observation from the same authenticated export session
and world generation may recover that affinity; the timeout cannot authorize sends, receive delivery,
renew itself, or merge rooms. Expiry clears membership normally. `game_exit`, `main_menu`,
`explicit_inactive`, `account_change`, `socket_replaced`, `app_quit`, `invalid_export`, and
`provider_conflict` are hard boundaries and clear membership immediately. Unknown reasons fail closed as
`explicit_inactive`. Privacy-safe diagnostics record `soft_leave_started`, `soft_leave_recovered`, or
`soft_leave_expired` without raw account, room, roster, session, or world identifiers.

The overlay and visible HUD separately retain accepted Server rows as bounded, in-memory display
history for the current game/widget session across backend room moves. This does not retain room
authorization: incoming delivery, history acceptance and sends remain fenced to the current
confirmed binding. The overlay clears the transcript on confirmed game-process exit; a new HUD
MovieRoot/game launch naturally starts empty. No session transcript is persisted to disk.

Production split/rebind decisions are logged at info level with SHA-256-derived
12-character references, component sizes, reason and fixed transport classes
(`native`, `bridge:zfe`, or `bridge:xscal`). Logs contain no player names, roster
contents, message bodies, raw room/session/request identifiers or tokens. Decisions
also carry a fixed continuity reason: `direct`, `shared_population`,
`empty_roster`, `fallback_expired`, or `threshold_rejected`. Successful shared-population
and empty-roster retention is debug-logged with only the fixed reason and a hashed room reference. Changed native
replacement observations additionally carry one fixed decision:
`replacement_overlap`, `replacement_shared_population`, or `replacement_rejected`.

HUD 2.10.114 additionally sends transition-only `FCMCTL/1/DIAG:` controls through the
existing authenticated, capability-gated `chat.v1` path. The body accepts only fixed
event/provider/source enums, a roster count from 0–24 and the numeric build version;
there is no free-text field. Events cover roster send, temporary-empty hold, disjoint
boundary, stale observation and MainMenu. Consecutive duplicates are suppressed and
each widget instance is capped at 32 events. The server advertises
`canSendRoomDiagnostics`; an older backend therefore receives no unknown control. These
controls never establish or renew membership and use an independent 12-per-minute limiter,
so diagnostics cannot consume the functional world-control budget.

The coordinator keeps a separate 24-hour Redis evidence ring: 1,000 recent global
events and 100 per relay identity. It records changed roster observations, held reloads,
grace sets, room assignments, splits, rebinds and clears. Player/alias values use
server-secret HMAC references; UUIDs, nonces, sessions and rooms use 12-character
SHA-256-derived references. Raw names, IDs, request values, tokens and message bodies
are not retained. `GET /admin/debug/room-diagnostics?userId=<relay-user-id>&limit=<1..200>`
reads the per-user ring; omitting `userId` reads recent global evidence. The endpoint
requires `X-Admin-API-Key` and the normal admin API limiter. Diagnostic storage is
best-effort and cannot fail room assignment.

### Roster-visible self names

HUD and account APIs can expose different labels for the same player. A 2.10.111 HUD therefore
adds bounded `@self:` aliases to the existing printable v1 roster control, and bridge 0.2.4 prefers
the local name from its fresh selected roster source for exported `ownName`. The coordinator may
match any normalized primary/alias name, but the direct-sighting path still requires both clients
to report each other. The bounded shared-population continuity rule above is separate and applies
only to clients that already own the same canonical room.
Aliases affect grouping only; relay tokens remain the sole actor identity and all sender/account
attribution is unchanged. One-sided aliases remain isolated, malformed or excess aliases fail
closed, and freshness/session/generation rules apply to the whole roster record.

The additive v1 encoding supports a HUD-first rolling update: an older backend treats `@self:` as
an unmatched peer entry rather than chat. A backend-first update accepts old clients with no
aliases. Automated coverage includes differing account labels, mixed HUD/bridge transport labels
and one-sided rejection. Fresh two-client native acceptance remains required.

### Delayed peer departure

A remaining player may report a roster without their peer before the peer's
leave reaches the backend. This separates live rooms after the bounded partial-
sighting grace. An established room reporting fresh empty rosters remains connected
only through the nonrenewable direct-evidence deadline described above. Leave, expiry,
account change and generation boundaries still separate immediately. The selected stable component keeps the canonical room. When every
member of another resulting component has the same previous room affinity and
unchanged observation session, the coordinator seeds its new room with a snapshot
of that old room's retained history before publishing the new assignment.
Redis COPY preserves message IDs and the existing expiration, does not replace
an existing destination, and emits no live messages. Subsequent messages remain
isolated. The list is already capped at 50 messages; no extra polling or timers
are added. Redis 6.2+ is required for COPY.
The history reader marks rows with an in-process Symbol identifying the room
actually read. Only this provenance permits an inherited message ID in desktop
history; JSON fields cannot forge it and live delivery retains strict room-ID
checks. Block filtering, binding revalidation and message-ID deduplication remain.

Mixed-affinity components, new members and new generations do not receive this
carryover. Copy failures abort assignment; missing/expired source history remains
empty. This preserves previously authorized history, not proof that clients are
still in the same world. Room IDs may change during ambiguous splits. It cannot
recover history already stranded before this fix. Native acceptance of the
delayed-departure path remains pending; automated backend tests are not proof of
the exact ordering observed on a user's machine.

Messages remain under the same capped, one-hour-idle Redis history policy. This
does not promise unlimited retention or reconstruct history already stranded by
an earlier room reassignment. Clients and their authentication protocols do not
change. Older backend instances must be drained before relying on continuity,
since they do not maintain the new optional room metadata.

Regression coverage: `worldRoomContinuity.test.js` covers either peer departing,
component splits, stable-component inheritance, non-renewing partial-sighting grace,
privacy-safe split telemetry, Daily Ops party-name suppression with an identical public-world
roster, rejection of shared-population joins across separate rooms, generation/leave boundaries,
a single HUD replacement, five simultaneous startup-empty replacements, peer-assisted populated
replacement recovery, 18/24 and 17/24 boundaries, direct-evidence expiry and disjoint replacement;
`relayHandler.test.js`
covers withheld confirmation during recovery, overlapping replacement bind, the
authenticated RESYNC marker and history confirmation.
`localExportBridge.test.js`
covers all four mixed provider pairings, canonical publication/history and peer
departure. Delayed-departure tests cover all four mixed labels (native providers
share the same backend protocol), bridge↔bridge and HUD↔HUD, preservation of IDs
and expiry, desktop replay, future-message isolation and generation boundaries.
`bridgeConnection.test.js` rejects forged replay provenance and cross-room live
messages. Existing backend CI runs these Jest suites without a new workflow.
Native two-client acceptance remains pending deployment/manual testing.

### Rejoin room selection

Previously, mutual discovery selected the lexicographically first eligible room
UUID. A returning player's provisional empty room could therefore replace the
continuously occupied room and make both feeds appear empty, even though the old
Redis history still existed.

Roster records now carry a backend-owned `sessionStartedAt`. Observations within
the same request/generation retain it; leave, expiry or a new generation starts
a new age. Eligible rooms are ranked by their oldest still-active member session,
then UUID for deterministic equal-age ties. Split-room exclusion still runs first.
No history is unioned/copied on a join, and no history TTL is extended. The returner
receives the selected occupied room's ordinary authorized replay; history from its
provisional room is not imported. Neither client protocol nor authentication changes.

During rollout, an active legacy roster without this field ranks as age zero
(older than new sessions), preserved on subsequent observations. Malformed ages
are rejected. No migration or client reinstall is required; existing active rooms
cannot recover an already-displaced selection merely from this deployment.

This remains roster-based inference, not an authoritative world identity. If two
long-lived disconnected components discover each other, the oldest active session
chooses the canonical room; we cannot prove which component represents the physical
world. Equal-age legacy rooms retain the deterministic UUID tie-breaker. We do not
merge their histories to hide this ambiguity. Freshness, mutual sightings and
per-session authorization remain required.

Regression coverage includes both UUID orders, legacy records, age validation,
generation reset, deterministic ties, and three leave/rejoin cycles for all four
HUD/provider-to-bridge/provider pairings plus HUD-to-HUD and bridge-to-bridge.
The shared backend tests assert stable survivor room/history and TTL, isolated
provisional messages, delayed mutual discovery, rendered desktop replay and unique
message IDs from both senders. Native provider labels exercise the common native
coordinator contract here, not separate extender binaries. Existing native/Ruffle
acceptance still applies; a fresh two-client game test is required after deployment.

### HUD MovieRoot replacement continuity (2026-09-19)

A local xScal session attached a second `MovieRoot` at 00:02:19 elapsed and the new
widget immediately sent `names=0` under a new request nonce. During the later room
incident the same widget instance remained alive, the Fallout process did not exit,
and its populated local roster remained stable while three relay confirmations moved
it through different rooms in about 0.62 seconds. This confirms that another member's
topology update can repartition the entire component; it does not establish a
physical Fallout world hop.

This lifecycle is consistent with current HUD mod behavior documented by other
maintainers: the [BuffsMeter author notes](https://www.nexusmods.com/fallout76/mods/2821)
that HUDMenu resets at each raid-stage completion, while the
[HUDChallenges author](https://www.nexusmods.com/fallout76/mods/2860?tab=description)
documents that an Overlay-layer build survives that transition at the cost of
different HUD data and rendering behavior. FCM remains on HUDMenu and makes its room
protocol tolerant of that expected reconstruction rather than changing render layers.

The exact native multi-client incident still requires post-deployment acceptance.
No client artifact is required for this backend-only correction.

### Client replay validation (follow-up candidate)

The Redis copy alone is insufficient: both clients historically required each
message ID to embed the current room, rejecting carried history from the prior
room. Desktop `bridge:history` payloads now carry `historyReplay: true`; the shared
renderer still requires the current binding and row channel, then accepts a
well-formed inherited canonical ID for marked history only. Live messages retain
their current-room check. Repeated history keeps original IDs for deduplication.

For the visible HUD, the relay projects its internal history-read provenance into
`h=<URL-encoded current room>` in the existing negotiated `FCMHUD/1;` targetUserId
carrier. This survives ZFE/xScal's native field filtering. The widget accepts an
inherited ID only when `h` matches its confirmed room; unmarked/stale-room rows
are rejected. Readiness, world-exit clearing and authentication stay unchanged.
No background bridge change is needed. Deploy the compatible backend, update the
portable overlay, and install the tested visible HUD only on machines using that
track (never coinstall it with the background bridge). Older clients fail closed
by hiding inherited rows until updated.

Backend integration tests now serialize replay frames and run them through the
actual shared renderer helper. Both Ruffle provider scenarios exercise marked,
unmarked, stale-room and duplicate rows through the widget/native adapter, plus
world-exit cleanup. Native acceptance still requires a fresh two-client test.

Client replay candidate verification (2026-09-18): all 228 affected backend Jest
tests, 456 backend TypeScript unit tests, 1,241 overlay units, 435 dashboard
units, and all 54 Ruffle scenarios passed. Backend/dashboard/renderer builds,
all chat Haxe tests, native API/auth checks, bridge state/export/package checks,
and SWF/source/archive/package checks passed. The rebuilt HUD archive was
extracted and compared byte-for-byte with the tested SWF. The Electron
interaction suite passed (including reconnects, retained drafts/history and
account changes); its owned processes and temporary profile were removed.
Ruffle's port 41739 was closed after completion. These results do not establish
native game acceptance or hosted deployment. The candidate retains the existing
private build version; it is not a new published release.

The Windows x64 portable candidate also built successfully on the native laptop
runner (1.4.0, 91,121,909 bytes). Its packaged renderer SHA-256 matches the tested
local renderer. The temporary build task was removed. It remains in build
staging, not installed; packaged runtime smoke, release gates and two-client
native acceptance remain pending. The HUD candidate is 2.10.110; its rebuilt BA2
SHA-256 is `21103a134fcd845a39912a1674ab86e1dce0c9e5a6f39a2aa4e6fb44b9cb9e0e`.

### Previous backend-only candidate verification

Local delayed-departure verification (2026-09-18, before the client replay fix): backend TypeScript build,
98 targeted room/bridge tests, 130 native relay tests, 455 backend TS units,
1,241 overlay units and 434 dashboard units passed. All chat Haxe tests,
bridge state/export/package checks, source/BA2/SWF/package checks and all 54
Ruffle scenarios passed. A disposable Redis 7 check confirmed COPY data/TTL,
no-overwrite and missing-source behavior; its container was removed and the
Ruffle listener closed. These are local results, not hosted CI or native
acceptance. No HUD/bridge binaries or installed clients were changed.
