# Archived HUD build notes

## Shared-editor input correction candidate 2.10.116 (2026-09-20)

- Native 2.10.110 evidence showed the SharedHUDTools field repeatedly transitioning from a
  one-character draft to empty, while every Enter edge was independently polled as the selected-link
  command and no chat send followed.
- Enter is now reserved exclusively for editor submission; selected-link activation defaults to F8.
  The widget retains and restores the last stable draft across unexplained empty host observations,
  while Backspace/Delete may still deliberately clear the field.
- Static startup history remains backend-owned: the relay still replays up to 15 persisted rows per
  static channel. This correction does not alter backend history, Discord mappings or retention.
- All Haxe/compiler/source/native-adapter/package/SWF/BA2/emoji gates, the complete 60-case Ruffle
  suite, 135 focused relay tests and 196 overlay widget tests pass. Native acceptance remains pending.

## Session Server transcript candidate 2.10.115 (2026-09-19)

- Retains accepted, room-authorized Server rows across room changes, travel, confirmation expiry
  and MainMenu for the current widget/game session. A new widget instance starts empty and the
  existing configured message cap bounds memory.
- Incoming rows and sends remain fenced to the current relay-confirmed room. Room transitions
  reset only room-scoped native deduplication, while canonical retained message IDs prevent replay
  duplicates.
- Adds Ruffle coverage for hop, expiry and MainMenu transcript retention. All 60 Ruffle cases and
  the complete local Haxe/native-adapter/package/SWF/BA2/emoji gates pass. Native acceptance
  remains required.

## Backend room-evidence candidate 2.10.114 (2026-09-19)

- Sends only fixed-schema, authenticated `roster_send`, `roster_hold`, `roster_boundary`,
  `roster_stale` and `main_menu` transitions. Provider, selected source, roster count and build
  are allowlisted; no player names, roster contents, messages, raw identifiers or tokens enter
  diagnostic controls.
- Consecutive duplicate controls are suppressed and each widget instance is capped at 32.
  Diagnostics use only the already-required nonblocking control transport and cannot change or
  renew room membership.
- The backend retains a bounded 24-hour pseudonymous event ring covering client state, changed
  roster evidence, reload holds, grace, assignments, splits, rebinds and clears. An admin-key-only
  endpoint reads either the global or per-user chain without collecting client logs.
- All Haxe/source/native-adapter/package/artifact gates and all 60 Ruffle cases pass. The rebuilt
  BA2 extracts to the tested normalized SWF byte-for-byte; overlay and dashboard unit/build gates
  also pass. Prod-target tester packages are staged in Downloads. The byte-identical BA2 and
  version marker are installed on the desktop after a game-closed check; provider/settings/loader
  files are unchanged and rollback is retained under the game root's `.extender-backups/`.
- Backend-first rollout and fresh two-client native acceptance remain required.

## Stable-room diagnostics candidate 2.10.113 (2026-09-19)

- Retains 2.10.112's chronological Server-history projection.
- Adds a one-shot inventory across all supported BSUI roster surfaces. Only provider/row field
  names and allowlisted identity-like field names are logged; values, names, roster contents,
  messages and tokens are never logged or transmitted.
- Pairs with the backend's non-renewing partial-sighting grace, deterministic stable-component
  inheritance and privacy-safe split/rebind decision telemetry. Those room semantics are backend
  owned; older HUD clients remain protocol-compatible.
- All Haxe/compiler/source/artifact/package checks and the complete 60-case Ruffle suite pass.
  Native acceptance remains pending; the candidate is not installed or published.

## Server-history chronology candidate 2.10.112 (2026-09-19)

- Preserves original relay `createdAt` values and the existing authorized-history carrier marker
  on canonical HUD records. The message timestamp is used for ordering only; it is not rendered.
- General excludes restored Server rows older than its loaded static-history horizon and slots the
  overlapping replay among existing rows chronologically. The Server subtab retains the full
  replay, and live current-room Server rows remain visible in General.
- Pure planning tests and compiled xScal/ZFE scenarios cover the projection and ordering. Native
  verification remains required before release.

## Roster-visible self evidence, private candidate 2.10.111 (2026-09-19)

- Adds up to four bounded `@self:` values to the existing printable v1 roster control. These are
  room-grouping evidence only; relay-token identity and message attribution do not change.
- The local UI name is collected from the same bounded roster rows that expose peers. The backend
  still requires mutual sightings, and old relays safely treat the additive field as an unmatched
  peer name during rolling deployment.
- Automated gates are required before local installation. Fresh two-client native acceptance
  remains pending and this candidate is not a published release.

## Production release 2.10.110 (2026-09-16)

- Published as a HUD-only update after commit `775905d0` and production merge `782024f6`.
- Retains 2.10.109's distinction between contiguous/stale xScal queue-retirement markers and
  forward/unidentified cursor gaps. Both xScal test machines crossed the former soak boundary
  without a resync or FCM error; ZFE 0.15.0 restored saved auth/history on both machines and the
  desktop received relay-confirmed Server membership.
- Adds the retained-local-row supporter refresh. Only rows whose sender ID matches an
  authenticated local account alias inherit the authoritative projection; same-name foreign rows
  remain untouched.
- Passed the complete local HUD gate, 37-case Ruffle suite, hosted CI, final 2.10.110 ZFE startup
  checks on both machines, and the retained 2.10.109 xScal native recovery checks. Published BA2 SHA-256 is
  `7db1b0149d637772c0c1db8b884c8dc41e3017c0833e23ad242db50edd7422b2`.

## Queue-retirement recovery fix, 2.10.109 release precursor (2026-09-16)

- Fresh 2.10.108 logs on both xScal machines show the first retention marker is the next
  contiguous event after the consumed cursor at the 128-entry boundary.
- The prior unconditional recovery replayed roughly 77 history events into the same bounded
  queue, causing another retirement marker and a self-sustaining 15-second resync loop.
- Acknowledge contiguous/stale retirement markers without recovery. Preserve fail-closed history
  recovery for forward gaps and markers without a usable sequence ID. Pure and compiled tests
  cover retirement and real-gap cases. This behavior passed fresh native acceptance and shipped
  unchanged in 2.10.110.

## Queue-loss evidence, diagnostic candidate 2.10.108 (2026-09-16)

- Both long-session 2.10.107/xScal captures report repeated dropped-event markers and RESYNC
  completions after roughly six minutes, while auth and Server membership remain healthy.
- Existing logs omit the marker/envelope queue metadata. Public xScal source lacks its current
  chat implementation, so neither a native queue bug nor a cursor-contract mismatch is proven.
- Add only the first three numeric queue summaries per connection, with fixed field allowlists
  and no message, identity or credential values. Preserve existing loss recovery and cursor gates.
- Pure tests and both-provider compiled scenarios verify privacy, bounded logs and no additional
  transport. This is diagnostic instrumentation, not a root-cause fix or publication approval.

## Pending ZFE authentication recovery, candidate 2.10.107 (2026-09-16)

- Native 2.10.106 restores populated roster reads, but the initial ZFE auth check runs before
  its asynchronous handshake finishes. Subsequent event polls only rechecked xScal, leaving
  local auth/identity unset and Server joining gated until a user send forced another read.
- Refresh pending or missing-identity ZFE auth on the existing event poll. Preserve xScal's
  continuous checks, all identity/Server confirmation gates, and settled ZFE's bounded reads.
- Add actual-widget delayed-auth scenarios for both adapters: history and roster arrive while
  pending; normal timers must then recover auth, send the roster and attach the Server tab
  without a user message or reconnect. The test fails on 2.10.106 for ZFE and passes for xScal;
  both pass with the correction.
- Fresh native acceptance is required before release; no publication is authorized by this fix.

## Restore the native-proven reader path, candidate 2.10.106 (2026-09-16)

- [Confirmed] The 11:47 native 2.10.105 run passes integer/number/finite probes but every
  synthetic decoder input fails at `probe entry` with E1014. Real reads fail at `decoder entry`.
  GFx rejects the method before its first statement; payload contents are not the trigger.
- [Confirmed] Commit `9adf10b9` replaced the previous native traversal with the shared decoder.
  2.10.104 removed the shared classes but retained the incompatible unified method structure.
- Restore the previous split: direct widget traversal for four sources and the closure-based
  `FcmRoster.readNames` for map/team sources. The unified method is used only by local diagnostics.
  Preserve bounded reads, damaged-list rejection, copied freshness timestamps and current
  effective-roster/history/session policy. Native acceptance remains necessary.

## Native roster diagnostic candidate 2.10.105 (2026-09-16)

- [Confirmed] Desktop ZFE loaded 2.10.104 at 11:28:41, then continued to report E1014 for all
  six roster sources. The user confirmed no Server tab. The direct-decoder candidate failed.
- Added fixed acquisition/decoder/storage phases and numeric error IDs for both pull and push
  failures, throttled per source. A one-shot local probe exercises numeric helpers and synthetic
  decoder inputs after the first real failure; it cannot write world evidence or call transport.
- This is diagnostic instrumentation, not proof of a native fix. Ruffle tests verify probe
  isolation, error privacy and repeated-error throttling through both provider contracts.

## Direct GFx-safe roster candidate 2.10.104 (2026-09-16)

- [Confirmed] The native 2.10.103 widget log threw `Error #1014` for every roster source before
  any roster control or `SERVER-READY` confirmation; the Server tab therefore remained hidden by
  its intended readiness gate. A prior 2.10.100 session under the same Fallout runtime completed
  roster controls and rendered Server chat.
- The visible child no longer invokes `FcmHudRosterReader` or its observation classes. Its direct
  `FcmRoster.readNative` path copies bounded names, rejects damaged lists, retains no native
  objects, and uses signature/timestamp evidence so an unchanged getter cache cannot renew a
  Server-room observation. The independent background bridge remains unchanged.
- Added pure direct-decoder checks and a source gate; the existing two-provider Ruffle scenario
  continues to assert a relay-confirmed, visible Server tab plus travel/expiry behavior.
- The exact production-target ZFE BA2 and version stamp were installed on the desktop only after
  the local gate and a game-closed check. The previous pair has a recoverable backup; ZFE/HUD
  settings were untouched. Native acceptance subsequently failed; publication, deployment, commit
  and push remain pending. Passing Ruffle/package checks cannot establish Fallout GFx compatibility.

## Shared roster collector candidate 2.10.103 (2026-09-16)

- The visible widget and background bridge 0.1.6 now share the native-data decoder. Game-owned
  objects stay at the collector boundary; bridge session policy stores only copied values.
- Invalid/damaged lists cannot establish or renew room evidence. Unchanged getter snapshots
  retain their timestamp; pushes/change evidence advance local revisions, not world identity.
- Added pure reader tests and an independent Ruffle host loading the exact packaged bridge SWF
  in a fresh application domain. Both provider transports are local mocks, not hosted Dev.
- Previous 0.1.5 native bridge acceptance still failed with E1014 and no parsed class identifier.
  Neither these architectural changes nor passing Ruffle tests establish a native fix.
- Not installed, deployed or published. See the current [build guide](../../../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md).

## Populated roster fallback candidate 2.10.102 (2026-09-15)

- Confirmed native failure on 2.10.101/xScal 0.2.16: the user fast-traveled within the same world.
  `MapMenuData` became empty while public-team observations stayed populated; strict empty-map
  precedence starved the usable roster until the 60-second grace expired and a new room was bound.
- Shared selection now permits populated player/public-team fallback only with overlap in an
  established session. Populated higher-priority rosters still win; disjoint cached lower-priority
  names and nearby-only lists cannot override an empty primary. Expiry and backend leases stay
  unchanged. The invisible bridge uses the same selector for membership and boundary retention.
- Pure HUD/bridge regressions and all four AVM2 provider/surface cases failed before the fix.
  The complete 28-test Ruffle suite then passed (40.4 seconds), including real-hop/expiry/MainMenu
  safeguards. These are local mock-provider results, not native travel acceptance or hosted CI.
- After the user closed Fallout 76, 2.10.102 was installed for the xScal/hosted-Dev retest.
  The old HUD/version stamps were backed up; settings, extender, native credentials and archive
  registration were not changed. Installed decoded SWF equality passed. Native retest is pending.
- BA2 SHA-256: `43cff32998f0be42b9ca7909e9824cd3e5d5a8462ebe64282c84ecea51a3f452`.

## Same-server fast-travel candidate 2.10.101 (2026-09-15)

- Confirmed: the 20:42 loading transition was same-server fast travel (user confirmation).
  Empty `TeamMarkers` triggered a pending boundary even with the main roster populated,
  clearing Server history and assigning a new room after LEAVE/rebind.
- Session decisions now prefer fresh `MapMenuData`, then `PlayerListData`, then the auxiliary
  union only if neither exists. Callbacks store snapshots without making irreversible boundary
  decisions. Same/overlapping lists retain the tab, rows, and nonce; disjoint full rosters still
  leave before rebinding even if an auxiliary contains old names.
- Empty-primary recovery is bounded at 60 seconds, never refreshed by repeated empty polls and
  never extending the existing relay lease. Initial solo binding and explicit MainMenu exits
  retain their behavior. Lease expiry cannot suppress a later required LEAVE.
- Added pure roster regressions and an autonomous AVM2 Ruffle scenario for both native adapters.
  Reintroducing the old auxiliary rule failed both tests at `same world preserves Server tab`.
  The harness now reads movie parameters correctly and attaches its trace observer after load,
  so requested-provider/state assertions cannot silently pass against browser-only controls.
- Candidate only: no local game installation, backend deployment, or publication in this change.
- Local validation passed: all 20 `test-*.hxml` suites, native adapter/auth tests, empty compiler
  diagnostics, source anchors, BA2/SWF/package tests, emoji generation/embedded/JS checks, and
  the complete 26-test Ruffle suite (32.7 seconds). Automatic teardown left no listener on
  port 41739. The rebuilt archive contains exactly one SWF, extracted byte-for-byte equal to
  the normalized FWS v32 artifact. Hosted CI and native acceptance remain pending.
- BA2 SHA-256: `0d6b80715590e1f762a9d1d4267dec1fbdf0e58e3b9d7a587aa5fe3cdc83c255`.

## GFx-safe ZFE receipt candidate 2.10.100

- Replaces the 2.10.99 async send/control receipt parser with the existing bounded,
  exception-free `FcmJson` reader. The build already enabled `haxeJSON`; the previous claim
  that a missing native JSON global caused this failure was not established.
- Fresh 2.10.99 diagnostics showed a 48-byte response and a later WSS completion while the
  widget took the synchronous-success branch. The raw envelope was not captured.
- Adds documented queued-envelope, whitespace, malformed-type, nested-object, and source-gate
  regressions. The render coalescer, six-row slices, and row reuse are retained unchanged.
- Rebuilt and validated the production-target FWS v32 SWF and one-entry BA2, then installed it
  locally with ZFE after confirming Fallout 76 had exited. The previous 2.10.99 BA2 remains in
  the timestamped local backup directory.
- Fresh 2.10.100 logs confirm queued/completion handling. They show the remaining failure:
  a link notice received by the first HUD instance is absent after a movie reload, and
  limited-identity RESYNC/send/roster requests receive `permission_denied`. The local backend
  recovery fix resends that private notice without clearing native credentials; it still
  requires hosted deployment and in-game acceptance.

## ZFE terminal send/control completion candidate 2.10.99

- Treats ZFE's immediate `status=queued` response as queue admission only and correlates its
  numeric `requestId` with the later `chat.send.accepted` or `chat.send.failed` poll event.
- Keeps an optimistic message pending until a durable relay echo/receipt, surfaces terminal
  failure codes, and leaves the Server tab gated on `FCMCTL/1/SERVER-READY`.
- Delays the fast follow-up poll to 750 ms so ZFE's asynchronous WSS worker can publish its
  completion. The Ruffle ZFE mock now exercises the same two-stage behavior instead of returning
  a false synchronous relay success.

## Provider-gated Server-room binding candidate 2.10.98

- Restores automatic roster-derived Server-room binding on ZFE only when runtime info advertises
  `zfe-chat-async-control-v1`; older synchronous ZFE builds remain fail-closed so a relay timeout
  cannot freeze Fallout's Scaleform thread.
- Keeps xScal Server-room binding on its asynchronous `chatInterface` path and adds provider-parity
  unit coverage for both safe paths plus the legacy-ZFE rejection case.
- Extends the simulator fixtures with a HUD-published roster and relay-style `SERVER-READY`
  response, and adds source/package assertions for both provider paths. The executable native
  Haxe tests verify capability gating and exact control payload preservation; final
  BSUIDataManager subscription/acknowledgement remains an in-game acceptance item because the
  current Ruffle build does not expose the movie callbacks needed to observe that state.

## Provider physical-key rebind candidate 2.10.96

- Fixes channel-next, channel-previous, and hide parsing so recognized physical tokens such as
  F8, F7, and F2 are not silently replaced by their defaults.
- Registers `openKey` through numeric `Input.*` for both providers. This covers ZFE F-keys when
  its narrower native `updateChatHotkey` watcher returns false; accepted native tokens remain a
  compatibility fallback.
- Fresh ZFE 0.12.26 in-game acceptance on 2026-09-15 confirmed the F12/F8/F7/F6/F5/F4/F3/F2
  profile.
- Fresh xScal in-game acceptance on 2026-09-15 confirmed the rotated F2/F3/F4/F5/F6/F7/F8/F12
  profile. The native log accepted all eight VKs, selected `provider=xscal`, completed Dev history
  replay, and retained 41 records; manual testing confirmed the reassigned actions worked.

## Terminal subscribe-history candidate 2.10.93

- Subscribe-time relay history ends with exactly one `FCMCTL/1/HISTORY-DONE` system frame after
  the bounded snapshot and queued live frames.
- ZFE drains full 16-event batches immediately instead of waiting for an impossible 64-event poll.
- Recovery remains armed until the terminal marker arrives; receiving one static row is no longer
  treated as a complete snapshot.
- Adds backend ordering/uniqueness coverage and a multi-poll ZFE Ruffle scenario.

## ZFE synchronous-roster stability candidate 2.10.92

- Disables automatic Server-room roster and leave controls on ZFE. In-game logs showed failed
  roster controls blocking Fallout's Scaleform thread for about 15 seconds; repeated retries looked
  like a recurring freeze/crash loop.
- Keeps ordinary ZFE chat, authentication, static-channel history, input, and direct browser-link
  activation enabled. xScal retains automatic Server-room binding.
- Adds policy tests for editor suppression, bounded retries, membership churn, and unsafe synchronous
  transports.

## Local direct-link/history-recovery candidate 2.10.91

- Selected HTTP(S) links now use GFx `navigateToURL` directly, avoiding the synchronous ZFE relay
  call that could block Fallout 76's UI thread for the network timeout and required a connected
  desktop overlay.
- A `LINK COMPLETE` identity transition re-arms bounded history recovery, so a pre-link
  `permission_denied` RESYNC cannot leave the newly linked HUD with only live messages.

## Local bindable-link candidate 2.10.90

Added `activateLinkKey` (Enter by default) across the INI, persisted-environment merge, named and
physical provider paths, focused SharedHUDTools editor, simulator profile, package validation, and
documentation. The action is fail-closed unless OpenChat owns an editor and the selected row has a
validated HTTP(S) target.

## Local tab/keybind/container-safety candidate 2.10.89

Applied active/inactive tab colors with exact TextFormat character ranges, kept file-defined
keybinds and HUD-mode guards authoritative over persisted appearance, synchronized ZFE's native
watcher after discovery, and blocked input acquisition in ContainerMode so a T binding cannot
steal Fallout's Deposit All action. The browser harness can load the locally installed game's
Roboto Condensed font library without checking it into or distributing it with FCM.

## Local ordinary-link parity candidate 2.10.88

Applied URL abbreviation before emoji planning so messages containing both ordinary HTTP(S) links
and emoji retain correct decoration offsets. Selection keeps the original full first URL as its
action target and is repainted after feed snapshot replacement.

## Local link-selection candidate 2.10.86

Added row-based Up/Down selection, a selected-row highlight, bounded URL abbreviation, and empty
Enter activation. Browser opening is handed to the linked user's connected Electron overlay over
the existing authenticated relay; the HUD mod itself has no browser or independent network API.

## Local selection-color candidate 2.10.87

Made the row highlight color independent from the active-tab color. It is selectable from the
existing F11 color palette, serialized as `selectedRowColor`, and included in xScal layout sync.

> Historical snapshot preserved during the 2026-09-12 documentation audit. Statements such as
> “current,” “installed,” “pending,” and “not yet deployed” below refer to their original test
> session, not today's state. This file is an investigation record, not an active runbook.
> Use [BUILD.md](../../../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md) for current build/install steps, [the HUD index](../../../../overlay/zfe/README.md)
> for current behavior, and [styling test history](../../../../testing/hud-emoji-status.md) for
> the final 2.10.74 ZFE confirmation. Older emoji failures, Haxe/bridge recipes, source-only
> labels, diagnostics plans, and ZFE hotkey-contract availability may be superseded.

---

## Local physical Delete candidate 2.10.85

The 2.10.84 xScal trace confirmed that Delete reached the host as `Unmapped` and eventually reduced
the focused field from four characters to zero, while the editor-safe hide guard kept the panel
visible. It also exposed a configuration gap: `hideKey` still shipped blank and physical Delete
was not registered as an idle hide trigger. Version 2.10.85 makes `hideKey=DELETE` the shared
default, registers it through the selected provider's physical `Input.*` surface, and sends its
edge through the same input-ownership guard. Delete edits while an editor is open and hides after
the editor closes. Named-action behavior remains available on loaders that forward Delete by name.

## Local editor-safe Delete candidate 2.10.84

All hide entry points now fail closed while either provider's editor owns keyboard input. If a
user configured `hideKey=DELETE`, the named Delete action returns unhandled to SharedHUDTools or
the ZFE fallback so it can edit the draft; it cannot close the editor or hide the panel. Once the
editor closes, that same configured action hides normally. `/hide` still works because commands
are evaluated after submission, and the F11 menu remains available while idle. Pure command tests
cover idle hide, active-editor Delete, blank bindings, and unrelated actions. The maintained
ZFE/xScal matrix records this shared rule alongside the visible editor, callback recovery, provider
discovery, key sources, and frame-budgeted renderer.

## Local Windows frame-budget candidate 2.10.83

An xScal 0.1.15 log from Windows 10 confirmed that 2.10.79 removed the white intermediate frame
but continued rebuilding every visible retained row when a message arrived. At 76-187 rows, 115
of 119 sliced rebuilds took at least 100 ms end to end, with a 166 ms median and 3,038 ms maximum.
More directly, the synchronous first slice repeatedly occupied 32-65 ms. No native relay poll
crossed the widget's 50 ms slow-call threshold, so the log does not support the network call as
the observed stall source.

Version 2.10.83 reduces each render turn from 32 rows to six. Using the observed cost of roughly
one millisecond per row, this targets less than eight milliseconds of Scaleform construction per
turn. Atomic staging remains in place, so the older complete feed stays visible until all slices
finish and the new snapshot commits. Packaging tests lock the slice limit. This mitigates the
confirmed frame spikes without changing history limits, ordering, filtering, emoji, or provider
behavior; fresh Windows 10 xScal frame-time validation remains required.

## Local lost-submit recovery candidate 2.10.82

The 2026-09-13 ZFE log confirmed that 2.10.81 opened the SharedHUDTools editor and retained four
successive characters, but Enter removed `stage.focus` without invoking the registered TextEdit
callback. No send followed, while the widget's logical `_inputOpen` flag remained true and blocked
later Insert edges.

Version 2.10.82 binds a high-priority, observational key-down listener to the public focused input
field. It retains the draft only in memory and arms recovery on Enter without preventing the host
event. A 225 ms watchdog gives the normal callback priority. If the field disappears and the
callback remains missing, the widget invalidates that generation, balances `EndTextEdit`, and
submits the captured draft once. Escape, Tab, and unexplained focus loss cancel instead and restore
Insert. `FcmSharedInputRecovery` has pure tests for grace, submit, cancel, empty draft, and missing
editor cases; package anchors require the recovery integration. The same BA2 behavior applies to
ZFE and xScal because both use SharedHUDTools first. The production-target BA2 was installed in the
local Steam/Proton game directory with ZFE and the default key map; fresh in-game acceptance is
pending.

## Local visible-input correction candidate 2.10.81

Both providers again open the visible SharedHUDTools editor first. The widget enables selection on
the focused public input TextField because the host creates it with `selectable=false`; the
2.10.79 trace showed that field returning to length zero between ordinary keys. ZFE retains its
buffered native editor only as a fallback when SharedHUDTools cannot open. xScal never receives
ZFE-only input calls. Shipped key settings remain Insert, Page Up/Down, Up/Down, with newest and
hide unbound.

## Local provider-aware input candidate 2.10.80

This superseded candidate selected ZFE's buffered native API first. In-game testing showed Insert
was detected, but the native buffer did not provide the visible chat field. Version 2.10.81
restores the shared visible editor and keeps native input as fallback only.

Pure Haxe tests cover ZFE, xScal, unavailable-native, and unknown-provider routing. Both provider
transports, history recovery, rendering, and packaging remain in the single shared artifact.

## Local atomic-refresh diagnostic candidate 2.10.79

The message feed retains its last complete display snapshot while delayed row batches are built in
a hidden staging container. Each staged row receives its final content position before one guarded
commit replaces the active snapshot. A newer render generation, panel rebuild, link/account state
change, failure, or unload discards the staging container without exposing it. This removes the
partially positioned overlapping rows that produced a bright flash during message refresh.

For xScal sessions, SharedHUDTools remains the only lock-owning text editor. While that editor is
open, the widget samples only public `stage.focus` TextField metadata: text length, caret and
selection indexes, input type, and `maxChars`. Logs use the `inputdiag` category and never include
the draft. This is diagnostic instrumentation for the reported `hello` -> `o` replacement; it does
not force the caret or alter selection before the runtime trace establishes the cause.

Pure Haxe generation tests cover the commit gate, and package/source tests require both the atomic
snapshot and privacy-safe input diagnostic anchors. In-game xScal validation remains pending.

## Local combined General candidate 2.10.78

General displays General, current-room Server, Trading, Events, Infests, and Raids using
the same canonical records as the individual tabs. Source labels and send destinations stay
intact. Replay rejection now precedes self-echo reconciliation; a known ACK ID cannot be
overridden by a different event with the same sender/body. Room validation and clearing still
apply to Server messages. New-message counts follow the selected view.

The review also fixes physical scroll aliases (including reversed Up/Down bindings) and
contains failures in delayed render slices with the same plain-text fallback as the first
slice. Existing CI suites cover the new filter matrix, replay/reconnect/world transitions,
echo-ID conflicts, key aliases, and delayed error recovery. Compile/package checks do not
establish in-game compatibility; test this candidate on ZFE and xScal before release.

## Local xScal open-key hotfix 2.10.77

[Confirmed] xScal exposes the documented `Input.RegisterKey` and
`Input.IsKeyPressed` callbacks through the generic HUD callback. The widget now maps
`Data/FCMChat.ini` `[FCMChat] openKey` to a Windows virtual-key code, registers it
when xScal is selected, and opens the editor on a physical down edge. The existing
named `HUDMod::UserEvent` route remains as a fallback. `Input.RegisterKey` is
bookkeeping/polling, not keyboard suppression; xScal's documented suppression
functions apply to gamepad buttons. The key is unregistered when the widget unloads.

The mapping accepts the packaged key names (Insert, Delete, Home, End, Page Up/Down,
arrows, Escape, Tab, Space, F1-F12, letters, and digits). Unknown or control-map-only names fail closed
and keep the named-action path available. This build does not invent an `OpenChatKey`
setting in `xscal.ini`.

## Local navigation hotfix 2.10.76

[Confirmed] The local ZFE 2.10.74 log registers keys 33/34/38/40/36/35, then
stops the navigation timer with Error #1014 before its first poll diagnostic.
[Hypothesized] The ZFE decoder's Haxe JSON parser/printer dependencies trigger
GFx method verification failure, including on its native-boolean fast path.
This build uses the existing bounded FcmJson reader and traverses nested objects
without serialization. Timer failures now identify the key/read/dispatch step.
Native mock tests and source dependency guards run in CI; runtime success still
requires a fresh ZFE game session. No new hotkey payloads are guessed.

The existing Input.* ZFE compatibility path is observed locally, not guaranteed
by the public ZFE API contract. zfe-input-v1 identifies input.v1 text sessions,
not arbitrary physical keys. The public Modder Guide names zfe-hotkeys-v1 and
hotkeys.v1.register/poll/unregister, but the detailed payload contract was not
available in the public articles reviewed. Capability-gated migration remains
pending that contract; this patch retains current key ownership and xScal behavior.
See https://www.nexusmods.com/fallout76/articles/255 and articles/248.

Build the legacy bridge with `--class-path hudmodloader-chat` so it can share
FcmJson; build.sh and CI include this path. No INI changes are required.

> **Local test build 2.10.78:** Includes retained-message replay protection, duplicate
> diagnostics and the appearance/auto-hide controls. Built for local production-connected
> testing; no public release or in-game verification is implied by compilation.

# FCMChatWidget build, install, and verification

> **Widget version:** 2.10.78. This is the optional in-game HUD-mod track. It is
> never installed or modified by the desktop overlay.

## Release status — 2.10.74

The user confirmed the ZFE test works after correcting its global endpoint to Prod.
The xScal emoji path also reached native sprite placement in-game. The diagnostics
below describe the investigation history; the earlier block-rendering limitation is
superseded. See `docs/testing/hud-emoji-status.md` from the repository root for evidence.

## 2.10.74 ZFE name-color diagnostic

User confirms emojis work with ZFE, but chosen name colors are missing for their
own and other users. This build counts validated incoming/carrier name colors and
rendered rows whose name color differs from the theme. No identities, raw colors,
or message contents are logged. No rendering behavior is changed; the loss boundary
was traced to a Dev/Prod mismatch: the global ZFE configuration still targeted Dev,
where the sending account had no chosen name color. Check both the fragment and
`Data/configuration/zfe.ini` `[TextChat] Endpoint`; the desktop global setting has
been corrected to Prod, awaiting a restarted-game test.

## 2.10.73 compatibility candidate

The emoji planner now uses a sorted array and binary lookup, with direct string
concatenation and decimal catalog IDs. This removes the `haxe.IMap`, `StringMap`,
and `Std.string` dependency paths seen in its 2.10.72 decompile. This is a targeted
compatibility candidate, **not proof of the exact missing runtime class**. All 5,273
catalog sequences are checked in both the interpreter and JavaScript UTF-16 tests.

The shared xScal/ZFE rendering path retains the complete styled baseline. When
planning succeeds but picture decoration fails, it builds a styled readable-name
fallback. Planner/catalog, layout, and sprite placement diagnostics distinguish the
remaining failure stages without logging message content. In-game confirmation of
pictures, wrapping, and colors is still required for each extender.

## Current verified status — 2.10.72 (2026-09-08)

The user confirmed that the desktop HUD styling is correct again: channel/name/body
styling and the vector supporter star are restored. Their screenshot still shows
block placeholders where the sent emojis should appear. Emoji sending reaches Discord
and the desktop overlay; successful delivery does **not** establish HUD image rendering.

The fresh desktop xScal log identifies `BUILD=chatv1-widget-v2.10.72` and reports
`kept styled row; step=emoji-plan: TypeError: Error #1014`. The optional emoji path is
failing during planning, before sprite decoration. The styled baseline survives, as
intended, but raw Unicode can display as missing-glyph blocks in the game font.
The exact missing runtime class/dependency is not established. Do not describe this
as a confirmed sprite placement, bitmap, or font-only root cause.

| Surface / behavior | Evidence and status |
| --- | --- |
| Desktop xScal message styling | User-confirmed correct in 2.10.72 |
| Emoji sending to Discord and overlay | User-confirmed working |
| Emoji pictures in the HUD | Unresolved: tested messages show blocks |
| Native sprite artwork | Offline FFDec previews and linkage checks pass only |
| Current ZFE build in-game | Not verified by this test; shared code/tests are not runtime proof |
| Public HUD downloads | Not updated by these local test installations |

A styled baseline is built before optional emoji work. Emoji errors retain that row
rather than forcing the whole feed into the emergency plain-text view. `/emoji`,
queued sends, reconnects and the other current transport features remain included.
See [the test record](../../../../testing/hud-emoji-status.md) for the remaining checks.

## Current experimental image implementation

The candidate uses native SWF bitmap-filled sprites, not AS3 BitmapData or TextFieldEx
image substitutions. `emoji/build_sprites.py` (Pillow 12.3.0) refreshes a checked-in tag
archive offline; `normalize_swf.py` embeds it without downloads or Pillow. Checksums
bind the archive to the PNG manifest. `emoji/generate.py` regenerates the catalog and
Sprite factories; notices and licenses ship in `licenses/emoji/`. No game-owned assets
are embedded. The catalog includes Twemoji 17.0.3 and 48 FCM Discord emojis captured
2026-09-08. Animated custom assets are static renditions; animation is not implemented.

The intended layout reserves NBSP glyphs with letter spacing and places sprites at
measured bounds after native text formatting. CRLF is normalized before indices are
calculated. Up to 32 pictures per row are planned. This path has **not** been confirmed
in-game: the current test fails before decoration. Readable-name fallbacks exist for
some paths, but cannot be promised for every emoji failure; blocks remain visible.

### Superseded experiments

- 2.10.69/70 used BitmapData and a TextFieldEx substitution probe. The 2.10.70
  in-game row-builder failure caused the styling regression; sending still worked.
- 2.10.71 introduced native sprites but still failed before a styled row was built.
- 2.10.72 isolates the complete styled baseline from optional emoji processing.
  Styling is now confirmed; emoji planning/rendering remains unresolved.

Offline SWF previews prove asset structure and appearance in that previewer, not
Fallout GFx compatibility. Previous text-width-probe and 128-bitmap-cache descriptions
apply only to the removed image-substitution implementation.

## Sending emojis (2.10.70)

Type `/emoji <name>` to send one emoji to the selected channel. Examples:
`/emoji smile`, `/emoji heart`, `/emoji thumbs_up`, `/emoji grinning face`,
or `/emoji <custom Discord name>`. Names are case-insensitive; underscores and
spaces are interchangeable, and surrounding shortcode colons are accepted.
A bare `emoji <name>` is accepted when the native editor consumes the slash.
`/g /emoji heart` also works through the existing channel-switch parser.

Custom names take precedence over Unicode names. Use `unicode:<name>` or
`discord:<name>` to disambiguate. Common aliases include smile, grin, heart,
thumbsup, thumbsdown, laughing, joy, and wave. Bare `/emoji` shows usage; unknown
names show a local error and do not send. The command resolves from the bundled
catalog, so newly added/renamed custom names require a refreshed HUD build.

The shared submit handler converts the command into Unicode or Discord markup
before the normal send/outbox path. It retains channel membership checks, auth,
moderation, rate limits, retry receipts and ordinary Discord bridging. No bot
impersonation, new relay operation, or desktop-overlay command handler is added.

## What it does

The feed uses one native multiline plain-text TextField per message, at the full current feed width.
The channel tag is inline on the first line; every continuation starts underneath that tag and
wraps at the current right edge. Auto-size owns the height, and resizing rebuilds all rows.
The author alone uses the chosen name color; message text, colon, and custom tag use the
configured standard text color. Channel colors remain independent.

Supporter stars remain row-local vector shapes, with measured non-breaking spaces reserving
an inline slot immediately before the name. The slot follows the name when the prefix wraps.
First-author and slot character bounds must agree on a line and provide sufficient room before
the star is displayed; unavailable metrics hide only the optional marker, not the message.
The outer feed rectangle clips the scrolling list, not individual message continuations.
Body CRLF/LF/CR line breaks normalize to LF; markup remains literal text. After assigning
`text`, `setTextFormat` applies exact character ranges: baseline/body/theme, channel/channel
color, and name/chosen color. No HTML inheritance is used for message colors.

[Confirmed, installed Steam English assets] `interface/fontconfig_en.txt` maps the Light/Bold
aliases to Roboto Condensed Light/Bold. FFDec 26.2.1 inspection of `interface/fonts_en.swf`
from `SeventySix - Interface_en.ba2` finds U+00A0 at glyph index 101 in both fonts, positive
advance (4340/4360 font units), and an empty outline (`EndShapeRecord` only). The reserved
space is therefore an available blank glyph, not an unsupported character placeholder.
Extracted SWF SHA-256: `5aaeadcf59ebce885509cac98d69ec3654f82f0cec8d6fb254238991ef534c61`.
This is English-font asset evidence; other font overrides and runtime line-break behavior
still require visual confirmation. No extracted game font is packaged with the widget.

Native rendering still requires an in-game visual check at wide and narrow sizes, with long
names, custom tags, moderator references, stars, and several chosen name colors.

xScal position/size now persist per authenticated relay device in Postgres
`hud_pairing_tokens.hud_layout`, because xScal does not implement ZFE storage commands.
The private `FCMCTL/1/LAYOUT/GET;requestId` and `SET;requestId;json` controls travel through
its sanctioned chat bridge. `FCMLAYOUT/1;requestId;json` replies are consumed internally,
never displayed as chat. Restore/save requests retry at most once per 10 seconds; a newer
local move invalidates older replies. Desktop and laptop tokens keep separate layouts.
ZFE continues using vendor-scoped local storage; the packaged link URL is preserved.
The pending appearance backend extension also persists font/input dimensions, colors, opacity and auto-hide. Deploy it before testing persistence with HUD 2.10.77; older backends accept only geometry and reject the new settings payload. Relinking with a new device token starts with packaged defaults.

Deploy the matching backend and idempotent migration to enable xScal geometry persistence.
The HUD requires `getAuthState.permissions.canSaveHudLayout=true` before sending layout
controls; on older backends, wrapping works but remote geometry persistence stays disabled.
In-game checks still required: both extenders, long/short messages, narrow/wide resizing,
world leave/join, game restart, and separate desktop/laptop geometry. Compiling and unit
tests are not proof of a successful Fallout GFx render or native round-trip.

v2.10.60 updates the unlinked instructions to offer Steam or Discord.

v2.10.78 includes all six feeds in General, retaining each row's original channel label.
The individual tabs remain channel-specific views. Sending from General still sends to General;
SERVER delivery remains scoped to the confirmed room and is cleared from both views on leave.

PipBoy actions release the current HUD text editor before returning control to the game.
The open-input path refuses entry during the 1.5-second menu transition and while exposed
`MenuStackData` contains PipBoy. Existing input polling also closes an editor if the menu
appears without a named action. SharedHUDTools callbacks carry an editor generation so a
late callback cannot submit or close a replacement editor. This is an ownership handoff,
not xScal keyboard suppression; the provided xScal keyboard API does not offer suppression.
In-game verification must exercise simultaneous Insert/PipBoy and reopening after closing
PipBoy on both providers. Static tests do not certify that a game freeze is resolved.

`FCMChatWidget.ba2` contains `interface/FCMChatWidget.swf`, a HUDModLoader child
widget. It calls the active script extender's sanctioned chat API for authenticated community
chat: ZFE's `chat.v1` dispatcher or xScal's `chatInterface` under `__SFECodeObj` or
`__SFCodeObj`. Current xScal builds may also expose a generic call-only
`__SFCodeObj.call` callback object on the movie root; it is not the chat surface and must not
be classified as ZFE.
It only uses HUD UI data that Fallout 76 already exposes to its HUD; it does not
read game memory, inject code, alter game state, or scan local ports/networks.
Message timestamps are not displayed in the in-game feed; legacy timestamp settings are ignored.

xScal connection is asynchronous. A successful `connect` response with
`status:"connecting"` is an accepted start request, not authenticated readiness. The widget keeps
the native transport alive, polls `getAuthState` until it reaches `authenticated`, and only
reconnects for terminal xScal states such as `rejected` or `disconnected`. The generic
`__SFCodeObj.call` callback, when present beside `chatInterface`, is diagnostic-only and receives
FCM's `log` calls, never chat transport calls. xScal receives parsed ActionScript objects for
`connect`, `pollEvents`, `sendMessage`, `getAuthState`, and moderation/report
commands. `getRuntimeInfo`, `disconnect`, `logout`, and `clearChatAuth` are invoked with no
arguments, matching the xScal interface contract; they must not receive the JSON string `{}`.

The widget's community tabs are deliberately a **single static text strip**. They
are navigated with the configured control-map actions and slash commands; do not
add HUDButton instances over that strip. Doing so creates the overlapping labels
that v2.9.2 removed.

The `SERVER` room uses an authenticated relay session. The widget sends a bounded
nearby-player roster control from HUD UI data; the backend derives a short-lived
room from it. New controls use printable `FCMCTL/1/*` framing; the relay retains
legacy NUL framing for deployed widgets. There is no client-side relay-control HMAC
or shared secret in the distributed SWF. `worldId` controls are a guarded
compatibility fallback.

Both providers receive the same complete bounded history from the long-lived relay subscription.
A fresh cursor-zero subscription sends up to 15 recent rows for each static feed (`global`,
`trade`, `events`, `infests`, and `raids`) plus up to 50 rows from the current `server` room:
125 events total. The native `pollEvents` limit remains 64, so the widget drains the ordered
snapshot over multiple polls. xScal's asynchronous subscriber is drained with a 250 ms
warm-up for at most 20 polls, so history appears promptly after authentication. ZFE uses the
same subscribe-time stream. Both providers use an authenticated, 1.5-second `FCMCTL/1/RESYNC`
fallback when static history is absent or the native queue reports loss. SERVER and link notices
do not suppress recovery; a normal static snapshot does. Accepted recovery restarts the bounded
drain and forces the next roster/world bind, which releases deferred current-room history.

After the correlated streamed room confirmation, the widget drains the server snapshot every 150 ms until two
consecutive empty polls (hard cap: eight attempts), covering xScal's delayed subscriber delivery
without waiting for the normal five-second poll.

v2.10.58 also reads map player markers and public-team members, resets the room nonce at
world boundaries, and keeps SERVER hidden until the relay confirms that nonce. Native queued
success alone never enables the tab. See [Server session binding](../../../../overlay/zfe/native-chat-relay/server-session-binding.md)
for deployment order, metadata fields, expiry, and roster-derived mapping limits.

The v2.10.54 widget explicitly pulls the cached values for `PlayerListData`,
`TeamMarkers`, `PartyMenuList`, and `VoiceChatAreaData` after subscribing. The upstream
`BSUIDataManager.Subscribe()` call installs a change listener but does not replay the current
provider value, so relying on the callback alone can leave a newly joined world without a
`SERVER` tab or its history. Each provider is stored as a replaceable snapshot. A provider changing from a nonempty snapshot to an empty or
completely disjoint snapshot marks a world-session boundary; the widget clears only local
ephemeral `SERVER` rows, sends `FCMCTL/1/LEAVE`, and submits a fresh roster on the next poll.
The relay's accepted fresh bind then backfills the current room's recent Redis history. Static
channel history remains durable; `SERVER` history is intentionally bounded/ephemeral.
Clearing SERVER also clears its replay IDs so a rejoin can restore those rows. Static message
IDs stay remembered across world changes/reconnects; native event IDs reset on reconnect.
An unchanged empty auxiliary snapshot never triggers a new leave. `haxe test-history.hxml`
exercises shared recovery and repeated transitions in the required game-mod CI job.

The widget resolves the sender identity from HUD-published `AccountInfoData.name`, which is the
public Fallout/Bethesda account handle other players see. Punctuation is preserved.
`PlayerListData` and `CharacterInfoData` expose character labels and cannot satisfy the relay
identity gate. Because account data may be populated late, the widget waits and retries before its
first relay handshake rather than connecting with `Wanderer` or a character-name substitute. Once
connected, later HUD reads update local identity state only; they never issue a second native
`chat.v1.connect`, and empty reads do not erase a known name.

The HUD renders the server-validated channel and identity tags plus an optional supporter marker.
The marker is a five-point vector `Shape` beside the full-width message field in one
row `Sprite`. Measured non-breaking spaces reserve its inline position immediately before the
name. Row-local first-author bounds anchor and center the vector; no document-wide scroll
estimate or global/local transform is used. Missing or inconsistent metrics hide the optional
star to avoid painting it over another part of the message. It uses the validated `starColor` and never
renders a Unicode glyph, bitmap, HTML image, or substitution token. Feed paragraph leading is zero,
and the feed keeps only a 4px safety gap above the top-level HUDTools input so rows stay compact
while new content remains above the input field.
Before entering the synchronous native send RPC, the widget creates exactly one local send
transaction row (even during the short interval before `getAuthState` supplies the relay user id).
The current relay returns the server-resolved tag/star and message ID in the successful ACK, so
the widget decorates that exact row as soon as the send response arrives. The live event may race
the ACK; a stable-ID event can complete the same row first, never a second row. The later event is
reconciled by the stable relay message ID when `FCMHUD/1` is available, then by a proven local
identity. For an older Dev bridge, the widget seeds a bounded local cosmetic snapshot only from
one unambiguous historical sender identity, keeps it on a cosmetics-free ACK, and finally uses a
unique, ACK-accepted, 15-second display-name/channel/body fallback. A matched event updates the
existing row in place; it never appends a second row. Ambiguous or stale legacy candidates remain
separate rather than being guessed. One deferred poll remains as a compatibility drain; ordinary
background polling remains controlled by `pollMs`. When `AccountInfoData` serves a blank handle all session, `FCMChat.ini` `displayName=` supplies a client-side bootstrap label so `chat.v1.connect` can still be reached; linked tokens retain the server-held identity and the relay ignores this fallback for durable account/message identity. Public-event auto-broadcast stays behind `autoBroadcastWorldEvents=false` (default OFF) and is further narrowed by `broadcastEvents=` (comma-separated exact names, case-insensitive, never substrings) plus `broadcastEventsMode=allow|deny` (default `allow`); a blank allow-list reads as broadcast off, quietly.

The backend sends a newly finalized static-channel message directly to native relay subscribers
on the same process, then publishes it to Redis for other backend instances. The Redis listener
skips the shared local instance ID, so the direct event is not delivered twice. This is the
latency-critical path for all already-connected HUDs; a Dev deployment must run the matching
backend source for it to take effect.

The relay auth-state response exposes both the relay-text `userId` and the linked account
`linkedUserId`. HUD chat events use the linked account UUID as `senderUserId`, so the widget keeps
both aliases locally when matching its own authoritative echo; the linked ID is never sent back
as a client-supplied identity. An old Dev native bridge can preserve neither the matching alias nor
the `FCMHUD/1` message-id carrier, so the bounded fallback is deliberately accepted only after the
same send receives a successful ACK and only when exactly one candidate matches.

ZFE's native `chat.v1` bridge filters unknown JSON members before the SWF receives an event. The
The v2.10.54 widget therefore reads the stable message ID, validated `tag`, and cosmetic transport from an
`FCMHUD/1;...` envelope carried in the existing known `targetUserId` field. For ordinary channel
chat this field is an empty transport slot, not a real recipient. The relay only emits the
envelope to v2.10.16+ clients; older BA2 files receive no transport data. Raw relay consumers
still receive the additive fields described in the protocol spec.


### v2.10.55 send and reload recovery

The send timer removes itself with `splice`, avoiding Haxe's Flash 19 `Array.removeAt`
bootstrap path. Cleanup and dispatch share an exception boundary; failures are logged before
attempting pending-row rollback. A local echo is not proof of relay delivery. The new
`deferred callback entered` diagnostic separates timer dispatch from native transport.

Roster snapshots use a bounded array-backed provider store instead of Map key iterators.
Replacement, expiry, empty providers, and cross-provider deduplication retain their existing
semantics. Timer logs now distinguish `roster-snapshots` from `roster-binding` failures.

Both ZFE and xScal recovery wait for `FCMCTL/1/HISTORY-DONE` on an authenticated system
chat event. Native acceptance alone does not complete recovery. After the initial 1.5-second
grace period, recovery is attempted at most three times, at least ten seconds apart. The
relay emits the marker even for an empty static snapshot; it is consumed without rendering.
A later native queue-loss marker can request recovery again after a completed replay.

The matching backend is required: static and world-bind replay allocate fresh, monotonically
increasing delivery cursors from `relay:seq`, retaining canonical message IDs and timestamps.
Replays serialize per relay identity and hold live frames behind a bounded barrier, then emit
them in cursor order. Static replay balances up to 15 rows per channel; SERVER remains scoped
to the current room and waits for a fresh bind after RESYNC. Historical database/Redis rows
are not rewritten. Raw subscribe/poll history continues to use the original cursors.

Regression coverage models a retained native cursor over repeated widget reloads, live traffic
during recovery, empty-history completion, retry bounds, and snapshot expiry. Native ZFE/xScal
and Dev Discord end-to-end validation still require a fresh in-game run of this exact build.

## Requirements

| Component | Requirement |
| --- | --- |
| Haxe | 4.3+ |
| Python | 3 (stdlib only) |
| HUDModLoader | installed by the user |
| ZFE | 0.9.9+ with `zfe-chat-online-v1` capability |
| xScal | `[Chat] enabled=true` and `chatInterface` under `__SFECodeObj` or `__SFCodeObj`, with `connect`, `pollEvents`, and `sendMessage` |
| Fallout 76 | native Windows or Proton/Wine installation with the current ZFE chat.v1 support; do not treat this as a requirement for the desktop overlay |

## Configuration and install layout

Install the opt-in mod assets into the Fallout 76 `Data` directory. The recommended
distribution is the target-specific ZIP produced by `package.py`; it includes the
BA2, both configuration files, an append-only HUDModLoader snippet, `INSTALL.txt`,
and `HUDMODLOADER-MENU.txt`.
It deliberately does not include a replacement `Data/hudmodloader.ini`.

```text
Data/FCMChatWidget.ba2
Data/FCMChat.ini
Data/ZFE/TextChat/fragments/FCMChatWidget.ini
FCMChatWidget.hudmodloader.ini       # root-level append snippet, not Data/hudmodloader.ini
Documents/My Games/Fallout 76/Fallout76Custom.ini
```

After extracting the package, append `FCMChatWidget` exactly once to the user's
existing `Data/hudmodloader.ini`. Preserve all other widget entries. Append
`FCMChatWidget.ba2` to the existing `sResourceArchive2List` value in
`Fallout76Custom.ini`; do not replace the user's BA2 list.

`Fallout76Custom.ini` needs the archive listed with HUDModLoader, for example:

```ini
[Archive]
sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2
```

The shipped fragment uses `OpenChatKey=INSERT` and the production endpoint by
default. The endpoint is **always** `/relay`,
not `/zfe-relay`. Local and hosted-dev users override the exact endpoint key in
`Data/configuration/zfe.ini`:

```ini
[TextChat]
Endpoint=wss://dev.falloutchatmod.com/relay
```

The included `FCMChat.ini` controls position, colors, size, polling cadence and
key bindings. Its open-key setting is separate from ZFE's authoritative
`OpenChatKey`; keep both settings aligned. ZFE reads Text Chat fragments at game
startup, so restart Fallout 76 after replacing the BA2 or fragment; hot-reloading
the widget cannot reload native relay configuration.

HUDModLoader's F11 menu exposes **FCM → Customize → Reset all settings**. The action
restores the `FcmConfig` defaults live, saves them in vendor-scoped ZFE storage
(`FCMChatWidget/settings.ini`), and retains the environment-owned link URL. The generated ZIP
includes `HUDMODLOADER-MENU.txt` with the same menu and input steps. Press **F11** to open the
menu, use **FCM → Customize...** for appearance/settings, and **FCM → Scroll to newest** for the
feed. The loader reload control applies live widget changes; replacing the BA2 or ZFE fragment
requires exiting and restarting Fallout 76.

### Target-specific packages

Do not assemble a DEV package by copying the production INIs. The package helper
stamps both environment-owned values together: the relay endpoint and the account
link host. Run it from this directory after building `FCMChatWidget.ba2`:

```bash
python3 package.py --target dev --output /tmp/FCMChatWidget-dev.zip
python3 test_package.py
```

Use `--target prod` for production. The helper refuses to package a stale BA2
whose embedded version does not match `FCMChatWidget.hx`. Each generated archive contains only its
target's endpoint and account-link details. Never copy a configuration file
between targets. `INSTALL.txt` in the generated archive repeats the matching
URL and installation steps, and `FCMChatWidget.version.txt` records the embedded
widget version. The output can be regenerated at any time from the current
`FCMChatWidget.hx` version:

```bash
python3 package.py --print-version
python3 package.py --target prod --output "/tmp/FCM HUD Mod-$(python3 package.py --print-version) (PROD).zip"
```

## Input-path acceptance

The current package uses HUDModLoader's SharedHUDTools editor first when Insert opens the editor.
That host-domain path owns the balanced `ControlMap::StartEditText` / `EndEditText` lifecycle, so
game movement/actions remain locked while the player types and are restored on Enter/Escape or a
named modal handoff. v2.10.45 incorrectly reintroduced a dynamically resolved child-SWF dispatch
of the same ControlMap events; in-game this emitted repeated `FCMChatWidget: [UncaughtErrorEvent
... Error #1014]` lines and left the player unable to control the character. v2.10.46 removes
that child dispatch. v2.10.50 also removes the undocumented `PlatformChangeEvent` constructor
probe that produced the caught `Error #1063` on the current HUDModLoader build. If SharedHUDTools
is unavailable or its editor cannot open, ZFE native input is an emergency no-lock fallback; it
never attempts to synthesize the ControlMap lock.

Both repeating HUD timers are guarded at their event boundary. The event poll records its current
transport/auth/render phase, and the world poll records its BSUI/roster phase; an exception is
logged and the timer continues instead of escaping as `UncaughtErrorEvent` / Error #1014. Native
roster arrays are enumerated one slot at a time with per-entry isolation because GFx can replace a
provider array during a world hop.

HUDModLoader's `HUDModUserEvent` exposes the action and edge through the native AS3 getter
properties `EventName` and `IsKeyDown`. The widget reads those through `FcmUserEvent`'s
dynamic-property adapter; `Reflect.field()` alone skips AS3 accessors and silently turns Page
Up/Page Down (and every other named action) into an empty key-up event. When the loader still
collapses the physical keys to `Unmapped`, v2.10.54 registers `PAGEUP=0x21` and `PAGEDOWN=0x22`
(plus the Insert-gated feed keys) through the extender's `Input.*` compatibility surface. The
poll starts at provider discovery, before and independent of the relay connect, so Page keys
work even when relay auth is rejected. Registration tries the generic callback
(`__SFCodeObj`/`BRG_OBJ`) first and, under ZFE, the `__ZFE` dispatcher second; the first
candidate that does not answer false/error/unsupported is locked for later calls, and a void
`null` return counts as success (xScal's wrapper is void). `Input.IsKeyPressed` is decoded from a
native boolean or from an explicit `pressed`/`down`/`value` field of ZFE's JSON envelope; a bare
`"success":true` is not a key-down. Recognized navigation events, each registration (with
dispatcher name and raw response), one IsKeyPressed sample per session, and physical edges are
logged so a live `zfe.log` can confirm which path handled them.

The native adapter CI suite exercises both Page keys against xScal's void registration and
boolean press/release responses, including repeated presses and unload cleanup. It covers
separate and combined callback objects, discovery through the main stage or a parent, and
xScal both alone and selected alongside ZFE. These are mocked contract tests; a live xScal
smoke test must still confirm channel switching while idle and while preserving an open draft.

The ZFE fallback clears and verifies its native buffer immediately after
`setChatInputActive("true")`; the startup activation probe is intentionally absent because some
supported Windows/ZFE builds expose that bare payload as literal text. A package is not acceptable
unless the normal SharedHUDTools path opens one editable field, typing `hello` visibly becomes
`hello` (including repeated letters), Escape cancels, Enter sends the complete text, gameplay is
restored after editing, and named Quick Actions/Friends focus transitions do not leave the editor
stuck.
Page Up/Page Down must switch channels both while idle and while preserving an open draft. The
widget accepts either the first key-down or a key-up-only loader event without double-switching;
when no named event arrives, the provider-level physical-key fallback handles the key-down edge
and unregisters every registered key at shutdown. The fallback must switch channels before relay
auth completes and while it is rejected. Configured scroll actions remain ordinary Fallout
controls until Insert has opened the feed editor; the packaged `scrollBottomKey` is unset.

On supported ZFE builds, a bare boolean from `readChatInput` immediately after a successful
`clearChatInput` is an empty/status response, not a one-character draft; the native fallback remains
available. If the clear is not confirmed, the widget closes the partial native session and uses the
single SharedHUDTools editor. One-character native observations are
accumulated, including repeated characters, so a draft such as `hello` is not reduced to its last
letter.

### Relinking a Discord account

Type `/relink` as a standalone HUD command, or choose **F11 -> FCM -> Relink account...**. The
widget requests ZFE's top-level `clearChatAuth` command, which is the only supported owner of the
DPAPI/local relay token at `Data/ZFE/chat-auth.bin`. When ZFE confirms the clear, the widget
reconnects and displays a newly issued link code. The command does not accept arguments, and the
widget never tries to write the auth file through `writeStorage`.

`clearChatAuth` is an optional ZFE-side extension. If the installed ZFE returns an unsupported
command or otherwise rejects it, the widget leaves the saved token untouched and displays:
"Exit Fallout 76, delete Data/ZFE/chat-auth.bin, then restart." This fallback is intentional: a
HUD SWF cannot safely delete an arbitrary local file, and it must not report a successful relink
when the old token remains. The current ZFE build must implement this command before the automatic
part of `/relink` is available to players.

## Build the archive

Run from this directory.

```bash
haxe test-config.hxml
haxe test-command.hxml
haxe build.hxml
python3 normalize_swf.py FCMChatWidget.swf
python3 ../hudmenu-chat/ba2tool.py create FCMChatWidget.ba2 \
  interface/FCMChatWidget.swf=FCMChatWidget.swf
```

The Scaleform artifact must have `FWS` bytes and SWF version 32. Verify the BA2
contains the same SWF before distributing it.

## Required checks

```bash
haxe test-config.hxml
haxe test-identity.hxml
haxe test-history.hxml
haxe test-render-generation.hxml
python3 ../hudmenu-chat/test_anchors.py
cd ../../../cross-platform-overlay
npm run test:unit -- --run __tests__/fcm-chat-widget-logic.test.js
cd ../backend
npm run build
npm test -- --runTestsByPath tests/relayHandler.test.js
```

The source-level anchor test prevents the tab-renderer regression, rejects a
compiled relay-control HMAC, and ensures release diagnostics do not log chat text
or relay identities. The JavaScript test covers JSON event boundaries,
including braces and escaped quotes in message bodies. Backend tests cover relay
availability, authenticated controls, validation, and roster membership.

## Production rollout

The backend refuses `/relay` in production unless
`RELAY_PRODUCTION_ENABLED=true`. It defaults to `false`; setting the value is an
explicit deployment action, not part of building this BA2. Before enabling it,
deploy the matching backend, run its relay tests, and perform an authenticated
WebSocket handshake against the production endpoint. If that handshake fails,
leave the flag off and do not distribute a production-configured build.

## Hosted-dev tester handoff (verified 2026-07-19)

The hosted-dev stack tracks `dev` at `dev.falloutchatmod.com` and its direct
relay endpoint. The relay accepts both control formats during the transition.
Current widgets emit printable `FCMCTL/1/*` frames; legacy NUL-framed controls
remain accepted for older installations. A player with an older build can obtain
the `SERVER` tab after reconnecting and the next roster update.

The relay must acknowledge every accepted control with a non-empty synthetic
`messageId`; an empty ID violates ZFE's send-response contract and is surfaced to
the widget as `relay_rejected`, leaving `SERVER` hidden even though membership was
updated successfully.

Copy the matching BA2 into `Fallout 76/Data` only after Fallout 76 has fully
exited, then restart the game so ZFE reloads the archive and fragment. Never
overwrite an in-use BA2.

HUDModLoader's upstream menu hotkey is **F11**, outside the Pip-Boy. F12 is the
game's `DiagnosticSnapshot` action and is not a reliable route to the loader menu.

### Staff moderation commands

The HUD derives moderation availability from `chat.v1.getAuthState`; only a linked Discord
`moderator`, `admin`, or `owner` sees a `[#XXXXXXXX]` reference beside visible messages and the
**FCM → Moderation commands** F11 menu item. Enter an exact visible player name for a quick action,
or quote a multi-word name. The HUD resolves that local display-name match to the immutable relay
message and account IDs. If two visible accounts have the same name, it refuses the action and you
must use the `[#XXXXXXXX]` reference instead.

Open chat and enter one of the following, supplying a non-empty reason for every action:

```text
/mod Alice mute <minutes> <reason>
/mod "Alice Smith" kick <reason>
/mod #XXXXXXXX delete <reason>
/mod #XXXXXXXX kick <reason>
/mod #XXXXXXXX mute <minutes> <reason>
/mod #XXXXXXXX unmute <reason>
/mod #XXXXXXXX ban <minutes|permanent> <reason>
/mod #XXXXXXXX unban <reason>
```

`mute` and temporary `ban` accept 1–43,200 minutes (30 days). `ban` requires an explicit duration
or `permanent`, preventing an accidental permanent ban. Slow mode deliberately has no HUD command:
FCM has no per-channel slow-mode primitive. The relay repeats role, target, reason, and protected-
staff validation on every request; the HUD permission is only a visibility hint.

## In-game acceptance checklist

1. With HUDModLoader and ZFE or xScal loaded, the startup log identifies `chatv1-widget-v2.10.60`. If
   `AccountInfoData` is late, the widget waits and retries. The sender label and a newly sent
   message use the exact public Fallout 76 account handle, including punctuation; neither
   `Wanderer` nor the local character name is used for the relay handshake.
2. The tab row contains one label for each visible channel—no boxed duplicate labels.
3. Switch channels, join/leave a world, and switch again; the tab row remains single-rendered.
4. Send a body containing `{`, `}`, quotes, and backslashes; later events still render.
5. On DEV, use a linked supporter account and confirm each supporter message has exactly one
   colored vector star immediately before the name with a 4px gap.
   It must be centered on the first author character, including when a moderation or
   custom identity tag is present. The marker must move with its row while scrolling and never
   appear in the header/top-left corner.
   Confirm non-supporter
   messages have no marker, and that neither `FCMHUD/1;`, `FCMSTAR`, `★`, nor tofu blocks appear.
6. Temporarily disconnect the relay. After three failed polls the widget shows reconnecting,
   then reconnects once the relay returns.
7. Confirm `SERVER` remains hidden until the relay acknowledges the printable roster/world control,
   then remains isolated to its derived room while static channels still work. Change worlds and confirm
   the log shows a roster-session boundary, `LEAVE`, and a fresh roster acknowledgement; the
   `SERVER` sub-tab returns and only the newly bound server-room history appears. Static history
   returns independently. An empty roster is valid for a solo world.
8. While typing, confirm the SharedHUDTools editor has only one visible text renderer; type
   `hello` and confirm the complete buffer remains visible, including repeated letters; game
   movement/actions are locked and restored after Enter/Escape;
   Page Down/Page Up switch channels on both key-down and key-up-only loader builds, including the
   physical Input.* fallback, without entering a persistent channel-selection mode. A successful
   send should show the tag/star from the ACK or direct live event without waiting for the next
   regular poll, then reconcile to one authoritative row. All connected widgets should receive the
   same event through direct local fan-out or the Redis cross-instance path. For a one-message test,
   the `recv` log must keep `recordsBefore` equal to `recordsAfter`, with `ownEchoId=1` on a new
   relay or `ownEchoFallback=1` on the old Dev bridge. `ownEchoAmbiguous=1` is a failure for a
   single send. After Insert opens the typing
   session, the configured `scrollUpKey`/`scrollDownKey` actions scroll
   the feed and an optional `scrollBottomKey` returns to newest without closing the input or
   losing its draft; the packaged newest binding is blank, and before Insert all scroll keys
   remain game controls. Enter/Esc
   restore game input. While a draft is active, press Ctrl+Tab and confirm the social menu opens
   normally and Escape can close it: the `OpenSocial` handoff must deactivate the no-lock native
   fallback or call `SharedHUDTools.EndTextEdit()` before the game processes the social action. The canceled
   draft must not be sent or reappear as a duplicate.
9. Outside the Pip-Boy, press F11 and confirm the HUDModLoader menu opens and lists FCMChatWidget.
10. Open **FCM → Customize → Reset all settings**; confirm the default size, position, opacity,
   amber theme, and auto-hide behavior return immediately and remain after restarting the game.
11. Use **F11 → FCM → Relink account...** and type `/relink` once each. On a ZFE build with
    `clearChatAuth`, confirm the local token is cleared, the relay reconnects, and a new link code
    appears. On an older ZFE build, confirm the widget shows the manual reset instruction and does
    not reconnect or claim that the token was cleared.
12. On the DEV relay, sign in with a linked moderator account. Confirm staff references and
    **FCM → Moderation commands** appear; submit actions against disposable test accounts by exact
    visible name (including a quoted multi-word name). Verify a duplicate visible name is rejected
    until its `[#XXXXXXXX]` reference is used. Submit delete, kick, mute, unmute, temporary ban,
    permanent ban, and unban. Confirm each action creates an audit entry and has the same Discord
    timeout/lockdown/role restoration outcome as the dashboard.

Do not copy the new BA2 into a live game installation or publish it until these
checks have passed on the intended environment.


### Unified release packaging

`python3 package.py --target prod --output "/tmp/FCM HUD Mod-$(python3 package.py --print-version) (PROD).zip"`
builds the default single download: one auto-detecting BA2, the shared runtime INI,
`examples/ZFE/FCMChatWidget.ini.example`, `xscal.ini.example`, and the xScal enable helper.
Only apply the example for your installed extender. ZFE users copy the example into
`Data/ZFE/TextChat/fragments/FCMChatWidget.ini`; xScal users do not create that folder.
The ZIP contains no active ZFE fragment. Optional legacy `--provider zfe` and
`--provider xscal` outputs remain available for targeted diagnostics.
For xScal, after extracting into the
game folder with Fallout 76 closed, run the CMD helper on Windows. It backs up the
existing `xscal.ini`, changes `[Chat] enabled=false` to `enabled=true`, stamps the
package relay endpoint, and preserves unrelated settings, encoding and line endings.
Repeated runs are idempotent; duplicate `[Chat]` sections fail without writing.
On Linux/Proton, edit those two keys in the existing `[Chat]` section using the example.
Never replace the full xScal INI. Extraction alone does not enable xScal chat.
BA2-only update archives assume extender configuration is already enabled; use the
provider setup package for first installs or disabled-chat configurations.
The setup regression suite runs in the required native Windows CI job.
`FCMChatWidget.provider.txt` records the setup target, not a binary runtime restriction.

xScal physical navigation uses the generic callback's `Input.RegisterKey`,
`Input.IsKeyPressed`, and `Input.UnregisterKey` operations, with virtual-key arguments.
Registration/polling is not gameplay suppression. The maintainer's supplied note for
[article 268](https://www.nexusmods.com/fallout76/articles/268) says keyboard suppression
was not yet implemented. Do not claim suppression without a supported API and runtime test.


v2.10.56 follows the supplied xScal article 268 keyboard contract: `Input.*` callbacks
receive positional arguments and return Boolean values. Non-Boolean results and virtual
keys outside 1..255 fail closed. xScal supplies false while Fallout 76 is not foreground.
The widget registers six keys at setup, polls their state, and unregisters those keys at
teardown. It does not call global `ClearKeys`, which could remove another widget's keys.
Gamepad suppression is documented separately; this keyboard widget does not enable it.

### Manual installation documentation

The unified ZIP's `INSTALL.txt` includes complete manual steps for both providers;
`Enable-xScal-Chat.cmd` is optional. New xScal users must also set `[Chat] enabled=true`
and the target-specific `relayEndpoint`. An example file alone does not activate chat.
If `xscal.ini` is absent, create it beside `Fallout76.exe`; otherwise preserve existing
sections and settings. ZFE users copy the complete example into the active fragment
path. Keep these steps aligned with the website's `HudManualInstall.tsx` and the Nexus
copy in `docs/marketing/nexus-description.bbcode`.

The SWF build forces `-D haxeJSON` so layout serialization uses bundled Haxe code, not the optional Flash Player native `JSON` class. Render failures log a bounded stage label without message contents.

Runtime logs for 2.10.62 failed at `wrap-ranges`; 2.10.63 failed at `build-row` after
inlining. This identifies the custom wrapping path as incompatible, but does not identify
the exact missing runtime class. 2.10.64 removes that path and the TextLineMetrics return-type
dependency, using native HTML wrapping/auto-size instead. The gated plain-text fallback remains
an emergency path, not the normal styled presentation. In-game confirmation is still required.

Research references: [Scaleform text sizing](https://help.autodesk.com/cloudhelp/ENU/Scaleform-Help/scaleform_help/as2_reference/textfield_extensions/text_size.html),
[Scaleform AS3 text area](https://help.autodesk.com/cloudhelp/ENU/Scaleform-Help/scaleform_help/clik/clik_as3_user_guide/prebuilt_components/basic_button/textarea.html),
and [TextField formatting](https://airsdk.dev/docs/development/text/using-the-textfield-class/formatting-text).
These document API behavior, not Fallout runtime certification. Local FO76 UI artifacts confirm
use of TextField auto-size; no third-party source or assets were incorporated.

## v2.10.66 connection recovery

The authenticated widget keeps an in-memory outbox of at most 32 messages for 30 minutes.
Connection attempts continue with capped backoff; an unresolved handshake is restarted after
60 seconds, and malformed polls count toward reconnect recovery. Previously authenticated
players can compose static-channel messages while offline. Retry dispatch waits for fresh
authentication and uses a stable identifier; SERVER entries also require their original room.
Relinking or changing accounts clears queued text. Widget unload/game exit clears the outbox.

Safe ambiguous-send retries require the matching backend's `canRetryHudSend` capability.
See [send receipts and limitations](../../../../overlay/zfe/hud-send-retries.md) and
[native recovery checks](../../../../testing/hud-recovery.md). Run `haxe test-outbox.hxml`
for the queue, identity/room isolation, and handshake/poll policy tests; CI runs this suite.

## v2.10.65 identity styling (prior layout)

Native auto-size/wrapping remains unchanged from the in-game-confirmed 2.10.64 build.
Stars now center their actual vector bounds on the first author character's layout rectangle,
translated by the message field's row-local position. Narrow layouts reserve a star slot beside
the name below the channel. This removes the generic sample-height/2px-nudge alignment from the
normal path. Tests cover marker bounds, row offsets, and narrow widths; exact game alignment
still needs visual confirmation.

The backend carries the user's resolved solid name color through `FCMHUD/1;n=...` as well as
`nameColor`, validated as six hexadecimal digits. Live/history rows and send ACKs share that
transport; optimistic rows reuse the latest authoritative local color. Deploy the corresponding
backend projection to enable chosen colors in Prod. Missing colors use the configured theme.

## v2.10.67 authentication parser hotfix

[Confirmed] The desktop 2.10.66 log reported Error #1014 at every auth probe and
subsequent malformed-poll reconnects while the Prod relay flag remained enabled.
The new auth and poll validation called the general Haxe JSON parser. [Deduced]
its runtime dependency path caused this regression; the exported parser references
Haxe exception classes. FcmJson now reads bounded JSON without throwing or using
native JSON. Auth, poll, private receipts and layout restore share that reader.
It rejects malformed input, oversized envelopes and nesting beyond 32 levels.
The reconnect failure counter also resets when a new transport is accepted.

Run `haxe test-json.hxml`, `haxe test-outbox.hxml`, and `haxe test-hud-layout.hxml`.
FFDec inspection confirms FcmJson/FcmReconnect do not reference JsonParser or Haxe
exception classes. The user subsequently confirmed connection in 2.10.67; current per-provider validation limits are recorded above.

## v2.10.68 explicit color ranges

The user confirmed full-width wrapping and successful connection with 2.10.67, but
reported channel-color bleed into message text. Message rows now use plain text
and explicit native TextFormat ranges. Font, size and color are set for the whole
row, then for the channel, name and body separately; colon and body are reset to
the configured textColor. Star Shape fill continues to use the validated starColor.
The same string offsets anchor the star, so range styling preserves full-width
wrapping. Tests cover prefixes, literal markup, line breaks and exact name/body
boundaries (`haxe test-feed-text.hxml`). This was the earlier implementation milestone; styling is now user-confirmed in 2.10.72 on desktop xScal. Current emoji limitations are recorded above.
## Retained supporter-history correction, released in 2.10.110 (2026-09-16)

- [Confirmed] Hosted DEV showed multiple retained messages for the authenticated HUD sender
  without supporter presentation, followed by a newly resolved row with the expected star.
- When an authoritative ACK or self-echo supplies cosmetics, the widget now reapplies that
  projection to retained rows whose sender ID matches one of the authenticated account aliases.
  Display names are never used for this backfill, so a different user with the same visible name
  remains unchanged.
- The Ruffle harness covers both ZFE and xScal with old linked/relay-identity rows and a same-name
  foreign row.
