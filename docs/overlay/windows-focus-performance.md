# Windows focus-return performance candidate

2026-09-18 investigation: the submitted portable 1.4.0 log contained 155 completed
focus helper lifetimes, median 1,230 ms, with four 3-second timeouts in its final
session. The old Windows path spawned PowerShell and compiled interop per return.
This proves handoff latency, not continuous game frame-time stalls. The xScal log
contained only startup/attachment entries and cannot identify a runtime CPU cause.

The desktop now prewarms one owned worker at Electron readiness. Interop compiles
once; the idle worker blocks on stdin. Each request checks the current foreground
owner and deadline, finds an existing Fallout window and reports activation success
or denial. No new service or persistent install is needed; portable and installed
builds use the same code. Linux behavior is unchanged.

Only one request may be pending. Typing again, switching to another application,
or a timeout retires the exact worker so stale queued commands cannot activate the
game later. Failures back off five seconds; there is no automatic restart loop.
Quit terminates the owned worker and timers. Normal successful requests reuse it.
The existing Windows foreground-lock workaround is retained; tests never inject
input into Fallout. A successful worker response does not certify game rendering.

The foreground watcher also compiles its loop once. It checks the window owner
every 100 ms, but resolves the process name and emits output only on owner changes
or a one-second heartbeat. Existing watchdog and cancellation behavior remain.
A five-second sample of the previous laptop session measured 11.56% of one CPU
core in the foreground PowerShell helper. This uncontrolled sample motivates the
change; it is not a before/after frame-time benchmark.
A five-second native packaged-UI sample of the candidate's two PowerShell helpers
measured 0% and 0.62% of one core, with working sets 114.8 and 78.4 MB respectively.
The old and new samples have different workloads; do not present them as a
controlled percentage improvement or evidence that live game stutter is resolved.

## Local diagnostics

Launch with `FCM_PROFILE_LOCAL=1` to collect local-only diagnostics every 15 seconds
for at most ten minutes. `[local-perf]` lines contain Electron process-type CPU,
working-set memory in KB, main-thread event-loop p95/max delay, and aggregate
bridge-export read-pass timing/candidate counts. No usernames, roster contents,
tokens, process IDs or file paths are included in these samples. Nothing is uploaded.
Quit stops capture early. With the variable absent, the sampler is disabled.

`[focus-worker]` lines report startup, request round-trip/native-call milliseconds,
result and fixed stop reasons. GPU-process **CPU** is not GPU utilization. Export
read timing is desktop filesystem timing, not the native ZFE/xScal callback duration.
Native provider timing and actual game frame times remain separate measurements.

## Verification

Unit tests exercise reuse, chunked replies, cancellation, stale output, failure
backoff, deadline/foreground guards, teardown, bounded profiling and packaged modules.
They run in the existing overlay Vitest CI job. The native, no-input benchmark is:

```
node scripts/focus-worker-benchmark.cjs
```

On the MSI laptop, cold preparation measured 726 ms; a separate warmed worker
handled 100 dry-run commands with p50 0 ms, p95/max 1 ms (millisecond resolution).
These are compilation/IPC measurements, not SetForegroundWindow or game benchmarks.
The dry-run branch does not enumerate game windows, activate windows, or send keys.
The benchmark always disposes its workers. Packaged UI testing uses the existing
isolated `scripts/usability-smoke.mjs`; close Fallout before window interaction tests.
The candidate passed 1,256 overlay unit tests and the complete isolated Linux and
Windows packaged UI checks. A subsequent Server sub-tab label correction is
covered by an explicit staff-account UI assertion; message labels remain distinct.
Live user acceptance must confirm repeated send/hide/cancel, Alt-Tab cancellation,
and compare captured CPU/frame timing during idle, chat activity, travel and reconnect.

The final label-corrected candidate passed both UI suites and was installed on the
MSI laptop with its existing FCMData retained. Portable EXE SHA256:
`5a0c67de976c35ed0a4d549c00b7ac047627a07a2f48294892c9379615d32917`.
The previous EXE and data are backed up under
`C:\Users\White\FCM-overlay-backups\before-focus-worker-20260918`.
Startup registered the saved account successfully. No hosted deployment or public
release occurred; live game performance and focus acceptance remain pending.

## Renderer optimization, first increment

Live laptop profiling found 1,475 mounted message rows. One 12-second capture
recorded 538 ms of style recalculation and 194 ms of layout; a second was mostly
idle. These are intermittent costs, not proof that all reported stutter shares
one cause. No game input was automated; the temporary debugger was removed.

The first renderer change filters root-style mutations by the two shell-owned
opacity properties before requesting computed style. Actual opacity changes
still resolve computed CSS once and retain clamping/default behavior. Unrelated
style changes produce no opacity notifications or computed reads. History,
message mounting, scroll anchors, authentication and provider protocols are unchanged.
Unit tests cover 100 unrelated mutations, live changes, removal and teardown;
the Electron usability suite additionally checks retained draft/history.

The isolated idle profiler now defaults to 1,500 fixture messages; override with
`FCM_PROFILE_MESSAGES=250` for the former baseline (valid range 1–5,000).
Compare the same fixture size, theme, effects and window dimensions on both builds.
Virtualization remains deferred until controlled measurements justify it. Do not
claim a native performance improvement from the mutation-read regression alone.

Verification for this increment: 458 dashboard tests, 1,256 overlay tests, renderer
build and full Linux Electron usability suite passed, including the 100-mutation
computed-read assertion. Test-owned processes/profile/relay were removed. Existing
CI dashboard/overlay unit jobs and Linux interaction job cover these regressions.
The complete Windows packaged interaction suite subsequently passed, including
the 100-mutation opacity assertion. The portable candidate was installed on the
MSI laptop with the game closed and existing settings/login retained. SHA256:
`5b7af0683c7ad12a61454dbd5bb9ff5efadc48097a8c62a0fdc0f5dd744d4a36`.
The previous EXE and FCMData are backed up under
`C:\Users\White\FCM-overlay-backups\before-opacity-20260918`.
Matched native before/after performance measurements remain pending.

## Progressive message rendering

The next increment limits desktop normal-feed row construction to the most recent
100 filtered messages, without trimming the message store. Upward reading reveals
100 more cached rows before remote pagination. The first rendered message ID is
held while reading so live arrivals do not evict it. A layout-phase scroll-height
adjustment preserves the viewport on cached prepend; existing server-history
restoration remains responsible for remote prepends. Explicit mention navigation
may reveal the retained range. Returning to latest resets to 100 rows.

463 dashboard tests and 1,256 overlay tests passed. The Linux Electron suite
verified a 1,500-message fixture starts with 100 rows, reveals 100 older rows with
under three pixels of anchor movement, retains the composer, and returns to 100.
This demonstrates reduced mounted rows, not a measured percentage CPU improvement.
The same complete packaged Windows suite passed, including the 1,500-row scenario.
Portable SHA256 `22896ac5925d515cde524552801d6ad3e96d462d607e29f401e646dba2e35b29`
was installed on MSI with the game closed and the prior EXE/FCMData saved in
`C:\Users\White\FCM-overlay-backups\before-render-window-20260918`.
In-game performance acceptance remains pending. No commit, push or hosted deployment.

## Live animation isolation (2026-09-19)

With explicit permission, only the laptop overlay was restarted/profiled while
Fallout76 remained running. Temporary renderer-only styles did not persist settings.
All captures had 100 message rows. Ten-second CDP renderer TaskDuration samples:

| Condition | Task time | Style recalculations |
| --- | ---: | ---: |
| Expanded, normal effects | 5.298 s | 2,402 |
| All animation/transition motion temporarily disabled | 0.254 s | 4 |
| Only chroma-split animation disabled | 0.889 s | 305 |
| Normal effects restored | 4.533 s | 2,399 |
| Only chroma-split disabled, repeat | 0.605 s | 222 |

Confirmed: disabling `.fcm-name-fx--chroma-split` motion repeatedly removed most
of the renderer task load in this live session. Its CSS animates text-shadow;
even one visible animated name coincided with approximately 240 style recalculations
per second. These are renderer task timings, not total CPU or game frame times.
Live messages/typing were not frozen, so this is an intervention comparison rather
than an identical-message replay benchmark. No message contents were collected.

Collapsed captures are INVALID for state comparison: the overlay had already
returned to expanded at both recorded state checks. Do not present their numbers
as collapsed performance. The next targeted remedy should preserve the chroma
appearance/cadence without a continuously sampled text-shadow animation; verify
with repeated native captures before claiming resolution. Debugger and temporary
styles are removed after capture; no product fix was made by this experiment.

## Discrete chroma motion follow-up

Chroma Split now uses four scheduled shadow changes per 10.5–15.5 second
message-specific cycle instead of a continuously sampled CSS animation. The
existing visibility observer owns each timer: offscreen/hidden names, viewer
motion opt-out, reduced motion and teardown cancel it. No layout measurement,
React state update, transport or game input is involved. Unsupported observers
fall back to the static shadow. Unit tests cover phase, cadence and cleanup.
Verification: 467 dashboard tests, 1,256 overlay tests, renderer build and the
full Linux Electron usability suite passed, including actual shadow changes,
absence of chroma CSS animation, reduced-motion cancellation and history/draft
regressions. No HUD/provider code changed in this follow-up.

Native laptop follow-up (game left running, chat renderer only): two expanded
10-second captures with 100 mounted rows measured TaskDuration 1.791950/1.536647s,
RecalcStyleCount 387/402 and RecalcStyleDuration 0.112711/0.099573s. The second
capture confirmed five retained chroma names, three actively scheduled; typing
animations remained enabled. Earlier normal captures measured TaskDuration
5.298464/4.533085s and 2402/2399 style recalculations. Live traffic differs, so
these are directional native observations, not an identical-workload percentage
claim, total process CPU or game frame-time evidence.

Windows portable SHA256:
`76ced0b49249e29f281aa6353d4d0c026682af138e3642c33972db66a9fcc5ee`.
Previous executable and FCMData backed up on laptop under
`FCM-overlay-backups/before-chroma-20260918`. Native focus/input automation was
not run with the game open; profiling used no game input.

## Release-performance follow-up: shared ambient-motion budget

Confirmed additional costs on MSI: the shared `.username-chip` text-shadow
transition interpolated each discrete chroma change for 120ms. Disabling only
that transition twice reduced idle renderer/GPU process CPU to approximately
1%/1–2% of one core. A three-dot typing fixture consumed approximately 41%
GPU-process CPU with either smooth CSS or CSS steps; sampling the animation
at 10Hz reduced this to 4.7%. A single Glow Pulse fixture also reproduced high
CPU; the candidate sampling reduced renderer/GPU CPU to 3.8%/4.8%. These are
short intervention probes, not the final sustained acceptance result.

`ambient-motion.ts`, mounted only by the desktop shell, now owns one shared
100ms timer for approved repeating status/name animation types. It retains CSS
keyframes/delays/colors while pausing native continuous playback. It suspends
hidden/offscreen names, typing while collapsed, all full-hidden effects and
reduced motion. Empty scenes have no timer; reinitialization/page teardown
disposes it. Smooth interaction/collapse transitions are excluded. No server,
provider protocol, login, message state or input behavior changes.

Performance sign-off criteria for this candidate on the reference laptop
(one-core CPU units, **not** total-system percentages or GPU utilization):

- Quiet expanded feed: mean whole-overlay CPU <=10%; p95 15-second samples <=20%.
- Active typing/unread or 20-name mixed-effect stress: mean <=25%; p95 <=40%.
- Fully hidden: mean <=5%; p95 <=10% after transitions settle.
- Renderer main-thread work <=10% of wall time in steady-state; no recurring
  >=250ms long tasks; no renderer/main crashes or foreground-watchdog restart loop.
- A 30-minute native soak with bounded row count, no sustained private-memory
  growth after warmup (compare first/last five-minute medians; investigate >50MB),
  plus functional regression suites. A stalled/missing process or invalid mode
  sample cannot count as a pass. Record native game-frame-time limits separately.

These are engineering acceptance budgets for the reference machine, not a
promise for every GPU/driver. Packaged smoke/security/CI gates remain separate
from performance approval. Final artifact measurements and verdict pending.

The preservation check caught an additional integration issue: appearance
previews live outside the chat viewport and therefore did not get Chroma's
message scheduler. Their dedicated stepped preview animation is now covered by
the same desktop ambient clock, including the settings portal under `body`.
Chat usernames remain on the discrete, visible-only scheduler. The UI test
checks an actual body-level preview, shadow changes and reduced-motion fallback;
the reduced-motion assertion waits for the media-query handler to settle.

Local verification after this correction: 1,264 overlay and 468 dashboard unit
tests pass; the complete Electron usability suite passes with owned-process,
mock-relay and temporary-profile teardown. These tests remain in the existing
unit-Vitest and Linux overlay interaction CI jobs; local success is not a claim
that hosted CI has run on the uncommitted changes.

The isolated Linux packaged profile (Xvfb, i9-12900K, 1,500 fixture messages,
100 mounted rows, 20 visible Glow Pulse names) measured 16.83% aggregate CPU
visible and 3.01% hidden, in one-core units. Hidden capture had zero layouts and
style recalculations. ASAR SHA256:
`829108d20b08fa80c3e5fbc290300cefb0445827fbcdc479899aa71a9c253025`.
This software-display profile supports regression checking, not native game
frame-time or Windows GPU claims. Final native artifact acceptance remains pending.

Further native acceptance findings (2026-09-19):

- Confirmed: opacity/full-hide can leave a one-pixel window document-visible and
  geometrically intersecting. `observeNameMotion` now observes shell collapse,
  fade and full-hide state directly, stopping Chroma timers in all three states.
  Unit and Electron tests cover suspension and resumption without deleting messages.
- Confirmed: short-lived `tasklist` children were absent from interval process
  samples. Twelve standalone queries averaged 37.76ms CPU each on MSI; two per
  2.5 seconds add approximately 3.02% of one core. Earlier process-family figures
  therefore undercount this cost and are not final whole-overlay approval.
- The existing Windows helper now performs a process-only
  [Tool Help snapshot](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/nf-tlhelp32-createtoolhelp32snapshot)
  at the same cadence. Only `TH32CS_SNAPPROCESS` is requested, never module/heap
  enumeration or process memory. Handles close in `finally`; only a boolean or
  unknown status reaches Electron. Foreground identity and its watchdog remain
  independent. Native errors/stale data retain bounded, non-overlapping tasklist
  fallback; late fallback results cannot overwrite newer helper observations.
  Existing two-scan launch / three-scan exit hysteresis is unchanged.
- Native fixture acceptance detected both executable-name paths and their exits,
  with zero handle growth across 100 checks (14.31ms mean call wall time). These
  fixtures were owned test processes, not Fallout. The game was neither stopped
  nor sent input. VM integration tests exercise fallback, errors, stale results,
  fragmented worker output and separation from foreground/keybind handling.

## xScal stutter follow-up: zero recurring decorative paint

An xScal user report included a clean xScal 0.2.16 initialization and successful
D3D11 dispatch, with no provider errors or repeated hook initialization. Its
overlay log also showed healthy foreground/presence workers: no watchdog failure,
tasklist fallback loop, focus-worker timeout or crash. The submitted logs did not
contain frame times or opt-in `[local-perf]` samples, so they cannot by themselves
attribute the reported game hitch to a specific process.

The remaining known recurring desktop paint source was the shared 100ms ambient
animation sampler described above. That design reduced average CPU relative to
continuous browser animation, but still assigned Web Animation current times ten
times per second and therefore could not provide a zero-wakeup idle guarantee.
At this stage the desktop overlay held approved repeating decorative animations on their
first frame instead. Static supporter styling, typing labels and unread markers
remain; website/dashboard animations and short interaction/collapse transitions
are unchanged. Mutation observation only catches newly created CSS animations;
there is no animation interval, animation-frame loop or geometry polling. Unit
coverage requires zero timers through visibility, collapse, reduced-motion,
settings-preview, repeated mount and teardown states. Native A/B game-frame
acceptance is still required before calling the user-reported stutter resolved.

Live testing with Fallout76 and the repaired portable then exposed a separate
periodic cost: every 15-second local-profiler window contained a bridge read pass
lasting about 1.0–1.1 seconds (the startup window peaked at 1.428 seconds), while
Electron CPU stayed below one percent per process and event-loop maxima settled at
33–35ms. Tracing the timed boundary showed that `watchExports()` repeated path
discovery every ten seconds even after it had four valid candidate paths. Windows
discovery launches PowerShell and queries `Win32_Process`, so this preserved a
recurring process/WMI workload during play.

Provider paths are now pinned after the first non-empty discovery for the current
watcher/game lifetime. Empty discovery still retries every ten seconds for startup
ordering. Game exit, auth/socket replacement or overlay restart creates a fresh
watcher and performs discovery again. Exact provider files continue to be read once
per second, without overlap, and all expiry/freshness behavior is unchanged. Unit
coverage runs the watcher for 30 simulated seconds and requires one discovery with
continued reads; the existing empty-first test still requires retry and recovery.

The repaired portable was then profiled live for 21 consecutive 15-second windows
while Fallout76 remained open. The expected first discovery took 1.511 seconds and
the startup event-loop maximum was 220ms. Across windows 2–21, bridge-pass maxima
fell to 11–25ms, event-loop maxima settled at 35–39ms, and each sampled Electron
process stayed below 0.9% CPU. Working sets stabilized or declined after warm-up,
and no watchdog, worker-exit, worker-timeout, game-scan or uncaught errors appeared.
This confirms removal of the recurring discovery spike. The laptop does not have a
native frame-time recorder installed, so subjective in-game acceptance and a future
PresentMon-class capture remain the final evidence for the reporter's visible hitch.

The first 37-minute soak completed with cleanup, but is diagnostic rather than a
final acceptance run: boundary-only visibility sampling could miss a wake and
re-hide within one interval. The final recorder counts every collapse/full-hide
transition and excludes mixed-state intervals from quiet hidden-state results.
It also includes CPU accrued by newly observed helper processes. Native artifact
verification must confirm the persistent presence route, avoiding the missing
short-lived-helper cost before applying the original acceptance budgets.

## Glitch restoration — 2026-10-13

Freezing glitch's two CSS layers also froze its tear at the stable per-message
phase. The desktop guard now advances these paused layers only at the existing
93%, 95%, 97% and 99% keyframe boundaries. One pending timeout per layer skips the
rest of each 9.5–13.5 second cycle. There is no animation-frame loop, repeating
sampler, geometry read or React state update; other frozen decorations retain
their previous behavior. Website/dashboard keyframes are unchanged.

Native Chromium diagnosis found that an exact 93% seek could report progress
`0.9299999999999999`, leaving the prior frame visible. Timeouts therefore fire
one millisecond after each boundary. Unrelated DOM changes preserve the clock;
changed CSS duration/phase reschedules it. Offscreen/document/native hiding,
collapse/full-hide, reduced motion, viewer opt-out, effect removal and teardown
cancel pending work.

The existing overlay Vitest gate covers boundary cadence, stable phase, timing
changes, all cancellation paths and 100 mount/teardown cycles. The required Linux
Electron interaction gate checks that both layers actually paint all three tears
and rest, stay paused, preserve name text/width, and stop while offscreen or hidden.
Its animation checks select the glitch layers specifically: normal hover
transitions may still run. Compare visible-unfocused and hidden CPU/layout/paint
against the frozen baseline with identical local fixtures. Short synthetic
diagnostics do not establish Windows or in-game frame-time acceptance; the native
A/B matrix remains separate.

Set `FCM_TEST_ARTIFACTS` to an owned output directory for interaction evidence;
the harness clears that directory on startup. Its default remains
`cross-platform-overlay/test-results/overlay-usability/`.
