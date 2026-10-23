# FCM Server Bridge 0.2.19 source candidate

Fresh 0.2.18 native probes on both providers report `receive:E1014` with zero
private requests and accepted replies, while roster exports remain active.
0.2.19 separates cosmetic connect, auth, poll, event decoding and request/send
methods, following the working visible HUD's staged lifecycle. The orchestration
method no longer contains JSON encoding or an event-array cast/loop. This is a
controlled native compatibility candidate, not an identified missing class or a
confirmed color fix. It shares the unchanged HUD painter and lease policy.
Boundary unit tests cover exceptions and unload during all four native calls;
the isolated provider harness also tests unload inside native auth.
All required local checks pass, including 97/97 Ruffle cases. The exact DEV probe
archive was installed on desktop/xScal and MSI/ZFE with protected files unchanged.
Both native receivers now advance accepted replies without the recorded E1014,
and the user reports working colors. The desktop has since switched to the
tested visible HUD for mixed-client validation; broader native acceptance remains
pending. No hosted CI run or publication is claimed.

The 2026-10-23 local overlay test reached one canonical room on both providers
but showed no blue names. `package.py --target dev --nameplate-diagnostic`
provides an unpublished gate/error probe in the existing export build field.
See the [native investigation](../../../docs/testing/blue-nameplates-2026-10-23-bridge.md).
This is diagnostic evidence collection; it does not claim a native color fix.

0.2.18 shares HUD 2.10.150's stationary continuation for already admitted exact
visible field/plate/entity/name associations under current eligibility and fresh
private presence. Source acquisition expires at its original 30-second deadline;
hidden, recycled, ineligible or withdrawn associations retire and cannot be
reacquired from expired evidence. Source timestamps, private TTLs and export/room
authority are unchanged. Required local regression gates pass, including all
93 Ruffle cases; no new bridge distribution/install or native acceptance is claimed. See the
[full cosmetic policy](../../../docs/overlay/zfe/blue-nameplates.md).

0.2.17 retains the five-second unchanged-roster xScal export coalescing and the
optional 0.2.10 blue-name receiver. It shares HUD 2.10.149's correlated marker
source, deferred redraw handling, transient paint recovery and persistent numeric
error/clear diagnostics. Paint cleanup uses GFx-compatible `indexOf`/`splice`, and
private requests retain a three-second minimum interval with unchanged bounded TTLs.
At most four unexpired same-context replies may overlap; a newer accepted reply
fences older replies, and resets clear every pending request.
Pending pruning uses indexed `splice` operations with fixed request phases after
HUD 147 native error 1014. Fresh 148 native acceptance also fails. The 149
experiment separates pruning, queueing and encoding methods with fixed
call/entered phases. Native compatibility remains unverified.
It establishes the cosmetic context before
the painter's first snapshot, and fences requests to the last successfully saved
active export world. The distributed DEV 0.2.10 ZIP is unchanged. The source
candidate is not published or native-accepted. The packaged
0.2.8 bridge remains the current public release until the new candidate passes
native room, travel, and lag acceptance and its exact ZIP hash is pinned by the
overlay release packaging scripts.

Invisible, optional HUDModLoader child. Sign into the desktop overlay only.
No bridge login/code/pairing, input editor or helper service. Optional blue names
use a separate native-chat receiver for private cosmetic presence; disabling it
leaves the export-only Server bridge working. See the
[blue-name contract](../../../docs/overlay/zfe/blue-nameplates.md).

Requires official ZFE scoped storage or xScal 0.2.17+ named modStorage plus HUDModLoader.
Install BA2 and merge loader/archive configs with the game closed; preserve unrelated
mods and recoverable backups. Never coinstall visible FCMChatWidget or legacy FCMBridge.
See [INSTALL.template.txt](INSTALL.template.txt) and the maintained
[architecture/protocol guide](../../../docs/overlay/zfe/background-server-bridge.md).

## Contract

- `FCMServerBridge`: bounded native UI observations and subscriptions,
  deferred refresh and lifecycle disposal. Optional cosmetic native chat does
  not authenticate the overlay, assign rooms or alter exported observations.
- `FcmBridgeState`: copied observations, source precedence, world generation,
  fast-travel continuity and 30-second expiry.
- `FcmBridgeExport`: schema-1 bounded snapshot, maximum one write/sec. xScal
  coalesces unchanged-roster observations to a five-second export cadence after
  two startup writes; ZFE keeps its existing observation cadence. Material
  state/roster/world changes bypass coalescing. Separate observation sequence/age
  prevents stale heartbeat renewal.
- `FcmBridgeStorage`: xScal 0.2.17+ named `load(name)` / `save(name, document)`, or validated ZFE
  `zfe-storage-v1` + `writeStorage`. Independent of native chat authentication.
  Modern aliases win before the legacy `BRG_OBJ` fallback; every route must pass
  the same storage capability check. The bridge registers no menu or input listener.

Export contains no credentials. Environment is compiled into the SWF.
The overlay validates advancing local snapshots and forwards them through its
authenticated socket. Backend confirmation enables Server. HUD and bridge users
must share the same canonical room/history/publication across all provider pairings.
Roster names supply mutual-discovery evidence, not account authentication or an
authoritative world ID.

The previous local 0.2.12 regression build passed the pure/export/package checks and the
complete 93-case provider harness, including an initial live marker snapshot
without subsequent pushes, same-context resets, successful-export fencing,
hops, fresh marker recovery, expiry and teardown. Native acceptance is pending;
the requested local deliverable is HUD 2.10.150. The preceding 0.2.17 local pure/package and
complete 93-case provider rerun pass;
no new bridge distribution or installation is requested.

## Build and verify

Requires Haxe 4.3+, Python 3 and simulator dependencies. From this directory:

```bash
haxe test-state.hxml
haxe test-export.hxml
python3 test_package.py
cd ../hudmodloader-chat
for suite in test-*.hxml; do haxe "$suite" || exit 1; done
npm test --prefix simulator
cd ../hudmodloader-bridge
python3 package.py --target dev --output ../../../_dev-test-builds/server-bridge-0.2.16/FCM-Server-Bridge-0.2.16-DEV.zip
```

Also run parent native-adapter/auth/source checks and affected backend, overlay and
dashboard suites. Both package targets require normalized FWS v32, one BTDX v1 GNRL
entry `Interface/FCMServerBridge.swf`, decoded-byte equality and no login, harness,
chat widget or input symbols. Only the optional cosmetic receiver and painter
may use native-chat/render surfaces. Packaging during tests is an owned test
fixture, not install approval.

`haxe build.hxml -D bridge_dev` compiles Dev; omitting the define compiles Prod.
Neither command installs or publishes. Do not apply the widget emoji normalizer.

For a native lag investigation only, add `--diagnostic` to `package.py`. This
compiles a separate test candidate with `bridge_perf`; do not distribute it as a
release. Its existing export `build` field adds `p`, `e`, and `s` last/peak
millisecond pairs for the two-second world observation pass, JSON encoding,
and native storage save. Peaks accumulate for the current HUD movie session;
encode and save samples appear in the following export.
For example, `0.2.16-c5-perf:p4/18:e0/2:s1/27` means the latest/peak save took
1/27 ms. Values are capped at 9999 ms; no names, raw identifiers, or extra
storage writes are included. The regular build keeps the exact `0.2.16` marker.
Compare the same game/world with the bridge absent and present while keeping
xScal, HUDModLoader, and other mods unchanged. Ruffle cannot prove native
frame timing; keep this candidate native-unverified until an in-game test.

The complete Ruffle suite includes storage-based combined lifecycle tests and an
isolated host loading the exact packaged child without production helpers. It
cannot prove native storage timing, GFx verification or game stability. Mark new
artifacts native-unverified until fresh two-client manual acceptance passes. No game
input automation.

0.2.1 restores the compatibility-dispatcher lookup omitted from 0.2.0's storage
adapter. Pure tests cover scope/parent/root lookup, provider priority, bad responses
and failed probes; isolated Ruffle cases cover fallback exports and capability
absence/recovery. This does not prove the installed ZFE fallback supports storage:
native acceptance requires a fresh export and confirmed overlay Server room.

0.2.2 adds diagnostic-only cached `Storage probe` and `Last failure` rows. Probe labels
separate discovery, native-call, parse, rejected-success and missing-capability failures;
outer lifecycle labels identify failures before storage discovery. Only fixed labels and
validated numeric error IDs are exposed, never replies, exception messages or roster data.
`Last failure` retains the last caught lifecycle error until movie reload; it is not current
health. Probes keep their existing five-second cadence and capability requirements.
The public read-only diagnostic method is observed by the isolated Ruffle host without
production helper linkage.

0.2.3 replaces runtime-info and write-acknowledgement decoding with the existing HUD's
bounded `FcmJson` reader. The 0.2.2 laptop screenshot confirmed `__SFCodeObj parse E1014`
while the roster was fresh; the exact missing class was not reported. Package validation
now rejects `JsonParser` linkage. Capability and successful-save checks stay mandatory,
and the visible HUD is unchanged. Pure and isolated Ruffle tests cover malformed/oversized
replies and recovery. The 2026-09-17 laptop check verified active, advancing ZFE exports;
the user reported it working. Full mixed-client room/message/travel acceptance remains
pending; see the dated evidence linked from the architecture guide.

0.2.4 prefers the fresh local-player name exposed by the same accepted roster source over
`AccountInfoData` when writing `ownName`, with the account name retained as a fallback. This
aligns bridge evidence with the name peers actually observe without treating either value as
authentication. Freshness, generation, mutual-sighting and bounded-export rules are unchanged.

0.2.8 uses xScal 0.2.17's stateless named storage calls for the bridge export. It does not
claim the legacy HUDMenu-wide registration slot, so Improved HUD can continue using its own
`improvedbars` document while FCM writes only `fcmserverbridge-dev` or
`fcmserverbridge-prod`. Older xScal builds retain the legacy adapter for standalone
compatibility, but 0.2.17+ is required when another HUD child also uses modStorage.

The 0.2.9 release candidate leaves two-second roster polling intact but
coalesces xScal exports when only the observation timestamp/sequence changes.
It still sends two advancing startup snapshots and promptly exports roster,
world, active/holding/inactive, and self-name changes. The candidate is not a
published or native-accepted fix; compare its save timing and perceived hitches
against the earlier diagnostic build before promoting it.

Previous native-network acceptance never certifies this storage-based candidate.
