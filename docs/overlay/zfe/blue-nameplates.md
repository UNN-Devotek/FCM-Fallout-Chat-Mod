# Blue FCM nameplates — testing candidate

HUD stationary-retention source candidate **2.10.150** and Server Bridge source **0.2.18** target tinting an existing
overhead player name blue (`#167FAF`) when that player has fresh FCM presence in the viewer's
confirmed canonical Server room. Fresh 149 runs on desktop/xScal and MSI/ZFE now
advance private requests and accepted replies, bind the painter, and record no
1014 or paint errors. Both still intermittently lose blue. Logs confirm some
30-second marker-source expiries and separate fresh-source unpainted samples;
the user confirms visible labels stay present and movement restores blue.
150 separates initial acquisition from continuation of an already admitted visible
plate, as described below. All required local gates pass, including 93/93 Ruffle
cases; 150 is installed with verified archives, backups, settings and MSI login.
Native stability, hosted CI and publication remain pending.
The preceding diagnostic 149 passed all required local gates. Candidate 2.10.148 passed all required local gates after
fresh 147 native logs show active gates but zero requests, no binding and repeated
runtime 1014 on both providers. Passing 147 Ruffle tests do not accept native use.
The preceding 148 removed new local Array coercions through indexed in-place
pruning, but fresh 148 native logs still show zero requests and error 1014.
Candidate 149 separates clock/session reads and pruning/queueing/encoding methods
with fixed call/entered phases and bounded error/class diagnostics. Both focused
provider scenarios pass, followed by all required local gates and 93/93 Ruffle
cases. 149 is installed on both machines; native acceptance remains required. It follows
an independent-timer review that reproduced still-valid replies being rejected when
renewal precedes polling. The preceding 2.10.146 passed local gates, including
93/93 Ruffle cases, with settings and login preserved. The preceding 2.10.145
passed all local gates, but the user reports repeated flicker and fresh
logs confirm restore-phase error 1006 on both providers, private-lease gaps and
some genuine marker-source expiry. 2.10.146 uses GFx-compatible paint cleanup and
private-request renewal headroom. Native acceptance and publication remain pending.
Bridge 0.2.17 is a local regression source; the
distributed 0.2.10 ZIP is unchanged. See the
[2026-10-12 recovery investigation](../../testing/blue-nameplates-2026-10-12-recovery.md)
and [2026-10-07 evidence review](../../testing/blue-nameplates-2026-10-07-review.md).

The renderer is shared by both optional HUDModLoader children. It uses the
installed HUD's public `TeammateMarkerBase.TeamNameplates`, `Name_tf` and
`entityID` properties and public `TeamMarkers` HUD data. The generic source still
requires explicit `dataReady=true` and `isTest=false`; missing, throwing or other
flag values remain ineligible. Candidate 2.10.143 adds a separate, local cosmetic
source for the observed native-HUD envelope anomaly. It requires all of:

- A genuine post-bind `TeamMarkers` event from the manager resolved in the owning
  HUD movie's ApplicationDomain, with the current bound host and generation.
- `event.fromClient` identical to the provider/canonical cached envelope and
  `event.data` identical to its payload, with explicit `dataReady=false` /
  `isTest=true`. A snapshot or diagnostic getter is insufficient.
- A complete bounded snapshot of at most 128 rows, copied to scalar values. IDs
  must be unique finite numeric uint values (`0` is valid), excluding the
  unassigned sentinel `4294967295`; normalized names must be nonempty.
  Invalid rows reject the correlated snapshot rather than being silently skipped.
- A current visible native nameplate with the same public entity ID and name,
  including visibility of the TextField's ancestors and `NamePlateNameGroup_mc`.
  Nonlocal, nonhostile and not-wanted eligibility is rechecked on every paint.
- Current private FCM presence, its context and reset generation, and a source
  age below 30 seconds when acquiring a new painted association. Only genuine pushes renew the cosmetic source; getters,
  snapshots, probes and frames never do. Returning to an old context does not
  restore a source from before its reset.

The painter may retain its owned provider-envelope reference for identity and
current eligibility checks; marker records contain scalar copies, with no retained
rows, payloads or events. A ready/non-test generic first-bind snapshot can establish
an initial bounded source time. Subsequent getters, frames and probes cannot renew
it; the correlated source still requires a genuine post-bind push.

The cosmetic source cannot authenticate a user, assign a room, renew a presence
lease, or change provider flags or watches. It is not a general acceptance of
test data. Before 150, a stationary native push gap of 30 seconds also removed
already admitted colors despite ongoing fresh private presence.

150 closes acquisition at the same 30-second source deadline without renewing
that timestamp. An already painted association may continue only while the exact
same TextField, plate and entity ID remain in the current public collection,
the normalized visible name is unchanged, the full visibility chain is valid,
the ID is unique, and the complete current owned envelope still corroborates
nonlocal/nonhostile/not-wanted eligibility. The original host, binding, private
context and reset generation must remain current, and an unexpired private lease
must still include that name. Cached reads corroborate eligibility; they never
establish a new association or source timestamp. A hidden/recycled/renamed,
ineligible or withdrawn association is removed, and expired evidence cannot
reacquire it merely because the label becomes visible or a new private reply arrives.
Auth/room/world/stage/binding resets, teardown and paint failure remove admissions.
Private lease submission deadlines, backend observation expiry, room authority,
readiness flags and watches are unchanged. This is a deliberate cosmetic
continuation policy, not extended marker freshness or authority. Native stability
still requires a stationary run exceeding the source deadline on both providers.

150 diagnostics add fixed `currentSource` (not-read/absent/scope/getter/envelope/
flags/rows/valid), `sourceExpired`, and bounded `privateMarkers`, `visibleLabels`,
`privatePlates`, `currentRows`, `uniquePlates`, `exactLabels` and `retained` counts.
They expose remaining matching/visibility rejections without identities or raw data.

It does not distribute a replacement HUDMenu, TeammateNameplate class, game font
or any original Text Chat asset. It changes only the existing name field's color.
Vanilla visibility, distance, titles, icons and hostile/wanted colors remain
authoritative. A recycled label must match its current marker before it is tinted.

The candidate paints at stage `Event.RENDER` priority `-10000`, after vanilla's
default-priority deferred redraw. It retains a frame hook for expiry and cleanup,
and removes both hooks on teardown. It restores the last observed vanilla color
when disabled, expired, unloaded or excluded, without calling `SetIsDirty` during
RENDER. Frame ordering, stationary source availability and performance must still
be tested in GFx; Ruffle passing does not establish native stability. The painter
source is shared with bridge **0.2.18** for local regression builds. It establishes
the cosmetic context before binding and taking the first generic marker snapshot,
so a stable snapshot is not immediately retired by the context change. The
bridge also requires the current world to match its last successfully saved
active export before requesting cosmetic presence or binding, with a recheck
after native calls. Deferred/failed exports cannot authorize a new world.
The existing distributed DEV **0.2.10** ZIP is unchanged. The previous complete
93/93 local harness covered rebuilt 0.2.12 and 0.2.13 bridges; the new complete
93/93 reruns cover rebuilt 0.2.14, 0.2.15 and 0.2.16 packages.
No harness result accepts native game behavior.

In 2.10.145, a caught frame/RENDER failure restores vanilla colors and preserves
still-valid marker evidence. The next callback revalidates its original source
age, context/generation, private lease and current public rows. Auth/room/world
resets, expiry and teardown still retire the source. Only a genuine native push
can renew correlated source age. Confirmed HUD rosters now send every ten seconds
under the existing fresh-observation and nonblocking gates, with headroom before
the backend's unchanged 30-second evidence deadline; private lease TTLs are unchanged.

The ten-second diagnostic also records bounded `frameErrors`, `renderErrors`,
`lastPaintErrorCode`, fixed `lastPaintErrorHook` / `lastPaintErrorPhase`,
`clearCount`, fixed `lastClearReason` and `markerAgeMs` (`-1` when absent, otherwise
0–30000). Error evidence survives successful painting; paint faults do not count
as source clears. Clear reasons are `explicit`, `binding`, `stage`, `host`, `room`,
`auth`, `gated`, `context`, `source-expired` or `shutdown`. No native exception text
is included. Fresh 2.10.145 logs confirm recurring error 1006 during restoration.
The shared 2.10.146 painter avoids `Array.remove`, whose Flash 19 helper calls the
unavailable `removeAt`, and uses `indexOf`/`splice` for expired and recycled plates.
This compatibility change does not renew source timestamps or private leases.

HUD 2.10.139+ logs a bounded `nameplates` record every ten seconds through the
selected provider: a fixed request gate, request/accepted/rejected counts, pending
state, remaining lease, name count, automatic frame count and painter marker/
plate/painted counts. Names, tokens, account IDs, request IDs and contexts are
excluded. These diagnostics do not change authentication, membership or leases.
From 2.10.148, `requestPhase` is one of `waiting`, `retired`, `binding`, `throttled`,
`pruning`, `queuing`, `encoding` or `ready`. `ready` means the control payload was
prepared, not that the native provider delivered it. The world timer separately
labels `nameplates`, `nameplates-request`, `nameplates-bind` and `nameplates-send`
to distinguish method-entry verification from runtime pruning/binding/transport.
Version 2.10.149 adds `pruning-call`, `queuing-call` and `encoding-call` before
the separate helper invocations; each helper sets its entered phase on entry.
The widget separately records `nameplates-clock` and `nameplates-session` before
`nameplates-request`. The world catch captures the current request phase, bounded
`errorID` and `missingClass`. Only the class identifier from the canonical VM
1014 template is permitted; other messages become `not-reported`. The diagnostic
fallback uses `errorID=unavailable` if its formatter cannot run. Raw exception
messages, stacks, names, native/session IDs and control payloads are excluded.
These records are diagnostic only; they cannot authorize or renew presence.
The shared `FcmRuntimeError` module holds the bounded parser; the bridge's existing
`FcmBridgeRead` API delegates to it. Widget builds do not require bridge-only classes.
Version 2.10.140 also records the painter's bound/subscribed state, lifetime
bind/pull/push/observation counts, fixed bind/read phases, ready/test flag states,
bounded row/skipped/eligible counts, numeric bind error and whether its manager
matches the widget's roster manager. Missing/throwing flags remain ineligible for
both source paths.
These records distinguish a failed subscription from a rejected provider envelope;
they do not establish a fix for the native zero-marker failure.

Candidate 2.10.141 resolves the public manager definition from the movie owning
`TeammateMarkerBase`, through its `loaderInfo.applicationDomain` (or that movie's
root loader info). It uses the existing supplied manager when the host domain or
required callables are unavailable. Resolution creates no watches and never
changes a provider's readiness/test flags. A callable host manager takes priority;
an unready/test host envelope is still rejected. The log adds fixed
`managerScope`, `hostManager` (same/different/missing/unavailable/not-callable) and
numeric `domainError` fields. This tests a source-selection hypothesis: 2.10.140
received peer names but rejected every sampled marker envelope as unready/test
data. Fresh 2.10.141 logs on both providers report the same manager and the same
rejection; host-domain selection did not fix painting. The distributed bridge
0.2.10 artifact predates this source-selection change.

Historical diagnostic 2.10.142 compares the event payload with its own provider and cached
getter. Fixed same/different/missing labels reveal ownership without logging
values. Its additional CharacterInfoData comparison is inconclusive: the active
HUDMenu declares that field private, contrary to the diagnostic fixture's public
field assumption. `characterPayload=missing` cannot establish a separate cache;
candidate 2.10.143 removes that invalid private-field probe. It also counts raw rows,
eligible rows and visible name/entity
matches, and records whether the public manager exposes its native watch-removal
method and the provider's SetReady argument count. Neither method is invoked.
Extra reads use `GetDataFromClient(key, false)` at most once per ten seconds.
They cannot create a watch, alter flags, feed marker state or renew any lease.
In 2.10.142, even a populated, corroborated test envelope remains rejected by the painter.
The diagnostic was installed on the desktop/xScal and laptop/ZFE after a clean
91/91 local Ruffle pass, with exact archive/backup and preserved-file checks.
It is not published. Fresh 2.10.142 logs on both providers confirm populated
marker data with an eligible row matching a visible plate, identical sampled
event/provider/getter payloads, and zero painting. The envelope still reports
`dataReady=false isTest=true`, so the painter rejects it before copying rows.
This confirms the immediate rejection point, not the native registration cause.

The 2.10.144 follow-up review reproduced and fixed immediate link-notice
retirement and recovery after a failed subscription to the exact same manager.
Both providers also pass sealed UInt upper-range matching and explicit rejection
of conversation suffixes. Healthy bindings preserve source age; old pending
replies stay rejected after relinking. Native acceptance remains pending.

## Presence and authentication

The backend intersects the viewer's observed player names with fresh, authenticated
FCM peers already assigned to the **same canonical room** by the existing room
coordinator. Both public account handles and roster-derived self-name aliases
can match. Names are cosmetic evidence; they never authenticate accounts, grant
room authority or merge worlds. Nonusers remain their normal color. Discovery can
take longer when mutual roster evidence is missing.

HUD clients use their existing linked native identity and confirmed world request.
Separate HUD credentials can link to the same FCM account; the backend excludes
the requesting native identity when selecting peers. Each peer still needs a
fresh, observed game-name match in the viewer's canonical room.
Terminal HUD authentication or link failures immediately retire private presence
and painted colors; they do not wait for the remaining lease to expire. Recovery
requires fresh valid presence and source evidence.
The Server Bridge keeps desktop sign-in and Server chat on the existing scoped
export path. Its optional native connection is only a cosmetic receiver: it sends
no roster/world controls or ordinary chat. A native transport token does not need
to be linked. The backend accepts a bridge request only when its exact movie
session and world generation belong to a fresh authenticated desktop observation,
the original connection owner is still current and its session still exists.
Another device's account-wide/native link cannot substitute for that observation.

From 2.10.146, clients request at most once per three seconds. The HUD retains its
five-second poll timer; the shorter minimum prevents slightly early ticks from
skipping a full renewal interval. The bridge retains its existing bounded poll
loop. Requests are scheduled from the current submission, with no catch-up bursts
after a stall. The backend's unchanged four-per-ten-second native-identity limit
still applies. Replies are private system events,
addressed to that native subscriber only; they never enter history, community
feeds, Discord or public APIs. Responses contain at most 24 normalized names,
the request ID, context and a lease of at most ten seconds. Leases start at client
request submission, so delay or replay cannot extend them. From 2.10.147, clients
retain at most four unexpired request IDs, revisions and submission times in the
exact current context. A renewal submission does not discard a prior still-valid
reply. A newer accepted reply, including an empty withdrawal, retires all older
requests so out-of-order replies cannot override newer presence. Replay is rejected,
and world/auth/same-context generation resets discard every outstanding request.
Server-side freshness remains bounded by the original
30-second roster/desktop observation deadline; transport heartbeats cannot refresh
it. A remote peer that stops producing observations can remain blue until that
deadline, while the viewer clears locally on its own world/session loss.

Reserved relay request bodies are `FCMCTL/1/NAMEPLATES;` followed by strict JSON:

```json
{"mode":"hud","requestId":"req-1","nativeRequestId":"world-1"}
{"mode":"bridge","requestId":"req-1","sessionId":"movie-1","worldGeneration":"world-1"}
```

The private `chat.message` has `channel:system`, `senderUserId:system` and a body
beginning `FCMNAMEPLATES/1;`:

```json
{"version":1,"requestId":"req-1","context":"bridge:movie-1/world-1","ttlMs":10000,"names":["peer"]}
```

Invalid contexts, replaced owners, logout, bans, stale evidence and mismatched
canonical rooms yield an empty, zero-duration response. Requests have an independent
four-per-ten-second limit and cannot consume room-control/chat-send budgets.
Normal linked-account chat and moderation gates remain enforced.

## Configuration and testing

HUD users can set `blueNameplates=false` in `Data/FCMChat.ini`; the default is true.
Existing configs without the key inherit that default. The bridge's Server export
continues to work without native chat. To enable its blue-name receiver, install
the package's **FCMServerBridge** ZFE TextChat fragment, or merge its xScal
`[Chat] enabled=true` and matching `relayEndpoint` settings. Choose exactly one
provider and one FCM child. There is no bridge editor, hotkey or linking screen.
ZFE must advertise asynchronous connect, send and control; older providers leave
the cosmetic receiver unavailable without blocking exports.
The contracts come from the provider's [ZFE Chat Relay Guide](https://www.nexusmods.com/fallout76/articles/256)
and [xScal](https://www.nexusmods.com/fallout76/mods/4183).

The default desktop overlay still reads only its bounded, explicitly installed
provider export files. It gains no game-file writes, direct native/game access,
injection or network scanning.

Use the [candidate test matrix](../../testing/blue-nameplates-2026-10-06.md) with
two distinct Bethesda/native identities in one world. Separate FCM accounts and
two native identities linked to one FCM account are both supported. The matching
backend must be deployed to the chosen environment before the ZIPs can show blue names. Test packages are
kept separate from production release artifacts and the golden QA overlay lock.
