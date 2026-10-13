# Blue nameplates: stationary-retention candidate 2.10.150

Source: HUD 2.10.150 and shared bridge 0.2.18, locally verified. HUD 150 is installed
on both machines; native acceptance remains pending. The preceding installed 149
now progresses requests/replies on both providers without paint exceptions but
still flickers. See the latest native findings and continuation policy below.
Installed 148 passed local gates,
but fresh native acceptance fails with error 1014 and zero requests on both
clients. The preceding 147 also fails native acceptance. Previous 2.10.146 verification and packaging passed; it was installed with settings and login
preserved. The preceding 2.10.145 passed automated gates but fails native color
stability; native acceptance remains pending.
No public release, backend deployment or new bridge distribution is requested.

## Native evidence from 2.10.144

- **[Confirmed, user report]** Desktop briefly displayed Abdrann in blue, then
  restored normal color. The laptop never displayed Dev Attack in blue.
- **[Confirmed]** Installed archives on both machines match 2.10.144 BA2 SHA-256
  `c6ab4a154c1ec798827257548c4433f66a675c88e48919d099bf712a3067101e`.
  MSI now uses `D:\SteamLibrary\steamapps\common\Fallout76`, ZFE 0.21.1 and
  HUDModLoader v70; desktop uses xScal 0.2.20. Game runtime is Steam 1.7.26.22.
- **[Confirmed]** Read-only DEV backend evidence contains two distinct linked
  native identities on one FCM account. Both native clients accepted private
  replies with an eligible peer during some intervals. Same-account use is
  supported; it does not explain every zero-color interval.
- **[Confirmed]** Both logs admit populated `markerSource=hud-event` with
  validated eligible rows. The earlier registration-envelope gate is passed.
- **[Confirmed]** Other samples have zero private-lease time/names. Separately,
  source becomes `none` while the subscription remains healthy, observation
  counts remain unchanged and `readPhase=complete`. MSI first loses source
  within at most 15 seconds after binding. Later real pushes reacquire source.
- **[Deduced]** That first loss is not the 30-second source-expiry path, which
  sets `readPhase=retired`, and not detachment. Remaining matching paths in
  2.10.144 include widget auth/room/gate clears and frame/RENDER catches.
  Empty or expired private replies alone do not clear marker evidence.
- **[Hypothesized]** A native paint exception caused the reported source loss.
  Confirm with persistent frame/render error counters at the loss; refute if
  the error counters stay unchanged and an auth/room/gate clear is recorded.
  Current native logs cannot distinguish these paths.

Sanitized capture files in the conversation evidence directory are
`desktop-blue144-counts.json`, `laptop-blue144-counts.json`,
`laptop-blue144-timeline.json` and `dev-blue144-postmortem.json`. They contain
fixed states, counts, timings and labeled identity equality, without tokens,
raw account/native IDs or roster payloads. Backend room diagnostics record
changed roster contents; unchanged renewals need not produce a diagnostic row.

## Reproduced defects and focused changes

**[Confirmed] Roster timing:** the previous confirmed-roster threshold is
30,000 ms on a five-second poll timer; backend cosmetic observations expire
after 30,000 ms. Timer drift and delivery leave no renewal headroom. The new
pure regression fails at both the ten-second boundary and the modeled
timer/reply deadline on the old scheduler. The scheduler now uses 10,000 ms.
It still requires fresh observations, authentication, current world/session
and a safe nonblocking provider. No heartbeat renews stale observations.

**[Confirmed] Paint recovery:** a one-shot numeric lease-read exception through
the actual registered stage callbacks restores vanilla colors but discards
still-valid marker evidence in the 2.10.144 painter. Both simulated providers
fail the unchanged-source assertion for frame and RENDER faults. Evidence:
`hud145-paint-recovery-red.log` (ZFE) and
`hud145-paint-recovery-red-xscal.log` (xScal). The first xScal attempt's browser
setup timeout is infrastructure evidence; the isolated retry reaches the
scenario and reproduces the defect.

2.10.145 restores only painted colors after those errors. A successful later
callback revalidates the original age, envelope, context/reset generation,
private lease and current eligible public rows. It does not require another
native push while the original source remains valid. Expiry, auth/room/world
resets and shutdown continue to retire evidence. No timestamp or TTL is extended.

The ten-second diagnostic retains bounded error counts, last numeric error ID,
fixed error hook/paint phase, clear count/reason and bounded source age. A
successful paint does not erase the last error. Unknown clear reasons become
`explicit`; exception text and identity data are excluded. This telemetry is
needed to test the unresolved native cause, not evidence that the cause is known.

## Fresh 2.10.145 native flicker

- **[Confirmed, user report]** Blue names repeatedly alternate with normal color.
- **[Confirmed]** Both machines loaded 2.10.145. Both paint an eligible peer in
  some samples, and both retain accepted private replies with zero rejected replies.
- **[Confirmed]** Persistent errors repeatedly record `lastPaintErrorCode=1006`,
  `lastPaintErrorHook=frame`, `lastPaintErrorPhase=restore`. MSI also records one
  RENDER restoration error. The 2.10.145 recovery retains source evidence after
  those errors; they are not auth or room clears.
- **[Confirmed]** Private request counts sometimes advance only once in ten
  seconds, with zero remaining private lease between accepted replies. A pure
  regression reproduces skipped requests when a five-second tick arrives just
  before `nextRequest=previousSubmission+5000`.
- **[Confirmed]** Some native marker push gaps reach the original 30-second bound
  and record `lastClearReason=source-expired`, independently of private lease gaps.
  This availability limitation remains in 2.10.146.
- **[Deduced]** The native restoration error is the painter's `Array.remove`
  helper. The installed Haxe 4.3.7 Flash 19 path calls `removeAt`, and this project
  already avoids that unavailable GFx method for send timers. Two painter cleanup
  sites still use it. See the primary
  [Haxe 4.3.7 Flash helper source](https://github.com/HaxeFoundation/haxe/blob/4.3.7/std/flash/Boot.hx).
  A fresh 2.10.146 native run must verify that the restoration error stops.

Sanitized evidence is `desktop-blue145-counts.json`, `laptop-blue145-counts.json`,
`desktop-blue145-timeline.json` and `laptop-blue145-timeline.json` in the conversation
evidence directory. The MSI file also includes prior 2.10.144 rows; new analysis
selects 2.10.145 rows with persistent error fields.

## Focused 2.10.146 changes

**[Confirmed] Cleanup regression:** both provider scenarios fail the old painter
when the fixture-owned array's dynamic Haxe `remove` helper throws numeric 1006.
Expiry and recycled-name cleanup both invoke the helper. The corrected fixture
changes only that owned array, leaving global prototypes and sealed builtins intact.
Evidence: `hud146-cleanup-red-valid.log` and associated provider traces. The earlier
attempt to replace Ruffle's sealed `removeAt` raises 1037 and is invalid defect
evidence; it is retained separately in `hud146-cleanup-invalid-fixture.log`.
Production cleanup now uses `indexOf`/`splice` at both sites.

**[Confirmed] Renewal regression:** `hud146-cadence-red.log` fails on the old
five-second minimum because alternating early/late HUD ticks create ten-second
request gaps. Requests now have a three-second minimum beneath the unchanged
five-second HUD timer. This overlaps private leases without extending their TTL,
adding timers, catch-up bursts or changing the backend's four-per-ten-second limit.
Rapid calls remain throttled; newer requests fence old queued replies; stalls do
not revive expired leases. `hud146-cadence-green.log` passes those cases.

The shared bridge is versioned 0.2.14 for regression packaging only. DEV 0.2.10
and public 0.2.8 distributions remain unchanged. Source age, private submission
deadlines, eligibility, auth/link/room reset and teardown behavior remain bounded.
Steady native availability is not established by the cleanup and timing tests.

## Previous 2.10.145 verification and native acceptance

All required local gates passed before packaging or installation:

- 31 pure Haxe suites, nine source/package checks and empty widget/scenario diagnostics.
- Both focused recovery cases, with trace evidence, then the complete 93/93 Ruffle
  suite (7.5 minutes). Tested source hashes stayed unchanged and port 41739 closed.
- Backend Jest: 130 suites, 1,669 passed and nine existing skips; TypeScript:
  445 passed, zero skipped. An isolated working directory and disposable loopback
  Redis avoid local/prod dotenv state; Redis removal verifies.
- Overlay: 59 files / 1,303 passed; dashboard: 49 files / 490 passed.

The existing `gamemod-anchors`, `hud-ruffle` and unit-test CI jobs discover the
regressions. Hosted CI has not been triggered. Gate metadata is in
`game-mods/FCMBridge/hudmodloader-chat/.build/FCMChatWidget-2.10.145-DEV-GATES.json`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Normalized FWS v32 SWF | 7,228,000 | `023ee01772f368b91949e730f871a41124ea6320c246ee0273c03c6b3613a704` |
| One-entry BTDX v1 GNRL BA2 | 7,228,089 | `69292ef3c1354cc9fd0e4a6290d81b862f0bcb7371f6e86a70914bf80668344e` |
| Unified DEV test ZIP | 12,018,676 | `799e0bbc77658a9ae9f2bea0546803ff4f4d6a7af654d7833920f734a37c0d72` |

The ZIP passes CRC checks, has 16 entries, identical tested BA2s in both provider
folders and DEV configs. It contains no provider DLL/executable, bridge archive,
harness or game font. The rebuilt bridge 0.2.13 is a regression fixture only.

Both games were independently closed for replacement. Installed BA2 hashes match
the tested artifact; old 2.10.144 archive backups verify. All six desktop and seven
MSI provider/config/profile hashes are unchanged, and the recreated MSI native
auth cache is present and unchanged. Desktop retains Home/Delete; MSI retains
Period/Delete. Exact backups:

- Desktop: `.extender-backups/before-hud-2.10.145-paint-recovery-20261012T165947Z/`
  under the game directory.
- MSI: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.145-paint-recovery-20261012T170337Z\`.

The first MSI install attempt failed before replacing the archive because the
PowerShell call supplied an empty backup path to `File.Replace`. The original
2.10.144 hash remained intact. The corrected call uses a real temporary backup
path on the game volume; replacement and backup hashes then verify. Only the
tested HUD archive was replaced, and owned temporary files were removed.

Native acceptance requires a fresh 2.10.145 startup on both machines: same world,
nearby visible names, stable colors while stationary and moving, vanilla redraw,
auth/link/room reset, travel, expiry, nonuser/hostile/wanted exclusion and reload.
Preserve desktop Home/Delete, laptop Period/Delete and the recreated MSI native
login cache. Replace only the tested HUD archive while each game is closed.

A genuine native marker push gap of 30 seconds still expires the source.
Continuous stationary availability and native performance remain unverified;
the recovery/cadence changes do not establish either. See the
[bounded native matrix](blue-nameplates-2026-10-06.md) and
[preceding source-contract review](blue-nameplates-2026-10-07-review.md).

## 2.10.146 verification, package and local installs

All required local gates passed for the new source, with no hosted CI run claimed:

- 31 pure Haxe suites, nine source/package checks and empty widget/scenario diagnostics.
- Both focused cleanup cases pass (13.0 seconds), then the complete 93/93 Ruffle
  suite passes (7.6 minutes). All 149 frozen source hashes remain unchanged.
- Backend: 130 Jest suites, 1,669 passed and nine existing skips; TypeScript:
  445 passed, zero skipped and zero failures. The owned disposable Redis is removed.
- Overlay: 59 files / 1,303 tests; dashboard: 49 files / 490 tests.
- Packaged bridge 0.2.14 is exercised on both providers in its isolated host.
  Source tests and the provider harness remain covered by the existing required
  `gamemod-anchors` and `hud-ruffle` CI jobs.

The first post-run socket bind without `SO_REUSEADDR` falsely reports the harness
port unavailable because of TCP TIME_WAIT. No listener remains. An owned loopback
bind with `SO_REUSEADDR` verifies teardown; the initial check is retained separately
as `hud146-port-initial-timewait.json`. It is not a product regression.

The DEV ZIP has 16 entries and passes CRC and decoded payload checks. Both provider
archive copies equal the tested BA2. DEV endpoints, default blue-name option and
link URL verify; no provider DLL, executable, bridge, harness or game font is bundled.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `FCMChatWidget.swf` | 7,228,102 | `65888eca7925ff583a8ba209cd0c8c78c833983d581335fbe8e1f6f2adb776b4` |
| `FCMChatWidget.ba2` | 7,228,191 | `0c883faeddd426718b489e6196e90e54afdce065025f8f46b48dafb76e35d506` |
| `.build/FCMChatWidget-2.10.146-cleanup-renewal-DEV-test.zip` | 12,018,826 | `56efdb2c347b2a72ebb22c347d6294e0f6b49cf115571ba012b0dc308632f876` |

Both games were independently confirmed closed immediately before replacing only
their tested HUD archives. Both installed hashes, prior 2.10.145 backups and all
six desktop/seven MSI provider/config/profile files verify. MSI native login cache
is present and unchanged. Home/Delete and Period/Delete remain configured.

- Desktop backup: `.extender-backups/before-hud-2.10.146-cleanup-renewal-20261012T191407Z/`.
- MSI backup: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.146-cleanup-renewal-20261012T191430Z\`.

The permanent record is `.build/FCMChatWidget-2.10.146-DEV-GATES.json`, with both
install manifests alongside it. Native acceptance remains pending: start both
games, confirm the 2.10.146 startup and DEV relay, join the same world and stay
nearby with overhead names visible for at least two minutes, both stationary and
moving. Confirm restoration error 1006 stops and successive HUD ticks renew private
leases without repeated expiry gaps. If colors still disappear, distinguish a
genuine `source-expired` gap from lease loss, auth/room clears and redraw behavior.
Continue the bounded exclusion, world travel, expiry and unload matrix before
native acceptance or publication. Do not infer steady colors from Ruffle alone.

## 2.10.147 follow-up stability review

**[Confirmed] Installed state:** both tested 2.10.146 archives still match their
install manifests. Both games were closed during the follow-up capture, and both
latest logs remain 2.10.145. There is no native 2.10.146 stability result to accept.
Evidence: `desktop-blue146-doublecheck.json` and `laptop-blue146-doublecheck.json`.

**[Confirmed] Ordering defect:** the independent-timer model runs five-second
request and reply timers in both orders and four phases with 100 ms transport
delay. The 2.10.146 request-before-poll case rejects all 12 delivered replies and
has zero active private-lease samples after warmup. Other phases pass. The pure
regression also fails when a valid prior reply arrives after a renewal submission.
Both compiled providers fail through the actual widget parser at the same prior
reply acceptance assertion. Evidence: `hud146-ordering-review-red.log`,
`hud147-overlap-red-valid.log`, `hud147-overlap-ruffle-red-valid.log` and provider traces.

**[Deduced] Availability risk:** timer creation currently starts the poll before
the world timer, but the single outstanding request makes correctness depend on
that callback order and delivery timing. A later submission discards a reply whose
original lease is still valid. This is a reproduced client defect, not a claim
that native 2.10.146 already encountered that order.

2.10.147 retains at most four outstanding request IDs, revisions and submission
times in the exact context. Expired entries are pruned on submission, and reset
clears the entire window. Accepting a newer valid reply retires every older
request, including when the newer reply contains no peers. Each accepted reply
uses its own submission timestamp; no TTL or marker source age is renewed by a
cache read, timer, heartbeat or delayed response.

**[Confirmed] Focused results:** the pure suite passes overlapping reply
acceptance, original deadlines, newer empty/positive precedence, replay,
same-context reset and the four-request bound. The independent model has 100%
active private-lease samples in all eight cases with zero rejected valid replies
(`hud147-ordering-review-green.log`). Both compiled-provider cases pass in 17.8
seconds (`hud147-overlap-ruffle-green.log`). They verify marker age stays unchanged
and twelve consecutive deferred native redraws finish blue while expiry and
unload still restore the current vanilla color.

The initial pure test used the old string-shaped pending field as an array and
failed compilation; `hud147-overlap-red.log` is invalid defect evidence. The first
compiled run also used an old harness after a UInt comparison failed to compile;
`hud147-overlap-invalid-stale-harness.log` and its mixed traces are excluded.
Only the clean rebuilt red and green runs support the defect/fix result.

Full local regression verification passed for HUD 2.10.147 and bridge 0.2.15:
31 pure suites, nine source/package checks, empty compiler diagnostics, 93/93
Ruffle cases (7.7 minutes), backend 130 Jest suites / 1,669 pass / nine existing
skips plus 445 TypeScript tests, overlay 59 files / 1,303 tests and dashboard
49 files / 490 tests. The owned Redis is removed, the harness port is closed and
all 149 frozen source hashes remain unchanged.

The DEV ZIP has 16 entries with CRC and both tested BA2 copies verified. DEV
configs are stamped, with no provider DLL, executable, bridge, harness or game font.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `FCMChatWidget.swf` | 7,228,453 | `a1390d8028693d0ea1d5b5277249c65ab3d2a767164a5adcc556bc1c9800a287` |
| `FCMChatWidget.ba2` | 7,228,542 | `68319a2e82eb617edb46c0297e945efae85eca1687f05ab91160c0f3ad0bbea2` |
| `.build/FCMChatWidget-2.10.147-overlapping-replies-DEV-test.zip` | 12,019,340 | `2f0ded46318b07c330a6a64bdb88324e3990bcfc1fd70d38fb303bb913326e33` |

Both games were independently closed for archive replacement. Installed hashes,
prior 2.10.146 backups, six desktop/seven MSI provider/config/profile files and
the MSI native login cache verify. Home/Delete and Period/Delete are unchanged.

- Desktop backup: `.extender-backups/before-hud-2.10.147-overlapping-replies-20261012T210357Z/`.
- MSI backup: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.147-overlapping-replies-20261012T210422Z\`.

The permanent record is `.build/FCMChatWidget-2.10.147-DEV-GATES.json`, with the
install manifests alongside it. No native stability, hosted CI or publication is claimed. A genuine
30-second marker push gap still expires the correlated source; slower polling or
transport delay can also exhaust the original private lease. These bounds cannot
be removed to make a stationary test appear to pass.

## Fresh 2.10.147 native failure and 2.10.148 compatibility experiment

**[Confirmed]** The user placed both characters nearby in the same world with
overhead names visible. Both processes are running and both logs load 2.10.147.
Desktop's installed archive matches the tested 147 hash. Over multiple minutes,
both providers record `gate=active`, `requests=0`, `accepted=0`, `bound=false`,
`binds=0` and no marker source. Repeated world-timer catches report TypeError 1014.
Frame/render errors stay zero because presence submission fails before binding.
Evidence: `desktop-blue147-live-start.json`, `laptop-blue147-live-start.json` and
the subsequent bounded warning capture. The 147 gate manifest is now marked
`installed-native-failed`; automated gates remain passed. This run does not
establish either steady color or source-expiry availability.

**[Confirmed]** The old world phase remains `world-id` after `checkWorldId()`
returns, so that label alone cannot prove that `readWorldId()` failed. The method
has an internal catch. The following `updateNameplates()` lacked request/bind/send
subphases. No named missing class appears in the native error string. AIR's
[runtime error reference](https://airsdk.dev/reference/actionscript/3.0/runtimeErrors.html)
maps 1014 to class lookup failure; that is platform guidance, not identification
of Fallout's missing class.

FFDec 26.3.0 was downloaded from its official release, with SHA-256 verified as
`35f4930eb7c380afe66f2117f90b006deac0631473ad7500bb39c78f68645ecd`, and used only
to inspect owned compiled SWFs. No game process memory or original game class
patching is involved. The previously native-working 145 SWF was extracted from
its verified DEV ZIP for comparison.

**[Confirmed]** Both versions contain the same JSON printer bytecode. The 147
request method adds two `coerce Array` instructions; its other class references
match 145. The 148 candidate uses indexed in-place pruning and `splice` and has
zero request-method Array coercions, no shift call, and the same class-reference
set as 145. Evidence: `hud145-abc-review`, `hud147-abc-review`,
`hud147-json-review`, `hud148-abc-review` and `hud148-request-bytecode-check.json`.
The comparison refutes a new JSON-printer implementation as the explanation.

**[Hypothesized]** The new request-method coercions trigger native verification
failure. Confirm if fresh 148 advances request counters, binds, accepts replies
and stops 1014. Refute if the same error persists with unchanged counters. New
fixed `requestPhase` values and `nameplates-request` / `nameplates-bind` /
`nameplates-send` timer phases narrow any remaining failure. No generic ban on
Array coercion elsewhere, or named missing class, is claimed.

The bounded four-request window, newer-reply precedence, each original submission
deadline, generation/context reset and 30-second marker-source age are unchanged.
Pure tests also verify pruning all expired entries after a long stall and fixed
phase privacy. All eight timing models preserve active leases; both focused
provider cases pass (27.0 seconds) with overlap and twelve deferred redraws.
Full 148 / bridge 0.2.16 regression verification passes. Native acceptance
requires a freshly loaded candidate; the game must be closed before replacement.

## 2.10.148 verification and package

All required local gates pass: 31 pure Haxe suites, nine source/package checks,
empty compiler diagnostics and 93/93 Ruffle cases (8.4 minutes). Backend passes
130 Jest suites / 1,669 tests / nine existing skips and 445 TypeScript tests;
overlay passes 59 files / 1,303 tests, dashboard 49 files / 490 tests. The owned
Redis and harness listener are removed. All 149 frozen source hashes remain unchanged.
The rebuilt 0.2.16 bridge passes its isolated provider regressions. Existing
required `gamemod-anchors` and `hud-ruffle` CI coverage remains in place; no hosted
CI run or native acceptance is claimed.

The DEV ZIP has 16 entries and passes CRC. Both provider copies equal the tested
BA2; DEV relay/link settings verify. No provider DLL, executable, background
bridge, harness or game font is bundled.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `FCMChatWidget.swf` | 7,228,677 | `f7e716eb517e4f974fbf8ca26edf4a166a430e876fd46d3b75575b2a3ae29af1` |
| `FCMChatWidget.ba2` | 7,228,766 | `11a4232053a724a68f29c45913397f746c0b78e630a438f9c22253a26ea28bdd` |
| `.build/FCMChatWidget-2.10.148-native-request-compat-DEV-test.zip` | 12,019,584 | `1dceb626991c8f0c01a2fb302f8a2f583b0ef228b560bea25a917d44c1e6bce4` |

The permanent gate manifest is `.build/FCMChatWidget-2.10.148-DEV-GATES.json`.
Both game processes stopped after the closure request and were independently
confirmed closed immediately before replacing only their HUD archives. Both
installed hashes, prior-147 backups and six desktop/seven MSI provider/config/
profile files verify. MSI native login is present and unchanged; Home/Delete and
Period/Delete remain configured. All owned staging files are removed.

- Desktop backup: `.extender-backups/before-hud-2.10.148-native-request-compat-20261012T233626Z/`.
- MSI backup: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.148-native-request-compat-20261012T233628Z\`.

Both install manifests and post-install checks are recorded with the 148 gate
manifest, now `installed-native-pending`. The first fresh 148 native check must
advance requests and accepted replies, bind the painter and stop error 1014
before color stability can be evaluated. Start both games, join the same world
and stay nearby with overhead names visible for at least two minutes. Compare
stationary/moving colors and capture source age, lease gaps and redraw errors;
continue the bounded travel, exclusion, expiry and unload matrix before acceptance.

## Fresh 2.10.148 native failure (2026-10-12 local / 2026-10-13 UTC)

**[Confirmed, user report]** Both characters are in the same world, next to each
other with overhead names visible; neither name is blue.

**[Confirmed]** Both fresh startups load 2.10.148. During a 157.5-second capture,
all 14 desktop and 13 MSI new diagnostic samples show `gate=active`, zero
requests/accepted replies, `requestPhase=retired` and no painter binding. The
desktop adds 31 and MSI 32 warnings, all error 1014 at `nameplates-request`.
Evidence: `desktop-blue148-live-start.json`, `desktop-blue148-live-end.json`,
`laptop-blue148-live-start.json`, `laptop-blue148-live-end.json` and
`hud148-native-failure-summary.json`. Both installed archives retain the tested
148 hash. The 148 gate manifest is now `installed-native-failed`.

**[Confirmed]** Removing the request-method Array coercions did not resolve the
failure. It refutes that change as a sufficient resolution, not every possible
Array-related runtime issue. No missing class has been identified.

**[Confirmed]** Compiled widget instructions at `nameplates-request` read the
clock, read the owned Server session's request ID, then invoke the presence
request. The label cannot alone distinguish those three operations. The logged
request phase is sampled before the attempt, so its unchanged value is not a
complete entry trace. Evidence: `hud148-widget-abc-review/scripts/FCMChatWidget.pcode`.

**[Hypothesized]** Native rejection of the combined compiled request method is
similar to the independently probed 2.10.105 roster-reader failure. Confirm with
separate argument phases and a smaller request method reaching its body; refute
if the argument read fails or the smaller entry is still rejected. Further fixed
helper-call/entered phases must identify pruning, queueing or encoding failures.
The prior native reader history establishes a comparable failure, not this
method's cause. The next candidate is a diagnostic experiment; no native fix is claimed.

## 2.10.149 request boundary experiment

The request keeps its four-entry pending window and delegates pruning, queueing
and encoding to separate small methods. Fixed `*-call` phases are set before
each helper; the helper sets its entered phase after invocation. The widget
separates the clock and owned-session reads from the request invocation. The
world catch records the request phase at failure rather than only before it.
It uses the existing bounded error/class parser; unrecognized messages and stacks
are excluded. A fixed fallback remains if the formatter itself cannot run.
No authentication, room, submission deadline, ordering or source-age rule changes.

**[Confirmed]** The pure nameplate suite passes, including the eight timer-order
cases and full-window expiry. Both focused Ruffle provider cases pass in 18.2
seconds. Injected request boundary errors exercise the actual widget and its
world-catch formatter, recording fixed stages and numeric codes without copying
private error text. Only a canonical bounded class identifier may be reported;
appended private text rejects the template. Original live lease, native room,
marker age and observation count remain unchanged. This is diagnostic coverage,
not reproduction or resolution of native 1014. Evidence:
`hud149-request-diagnostics-red-valid.log`, `hud149-request-diagnostics-green.log`
and their provider traces.

The initial test routed through world acquisition, which changed its synthetic
session before reaching the injected request. It is invalid diagnostic-defect
evidence (`hud149-request-diagnostics-red.log`) and is excluded. The corrected
case isolates the existing request call and the same catch formatter; its clean
red run fails at missing fixed request-phase reporting on both providers.
Complete 149 / bridge 0.2.17 regression gates and fresh native acceptance are pending.

The production compile caught the initial formatter's bridge-only classpath
dependency before changing artifacts. The unchanged parser is now in shared
`FcmRuntimeError`; `FcmBridgeRead` delegates to it and the HUD imports the shared
module. Direct pure HUD tests cover classification/template privacy, and the
existing bridge boundary tests continue through the same parser. A new production
rebuild and focused provider rerun pass for this final source.

## 2.10.149 verification, package and installs

All required local gates pass: 31 pure Haxe suites, nine source/package checks,
empty compiler diagnostics, both focused provider cases on final source (20.0
seconds) and 93/93 full Ruffle cases (8.0 minutes). Backend passes 130 Jest
suites / 1,669 tests / nine existing skips and 445 TypeScript tests; overlay
passes 59 files / 1,303 tests, dashboard 49 files / 490 tests. The initial backend
unit run reports 444 passing tests and omits the final appearance-clear case.
An isolated full-unit recheck includes that case and passes all 445, with zero
failures/skips/cancellations (`hud149-backend-unit-recheck.log`); that is the final
unit gate evidence. Both owned Redis containers are removed.

Compiled inspection verifies the public request has no Array mutation or JSON
printer calls and invokes the three separate helpers. All 150 frozen source
hashes remain unchanged; the owned harness listener is removed. The rebuilt
0.2.17 bridge passes isolated provider regressions. Existing required CI coverage
remains in place; no hosted CI run or native resolution is claimed.

The DEV ZIP has 16 entries, passes CRC and contains two copies of the tested BA2.
DEV relay/link settings verify; no provider DLL, executable, background bridge,
harness or game font is bundled.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `FCMChatWidget.swf` | 7,229,988 | `412300d5d6150b2f853b236e86f0dadf31d43dccd530c7c10acfcc0e85bb4386` |
| `FCMChatWidget.ba2` | 7,230,077 | `e789bc832362883f0d382e64eee9f63a00e71c51be0830b8d743d959c5c2a646` |
| `.build/FCMChatWidget-2.10.149-request-boundaries-DEV-test.zip` | 12,021,314 | `871fc26fd9cfc13bb78b54cbf3f37e8df3e1f00baa4b51a06bab49b50562903b` |

Both game processes were already stopped and were independently confirmed closed
immediately before replacing only the HUD archives. Both installed hashes,
prior-148 backups and all six desktop/seven MSI provider/config/profile files
verify. MSI native login is present and unchanged. Home/Delete and Period/Delete
remain configured. All owned temporary replacement files are removed.

- Desktop backup: `.extender-backups/before-hud-2.10.149-request-boundaries-20261013T021703Z/`.
- MSI backup: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.149-request-boundaries-20261013T021704Z\`.

The gate and both install records are in `.build/FCMChatWidget-2.10.149-DEV-GATES.json`,
marked `installed-native-pending`. A fresh two-client run must establish request
entry, helper execution, advancing request/accepted counts and painter binding
before testing color availability. New failure phases or a canonical missing
class identifier must guide any further change. Continue the bounded native
stationary/moving, redraw, exclusion, travel, expiry and unload checks before
acceptance. The diagnostic candidate is not published or native-accepted.

## Fresh 2.10.149 native stability failure (2026-10-13)

**[Confirmed, user report]** Both nearby clients intermittently return to normal
colors. The overhead labels remain visible; moving restores blue.

**[Confirmed, fresh logs]** Desktop/xScal and MSI/ZFE load 149, bind once to the
host-domain manager and advance accepted private replies with no rejected replies,
1014 warnings, frame errors or render errors. Desktop reaches 132 requests and
132 accepted replies; MSI reaches 147/147. This establishes request-path progress
for this run, not the exact construct responsible for earlier native verification
failure or full native acceptance.

The bounded desktop capture has 52 diagnostic samples: 19 paint, 14 show expired
source with active private presence, and 16 show fresh correlated source plus one
private name but zero painting. MSI has 60 samples: 23 paint, 21 show source expiry,
and seven show fresh source with one private name but zero painting. Sampled
diagnostics are not a time-weighted availability measurement. Both captures also
contain startup/transitional samples. Count-only probe matches are not proof that
the matching plate is the private peer or that its full visibility chain passes.

Evidence: `desktop-blue149-drop.json`, `msi-blue149-drop.json` and
`hud149-native-stability-summary.json` in the conversation evidence directory.
The installed-149 gate is now `installed-native-unstable`, with native acceptance
failed. Both games remain running; no 150 archive has been installed.

**[Deduced]** An unchanged stationary marker publication can reach the 30-second
source deadline independently of fresh private FCM presence; moving produces
new publications and can reopen acquisition. This explains the confirmed expiry
episodes, but does not establish the cause of the fresh-source unpainted samples.

## 2.10.150 stationary continuation policy and regressions

**[Hypothesized]** Separate initial source acquisition from continuation of an
already admitted exact visible association to prevent stationary expiry drops.
Confirm with a fresh two-client native stationary run exceeding the original
source deadline, with `sourceExpired=true`, advancing bounded private leases and
`retained=1`/`painted=1`. Refute if that episode still loses the visible blue color,
or a negative identity/eligibility/authority case remains blue.

The source still expires acquisition after 30 seconds and never renews its
timestamp through a getter, probe, frame or private reply. A previously admitted
field may continue only under the same current visible field/plate/entity/name,
unique ID, complete owned current eligibility, private name lease and original
host/binding/context/reset generation. A hidden/recycled/renamed, ineligible or
withdrawn admission is retired; expired evidence cannot reacquire it. Paint
failure removes admissions too. Auth/room/world/stage/binding resets and teardown
still clear immediately. Private TTLs, backend observation deadlines, provider
readiness/watches and room authority remain unchanged. This deliberately changes
cosmetic continuation, rather than calling cached data a fresh observation.

The 149 production painter fails the new stationary assertion on both provider
scenarios (`hud150-stationary-red.log`). The updated compiled painter passes the
focused scenarios before the additional two-minute stress loop (19.1 seconds).
The final scenario advances logical source/private-request time together using
the real private parser, with no extended deadline. It retains an admitted field
through two modeled minutes of private renewals and native recolor, while rejecting
new private peers and reacquisition after hiding. It tests hostile/wanted changes,
row removal/rename, invalid flags, recycled/duplicate IDs, withdrawal, private
submission expiry and same-context reset. Existing redraw, fault and teardown
checks remain. The pure suite verifies current-identity corroboration and ambiguity.

Fixed `currentSource` and bounded private/visible/current/unique/exact/retained
counts distinguish remaining rejections without names or raw payloads. A new
complete gate run and native acceptance remain required; simulator evidence alone
does not establish stability.

The first 150 backend gate passes all 445 TypeScript tests but fails one existing
registration limiter assertion (129/130 Jest suites). That test uses four
asynchronous requests against real wall-clock minute buckets; source inspection
shows a rollover can legitimately put the fourth request in a different window.
Its clock is now pinned inside `try/finally`, following the existing world-control
limiter test. Production rate-limit logic is unchanged. The focused assertion
passes; the complete Jest rerun is required before packaging. Initial failure
evidence remains in `hud150-backend-jest.log`.

## 2.10.150 verification, package and installs

Final source passes all 31 pure Haxe suites, nine source/package checks and empty
widget/native-scenario compiler diagnostics. All 93 Ruffle cases pass in 8.8 minutes,
including both stationary scenarios, deferred redraw and the complete provider
compatibility suite. All 150 frozen source hashes remain unchanged; the harness
listener is removed. Backend final Jest passes 130 suites / 1,669 tests with nine
existing skips; TypeScript passes all 445 with zero failures/skips. Overlay passes
59 files / 1,303 tests; dashboard passes 49 files / 490 tests. Both disposable
backend Redis containers are removed. The initial registration failure is retained
and its corrected clock-pinned assertion is covered by the full passing rerun.
Existing CI discovery covers these tests; no hosted CI run was triggered.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `FCMChatWidget.swf` | 7,231,327 | `d9eda59344a26908d501171a1be8f0b9c56aff6932a19e6959ac899e5bea1309` |
| `FCMChatWidget.ba2` | 7,231,416 | `4abe039cab1d42b5a15d5d5563e168e3f63e4a1d02d0c55b50c83df0b35f970b` |
| `.build/FCMChatWidget-2.10.150-stationary-retention-DEV-test.zip` | 12,022,898 | `7c14cba01115c8bc9f5d314c37aa1bc9873745fb513dd4d8f8ac6d5727939278` |

The package has 16 CRC-verified entries, identical tested BA2 provider copies,
DEV endpoints and no provider DLLs, executables, bridge, harness or font assets.
The normalized SWF/BA2 payload and source manifest match, including all 4,057 emoji.

Both games were independently confirmed closed before replacing only the HUD BA2.
Both installed hashes and prior-149 backups verify. Six desktop/seven MSI provider,
configuration and profile files remain unchanged; MSI native login is present
and unchanged. Desktop retains xScal 0.2.20/Home/Delete; MSI retains
ZFE 0.21.1/Period/Delete.

- Desktop backup: `.extender-backups/before-hud-2.10.150-stationary-retention-20261013T061323Z/`.
- MSI backup: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.150-stationary-retention-20261013T061337Z\`.

Gate/install records are in `.build/FCMChatWidget-2.10.150-DEV-GATES.json`, now
`installed-native-pending`. The user has been asked to start both games, join one
world, move once to acquire blue, then keep visible labels stationary for two
minutes. Compare `sourceExpired`, `retained`, `painted` and current-source/matching
counts with visible colors. Fresh-source drops remain unclassified until this
native capture. Continue negative identity/eligibility, auth/room/world, typing,
travel and unload acceptance; the simulator is not native acceptance. Nothing is
published or deployed, and the distributed bridge ZIP remains unchanged.
