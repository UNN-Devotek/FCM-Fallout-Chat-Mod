# xScal visible HUD acceptance — 2026-09-15

## Scope and installation

User-authorized local switch from ZFE to the official Nexus xScal 0.2.16 download, paired with
FCMChatWidget 2.10.101 against hosted Dev. Fallout 76 was confirmed closed before writing.
Initially only the visible widget was registered. The later game-closed switch to the invisible
bridge is recorded below; they are never coinstalled. No production/backend changes, publication,
commit, or game-input automation.

- Game: Steam/Proton at `/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76`.
- xScal: official downloaded `dxgi.dll`, 315904 bytes, matching the 0.2.16 harness fixture for
  Fallout runtime 1.7.26.10. A fresh native runtime/probe check remains required.
- Endpoint: existing `[Chat] enabled=true`,
  `relayEndpoint=wss://dev.falloutchatmod.com/relay`; widget link host remains hosted Dev.
- `xscal.ini`, `Data/FCMChat.ini`, `Data/hudmodloader.ini`, and the active Proton
  `Fallout76Custom.ini` were preserved byte-for-byte. Native authentication was not modified.
  Existing xScal priority/affinity settings were preserved, not reset to package defaults.
- Active loader entry: `FCMChatWidget`; archive list: `HUDModLoader.ba2,FCMChatWidget.ba2`.
- Both stale root/Data widget version stamps were corrected to 2.10.101. The decoded BA2 SWF,
  not the version-stamp file, is authoritative. Packaged keybind/customization/menu guides were
  copied into the game directory.
- Recoverable prior files are in the game directory's
  `.extender-backups/before-xscal-0.2.16-hud-2.10.101-MTikSi/`. Restore only with the game closed.

| Artifact | Initial 2.10.101 install SHA-256 |
| --- | --- |
| xScal `dxgi.dll` | `185de187aa616ae5db118f463aa43ff760f7819df77ca4a09f6b71714195fd5a` |
| `Data/FCMChatWidget.ba2` | `0d6b80715590e1f762a9d1d4267dec1fbdf0e58e3b9d7a587aa5fe3cdc83c255` |
| Extracted `interface/FCMChatWidget.swf` | `1aa6f751f227b79247edf5366edb0461aa446fae962ab8e44cc6718e0053a5a0` |

## Automated evidence

Passed before installation: all 20 widget Haxe suites; native adapter/auth suites; empty Haxe
compiler diagnostics; source anchors; package, BA2, SWF, embedded emoji and generated catalog
checks; all three JavaScript emoji suites; and the full 28-test Ruffle suite (36.9 seconds).
The installed archive's extracted SWF matches the tested normalized FWS v32 production SWF
byte-for-byte. Harness teardown released port 41739. Hosted CI was not run for these local changes.

The full suite includes xScal object-method routing, key registration/rebinding/old-key release,
editor-gated link activation, container guards, history/echo contracts, and real AVM2 widget
assertions for Server-tab visibility, history/nonce preservation, same-server recovery and real
roster changes. Some input/appearance tests assert source or browser delivery rather than GFx
state; passing them does not certify native control suppression, browser launching, visual layout,
or network delivery. Bridge regressions are included in the shared suite, but no native bridge
installation or acceptance was performed.

## Native acceptance — in progress

Fresh native evidence now confirms Fallout runtime 1.7.26.10, widget 2.10.101, selection of the
xScal adapter, and authenticated state. Initial history arrived in 16/16/9-event batches: 40
records plus the completion marker. A later replay rejected all 40 duplicate records. Three
General sends returned successful native send results and authoritative echoes; each used the
bounded fallback match (`ownEchoFallback=1`, `ownEchoAmbiguous=0`) with no appended duplicate.
All seven configured default physical keys registered successfully. This is not proof of every
physical action or of reception by Discord/another client.

The log also records a Loading transition at elapsed 00:02:08, return to ordinary HUD mode at
00:02:23, then a roster-boundary reset at 00:03:14 and a different room confirmation at 00:03:24.
The first room was confirmed three times before that change. The user confirmed this was
same-world fast travel: continuity failed in the installed 2.10.101 build.
No explicit native error-level line, rejected send or isolated callback exception was found in
the reviewed window. A bounded read-only capture completed at 01:35:27 UTC on September 16;
the manifest records `inputAutomation=false`, and the game was left running under user control.

### 2.10.102 correction — native ordinary fast-travel retest passed

The shared selector previously returned an empty MapMenuData snapshot before considering the
populated PublicTeamsData observation. New pure tests and HUD/bridge Ruffle scenarios reproduced
the reset under both xScal and ZFE before the fix. Selection now permits overlapping populated
player/public-team fallback without admitting disjoint cached lower-priority names. A populated
map still takes priority; nearby-only lists do not override an empty primary. No freshness/grace
or backend lease limits changed. All 28 Ruffle tests passed after the correction (40.4 seconds).
After the user closed Fallout 76, the
2.10.102 HUD was installed from the tested xScal/Dev package. Only `Data/FCMChatWidget.ba2` and
the root/Data version stamps changed. The unchanged xScal hash is recorded above; `xscal.ini`,
`Data/FCMChat.ini`, loader registration and active Proton archive configuration were verified
byte-for-byte against backups. Native authentication and the invisible bridge were not touched.

The prior HUD/version stamps and configuration snapshots are recoverable under the game directory's
`.extender-backups/before-hud-2.10.102-rezILC/`. Restore only while the game is closed.
The installed archive was extracted again and its SWF matched the tested normalized FWS v32
artifact exactly. Hashes of the tested visible HUD (now retained inactive):

- BA2: `43cff32998f0be42b9ca7909e9824cd3e5d5a8462ebe64282c84ecea51a3f452`.
- Decoded SWF: `4dddd9c580838c3f5aea2d5210c4312a24280b59189548d0d1d7275ea0594407`.

The subsequent native 2.10.102 run confirmed runtime 1.7.26.10, xScal selection, authenticated
state, 40 history records plus the completion marker and no dropped events. One General send
(elapsed 2:19) and one Server send (3:24) were accepted and reconciled with authoritative echoes;
both used the bounded legacy fallback match and appended no duplicate. Loading transitions at
2:46–2:53 and 3:34–3:45 preserved the same confirmed room through the reviewed 4:26 window.
There was no room/history reset or explicit error/failure in that window. This does not prove
reception by Discord/another client or visual appearance. MapMenuData remained populated
(21–24 names), so **the exact empty-map/public-team fallback is still native-test pending**.
Do not describe ordinary fast-travel success as coverage of a condition absent from the capture.

Perform these in order, with manual game input and sanitized fresh `xscal.log` evidence. Do not
carry forward older ZFE or xScal 0.1.15 results as acceptance of this installed combination.

| Check | Required evidence | Result |
| --- | --- | --- |
| Startup/auth/history | Fresh 2.10.102 marker, xScal adapter/runtime, authenticated Dev connection, complete multi-channel replay, readable text | Native startup/auth and 40-record replay passed; per-channel visual/font acceptance pending |
| Server membership | Visible Server tab plus current room acknowledgement | Native acknowledgements confirmed; user-visible tab confirmation pending |
| General/static sends | One accepted message/self-echo per channel; verify reception on Dev overlay/Discord separately | Three General sends/echoes passed; other channels and external reception pending |
| Server send | One accepted Server message/self-echo; verify another room participant separately | Native 2.10.102 send/echo passed; other-client reception pending |
| Editor/default keys | Insert opens once, typing/editing, Enter submits once, Escape cancels, gameplay input restored, Page Up/Down channel navigation, Up/Down selection only while editing, Delete hide outside editing | Pending |
| Full rebind | Game-closed edit of every binding in `Data/FCMChat.ini`, restart, accepted new VKs, each new action works and each superseded key is inactive; restore original profile afterward | Pending |
| Container conflict | With a temporary T binding, container mode does not open chat or steal Deposit All; held T does not open chat on leaving the container | Pending |
| Links/mentions | Regular URL, Discord channel and event target; selection color, shortened display, full safe URL; activation only after OpenChat; default browser actually opens | Pending; native URL-opening capability must be verified |
| Customization | Independent focused/unfocused tab colors, selected-row color, fonts/emoji, wrapping/width, settings survive restart; restore test settings | Pending |
| Same-world fast travel | Selected Server tab, existing history and room remain; no unnecessary LEAVE | 2.10.102 native room continuity passed through two loading transitions; exact empty-map fallback and visual tab/history acceptance pending |
| Real hop/MainMenu | Old Server history clears, old room leaves, new room confirms; no stale delivery | Pending |
| Recovery/performance | Reload/reconnect and repeated open/cancel/send remain responsive, no blank/crash, timers and owned input clean up | Pending |

Start with startup/history, Server membership and one General/Server send before proceeding to
more disruptive tests. Do not mass-send, reset authentication, hop worlds, or alter bindings
automatically. The read-only Linux collector in `hudmodloader-chat/native-capture/` can record a
bounded user-controlled session; it never owns or stops the game. Review sanitizer output before
sharing, and report only allowlisted counts, status, error codes, versions and timings.

## Background bridge phase — installed, awaiting manual game test

After the user closed the game, the latest local `dev` checkout (HEAD `6a3c7161`, matching
`origin/dev` at build time) was used with its existing uncommitted HUD/bridge corrections.
No commit, push, deployment or publication was performed.

- Added three repeated source-switch/travel cycles to each real HUD/bridge Ruffle scenario,
  required per-cycle pass markers and retained real-hop/expiry/MainMenu/teardown assertions.
  All 28 tests passed in 36.2 seconds under both providers; port 41739 was rebound afterward.
- Re-ran all 20 widget Haxe suites, shared native/auth tests, source/package/BA2/SWF/emoji checks,
  bridge's 34 pure checks and both package-target tests. Haxe diagnostics were empty. Also passed
  1,148 overlay unit tests, 41 backend bridge tests and six dashboard bridge-feed tests.
- Built overlay **1.4.0**, `fcmChannel=qa`, with `npm run dist:dev -- --linux --dir`.
  Installed the complete unpacked app at `/home/devotek/.local/opt/fcm-dev/1.4.0-bridge-Pto2KZ/`.
  Its `resources/app.asar` SHA-256 is
  `c9d57689d3a4ec8be8328b9826e185a2ed0c55b679eb46336efe81246a65ec25`.
  The separate **Fallout Chat Mod (Hosted Dev)** application launcher supplies
  `--user-data-dir=/home/devotek/.fcm/hosted-dev` and clears inherited relay/debug overrides.
  Startup logs confirm packaged 1.4.0, `dev.falloutchatmod.com`, that isolated profile, and no
  reported module/uncaught/renderer-exit error. Authenticated desktop chat/bridge delivery is
  **not yet verified**. It was subsequently stopped for the reported freeze isolation below;
  Prod was not replaced or stopped.
- Rebuilt **FCMServerBridge 0.1.1 DEV** after all shared roster corrections. Installed BA2:
  `f8f76272c0a18e4b6631fbce29ec61fb5981579d58d6c1b5c1b37ba2569c8515`.
  The extracted 39,856-byte FWS v32 SWF matches the package manifest hash:
  `ae6ba54c1c6d0d1d6f032dfac68a032b8665b86b3ca4aa1a06f642b07a40fba4`.
  `FCMServerBridge.build.json` and `FCMServerBridge-INSTALL.txt` accompany the local install.
- The loader now lists only `FCMServerBridge`; the active Proton archive list is
  `HUDModLoader.ba2,FCMServerBridge.ba2`. Exact comparison confirmed no unrelated INI changes.
  xScal 0.2.16 and its Dev endpoint/other settings are unchanged; native credentials were not read
  or modified. The visible HUD archive remains intact but inactive. Registry/archive snapshots,
  xScal settings and the prior visible archive are recoverable in the game directory under
  `.extender-backups/before-bridge-0.1.1-VNj1Bt/`. Restore only with the game closed.

### Steam pre-launch wait — resolved by user, bridge acceptance still pending

The user reported Fallout would not launch. Read-only inspection found no Fallout/Wine process,
no fresh xScal output (last modification 21:54:23 local), and no new crash dump. Steam's
`logs/console_log.txt:1868` shows launch action 12 waiting at `ShowInterstitials` at 22:07:51;
it advanced at 22:09:34, then line 1876 recorded **waiting for user response to CreatingProcess**.
`gameprocess_log.txt` had no new Fallout process after the preceding 21:54 shutdown. This is
confirmed pre-launch waiting, **not evidence of a bridge/native crash**. The exact pending Steam
prompt has not been visually identified. The user was asked to bring Steam forward and inspect
its launch dialog. Steam subsequently logged continuation at **22:11:26**, started Fallout,
and a fresh native xScal log identified runtime 1.7.26.10. `Fallout76.exe` was confirmed running;
the Dev overlay emitted visible=true after detecting it. No game, Steam or Prod process was
stopped and no input was automated. This confirms launch recovery, not bridge authentication
or room/desktop delivery.

Complete the Dev overlay's normal Discord authorization with the same
linked account as the bridge. Open F11 → **FCM Server Bridge** only to inspect status/linking;
there is intentionally no in-game chat widget or editor in this configuration. Verify:

1. Fresh native 0.1.1/xScal startup, authenticated state and room confirmation.
2. Desktop `bridge:state=ready` and Server tab after the account/device lease is confirmed.
   No Server tab while the game is closed is expected; an HTTP health check alone proves neither
   the deployed bridge handler nor account pairing.
3. One General message reaches the Dev static feed/Discord; one Server message reaches the
   same-room desktop/native peer exactly once. Server chat is private and does **not** go to Discord.
4. Repeated same-world travel retains the room/history; separately observe an empty-map fallback
   if the native UI produces it. Real hop/MainMenu retires the old room. Respect 30-second native
   observation and 45-second backend lease expiry; do not lengthen either to hide a failure.

Two-client same/different-world acceptance, both native providers and all remaining lifecycle,
permission, duplicate and recovery cases remain required before distribution. Ruffle coverage
cannot certify native DLL scheduling, GFx behavior or authoritative game-world identity.

### First native bridge run — failed acceptance, investigation open

The user entered a world and reported **Waiting for a fresh world roster** in F11, pressed
Reconnect, then reported the game freezing. The displayed status implies the bridge reached
authenticated state but lacked acceptable fresh in-world evidence (`FCMServerBridge.world`).
It does not establish that native reconnect caused the freeze; no current stack/crash dump or
phase-timed bridge log identifies the stalled operation. This bridge build does not emit the
visible widget's lifecycle/roster diagnostics, so absence of FCM lines in `xscal.log` is not
evidence that the bridge did not load.

The 709-byte native xScal startup log was preserved in the local evidence directory
`/tmp/fcm-bridge-overlay-dev-SyDvGr/xscal-freeze.log`; its last write was 22:12:04 local.
The existing `steam-1151340.log` was an empty June file, not evidence for this run. No game
memory was inspected. Only the exact new Dev overlay process was sent SIGTERM for isolation;
Fallout, Steam and Prod were left untouched. The user subsequently confirmed the game remained
frozen after the new Dev overlay stopped. This does not by itself identify the originating
stall. No game files were swapped while Fallout remained running; the user was asked to close
the game manually before the bridge can be disabled or replaced.

The user also reported the overlay header could not be dragged. The affected Dev-versus-Prod
window and whether the symptom persists after the new Dev process stops are not yet identified.
Do not modify Prod settings, restart the game, weaken provider-readiness gates, lengthen leases,
or claim a root cause from this report alone. Next evidence is the exact affected window,
game responsiveness after Dev shutdown, and game-closed permission before disabling/replacing
the bridge. Compare real subscription push data versus cached provider reads before changing
the roster protocol: existing mock pushes update the read cache together and cannot prove those
native paths stay synchronized.

### Bridge 0.1.2 and Linux header correction — installed, native acceptance pending

The user closed Fallout and authorized the bridge fix/install and overlay drag correction.
Process-name checks confirmed no Fallout process before game-file replacement. No game input
was automated, no native module was inspected/loaded, and Prod was not stopped or modified.

[Confirmed] The old bridge callback ignored the delivered event and reread `GetDataFromClient`.
The old mock updated the getter before invoking `callback(null)`, so it could not expose divergent
push/read snapshots. The new actual-bridge Ruffle test failed on **both** providers at “fresh event
wins over stale getter” before the fix, then passed. Upstream HUDModLoader source at
`71e2fde134933323777980b5e0fd0c6036c2408f` provides implementation evidence for
`FromClientDataEvent.fromClient` and accessor-backed `UIDataFromClient.data/dataReady/isTest`;
this is not a claim that the installed game artifact has been decompiled this turn.

0.1.2 consumes those validated envelopes, retains the event observation time while a getter lags,
and does not fall back to that older getter after push expiry. It keeps readiness/world gates and
the 30-second observation/45-second backend lease limits. Menu retries coalesce into a guarded
timer refresh; a healthy transport is not disconnected or reset by the menu callback. Identity
changes reconnect after the observation batch. ZFE controls require its async-control capability.
The bridge now emits capped fixed-field phase/status diagnostics, excluding names, room IDs,
credentials, codes and bodies. **The original native stall remains unproven**; actual transport
error/unload disconnect latency and fresh game acceptance remain manual checks.

[Confirmed] The Linux overlay handler ignored explicit `no-drag` on div/span controls and
rejected all modal drags, even though onboarding's stylesheet designates a drag header.
Two new unit cases failed before the fix and passed afterward. Real Electron tests verify native
window movement for the pre-auth strip, a shared-header-shaped fixture, actual Settings title
and actual onboarding title; the fixture's control remains stationary. These tests passed on
the local KDE/XWayland desktop and under Xvfb. The small default Xvfb screen initially clamped the
window against its work-area edge, correctly preventing further rightward movement; CI explicitly
uses a 1920x1080 test screen. This does not certify game-focused click delivery or mixed-DPI
movement distances; focus the overlay before dragging because game-focus click-through is retained.

Final local checks: 28 full Ruffle tests (36.3 seconds), all 20 widget Haxe suites, native API/auth
suites, 34 bridge-state checks, both endpoint package tests, source anchors/BA2/SWF validation,
empty Haxe diagnostics, 41 overlay Vitest files / 1,150 tests, clean overlay TypeScript check,
4 backend bridge suites / 41 tests, and 6 shared-renderer bridge-feed tests. The new desktop smoke
is wired into the existing required Linux CI gate; no hosted CI run is claimed. Test Electron
profiles/processes and local relay servers were torn down; binding port 41739 afterward proved
the Ruffle server released it. The installed Dev overlay below is deliberately left running.

Installed artifacts and rollback:

- `Data/FCMServerBridge.ba2`, **0.1.2 DEV**, SHA-256
  `46c134b3f6895dce9ca3862f645fc67cbd7eef3ca675a10845c9cd86e067bbf2`.
  The package validates one `Interface/FCMServerBridge.swf`, 41,380 bytes, FWS v32, SHA-256
  `bc2a769a52bf591e8db32d526303d320b14fa134893c45a638b05b8076e43c06`.
- Previous bridge, manifest/instructions and config snapshots are recoverable under
  `.extender-backups/before-bridge-0.1.2-aDaXG5/` in the game directory. Config comparisons confirm
  `hudmodloader.ini`, active Proton `Fallout76Custom.ini` and `xscal.ini` were unchanged.
  xScal remains official 0.2.16 with its prior hash and Dev endpoint; native auth files were untouched.
- Isolated Dev overlay 1.4.0 (`fcmChannel=qa`) is installed at
  `/home/devotek/.local/opt/fcm-dev/1.4.0-bridge-fix-4pwO2Q/fallout-chat-mod`, app.asar SHA-256
  `b270b91f4c7eb589e92f623d4f48548f7bb89adcdf5f19506abc2890847dfaae`.
  The existing Hosted Dev launcher now selects that exact executable and
  `--user-data-dir=/home/devotek/.fcm/hosted-dev --ozone-platform=x11`.
  Startup at 22:43:43 local confirms packaged=true, `dev.falloutchatmod.com`, isolated profile and
  Linux drag initialization, without a reported missing-module/uncaught/renderer-exit startup error.

Next manual check: authorize the Dev overlay if requested, enter one world, inspect F11 →
FCM Server Bridge, and verify the desktop Server tab and delivery. If it freezes again, do not
repeatedly reconnect; preserve the new phase/status log. This is an authorized local candidate,
not a release, native acceptance, backend deployment, commit or push.

## 0.1.2 native roster failure and 0.1.3 diagnostic candidate

[Confirmed] The user entered a world with the installed 0.1.2 bridge and reported F11 status
“Waiting for a fresh world roster.” Opening and closing the map did not change it. This status
is assigned in `FCMServerBridge.world` only when authenticated and `state.fresh(now)` is false.
It does not distinguish rejected MenuStackData from rejected/stale roster observations.
The fresh xScal log remained 709 bytes with native initialization only (mtime 2026-09-15
23:18:13 EDT); the optional bridge logger supplied no observation details. The installed BA2
still matched `46c134b3f6895dce9ca3862f645fc67cbd7eef3ca675a10845c9cd86e067bbf2`.

[Confirmed] A read-only check of the hosted Dev backend found its compiled bridge handlers,
and its Redis contained zero `relay:bridge:device:*`, `relay:bridge:account:*`, `relay:roster:*`
and `relay:world:*` keys. The isolated Dev overlay log showed reconnect with five channels
retained when Fallout appeared, and the backend recorded a desktop WebSocket connection.
No account/device secrets or roster contents were printed and no hosted state was mutated.
This establishes missing room evidence at that check, not the exact native rejection cause.

0.1.3 is **diagnostic-only and not installed/native-accepted**. It adds a version/provider row,
cached menu reason, overall roster freshness and six fixed per-provider reasons to the existing
F11 menu. It preserves readiness, session/lease lifetime, provider selection, transport calls,
and reconnect behavior. Menu preparation performs no native/provider calls. Labels carry no
names, payloads, room IDs or request nonces. Both Ruffle provider scenarios now require the
diagnostic marker and check read-only menu preparation, bounded inert rows and privacy. These
tests do not reproduce or fix the native failure; capture the new menu rows on the next run.

Local verification: 44 pure bridge-state checks; all 20 widget Haxe suites; shared native
API/auth checks; source anchors, BA2/SWF and emoji validation; both endpoint package tests;
all 28 Ruffle tests (37.5 seconds); 1,150 overlay tests; four backend suites / 41 tests;
six dashboard bridge-feed tests. The first backend command used nonexistent test paths and
ran no tests; the corrected `backend/tests/*.test.js` selection passed. Compiler diagnostics
reported no project-file issues, with two warnings in the installed Haxe standard library
(`Std.hx`, `Boot.hx`). The dedicated diagnostics tool was unavailable; this was compiler
`--display diagnostics`. Package tests retain existing BA2 helper ResourceWarnings. Teardown
was verified by rebinding loopback port 41739; no game input was automated. Hosted CI not run.

Prepared `/tmp/fcm-bridge-readiness-YnTTma/FCM-Server-Bridge-0.1.3-DEV.zip` (28,060 bytes):
one `Interface/FCMServerBridge.swf`, 42,685 bytes, FWS v32, 400x300, 30 fps, one frame, seven tags.
SWF SHA-256 `74f6052e5344c622b48e052b74243eaaa4e2fc4a1a04e166c56acd5c8b7e5be8`;
BA2 SHA-256 `b3bbbd4c184ab00201978d6a195eaaf309e7552dab36357e140563237884fd49`.
The package validated decoded-byte equality and target endpoint/config stamps. Game files,
native credentials, installed overlays, hosted Dev and Prod were not changed by this follow-up.

### Authorized local installation of diagnostic 0.1.3

After explicit user approval, confirmed no Fallout process and installed the exact tested Dev
archive above. The installed BA2 SHA-256 is
`b3bbbd4c184ab00201978d6a195eaaf309e7552dab36357e140563237884fd49`, matching the ZIP manifest;
the extracted payload matched the tested SWF hash and passed structural validation before copy.
`FCMServerBridge.build.json` and `FCMServerBridge-INSTALL.txt` also match the package byte-for-byte.

The three replaced files plus unchanged config snapshots are backed up in the game directory at
`.extender-backups/before-bridge-0.1.3-NiarTd/`. Byte comparisons confirm `Data/hudmodloader.ini`,
active Proton `Fallout76Custom.ini` and `xscal.ini` were unchanged. The single active bridge remains
configured for `wss://dev.falloutchatmod.com/relay`; xScal, native account credentials, Dev/Prod
overlays and hosted services were untouched. No source change or new test build occurred during
installation; the preceding full local gate applies to the installed artifact.

Native acceptance remains pending. Next: manually launch Fallout, enter a world, open F11 →
FCM Server Bridge, confirm version 0.1.3 and capture the Menu/Roster/provider diagnostic rows.
Do not include a link code or repeatedly press Reconnect. Installation does not establish that
the missing Server room or prior freeze is fixed.

## 0.1.3 native exceptions and 0.1.4 diagnostic candidate

[Confirmed, 2026-09-16] The user's screenshot identifies `Bridge 0.1.3 - xscal`,
`Menu - world allowed`, `Roster - not observed`, and `read failed` for Map, Public teams,
Player list, Team markers, Party list and Voice area. The main status remains `Waiting for
a fresh world roster`. In 0.1.3, the catch surrounds all of `FCMServerBridge.observe`, including
`GetDataFromClient`, push-cache selection and `FcmBridgeState.observe`. The screenshot therefore
does **not** identify a getter exception, missing native capability or specific error ID.
The installed bridge BA2 still matches
`b3bbbd4c184ab00201978d6a195eaaf309e7552dab36357e140563237884fd49`.
The xScal log remains 709 bytes, native initialization only, last written 2026-09-15 23:43:58 EDT.

[Confirmed] Read-only extraction of the installed `Data/HUDModLoader.ba2` (SHA-256
`0a8ef32357b484d152baab79b1c1aea90f9afcf577ad550fbdc5a8155f035f69`) yielded its
59,286-byte `interface/HUDTools.swf` (SHA-256
`c0fdaa0f54f0d36c4e84516e2941cc1ead31fa2867a32d5ff18a030eb1dbb5a3`).
FFDec 26.3.0, downloaded from the official jindrapetrik/jpexs-decompiler release, decompiled
`BSUIDataManager`, `UIDataFromClient` and `UIDataShuttleConnector`. The installed getter/subscription
signatures and provider accessors match the pinned source contract used here. This proves the
interface, not readiness or runtime contents. The installed 0.1.3 bridge was also decompiled;
`haxe.iterators.ArrayIterator` has an implementation in that SWF, so a string-table reference alone
does not establish a missing-class cause. No native module or game memory was inspected.

0.1.4 is a **diagnostic-only candidate, not installed or native-accepted**. `FcmBridgeRead` keeps
an observation-local phase, including getter versus processor entry and bounded processing stages.
Escaping errors retain only an integer `errorID` in 1..99999 or the fixed word `error`; exception
messages, stack traces, names and payloads are never rendered. A separate cached menu row reports
successful subscriptions out of eight and the latest subscription error ID. Per-attempt state
prevents nested callbacks from overwriting each other's phase. Optional-field helper catches are
unchanged; these labels do not report every absorbed property-access exception. Readiness,
transport calls, retry behavior and observation/lease limits are unchanged.

[Confirmed] The first new Ruffle error test failed on both providers: Haxe's Flash `Std.string`
catches an anonymous object's `toString` exception, so the supposed bad name was accepted. A
sealed throwing-name fixture now asserts conversion throws before exercising the bridge. Both
provider scenarios then passed, independently identifying an outer getter E1014, nested names
E1010 and subscription E1006 without private exception text. These codes are **injected test
values, not native errors observed in Fallout**. Failed observations do not create membership
or issue controls. Both scenarios require the explicit `BRIDGE-ERRORS PASS` marker in addition
to the earlier continuity, push divergence, read-only menu and teardown assertions.

Local verification: 47 pure bridge-state checks, both endpoint package tests, all 20 widget Haxe
suites, shared native API/auth tests, widget package/emoji/source/archive checks, 41 backend
bridge tests, 1,150 overlay tests and six dashboard bridge-feed tests passed. The initial full
Ruffle run had 26 passes and the two fixture failures above; the corrected complete run passed
all **28 tests in 42.3 seconds**. No project compiler diagnostics; the same two Haxe standard
library warnings remain. Existing package-helper ResourceWarnings remain. The required
`gamemod-anchors` and `hud-ruffle` CI jobs already include these suites; hosted CI was not run.
Playwright shut down its server, and a successful bind/close of loopback port 41739 verified
teardown. No game input or hosted messages were automated.

Prepared `/tmp/fcm-roster-read-failure-cxS4sq/FCM-Server-Bridge-0.1.4-DEV.zip` (28,727 bytes):
ZIP SHA-256 `163358d854d458ae526463105f964f2850a27993233ac4ddd97f02f9a9adcd80`.
Its sole archive entry is `Interface/FCMServerBridge.swf`, 43,731 bytes, FWS v32, 400x300,
30 fps, one frame, seven tags. SWF SHA-256
`14ace48c3e4a9d8ffd6ad3b189aaadc9f50610f043a0b1649d7ac8afb1d1c0c1`;
BA2 SHA-256 `25c497a08222c557ff45342e0096233eca666b930a0d33c28e6faebbd289a142`.
The package validated exact decoded SWF equality, archive structure and DEV endpoint/config
stamps. Evidence and decompiles are under `/tmp/fcm-roster-read-failure-cxS4sq/`.

Fallout was still running at the final check, so nothing was installed. The active bridge remains
0.1.3; game configurations, native authentication, Dev/Prod overlays and hosted services were not
changed. No commit, push, deployment or publication occurred. Next: obtain game-closed confirmation
and installation approval, install the tested candidate with exact-target backups, then capture
its F11 phase/error/subscription rows. Do not repeatedly reconnect or include a link code.
The underlying roster exception and prior native freeze remain unresolved.

### Authorized local installation of diagnostic 0.1.4

After the user requested installation, process checks found no Fallout game process. The exact
tested ZIP above was extracted to `/tmp/fcm-bridge-014-install-n1DQO3/`. Its manifest, DEV link
stamp, normalized SWF structure and both payload hashes were verified before copying. No source
or artifact was rebuilt; the preceding full regression gate applies to this same package.

[Confirmed] Replaced only `Data/FCMServerBridge.ba2`, `FCMServerBridge.build.json` and
`FCMServerBridge-INSTALL.txt` (the latter two are beside the game executable, not inside Data).
Byte comparisons against the extracted ZIP all passed. The installed BA2 SHA-256 is
`25c497a08222c557ff45342e0096233eca666b930a0d33c28e6faebbd289a142`.
The old three files and configuration snapshots are recoverable under
`.extender-backups/before-bridge-0.1.4-nZQRvv/` in the game directory.

Comparisons prove `Data/hudmodloader.ini`, `xscal.ini` and the active Proton
`Fallout76Custom.ini` are unchanged. The single active bridge still uses xScal and
`wss://dev.falloutchatmod.com/relay`. Native credentials, extenders, overlays and hosted services
were untouched. Initial `ps` and final separate exact-name checks confirmed Fallout was closed;
use separate `pgrep -ix Fallout76.exe` / `pgrep -ix Fallout76` checks, since a longer combined
regular expression triggers pgrep's process-name length warning and must not be trusted as a guard.

Next manual acceptance: launch Fallout, enter a world, open F11 → FCM Server Bridge and verify
`Bridge 0.1.4 - xscal`. Capture the subscription count and Menu/Roster/provider phase/error rows,
excluding any link code. Do not repeatedly press Reconnect. This installation does not establish
that Server chat works or the earlier freeze is fixed. No commit, push, deployment or publication.

## 0.1.4 native processor-entry E1014 and 0.1.5 preparation

[Confirmed, 2026-09-16] The new user screenshot shows `Bridge 0.1.4 - xscal`,
`Subscriptions - 8 of 8`, `Menu - world allowed`, `Roster - not observed`, and
`processor entry E1014` for all six roster sources. The main status remains waiting for a
fresh world roster. This fails native roster acceptance; successful subscriptions alone are
not a successful read, fresh roster or confirmed room.

[Confirmed] The ActionScript runtime reference defines E1014 as `Class _ could not be found.`
([HARMAN-maintained reference](https://airsdk.dev/reference/actionscript/3.0/runtimeErrors.html)).
The active BA2 still has SHA-256
`25c497a08222c557ff45342e0096233eca666b930a0d33c28e6faebbd289a142`.
Read-only extraction matched SWF SHA-256
`14ace48c3e4a9d8ffd6ad3b189aaadc9f50610f043a0b1649d7ac8afb1d1c0c1`.
FFDec 26.3.0 pcode export confirms the failing roster branch goes directly from the
`processor entry` label to `FcmBridgeState.observe` with six arguments; the normal getter and
push-cache work precede that label. The method exists, and its directly referenced packaged
helper classes are present. No missing class was identified by that file inspection. The
method's `flags` phase has not been reached in the screenshot. Native class resolution or
method-entry verification is the narrowed investigation boundary, not a proven absent file.

0.1.5 is **prepared, not installed and not a functional fix**. It adds one read-only cached
`Missing class` menu row for the latest E1014, using only a class identifier parsed from the
exact standard error template. It rejects absent/non-string/overlong messages, additional
stack text, URLs, menu delimiters and identifiers outside its bounded ASCII format. Unrecognized
or localized/numeric-only errors display `not reported`. It does not expose the full error or
change roster, provider, transport, retry or lease behavior. The parser cannot guarantee the
game supplies a usable class name. Both actual AVM2 Error-accessor tests and pure parser/reset
tests pass; these are injected errors, not a native reproduction.

The shared bridge scenario currently compiles the bridge and widget classes into one harness
movie (only the bridge is instantiated for this scenario). It does not exercise the packaged
bridge in an isolated GFx application domain. Its passing result cannot establish native class
resolution, and neither Ruffle nor the static artifact check identifies the missing runtime
class here. Do not claim this native failure is fixed or that subscriptions are broken.

Local checks: 61 pure bridge checks, both endpoint package tests, all 20 widget Haxe suites,
widget package tests, shared native API/auth tests, anchors/BA2/SWF tests, 41 backend bridge
tests, 1,150 overlay tests and six shared-renderer bridge-feed tests passed. Full Ruffle:
**28 passed in 37.3 seconds**, with automatic teardown verified by rebinding port 41739.
The first overlay command used absent `npm test` and ran no tests; corrected
`npm run test:unit` passed. Compiler diagnostics report no project-file issues, with the same
two Haxe standard-library warnings. Existing BA2 helper ResourceWarnings remain. The existing
required CI jobs cover these suites; hosted CI was not run.

Prepared `/tmp/fcm-bridge-e1014-JiGirF/FCM-Server-Bridge-0.1.5-DEV.zip`, 29,171 bytes. Its sole
entry is `Interface/FCMServerBridge.swf`, 44,392 bytes, FWS v32, 400x300, 30 fps, one frame,
seven tags. SWF SHA-256 `40cdead94f55ea19c13a8740fd4ef8dd4d27e4d0c30b01053f04c0ba2603cbf7`;
BA2 SHA-256 `d6123293ed342c11724e8b96a29d81838508d4590e5aef64a51e55a8d86827d9`.
The packager validated target stamps and exact decoded SWF equality. Decompiles/test logs
are under `/tmp/fcm-bridge-e1014-JiGirF/`. Installed 0.1.4, extenders, configs, credentials,
overlays and hosted services were unchanged. No game input, messages, commit, push or deploy.

Next native evidence, after an authorized game-closed install, is the new `Missing class` row
alongside the phase/error and subscription rows. If no identifier is supplied, it remains
unproven; do not replace native DLLs, weaken readiness or extend leases on this evidence alone.

### Authorized local installation of diagnostic 0.1.5

The user approved installation. Separate exact process-name checks confirmed Fallout was closed
before backup and again immediately before replacement. The existing single-bridge registry and
archive list still selected FCMServerBridge with HUDModLoader; xScal still targets hosted Dev.

[Confirmed] The tested ZIP SHA-256 is
`1f8fec07f991babf425e42b3494c91ae06d67c3f58c13bfeba8701949ec471d9`.
It was extracted to `/tmp/fcm-bridge-015-install-8iALCS/`; the DEV manifest/link stamp, normalized
SWF structure and both expected payload hashes were validated before copying. Replaced only
`Data/FCMServerBridge.ba2`, `FCMServerBridge.build.json` and `FCMServerBridge-INSTALL.txt`
(the latter two beside Fallout76.exe). All three installed files match the tested ZIP exactly.
Installed BA2 SHA-256:
`d6123293ed342c11724e8b96a29d81838508d4590e5aef64a51e55a8d86827d9`.

The previous 0.1.4 files and configuration snapshots are recoverable under
`.extender-backups/before-bridge-0.1.5-vt85XD/` in the game directory. Byte comparisons confirm
`Data/hudmodloader.ini`, `xscal.ini` and active Proton `Fallout76Custom.ini` were unchanged.
Native credentials and extenders were untouched, as were both overlays and hosted services.
No rebuild or source change occurred during installation; the preceding 61-check/28-Ruffle
regression gate applies to this exact artifact. No game input, commit, push or deploy occurred.

Native acceptance remains pending. Manually enter a world and open F11 → FCM Server Bridge.
Confirm `Bridge 0.1.5 - xscal` and capture the `Missing class` row together with subscription,
Menu/Roster and provider phase/error rows. Exclude any link code and do not repeatedly press
Reconnect. A successful install does not establish a functional Server room or resolve E1014.

## 0.1.5 native failure and shared-collector architecture (2026-09-16)

[Confirmed] The user's subsequent screenshot shows `Bridge 0.1.5 - xscal`, eight of eight
subscriptions, `Menu - world allowed`, `Roster - not observed`, `processor entry E1014` on all
six roster sources, and `Missing class - not reported`. This fails native acceptance. The last
row means the allowlisted parser did not obtain a class identifier; it does not prove the
exception had no message or identify a missing class. Attachment suffix:
`a51dc7ad-409b-459e-85e9-b406a09352fa.png`.

The user approved stepping back architecturally, then implementing the shared-collector design.
Source candidates are bridge **0.1.6** and widget **2.10.103**. `FcmHudRosterReader` unifies the
bounded roster decoder, copies names into observations and retains native payload references
only inside the game-facing collector. `FcmBridgeState` now receives decoded menu/roster values,
retains numeric local revisions instead of native data, and defensively copies emitted arrays.
Unchanged cached reads do not advance observation time. Fresh pushes/change evidence advance
revisions; older auxiliary evidence cannot move freshness backward. Invalid/damaged lists cannot
establish empty/partial membership. Thrown roster reads use capped per-source backoff without
lengthening observation/lease limits. Native transport and backend authorization are unchanged.

[Confirmed] The independent packaged host compiles without FCM production dependencies and
loads the real package's decoded child into a fresh application domain. Its initial positive
runs passed under both local mock adapters. The full combined+packaged suite then passed
31 tests; final expanded verification is recorded below. During test development, the first
packaged-driver run failed because `allowNetworking: internal` prevents ExternalInterface.
Enabling it only for the dedicated host, with nonlocal test requests blocked, allowed the driver
to observe actual packaged bridge behavior. This is a harness correction, not evidence about
Fallout's E1014.

The installed 0.1.5 game files, native credentials, extenders, both running overlays and hosted
environments were not modified. There was no game input automation, deployment, commit or push.
The candidate still needs an authorized game-closed installation followed by fresh manual native
acceptance; neither the earlier freeze mechanism nor the missing class has been established.

### Final local verification and native-failure control

[Confirmed] The versioned candidate passed all **33 Ruffle tests** (1.3 minutes), **66 bridge-state
checks**, **36 reader checks** (within 21 widget Haxe suites), native API/auth checks, source
anchors, emoji catalog/embedded assets, SWF/BA2 checks and all three bridge package tests for both
targets. Backend: four suites/41 tests; overlay: 41 files/1,150 tests; dashboard bridge feed:
six tests. Haxe diagnostics reported no project-code issues; installed standard-library warnings
and the existing archive helper's file-handle ResourceWarnings remain. Hosted CI was not run.

The five packaged tests verify exact package bytes/host isolation plus two provider-specific
lifecycle tests and two unready-provider recovery tests. Production timers drive the lifecycle;
poll counts stop after unload across more than two timer periods. Port 41739 was independently
bound and closed after teardown, confirming the owned server was released.

[Confirmed] As a negative control for native-compatibility claims, the installed failing
**0.1.5** SWF was extracted read-only (SHA-256
`40cdead94f55ea19c13a8740fd4ef8dd4d27e4d0c30b01053f04c0ba2603cbf7`). It also passed both isolated
packaged lifecycle tests (31.7 seconds). Therefore this harness does **not reproduce E1014**;
do not claim the new candidate fixes that exception from these tests. The generated test child
was restored byte-for-byte afterward. The installed archive hash remains
`d6123293ed342c11724e8b96a29d81838508d4590e5aef64a51e55a8d86827d9`.

Prepared DEV candidate: `/tmp/fcm-shared-roster-ZpnCs1/FCM-Server-Bridge-0.1.6-DEV.zip`, 30,281 bytes.
Its decoded FWS v32 SWF is 46,097 bytes and matches the final tested child exactly:

- ZIP SHA-256: `6e3b99c000d764041f2f0d130f199b4b52f4b10d1f00f950c9f14f04f242f6ed`.
- BA2 SHA-256: `b525cd641299a6c9775db94b659f610a17b16e513980e4886f7064288cbd026b`.
- SWF SHA-256: `d5a49b3e35bb995411d791780eb03daa368157d68f1eea0e10265588efa2bd44`.

Evidence and the prior generated widget BA2 are under `/tmp/fcm-shared-roster-ZpnCs1/`.
Next acceptance is deliberately small: one fresh native roster, matching backend room/lease,
then the same-account Dev overlay binding. Only after that passes, expand to two-client isolation,
same-world travel, hops, expiry and both extenders. Do not coinstall the visible widget or accept
old logs as evidence for 0.1.6. No installation or hosted change was performed in this refactor.

### Authorized 0.1.6 DEV installation

The user then requested installation. Separate exact process-name checks confirmed Fallout was
closed before backup and again immediately before copying. The tested 30,281-byte ZIP above
retained SHA-256 `6e3b99c000d764041f2f0d130f199b4b52f4b10d1f00f950c9f14f04f242f6ed`.
Fresh extraction to `/tmp/fcm-bridge-016-install-pXqOwd/` verified the DEV manifest/config stamps,
FWS v32 structure and decoded SWF equality with the tested candidate before installation.

Replaced only `Data/FCMServerBridge.ba2`, `FCMServerBridge.build.json` and
`FCMServerBridge-INSTALL.txt` (metadata beside Fallout76.exe). All three installed files compare
byte-for-byte with that ZIP. Installed BA2 SHA-256:
`b525cd641299a6c9775db94b659f610a17b16e513980e4886f7064288cbd026b`.

The previous 0.1.5 bridge and three configuration snapshots are backed up under
`.extender-backups/before-bridge-0.1.6-ZWFYVW/` in the game directory. `Data/hudmodloader.ini`,
`xscal.ini` and active Proton `Fallout76Custom.ini` remain byte-identical to those snapshots:
the sole FCM loader entry is FCMServerBridge, archives remain HUDModLoader plus FCMServerBridge,
and xScal remains enabled against `wss://dev.falloutchatmod.com/relay`. Native credentials,
extenders, both overlays and hosted services were untouched. No source/artifact rebuild,
game input, commit, push or deployment occurred during installation.

Native acceptance remains pending: manually enter a world and check F11 → FCM Server Bridge
for `Bridge 0.1.6 - xscal`, roster status, room confirmation and the Dev overlay Server tab.
If it still fails, capture the fixed diagnostic rows without link codes. Do not repeatedly
press Reconnect. The preceding 33-test Ruffle gate applies to this exact installed artifact,
but does not certify a native fix for E1014 or the previous freeze.

### 0.1.6 native result — payload boundary still failing

[Confirmed] The user's fresh screenshot, attachment suffix
`9e28b8e8-90fc-4d8e-9ea4-464c938f305e.png`, shows `Bridge 0.1.6 - xscal`, eight of eight
subscriptions, world allowed, no observed roster and `Missing class - not reported`.
Voice area, Party list, Public teams and Map report `payload E1014`; Team markers and
Player list report `test provider`. Native roster acceptance has failed. No freeze was
reported with this screenshot; it does not resolve the earlier freeze investigation.

[Confirmed] A new read-only hash check matches the installed BA2 to the tested candidate:
`b525cd641299a6c9775db94b659f610a17b16e513980e4886f7064288cbd026b`.
The 709-byte `xscal.log`, modified 2026-09-16 05:33:00 UTC, contains no FCMServerBridge,
0.1.6 phase, E1014 or roster entries. Its absence of diagnostic output does not contradict
the screenshot or demonstrate a transport failure. No native settings or credentials were read
or changed for this investigation.

[Confirmed] Source and exact-candidate FFDec AS3/P-code inspection show that
`FcmHudRosterReader.provider()` sets `payload` before reading `data` and calling `payload()`.
The latter constructs `FcmRosterObservation` before setting `list shape`. Thus this diagnostic
does not identify a particular failed getter, field or class. `test provider` is returned when
the envelope's `isTest` flag is true, before attempting payload decoding; it is not evidence
of an installed simulator. The inspected loader's BSUIDataManager also creates an `isTest`
placeholder when a native provider watch is unavailable, so subscription registration alone
does not establish usable live data. AS3/P-code evidence:
`/tmp/fcm-016-native-payload-jUPoL5/`.

[Hypothesized] GFx method-entry/class verification in the decoder could explain failure before
`list shape`. This remains unproven. The next discriminating native diagnostic is a small,
no-network synthetic-payload probe invoking the same compiled decoder, with separate phases for
payload acquisition and decoder entry. Failure on synthetic data supports a compiled-runtime
problem; success there and failure only on game-owned data redirects investigation to that
boundary. It must not accept synthetic names as a live roster, send them, bypass readiness or
extend a lease. No such probe was built or installed in this investigation.

Only documentation was updated to record failed acceptance. No source rebuild, test rerun,
installation, game input, extender/overlay change, hosted mutation, commit, push or deployment
occurred. The preceding local regression results remain valid only within their stated limits.

### Visible widget 2.10.104 direct-decoder candidate

[Confirmed, 2026-09-16] The visible 2.10.103 widget under the same Fallout runtime logged
`Error #1014` for all six roster snapshot sources. It consequently emitted no roster control or
relay `SERVER-READY`, so the Server tab correctly stayed hidden. A 2.10.100 desktop ZFE session
had previously parsed roster sources, sent the control, received `SERVER-READY`, selected Server,
and sent/received a Server message. This establishes the visible-widget regression boundary; it
does not identify a particular missing GFx class.

[Confirmed] Candidate 2.10.104 removes `FcmHudRosterReader` and its observation classes from the
visible SWF, while leaving the independent background bridge unchanged. The direct child-SWF
reader copies bounded names, rejects invalid/damaged lists, keeps no game-owned object, and uses
per-source copied signature/timestamp evidence: an unchanged getter cache cannot renew a
Server-room observation, while a fresh push or changed roster can. Unit, source, source/package,
SWF/BA2, native-adapter/auth, backend relay and overlay logic checks passed. The full Ruffle
Playwright suite passed all 33 tests across xScal and ZFE, including the relay-confirmed visible
Server tab, fast-travel continuity, real-hop rebind, expiry and MainMenu leave. These local mocks
do not prove Fallout GFx compatibility.

[Confirmed] Fallout 76 was closed immediately before installation. The production-target ZFE
archive was extracted and compared before replacing only desktop
`Data/FCMChatWidget.ba2` and `FCMChatWidget.version.txt`; the installed BA2 SHA-256 is
`4a314bf333425e9e61f88bb255831febcef69c4a7af6e05adc6fbfe1fd7c4bc8` and decoded SWF SHA-256 is
`979eb4e504ed75c8b16a4440ddc63dc4d1fae552e3ecea1d61963db6c7d55277`. The previous pair is
recoverable under `.extender-backups/before-fcm-hud-2.10.104-lijgTR/`; `FCMChat.ini` and the ZFE
fragment remained byte-identical. No game input, provider/executable change, hosted mutation,
commit, push, deployment or publication occurred.

Native acceptance subsequently failed; see the fresh evidence below.

### Visible widget 2.10.104 failed acceptance; 2.10.105 diagnostic candidate

[Confirmed, 2026-09-16] Desktop `zfe.log:11496` records `FCMChatWidget 2.10.104 loaded` at
11:28:41.357, instance 604693887. The same instance logs `snapshot phase threw: TypeError:
Error #1014` for all six roster sources through 11:30:11. The user reports the Server subtab is
still absent. This rejects the 2.10.104 fix hypothesis; it does not identify a missing class.

2.10.105 adds fixed phase labels at provider/payload/decoder/storage boundaries, including
length and cleanup phases inside the direct decoder. Errors contain only source, fixed phase
and numeric error ID, throttled to one/source/30 seconds. After the first real failure, one
local probe tests `Std.isOfType`, `Math.isFinite`, and empty/player/map/public-team synthetic
payloads. The probe calls only the decoder, never snapshot storage or transport, restores the
original failure phase, and cannot create/renew a Server binding. Ruffle exercises that
isolation and privacy for both providers. This candidate is diagnostic, not a functional fix.

[Hypothesized] If synthetic decoding also fails, the failing phase narrows a compiled-runtime
dependency; if it passes while real payloads fail, investigate the game-owned data boundary.
The next fresh native log must distinguish those outcomes before another behavior change.

[Confirmed] The 2.10.105 Haxe suites/diagnostics, emoji, native adapter/auth, source anchors,
SWF/BA2 and package checks passed. Final full Ruffle suite: **33 passed (1.4m)**, including
seven successful local probes, no raw exception text, one log per repeated source error, and
unchanged snapshots, timestamps, session nonce, confirmation lease, history and control counts
through both adapters. A test-only logger buffer captures the actual native-adapter messages;
ExternalInterface forwarding is unavailable in this harness, so browser-log absence is not proof
of missing native logging. Teardown released the harness port.

[Confirmed] With no Fallout76 process running, installed only desktop `Data/FCMChatWidget.ba2`
and `FCMChatWidget.version.txt`. Installed BA2 matches the tested and packaged payload exactly:
7,171,064 bytes, SHA-256 `788c93bcd639a2b1264d1f25e29851160811f9c9d68732629d0d607f502ca40b`.
Its decoded SWF is 7,170,975 bytes, SHA-256
`ec5f14d855ba5610242fa22682da6a0d32de704aca93bd463774bc1ec5a76b9e`.
Recoverable backup: `.extender-backups/before-fcm-hud-2.10.105-FGvI8a/`.
HUD settings and the ZFE fragment remain byte-identical. Production-target ZFE/xScal Nexus and
unified website test packages are under `/tmp/fcm-hud-2.10.105-zI0S0B/`. No laptop install,
hosted change, commit, push or publication was performed. Native 2.10.105 evidence is pending:
manually launch, join a world and wait 15 seconds, then inspect only startup/roster/probe lines.

### 2.10.105 native method-entry failure; 2.10.106 restored-reader candidate

[Confirmed, 2026-09-16] `zfe.log:11787` records 2.10.105 startup at 11:47:13, instance
779076522, with non-blocking Server controls enabled. At lines 11809–11811, integer, number
and finite probes pass. Lines 11812–11815 show empty/player/map/team synthetic reads all fail
with `phase=probe entry errorID=1014`. Real sources fail with `phase=decoder call
decoder=decoder entry errorID=1014` on both pull and push paths. The decoder's first assignment
to `decoder entered` is never reached. A 25-second filtered tail reproduced the same failures.

[Deduced] Rejection occurs on compiled method entry, independent of game-owned payload contents.
The source/SWF, old 2.10.100 backup and FFDec exports establish that commit `9adf10b9` replaced
the earlier widget traversal and closure-based map/team helper. 2.10.104 removed the shared
classes but retained much of the new unified decoder structure. Local origin/dev and origin/prod
contain identical affected source; the merge did not discard those fixes. The specific rejected
bytecode construct remains unidentified.

2.10.106 restores the previous reading split, retains bounded length checks and rejects damaged
data, while leaving copied observation timestamps and effective-roster/session/history policy
in place. `readNative` remains only as the diagnostic control and is forbidden in live collection
by a source guard. Ruffle exercises all six restored sources, malformed/throwing rows, unchanged
pull timestamps and fresh pushes, followed by the existing same-world/hop/expiry sequence.
Fresh native results are required before declaring the restoration successful.

[Confirmed] 2.10.106 passes Haxe suites/diagnostics, source anchors, SWF/BA2, emoji and package
checks. The focused restored-reader scenarios pass for ZFE and xScal, and the full suite passes
**33 tests (1.4m)** with automatic teardown and a released harness port. The scenarios exercise
six sources, invalid lengths, throwing names, unchanged-pull freshness, fresh pushes, and the
existing room/history continuity, hop and expiry checks. These do not emulate GFx verification.

[Confirmed] After verifying the desktop game had exited, installed only the tested BA2 and root
version stamp. Installed BA2: 7,172,830 bytes, SHA-256
`46c14f5870916678ae767468894396bcc7b8fdae76fc67ffeff522125d8a9105`.
Decoded SWF: 7,172,741 bytes, SHA-256
`0c18fb5ff934d0376a341a828df114eef0626084f093d9346c7aedfe3f00d94a`.
Backup: `.extender-backups/before-fcm-hud-2.10.106-T1Ga5r/`. HUD settings and the ZFE fragment
remain byte-identical. Production-target ZFE/xScal Nexus and unified website packages are in
`/tmp/fcm-hud-2.10.106-kIjthX/`. No laptop install, commit, push, hosted change or publication.
Fresh native 2.10.106 startup, roster observation, room confirmation and Server-tab acceptance
remain pending.

### 2.10.106 native roster recovery; 2.10.107 pending-auth correction

[Confirmed, 2026-09-16] Desktop `zfe.log:12189` starts 2.10.106 at 13:58:16.041,
instance 579797641. At 13:58:33.969 PublicTeamsData reports 13 names; 13:58:36.047
MapMenuData reports 18. Subsequent map counts reach 20, and TeamMarkers reaches 4 at
14:03:18.429. This instance has no observed roster E1014. Static history completes at
13:58:26.550 and new chat events continue, but no authenticated identity or roster control
appears in this instance through 14:04. The user confirms no Server tab.

[Confirmed] `startConnect()` calls `refreshAuthState()` immediately after native transport
acceptance, before the log's WSS connection succeeds. In 2.10.106, `pollEvents()` refreshes auth
only for xScal; `tickRoster()` requires a relay identity and authenticated state. `sendMessage()`
can lazily refresh a missing identity, explaining how manual sends can mask the startup race.
Git blame places the xScal-only polling gate in `4cca90fa9` (2026-09-04), not the roster rollback.

[Confirmed] A new delayed-auth AVM2 scenario reproduces this failure on unchanged 2.10.106:
both adapters receive history/roster while pending; xScal automatically binds and renders Server,
but ZFE times out with no recovery. It never forces auth refresh or sends an ordinary message.
The test result is **1 passed / 1 failed**, with ZFE's expected timeout. The mocks previously
authenticated synchronously, so the existing 33-test suite did not cover this native timing.

2.10.107 rechecks pending or missing-identity ZFE auth during normal event polling. Settled ZFE
avoids redundant reads; xScal retains continuous checks. Identity, relay acknowledgement, nonce,
roster freshness and room expiry gates are unchanged. Both delayed-auth scenarios now pass
without manual auth refresh, a reconnect or ordinary chat send. Fresh native acceptance remains pending.

[Confirmed] The complete 2.10.107 Ruffle suite passes **35 tests (1.6m)**, including both new
delayed-auth scenarios and all prior visible-widget/background-bridge cases. Teardown removes
the player and releases the harness port. Haxe widget/scenario diagnostics report `[]`; all
widget Haxe suites, native API/auth suites, source anchors, emoji generation/embedded/JS checks,
SWF/BA2 validators and provider/target package checks pass locally. Existing `hud-ruffle` CI runs
these scenarios; hosted CI has not been run for this uncommitted candidate.

Production-target ZFE and xScal Nexus archives plus the unified website archive are built in
`/tmp/fcm-hud-2.10.107-BAc2G4/`. Every ZIP contains the identical tested BA2, and the ZFE fragment
targets `wss://falloutchatmod.com/relay`. BA2: 7,172,866 bytes, SHA-256
`1257a2afa27e1f044a99e829c20829f2ee35cf32388bab4e9fb8d79b505de65a`.
Its decoded SWF exactly matches the normalized source build: 7,172,777 bytes, SHA-256
`6ba7ca536ae3ec1b02374645fb1556c3512d5a24173cdd6b63fe4b6a34a94561`.
The BTDX v1 GNRL sole-entry path and unchanged hash/flags/sentinel metadata are verified;
simulator-only drivers are absent. The desktop game is still running 2.10.106, so 2.10.107
is **not installed**. No laptop install, hosted mutation, commit, push or publication occurred.

[Confirmed, 14:13] The same desktop instance has zero auth log lines, send attempts, canonical
local send rows, matched own echoes and roster controls; it has zero roster decoder errors.
The user reports that chat appeared functional and messages could be sent, but the current
HUD log does not establish a successful send. The saved `Data/ZFE/chat-auth.bin` exists
(331 bytes, modified 03:56:31 local, before this launch); only metadata was inspected, never
its contents. File existence does not prove token validity, but there is no basis to clear it
or require account relinking as part of this correction.

[Confirmed, subsequent authorized install] After `pgrep` confirmed no Fallout76/Fallout76.exe
process, installed only desktop `Data/FCMChatWidget.ba2` and `FCMChatWidget.version.txt` from
the tested 2.10.107 ZFE/prod package. Exact byte comparison passes for both installed files;
the installed BA2 SHA-256 is
`1257a2afa27e1f044a99e829c20829f2ee35cf32388bab4e9fb8d79b505de65a`.
Prior BA2/stamp and configuration snapshots are recoverable under
`.extender-backups/before-fcm-hud-2.10.107-dJcA9w/`. `FCMChat.ini`, the ZFE fragment and
`hudmodloader.ini` remain byte-identical; saved auth file size/mtime/ctime are unchanged,
and its contents were not read or modified. No game launch, laptop change or publication.
Next native check: user launches and joins a world without sending chat first; verify restored
auth, populated roster, relay confirmation and visible Server tab on this exact build.

### 2.10.107 desktop ZFE automatic startup binding passes

[Confirmed, 2026-09-16] Fresh `zfe.log:12625` records 2.10.107 startup at 14:21:45.337,
instance 408362226, with the required online/non-blocking control capability accepted.
At 14:21:50.350 (`:12663`–`:12664`), the normal poll obtains the relay identity and logs
`authState=authenticated`, without a relink or ordinary message send. The initial roster
control is queued at 14:21:50.369 and the relay confirms membership at 14:21:51.621 (`:12691`).
History completes at 14:21:51.617. PublicTeamsData then reports 10 names, TeamMarkers 3, and
MapMenuData 23. A populated-map roster is sent at 14:22:25.346 (`:12775`), with relay
confirmation at 14:22:26.107 (`:12784`). No ordinary user-send attempt precedes either bind.
No roster decoder errors or isolated exceptions appear in the reviewed run through 14:22:46.
The user reports that it seems to be working.

This accepts desktop ZFE/prod **startup auth restoration, roster reading and automatic room
binding** for the installed artifact. It does not yet accept ordinary Server-send/echo,
same-world fast travel, real server-hop/MainMenu behavior, or laptop/xScal on 2.10.107.
Those native checks and hosted CI/release approval remain outstanding; nothing is published.

### 2.10.107 desktop Server-send and same-room travel check

[Confirmed, 2026-09-16] The same instance 408362226 receives accepted Server-send receipts at
14:29:54.300 (`zfe.log:13201`, request 16) and 14:30:25.338 (`:13340`, request 18).
The immediately following event batches each report `ownEchoMatched=1`, `ownEchoAmbiguous=0`,
`appended=0` and unchanged before/after record counts: each echo reconciles the pending row
without appending a duplicate. Both use the bounded legacy fallback, not the ID-match branch.

Between those sends, Loading at 14:30:12.747 (`:13255`) returns to All at 14:30:17.452
(`:13263`). VoiceChatAreaData and TeamMarkers become empty, but no Server-history clear,
roster boundary, reconnect or room-expiry event occurs. Relay confirmations before and after
the transition identify the same room (`:13236`, `:13359`); its actual ID is omitted here.
All reviewed confirmations since startup remain on that one room. Through 14:32:35, this
widget instance has zero warnings/errors and zero roster decoder exceptions.

Desktop ZFE/prod now passes ordinary Server send/echo and one same-room loading/fast-travel
cycle with empty auxiliary lists, in addition to automatic startup binding. No real server hop
or MainMenu leave is observed. Repeated/extended empty-primary fallback and laptop/xScal
remain unverified for this artifact. This log check does not authorize publication.

### 2.10.107 laptop install and desktop xScal test setup

[Confirmed, 2026-09-16] Following the user's explicit install/switch request, SSH Manager
confirmed the MSI laptop game was closed and installed only `Data/FCMChatWidget.ba2` and the
root `FCMChatWidget.version.txt`, replacing 2.10.103 with the tested 2.10.107 artifact.
The game directory is `C:\Program Files (x86)\Steam\steamapps\common\Fallout76`.
Prior BA2/stamp and configuration snapshots are recoverable under
`.extender-backups\before-fcm-hud-2.10.107-2c3cfc01\`. Uploaded and installed hashes match;
the existing xScal 0.2.16 provider was not changed. `FCMChat.ini`, `hudmodloader.ini`,
`xscal.ini` and the user's `Fallout76Custom.ini` are byte-identical to their backups.
No credentials were read or changed, and no legacy/background FCM bridge is registered.

After the desktop game closed, backed up its ZFE `dxgi.dll` and configuration snapshots under
`.extender-backups/before-xscal-hud-2.10.107-in63Pt/`. Replaced only the root `dxgi.dll` with
the verified xScal 0.2.16 copy retained in
`.extender-backups/20260915T-current-xscal-0.2.16-before-zfe-0.15.0/`.
The desktop HUD BA2/stamp, `FCMChat.ini`, loader registry, ZFE fragment, `xscal.ini` and active
Proton `Fallout76Custom.ini` remain byte-identical to the pre-switch snapshots. Saved ZFE
auth metadata is unchanged (331 bytes; original mtime/ctime), and its contents were not read
or migrated. Existing provider logs and inactive ZFE data remain intact for rollback.

Both installations now have the identical tested HUD BA2 (7,172,866 bytes), SHA-256
`1257a2afa27e1f044a99e829c20829f2ee35cf32388bab4e9fb8d79b505de65a`, and root version stamp
`2.10.107`, SHA-256 `07a6b2a82fd5dc1bf0a85808b72c8617ed5b5fcde165e74769940b5554a224b3`.
Both xScal DLLs are 315,904 bytes, SHA-256
`185de187aa616ae5db118f463aa43ff760f7819df77ca4a09f6b71714195fd5a`, with chat enabled and
`relayEndpoint=wss://falloutchatmod.com/relay`. Both archive lists retain
`HUDModLoader.ba2,FCMChatWidget.ba2` and the loader enables only `FCMChatWidget`.

This is installation/provenance evidence, not fresh native acceptance. Neither game was
launched by the agent. Next check on each machine: join a world without sending an ordinary
message first, then inspect fresh xScal logs for auth restoration, populated roster and
relay-confirmed binding while the user confirms the Server tab. The remaining native matrix,
hosted CI and release approval are still required. No commit, push, deployment or publication.

### 2.10.107 xScal startup passes; long-session queue-loss recovery blocks release

[Confirmed, 2026-09-16] Desktop `xscal.log:13` loads 2.10.107, instance 875989181.
The required chat/non-blocking control checks pass (`:15`–`:16`). Authentication settles at
log elapsed `00:00:32.564` (`:42`), first room confirmation arrives at `00:00:37.536` (`:81`),
and a 21-name map roster is sent at `00:01:11.937` (`:116`), confirmed at `00:01:16.940`
(`:118`). This all precedes the Server send at `00:24:06.265` (`:4570`). Its echo at
`00:24:06.936` (`:4576`) has `ownEchoMatched=1`, `ownEchoFallback=1`, `ownEchoAmbiguous=0`,
`appended=0`, and 163 records before/after. Reviewed confirmations remain on one room.

[Confirmed] The desktop nevertheless reports its first dropped-event warning at
`00:06:21.945` (`:446`), followed by a RESYNC at `00:06:23.440` (`:453`). Through elapsed
`00:30:42.283`, the read-only check counts 341 drop warnings and 98 RESYNC requests, with
history completing repeatedly at approximately 15-second intervals. No roster decoder error,
reconnect, Server-confirmation expiry or rejected ordinary send is observed in that window.

[Confirmed] SSH Manager reads the MSI laptop's `xscal.log` at the installed Steam game path.
Instance 65580425 loads 2.10.107 at log elapsed `00:28:02.974` (`:13`), authenticates at
`00:28:03.631` (`:42`) and obtains its first room confirmation at `00:28:08.396` (`:80`).
The public-team roster reaches 11 names and the map reaches 20–22; subsequent populated
controls receive confirmations (`:125`, `:153`, `:186`). The first short observation window
had no dropped markers or RESYNC requests. The later read at 19:44:50 UTC, 3,293 log lines,
instead finds **200 dropped-event warnings and 46 RESYNC requests**: first warning
`00:33:57.990` (`:480`), first RESYNC `00:33:59.506` (`:485`). That onset is about six minutes
after widget startup, similar to the desktop. This is not a clean long-session acceptance.
The user reports the laptop is good, but no laptop `sent ch=server`/matched-echo entry is
present in this captured log; keep that distinction rather than manufacturing send evidence.

[Confirmed] `FCMChatWidget.hx` marks `_history.dropped` on provider `events.dropped` markers
and schedules history recovery. [Deduced] Repeated markers are rearming recovery despite
successful history completion. The reason the provider keeps reporting loss is **unresolved**;
these logs do not establish actual lost user messages or a provider-side root cause.
Do not suppress warnings, discard cursor safeguards or claim the queue-loss issue fixed.

The user requested HUD-only packaging, prod promotion and Discord/Nexus preparation. Local
preparation proceeds, but prod merge/publication remain held for the long-session xScal issue,
remaining native matrix, commit-message approval and hosted CI for the new commit. The rerun
of all 35 Ruffle tests passes in 1.6 minutes; pure Haxe/native/auth, package/source/BA2/SWF,
emoji generation/embedding and widget compiler diagnostics also pass. Automatic teardown
releases port 41739. These mocks do not clear the newly observed native soak-test failure.

A fresh production compile and normalized SWF match the earlier tested artifact byte-for-byte.
The rebuilt one-entry BA2 and its extracted SWF also match exactly. Unified Nexus and website
candidate packages are at `/tmp/fcm-hud-release-2.10.107-VbN645/`; both contain the same BA2
SHA-256 `1257a2afa27e1f044a99e829c20829f2ee35cf32388bab4e9fb8d79b505de65a`.
The Nexus ZIP has 17 entries, no scripts/executables/provider DLLs, valid ZIP CRCs and prod
endpoint examples. It is 5,991,085 bytes, SHA-256
`3cdc7ca3e8adf10e37c8e0c54029f8a95fe384d333a8b629aed384a943da85ef`.
The website ZIP is 5,992,493 bytes, SHA-256
`f4fee4aa66abe2069c4b6b6ffeefe23cbb83ade6353fd63115a05ef2dc20615e`.
These are **blocked candidates**, not approved release files. Public notes and announcement
publication evidence is in [the HUD 2.10.110 release record](../deployment/hud-2.10.110-release-notes.md).

### 2.10.108 bounded queue-loss diagnostic candidate

The user authorized fixing and retesting the long-session failure before prod promotion.
[Confirmed] The desktop's last ordinary pre-loss batch reaches cursor 128 at elapsed
`00:05:56.937` (`xscal.log:425`); the first loss batch reaches 130 at `00:06:21.944` (`:445`).
[Hypothesized] The onset may be a retained-queue boundary rather than unread message loss.
Confirm/refute using the dropped marker's cursor/count metadata relative to the last consumed
cursor; existing logs do not expose those fields. The public xScal repository tree lacks the
current chat implementation, so it cannot establish the installed provider's queue contract.

Candidate 2.10.108 changes diagnostics only: at most three loss summaries per accepted native
connection, showing before/after cursor and fixed allowlisted numeric marker/envelope metadata.
It omits arbitrary keys, string values, message text, names, tokens and account/room IDs. Parse or
logging failure cannot interrupt normal loss handling. It does not suppress loss, reset auth,
alter cursor advancement, change recovery backoff, send extra controls or relax Server gates.

Pure privacy/shape tests and a compiled scenario for each provider cover the diagnostic cap,
unchanged loss recovery and no additional transport/records. The optional Haxe/archive/FFDec
sub-skills are unavailable; repository compiler diagnostics and archive/SWF validators are used.
This is an evidence-gathering step, **not a claimed fix**. Native capture is required before
choosing a corrective change or promoting either this build or the blocked 2.10.107 packages.

[Confirmed] All pure Haxe/source/package/emoji/archive checks and compiler diagnostics pass.
The complete Ruffle suite passes **37/37 (1.7 minutes)** after correcting its stale expected
artifact version from 2.10.107 to 2.10.108; automatic teardown was verified by rebinding the
owned simulator port. The first run's sole failure was that version assertion (36/37 passed).

The diagnostic-only PROD/unified Nexus-format ZIP was built and CRC-checked locally at
`/tmp/fcm-hud-2.10.108-CeSuk7/FCM-HUD-2.10.108-PROD-DIAGNOSTIC-Nexus.zip`, SHA-256
`02693398e4610ad92b62887c98b46a09158a2ce66750e42002e6851a9d6ce9a8`.
Its BA2 matches the checked artifact and embedded normalized SWF. Both games were confirmed
closed before installing only `Data/FCMChatWidget.ba2` and the root version stamp on the
desktop and laptop (MSI via SSH Manager). Installed BA2 hashes match on both machines:
`8a190ae5dc942f4457220f0f2e55b920d7555a55371c40e62adc41d71fe8cc60`.
Provider DLL, provider/chat/loader settings and archive registration hashes remained unchanged;
authentication files were not accessed or replaced. Previous widget/stamp backups remain in
each game root under `.extender-backups/before-fcm-hud-2.10.108-9Peezq` (desktop) and
`.extender-backups/before-fcm-hud-2.10.108-fd43a578` (laptop).

**Still pending:** launch the diagnostic build and capture its first three queue-loss summaries
after at least six minutes in-world. The root cause remains unproven; no corrective fix,
production merge, upload or publication is claimed by this diagnostic installation.

### 2.10.108 native diagnosis and 2.10.109 corrective candidate

[Confirmed] Both installed 2.10.108/xScal sessions reproduced the boundary with matching shape.
Desktop advanced normally through cursor 128, then logged `before=129 after=130` for marker
`id=130 dropped=1`. Laptop logged `before=130 after=131` for marker `id=131 dropped=2`.
In both cases the marker ID is the next contiguous sequence number, so no unread event is skipped.

[Confirmed] The old unconditional handler then requested history. Desktop's replay advanced from
130 through 207 before receiving contiguous marker `id=208 dropped=77`; laptop likewise advanced
through 208 before marker `id=209 dropped=77`. Further unconditional recovery repeated roughly
every 15 seconds. Desktop recorded 47 dropped-marker warnings / 13 resyncs in this capture;
laptop recorded 62 / 16, with no FCM errors. Authentication, relay-confirmed Server membership,
roster controls and ordinary messages continued.

[Deduced] xScal's marker count describes entries retired from its bounded queue, while sequence
continuity determines whether this subscriber missed unread events. Treating every retirement as
loss caused the HUD's history replay to fill the same queue and sustain the loop.

Candidate 2.10.109 acknowledges dropped markers whose sequence is contiguous with or stale
relative to the consumed cursor. A forward sequence gap or missing/unusable marker ID still arms
the existing fail-closed history recovery. Pure tests cover contiguous, stale, forward-gap and
unidentified markers; compiled xScal and ZFE scenarios reproduce contiguous retirement plus a
real gap. Fresh native build acceptance remains pending before production promotion.

[Confirmed] Candidate 2.10.109 passes all pure Haxe/source/package/emoji/archive checks, Haxe
compiler diagnostics, native API/auth suites, the targeted two-provider regression, and the full
Ruffle suite (**37/37 in 1.7 minutes**). Automatic teardown was verified by rebinding port 41739.
The tested PROD/unified Nexus-format ZIP is
`/tmp/fcm-hud-2.10.109-yxpVr1/FCM-HUD-2.10.109-PROD-Nexus.zip`, SHA-256
`e88cefa1aa48970a33944fff42eb775eb2e0b017c415dcb1e14a27cb94b778bd`.
The decoded/tested and installed BA2 hash is
`e19f41ac36ab33697135f0b53dd48d43c2e87b5ca2309a5e8261d5f80167ab6b`.

Both games were confirmed closed immediately before installing only the BA2 and root version
stamp on desktop and laptop. Provider/config/archive-registration hashes remained unchanged and
authentication files were not accessed. Recoverable backups are
`.extender-backups/before-fcm-hud-2.10.109-CIPy9X` on desktop and
`.extender-backups/before-fcm-hud-2.10.109-d445baf1` on laptop. Fresh native startup, automatic
Server binding, send/echo, and a soak beyond the previous retention boundary remain pending.

[Confirmed] Fresh 2.10.109 native xScal acceptance clears the queue-retirement regression on both
machines. Desktop instance `707150630` restored authentication and Server membership, crossed the
retention boundary with three contiguous `unreadGap=0` markers, and continued normally through
cursor 152 after 7:07 elapsed: **0 history resyncs, 0 dropped-event warnings, 0 FCM errors**, with
four relay room confirmations. Laptop first crossed the boundary through cursor 140 with the same
zero-resync result; its external server disconnect interrupted that session. After reconnect,
instance `911998730` restored authentication and Server membership automatically, acknowledged
three more contiguous retirement markers, and continued through 10:31 log elapsed with **0 history
resyncs, 0 dropped-event warnings, 0 FCM errors** and five room confirmations. No Server send was
observed in these specific 2.10.109 log blocks, so send/echo relies on the previously accepted path
until explicitly repeated. The retention/resync fix itself is native-accepted on both machines.

For the requested follow-up ZFE test, both games were confirmed closed and the provider DLL was
swapped from xScal 0.2.16 to the locally retained ZFE 0.15.0 archive. Installed DLL SHA-256 on both
machines is `3431d70517fd979e4f5193b1d9fd9d76dae7a8d341fae9838e5249b8f3fcb8b0`.
The tested 2.10.109 HUD, root stamp, chat/loader configuration and per-machine ZFE fragment hashes
were preserved; authentication data was not read or replaced. The existing `xscal.ini` is retained
as inert rollback configuration because xScal's DLL is no longer installed. Provider backups are
`.extender-backups/before-zfe-0.15.0-hud-2.10.109-vGdLdc` on desktop and
`.extender-backups/before-zfe-0.15.0-hud-2.10.109-323e68fa` on laptop. Fresh ZFE native acceptance
is pending.

[Confirmed] Fresh ZFE 0.15.0 launch logs load FCMChatWidget 2.10.109 on both machines, discover
`zfe-chat-online-v1` on the first attempt, enable the non-blocking Server-control path, synchronize
Insert, register all physical navigation keys, connect TLS/WSS, restore relay authentication, and
complete retained history without FCM errors. Desktop resolves populated map rosters and receives
four relay room confirmations with live chat continuing through cursor 364803. The laptop was
intentionally not taken through the user's login/world test, so no Server-room confirmation is
required there; it nevertheless restores relay authentication, receives history/live chat and
continues through cursor 364803 without an FCM error. Neither session includes a user Server send.

ZFE itself emits a short burst of `mod API bridge live install failed for all member names`
warnings (15 desktop / 16 laptop) while installing its bridge into unrelated UI movies. The active
FCM widget already reports its API capability as available and continues successfully afterward;
these are provider-level warnings, not FCM transport/auth/history failures.

## Bridge 0.1.7 follow-up from the accepted HUD release

The release owner pointed to a then-current release-note draft, later consolidated into the
[HUD 2.10.110 release record](../deployment/hud-2.10.110-release-notes.md), and
reported that the newly released HUD has working Server chat. Review of the current `dev`
checkout (`7f7647ee` before this change) and the native evidence above changes the bridge plan:
the proposed synthetic decoder probe already ran in visible HUD 2.10.105. It failed before
decoder entry; the split reader restored in 2.10.106 recovered populated native rosters.
2.10.109 subsequently confirmed automatic Server binding on both providers within the
recorded per-machine limits. The precise rejected bytecode construct is still unknown.

Source candidate **FCMServerBridge 0.1.7** adapts that split. `FcmHudRosterReader` delegates
map/public-team lists to the same `FcmRoster.readNames` used by the working HUD; the other four
sources use a separate bounded traversal. It rejects invalid/damaged lists before storing
observations. Cached reader state now holds only copied signatures, timestamps and revisions,
not game-owned payloads. Replacing a wrapper around identical names cannot renew freshness;
validated pushes and changed normalized contents can. Provider readiness, test-data rejection,
world/loading gates, room nonces, relay confirmation and expiry/backoff limits remain intact.

The bridge already calls `getAuthState` on every poll and has no HUD history-resync path. The
widget-specific 2.10.107 pending-auth and 2.10.109 retirement-marker fixes were therefore not
transplanted. No widget live source, backend, overlay or native extender changed.

[Confirmed] The new freshness regression and accepted-reader source guard failed on the old
bridge code before correction. The former state test's fresh-solo expectation relied on new
empty getter wrappers: it now requires expiry to remain closed, followed by an explicit fresh
push to establish solo evidence. Local verification passes:

- 67 bridge-state checks; 37 reader checks within all 21 widget Haxe suites; native API/auth tests.
- Four bridge source/package tests across Dev/Prod, widget package/anchors, SWF/BA2 validators,
  emoji catalog/embedded linkage and three JavaScript emoji tests.
- **39 Ruffle tests, 1.8 minutes**, including all six valid/throwing-name sources in both actual
  bridge scenarios, retained same-world/hop/expiry/privacy gates and isolated exact-package tests.
- Backend four suites/41 tests; overlay 44 files/1,163 tests; dashboard bridge feed six tests.
- Compiler diagnostics for bridge, widget and changed scenario report `[]`; `git diff --check`
  passes. Automatic teardown was independently checked by binding/closing port 41739.

The first alternate-output widget compile supplied a second SWF target and was rejected by
Haxe; replacing the existing output argument fixed the command. The resulting normalized
visible-HUD SWF compares byte-for-byte with the existing tracked artifact. Existing archive
helper ResourceWarnings and backend Jest's force-exit notice remain; hosted CI was not run.

Prepared `/tmp/fcm-bridge-017-yvCWtN/FCM-Server-Bridge-0.1.7-DEV.zip`, 31,474 bytes. Fresh ZIP
extraction/BA2 decoding equals the exact child used by the completed Ruffle run. Its sole entry
is `Interface/FCMServerBridge.swf`, 48,673 bytes, FWS v32, 400x300, 30fps, one frame, seven tags,
with a final End tag. Both provider examples and linking instructions target hosted Dev.

- ZIP SHA-256: `20bbbbc387d13c729b1ad20f51ece3c01e7766bb1b8e53176d993dcdfba356aa`.
- BA2 SHA-256: `b74c5100424dae7760df8042d9491e5cf74b842fd94cdc3fb869adc7b35507b0`.
- SWF SHA-256: `16659de436934a91f65a8c918e4734b888173841c0108efa8b644b7bbf2fe557`.

**Not installed, published or native-accepted.** The user-launched next test must independently
confirm 0.1.7's fresh roster → native relay room → same-account Dev overlay tab, then continuity
and expiry under each extender. Visible-HUD success and passing Ruffle do not certify this
new compiled child. There was no game input, game-file/config/auth write, live network test,
commit, push or deployment. Unnamed MCP project tools were unavailable; tracker preflight and
synchronization remain pending, not claimed complete.

## 0.1.7 local install and Dev overlay launch

The user subsequently authorized replacing the local visible HUD with this bridge and building/
running the matching Dev overlay. Exact process-name checks found Fallout 76 closed before
game-file changes. The Steam/Proton game root is
`/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76`.

- Installed the exact tested 0.1.7 DEV BA2 above; installed bytes and SHA-256 match
  `b74c5100424dae7760df8042d9491e5cf74b842fd94cdc3fb869adc7b35507b0`.
  `FCMServerBridge.build.json` and `FCMServerBridge-INSTALL.txt` beside the game executable
  also compare byte-for-byte with the final tested package.
- Backups are under the game root's `.extender-backups/bridge-0.1.7-dev-etb0ZR/`.
  The visible `Data/FCMChatWidget.ba2`, both active version stamps and the widget's ZFE fragment
  were moved into its `removed/` tree. Loader/custom INI, widget appearance settings and the
  previous Dev desktop launcher were copied into the backup. Existing unrelated backups remain.
- Changed only the FCM loader entry and FCM archive name: `FCMServerBridge`, with
  `sResourceArchive2List=HUDModLoader.ba2,FCMServerBridge.ba2`. A byte comparison confirms
  the active Proton `Fallout76Custom.ini` has no other changes. No loose FCM SWF was present.
- Retained the existing ZFE installation; no extender or credential files were changed.
  The bridge fragment uses `Endpoint=wss://dev.falloutchatmod.com/relay`,
  `DefaultChannel=server`, `AllowedChannels=server`, `AutoConnect=false`.
  `Data/configuration/zfe.ini` is absent, so no global TextChat override is present.
  The inactive xScal configuration was left untouched.
- Re-ran overlay unit tests: **44 files / 1,163 tests passed**. `npm run dist:dev -- --linux --dir`
  completed; packaged metadata is `Fallout Chat Mod`, version `1.4.0`, `fcmChannel=qa`.
  Existing Vite config/deprecation/chunk warnings remain, with no build failure.
- Installed the whole unpacked app in
  `/home/devotek/.local/opt/fcm-dev/1.4.0-bridge017-MfLwgp/`, including its launcher icon.
  `resources/app.asar` SHA-256:
  `8cdee84f87a3e4a665d53925d867dcd9be1a27bbe560b09e0e7343696677b518`.
  Updated only `fcm-hosted-dev-bridge.desktop` to this executable, retaining the explicit
  `--user-data-dir=/home/devotek/.fcm/hosted-dev --ozone-platform=x11` arguments.
- Fresh startup at `2026-09-16T23:07:12Z` confirms packaged execution, the exact new executable,
  `relayHost=dev.falloutchatmod.com`, and that isolated profile. No missing-module, uncaught or
  fatal startup error was observed. The renderer reached active chat, then hid to the tray and
  closed its WebSocket normally because the game was closed. This is startup evidence, not
  evidence of a new bridge room or matching-account native acceptance.

The user-requested Dev overlay remains running. No game input was automated; the game, Prod
overlay/launcher/profile, backend and native auth were not modified or restarted. No publication,
commit, push or hosted deployment occurred. Next: launch the game manually, enter a world,
check F11 → FCM Server Bridge for 0.1.7/provider/roster/room status, then verify the same-account
Dev overlay's Server tab, send/echo and same-world travel. Do not repeatedly press Reconnect
while collecting the first native result. Rollback requires the game closed and restoring only
the backed-up FCM files/registrations, not overwriting unrelated later configuration changes.

## 0.1.7 desktop ZFE acceptance and next-provider setup

[Confirmed, 2026-09-16] The fresh desktop ZFE log identifies bridge `0.1.7`, authenticates at
19:16:19 local time, observes a fresh in-world roster at 19:16:47 and reports `bound=true` at
19:16:50. It remains authenticated/fresh/bound through the subsequent half-hour observation.
During user-confirmed same-world fast travel it changes status to `Waiting for world roster
recovery` at 19:48:55, then `Connected - chat is in the desktop overlay` at 19:49:07. All recorded
states in that transition retain `auth=true`, `fresh=true`, `bound=true`; there is no connect or
disconnect call in the inspected travel window. The user confirms the Server message appeared
once and the preceding history stayed intact. Message delivery is user-observed acceptance,
not an inferred backend acknowledgment: this overlay log does not record message ACKs or room IDs.

No E1014 or FCM transport error appears in that inspected run. ZFE's UI attach E37 / failed
bridge-publication warnings recur around other UI loads despite the working FCM binding. Two
earlier control calls took 413/434ms; 95% of the first 110 measured controls were at most 9ms.
Travel-window controls were at most 10ms. This bounded pass does not certify all freeze paths,
real world hops, extended loading/expiry, two-account room matching or native xScal.

The user then requested Windows-laptop ZFE testing and desktop xScal testing. With the desktop
game confirmed closed, its provider was switched to the retained official xScal **0.2.16** DLL,
SHA-256 `185de187aa616ae5db118f463aa43ff760f7819df77ca4a09f6b71714195fd5a`.
Only `xscal.ini`'s relay endpoint changed from Prod to `wss://dev.falloutchatmod.com/relay`;
all other xScal settings compare unchanged. Bridge BA2 and loader remain the tested 0.1.7 DEV
artifact. The inactive ZFE fragment/auth are retained; credentials were not read or migrated.
Rollback snapshot: `.extender-backups/bridge017-before-xscal-3b2JfX/` under the desktop game root.
Fresh xScal native acceptance remains pending. Use one in-world bridge at a time for a shared
account; simultaneous devices deliberately make its background-bridge lease ambiguous.

## 0.1.7 Windows laptop install and native Dev overlay build

[Confirmed, 2026-09-16 local time] Connected to the existing SSH Manager `msi` entry; no
network/port scan was performed. The Windows game was closed. Nexus mod 4065's current files
page still lists ZFE **0.15.0**, uploaded 2026-09-15 20:46 UTC. The laptop's existing `dxgi.dll`
is already byte-identical by SHA-256 to the retained official archive payload:
`3431d70517fd979e4f5193b1d9fd9d76dae7a8d341fae9838e5249b8f3fcb8b0`.
It was therefore verified and retained, not replaced with an unneeded duplicate download.

Installed the exact 39-scenario-tested bridge 0.1.7 DEV package in
`C:\Program Files (x86)\Steam\steamapps\common\Fallout76`. Its installed BA2 hash remains
`b74c5100424dae7760df8042d9491e5cf74b842fd94cdc3fb869adc7b35507b0`.
Visible-HUD BA2/stamps and its ZFE fragment were moved into the recoverable
`.extender-backups\bridge017-dev-QA71bh\removed\` tree. Loader/archive/settings and ZFE DLL
snapshots are in the parent backup. Appearance config and native credentials remain untouched.
The loader now lists only `FCMServerBridge`; the archive list retains HUDModLoader and replaces
only `FCMChatWidget.ba2` with `FCMServerBridge.ba2`. The new ZFE fragment targets hosted Dev,
server-only, `AutoConnect=false`. The existing global ZFE INI has no `[TextChat]` override.

Built the current overlay source **natively on the MSI Windows laptop**, not under Wine:

- Staging/evidence: `C:\Users\White\fcm-build\bridge017-QA71bh\`.
  Current source archive SHA-256:
  `2fa57bcd235905dc7b824a9824f5519c2b8d07a211d3d02198f252f7d68f279f`.
- The original SSH child exited without output. A held-open SSH attempt exposed the system
  Node 24.11/jsdom 30 engine mismatch and PowerShell treating npm stderr as terminating output;
  a later held-open command hit SSH Manager's observed 30-second cap despite a longer requested
  timeout. Used a unique, time-limited on-demand task with explicit exit-code checks and logs.
- Used portable Node **24.18.0** only in staging, verified against the official Node checksum
  list: ZIP `0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821`.
  System Node was not upgraded. The initial reduced staging archive omitted three test fixture
  surfaces; their ENOENT errors were corrected by supplying the actual repository files, not
  suppressing tests. The final run passes **44 files / 1,163 tests** on Windows in 13.54 seconds.
- `npm run dist:dev -- --win --x64 --dir --publish never` succeeded. Verified packaged metadata
  (`1.4.0`, `Fallout Chat Mod`, `fcmChannel=qa`) and required main/preload/core/renderer entries.
  Installed `resources/app.asar` matches the build, SHA-256
  `ccd8087edefdde3f5270c43c7c7651cfc397294e040c652fe4e832e18d535ffe`.
- New application: `C:\Users\White\Apps\FCM-Hosted-Dev-1.4.0-bridge017\`.
  New desktop shortcut: **Fallout Chat Mod (Hosted Dev)**. It removes inherited relay/persona
  overrides and launches with `--user-data-dir=C:\Users\White\.fcm\hosted-dev`.
  The old portable Dev executables (1.3.91/1.3.98) and prior on-demand task definition are backed
  up in `C:\Users\White\FCM-dev-uninstall-backup-bridge017-QA71bh\`. No registered NSIS
  overlay installation or running old overlay was found. Old installers in Downloads and all
  existing application profiles were left alone.
- The existing **FCM Dev Overlay Interactive** on-demand task now launches the new installation
  in the signed-in Windows session. Fresh startup at `2026-09-17T00:08:42Z` confirms `win32`,
  Electron 43.2.0, the exact installed executable, `relayHost=dev.falloutchatmod.com` and the
  isolated profile. Processes run in interactive session 1, with no observed missing-module,
  uncaught or renderer-crash startup entry. This is a startup smoke check, not authenticated
  room/message acceptance or a signed/published release.
- Removed the temporary build task, both staged `node_modules` trees, staged duplicate package
  output and portable build Node runtime/archive after installed-hash verification. No staged
  executable remained running. Source archives, scripts, logs, installed app and rollback copies
  are retained. The intentionally running installed Dev overlay is not a temporary harness.

Next Windows test requires normal Dev Discord sign-in in the new isolated overlay profile and
native linking at `https://dev.falloutchatmod.com/link` if prompted, using the same account on that
machine. Native credentials were not copied from desktop or Prod. Start only one in-world bridge
for that account, then verify 0.1.7/ZFE, fresh roster, Server tab, one send/echo and preserved
history during same-world travel. Windows native acceptance and the desktop xScal follow-up
are still pending. No game input automation, backend deployment, publication, commit or push.
