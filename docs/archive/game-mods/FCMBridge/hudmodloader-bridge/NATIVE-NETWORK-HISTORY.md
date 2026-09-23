# Historical 0.1.x native-network bridge

Superseded by [0.2.0 local export](../../../../../game-mods/FCMBridge/hudmodloader-bridge/README.md). Old linking/network/install steps below
are historical evidence only, not instructions for current candidates.

# FCM Server Bridge 0.1.7

Separate invisible HUDModLoader child for Server chat in the FCM desktop overlay. Requires
HUDModLoader plus ZFE `chat.v1` or xScal `chatInterface`. It has no chat widget or chat editor;
HUDModLoader's menu shows connection status, a one-time link code and a reconnect action.

This is a local test candidate. The matching backend and shared overlay changes must be deployed
to the same environment before hosted end-to-end use. Bounded desktop ZFE startup, room binding,
send/echo and same-world travel acceptance passed; native xScal, Windows and broader lifecycle
acceptance remain pending. No publication is claimed. See the
[architecture, protocol and acceptance guide](../../../../overlay/zfe/background-server-bridge.md).

## Restored-reader candidate (0.1.7)

The [HUD release record](../../../../deployment/hud-2.10.110-release-notes.md)
and its native evidence supersede the earlier recommendation to repeat the synthetic probe.
HUD 2.10.105 already failed that probe before decoder entry; 2.10.106 restored populated reads
by returning to the earlier split traversal. Subsequent 2.10.109 runs confirm automatic Server
binding on both providers. That evidence belongs to the visible HUD, not this bridge.

0.1.7 adapts the bridge reader to that split: map/public-team lists use the same
`FcmRoster.readNames` helper as the accepted HUD; player/party/marker/voice lists use a separate
bounded traversal. The rejected unified decoder is not used. The visible widget and its
released artifacts are unchanged. Invalid/damaged lists cannot replace world evidence.

The collector now retains only copied signatures, timestamps and local revisions. A new wrapper
around unchanged getter data cannot renew freshness; a validated push or changed normalized
names can. Readiness/test-provider gates, menu/loading rules, nonces, relay confirmation,
30-second observation expiry, 45-second backend leases and capped exception backoff remain.
The bridge already refreshes auth on every poll and has no HUD history-RESYNC loop, so the
visible HUD's pending-auth and queue-retirement fixes are not copied into unrelated paths.

This candidate is **installed locally for hosted Dev as of 2026-09-16**, after the complete local
gate; it is **not published or fully native-accepted**. The visible widget was removed to a recoverable
backup, the existing ZFE provider retained, and an isolated Dev overlay rebuilt and launched.
The initial desktop ZFE roster → relay room → same-account Dev overlay test passed, including
user-confirmed send/echo and retained history through one same-world travel. The desktop now
uses xScal 0.2.16 and the laptop ZFE 0.15.0 for their next independent tests.
Passing Ruffle cannot prove GFx compatibility; the failed 0.1.5/0.1.6 builds passed there too.

## Previous shared collector candidate (0.1.6)

The user's 0.1.5 screenshot still reports `processor entry E1014` for all six sources,
eight subscriptions, world allowed, and `Missing class - not reported`. This is failed native
acceptance; the unidentified runtime exception is not claimed fixed by this refactor.

Bridge 0.1.6 used `FcmHudRosterReader`, which normalizes bounded strings and emits
observations with source, local revision, timestamp and fixed failure reason. The visible HUD's
2.10.104 candidate uses its own direct decoder, but also failed native acceptance with E1014.
HUD 2.10.105 adds diagnostics to that path; neither change establishes a bridge fix.
`FcmBridgeState` receives copied values only: its snapshots no longer retain native payloads, and
its menu input is a decoded allowed/loading observation. Manager/push envelopes remain in the
game-facing adapter so readiness provenance is preserved.

In 0.1.6 an unchanged getter cache kept its original observation time. A validated push, changed payload
identity or changed normalized contents advances its local revision/time; these revisions are
not world IDs. Old-world revision blocking, source precedence, loading holds and 30-second/45-second
observation/backend expiry remain in force. An older auxiliary observation cannot move the global
freshness time backward. Damaged lists are rejected, not accepted as empty or partial worlds.
Thrown roster reads use per-source 2/4/8/16/30-second capped backoff, cleared on successful reads
or manager detach. This does not extend any lease. No new native/network operation is introduced.

The complete suite now includes the [isolated packaged bridge](../../../../testing/hud-automation-plan.md#isolated-packaged-bridge-gate),
in addition to the combined lifecycle harness. Local test success is not proof that E1014 or the
earlier game freeze has been resolved. The tested 0.1.6 DEV package was installed locally with
the game closed on 2026-09-16; its subsequent native roster acceptance failed and it is not published.
The fresh screenshot reports `payload E1014` on Voice/Party/Public Teams/Map and `test provider`
on Team Markers/Player List, with no observed roster. These test flags belong to the game's
provider envelopes, not the Ruffle host. The failing native operation/class remains unidentified;
see the [evidence record](../../../../testing/hud-xscal-acceptance-2026-09-15.md#016-native-result--payload-boundary-still-failing).
The previous
0.1.5 files/configuration snapshots are recoverable from `.extender-backups/before-bridge-0.1.6-ZWFYVW/`
in the game directory. Extenders, native credentials and effective Dev configuration were unchanged.

## Build and verify

Requires Haxe 4.3+ and Python 3. From this directory:

```bash
haxe test-state.hxml
python3 test_package.py
cd ../hudmodloader-chat
for suite in test-*.hxml; do haxe "$suite" || exit 1; done
npm test --prefix simulator
cd ../hudmodloader-bridge
python3 package.py --target dev --output ../../../_dev-test-builds/server-bridge-0.1.7/FCM-Server-Bridge-0.1.7-DEV.zip
```

The package helper compiles the selected target, normalizes to FWS v32, builds a BTDX v1 GNRL
archive, validates the sole `Interface/FCMServerBridge.swf` entry and exact decoded SWF bytes,
and writes the ZIP with its manifest and instructions. `--target prod` changes the compiled
link URL and both native endpoint examples; it does not publish or install anything.
`haxe build.hxml` is a compile-only production-link build; add `-D bridge_dev` for a DEV link URL.
Do not use the visible widget's emoji-embedding normalizer on this small background SWF.

Every bridge change must pass its pure state/package checks and the full shared Ruffle suite
before producing an install candidate. The `bridge-fast-travel` scenario loads the actual
invisible bridge (without the visible widget), exercises both native adapters, and verifies
binding continuity, real-hop rebinding, expiry, MainMenu leave, and timer/subscription teardown.
Three repeated transitions assert recovery to the map source and fallback to overlapping public
teams while the map stays empty, with no intermediate room/nonce churn or redundant controls.
Playwright requires each cycle's pass marker, not only an eventual terminal pass. Follow the
[complete change-to-install gate](../../../../testing/hud-automation-plan.md#required-change-to-install-flow),
including desktop/backend tests and exact installed artifact hashes.
It sends no hosted messages or game input. CI runs these through `gamemod-anchors` and
`hud-ruffle`; local success is not hosted CI or in-game acceptance.

## Same-server continuity

0.1.1 retains the nonce/room through a brief `LoadingMenu` and unchanged/overlapping post-load
roster. Fresh map/player lists take precedence over nearby markers. An empty higher-priority
list permits populated player/public-team fallback only with overlap in an established session;
stale disjoint lower-priority names cannot override it. Snapshot callbacks only
collect evidence; session decisions follow the complete refresh. Transient empty primary lists
get at most 30 seconds to recover, without extending the backend's independent 45-second lease.
No roster heartbeat or LEAVE is sent during that hold. Prolonged loading also expires at the
existing 30-second observation limit. MainMenu, manager replacement and a disjoint effective
roster still retire the old binding; stale auxiliary snapshots cannot seed the new world.

## Provider events and reconnect safety (0.1.2)

The bridge consumes `FromClientDataEvent.fromClient`, preserving the provider's real
`dataReady`/`isTest` flags, instead of rereading a potentially older getter inside the callback.
Newer pushed envelopes win while a getter disagrees; their original observation time is retained,
and an expired divergent push cannot roll back to the stale getter. No readiness or lease gate
is relaxed. The harness uses compiled AS3-style accessor envelopes/events and verifies this
divergence, expiry, rejected test providers, nested data delivery and teardown on both adapters.

Reconnect clicks coalesce into a refresh on the guarded timer tick. A healthy subscription keeps
its room, cursor and native credentials; the menu callback no longer enters native disconnect.
Provider callbacks update only local evidence; identity-change reconnects happen after the batch.
Transport-error reconnect/unload still uses the native disconnect contract. Deferral/reentry guards
do not make that native operation nonblocking, and the reported native freeze is not yet proven
resolved. ZFE roster/leave calls additionally require the advertised async-control capability.

Provider-supported diagnostics use vendor `FCMServerBridge`: version/provider, fixed status,
connected/auth/in-world/fresh/bound booleans, and phase entry/exit/elapsed time for connect,
disconnect and controls. Output is capped at 24 entries/minute, with stable summaries at 30 seconds.
No names, room IDs, codes, credentials or wire payloads are logged. An absent optional xScal logger
is not a failure to load. Fresh game acceptance is still required before distribution.

## Native readiness diagnostics (0.1.3)

The 0.1.2 native run remained at “Waiting for a fresh world roster” even after the user opened
the map. That status is assigned only after authentication, but does not identify which data
gate failed. The optional xScal logger produced no bridge diagnostics. This is **not fixed or
native-accepted** by the 0.1.3 diagnostic candidate.

F11 → FCM Server Bridge now includes the version/provider, a cached Menu reason, overall roster
freshness, and one fixed diagnostic label for each of the six roster providers. Reasons distinguish
missing/test/unready providers, missing/invalid list shape, world/loading gates, old-world cache,
expired divergent push, failed reads and accepted observations. “Accepted” describes the latest
read, not a confirmed server room; the separate freshness/status rows remain authoritative.
Rows contain no names, room IDs, request IDs, credentials or payloads. Opening the menu neither
reads providers nor calls the native transport or refreshes a lease. Readiness and transport behavior
are unchanged. If the wait persists, capture these rows rather than repeatedly pressing Reconnect.
The pure state tests and both actual-bridge Ruffle scenarios assert reasons, inert menu rows,
privacy and no read/control/nonce mutation during menu preparation.

## Native exception diagnostics (0.1.4)

The installed 0.1.3 screenshot shows `Menu - world allowed`, `Roster - not observed`, and
`read failed` for all six roster sources. That catch covers the getter **and** processing;
it does not prove `GetDataFromClient` failed. The installed HUDTools SWF was extracted and
decompiled: its provider/accessor contract matches the interface used here. The actual native
exception remains unknown. See the [dated evidence](../../../../testing/hud-xscal-acceptance-2026-09-15.md#013-native-exceptions-and-014-diagnostic-candidate).

0.1.4 records a phase per observation attempt, so nested callbacks cannot overwrite each other's
diagnostics: getter, push cache, processor entry, flags, payload, list shape, cache check, names,
normalize or store. An escaping exception shows that phase plus a numeric `errorID` (for example,
`getter E1014`), or `error` if no valid integer ID is available. These examples are simulated,
not codes observed in Fallout. The menu also reports successful subscriptions out of eight and
the latest subscription error ID. Neither exception text nor stack traces/payloads are displayed.
Existing field-access helpers still absorb optional-field exceptions; only failures escaping
observation reach the phase diagnostic. This is not a log of every property access.

Both provider harness scenarios require `BRIDGE-ERRORS PASS`: an actual AVM2 getter error must
remain distinct from a nested name-conversion error; failed observations must not establish
membership; a subscription exception must be visible without its private message. The conversion
fixture asserts it throws before use (Haxe catches anonymous-object `toString` failures on Flash).
Readiness, retry/transport calls and session/lease lifetimes remain unchanged. This diagnostic
candidate is **not a native fix or native-accepted build**. The tested DEV package is installed
locally with xScal as of 2026-09-16; its failing native result is recorded below.

## E1014 class identifier (0.1.5)

The native 0.1.4 screenshot reports all eight subscriptions registered, an allowed world menu,
and `processor entry E1014` for every roster source. The
[ActionScript reference](https://airsdk.dev/reference/actionscript/3.0/runtimeErrors.html)
defines E1014 as an unresolved class. The installed bytecode dispatches directly to `FcmBridgeState.observe`
at that phase; it contains the method and its directly referenced helper classes. The screenshot
therefore narrows the failing boundary, but does not name the unresolved runtime dependency or
prove a packaged class is absent. The method's first `flags` diagnostic was not reached.

0.1.5 adds one inert cached `Missing class` row for the latest E1014. It accepts only the VM's
exact `Class <identifier> could not be found.` message template (optionally prefixed by
`Error #1014: `), extracting a bounded ASCII class identifier. No arbitrary message, stack,
URL, payload or delimiter is rendered; other formats show `not reported`. This depends on
the native VM supplying that message: a numeric-only/localized error cannot name its class.
The diagnostic changes no provider, world, roster, retry or lease behavior. The tested DEV
package is installed locally with xScal as of 2026-09-16, **not native-accepted**, and is not a
confirmed functional fix.

Pure tests and both compiled Ruffle scenarios cover valid class identifiers, actual AVM2 Error
accessors, noncanonical/private text rejection, reset, and no membership/control mutation.
The existing bridge scenario compiles the bridge into the shared harness movie; it is not an
isolated execution of the packaged bridge in native GFx and cannot certify native class resolution.

## Install

Every ZIP includes a complete `INSTALL.txt` generated from the maintained
[installation guide template](../../../../../game-mods/FCMBridge/hudmodloader-bridge/INSTALL.template.txt), with its version, environment, relay
endpoints and linking URL filled in. It covers prerequisites, exact destinations, preserving
existing INI entries, switching from the visible widget, both provider choices, account linking,
expected Server-tab behavior, troubleshooting, updating and uninstalling. Start with that file
after extracting the download; the `.example` files are references for manual edits.

Follow the instructions with the game closed. Append `FCMServerBridge` to the existing
HUDModLoader registry and `FCMServerBridge.ba2` to the existing archive list; preserve other
entries. Install only the selected extender's configuration example. ZFE global overrides take
precedence over the fragment. The ZIP contains no automatic installer or native executables.

Disable the visible FCMChatWidget and legacy FCMBridge entries before enabling this mod; they
share a native queue. Open F11 / HUDModLoader → **FCM Server Bridge** and redeem the code at the
specified `/link` page using the same account as the desktop overlay. Join a world and allow the
roster/lease to confirm. General and Server then show the same canonical server records.

The mod reads only real, ready HUD providers. Mutual sightings infer rooms; they are not an
authoritative world identifier. Incomplete HUD data can split same-world players. Two-client
in-game testing under each native provider remains required.
