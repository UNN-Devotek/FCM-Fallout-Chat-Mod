# FCMChatWidget

FCMChatWidget is the optional HUDModLoader chat widget for Fallout 76. It uses ZFE or xScal's
native chat bridge and FCM's `/relay`. It is independent of the desktop overlay.

**Current isolated test candidate: 2.10.117 CONTROLLER-TEST (native-unverified).** Current ZFE
uses owner-scoped `input.v1` keyboard capture and `hotkeys.v1` for supported configured actions
when those capabilities are advertised. Older ZFE falls back to SharedHUDTools and `Input.*`.
xScal polls every supported configured physical binding through `Input.*`, but text entry remains
best-effort through SharedHUDTools because xScal 0.2.16 exposes no keyboard capture/suppression API.
It retains 2.10.116's behavior and keeps
accepted Server rows as an in-memory transcript across room changes, travel, expiry and MainMenu
for the current widget/game session. New messages and sends remain restricted to the currently
confirmed room. Restarting the game/widget starts a fresh transcript, and the existing configured
message cap still bounds memory. It also retains transition-only authenticated room diagnostics. The widget sends only fixed event/provider/source
labels, a bounded roster count and its build version; it never sends names, roster contents,
messages, IDs or tokens as diagnostic data. Consecutive duplicates are suppressed and each widget
instance is capped at 32 events. It also reserves Enter exclusively for editor submission, moves
the selected-link default to F8, and preserves/restores the last stable SharedHUDTools draft when
the host field transiently reports empty. The backend stores the matching privacy-safe roster/room decision
chain for 24 hours so incidents can be diagnosed without collecting client log files.

It retains 2.10.112's behavior: when retained Server history arrives
after the static feeds, the widget now uses each message's original relay timestamp to place the
overlapping rows chronologically in General. Replay older than General's loaded history horizon is
kept out of General, while the Server subtab retains the complete replay. Live Server rows remain
part of General. The candidate retains 2.10.111's bounded roster-visible `@self:` evidence;
authenticated identity and message attribution remain token-owned. Fresh native acceptance is
still required.

The candidate also performs a one-shot, shape-only inventory of every supported
BSUI roster surface after world startup. It logs provider/row field names and the
names of allowlisted identity-like fields, never their values, player names, roster
contents, tokens or messages. This is diagnostic evidence for determining whether
the live game exposes a stable account/team identifier; no such identifier is
assumed or transmitted until native evidence establishes its semantics.

2.10.117 uses ZFE's owner-scoped `input.v1` capture when both text-input and release-barrier
capabilities are present, keeping keyboard entry independent of a connected controller. Older ZFE
uses the existing SharedHUDTools compatibility path. xScal adds configured physical-key polling but
retains best-effort SharedHUDTools text entry. Simultaneous ZFE and xScal installations fail closed.
The test-build gate results and hashes are recorded in `CONTROLLER-TEST-MANIFEST.md`. Version
2.10.117 has not been installed, natively accepted or published. Fresh controller input acceptance
is required before any promotion.

**Current production release: 2.10.110 (2026-09-16).** Once an authoritative
self-echo or acknowledgement supplies the local sender's cosmetics, retained rows for the same
authenticated sender IDs are repainted with the current star, color and tag. Same-name rows from
another account remain untouched. This builds on 2.10.109's queue-retirement correction.
The final build passed the complete local HUD gate, hosted CI, and fresh native checks on the
desktop and MSI laptop. The final 2.10.110 ZFE 0.15.0 runs restored saved authentication and
history; Server-room binding appeared automatically on the desktop after the roster and relay
confirmation, without a message send. xScal native acceptance belongs to the 2.10.109 recovery
precursor, whose queue logic is unchanged in 2.10.110; compiled xScal coverage ran on the final
artifact. The website and Nexus packages contain the same tested BA2.

**Root-cause chain retained for maintainers.** Desktop ZFE startup, Server sends and one travel cycle
first passed on 2.10.107.
2.10.105 proved that the replacement decoder fails before method entry even on synthetic data.
2.10.106 restores the earlier widget traversal and map/team helper while retaining copied
observation timestamps, bounded reads, rejection of damaged lists, and newer session/history
safeguards. Native 2.10.106 now reads populated rosters without the previous decoder error,
but its startup auth check can precede ZFE's asynchronous handshake. 2.10.107 rechecks pending
auth on the normal event poll so Server joining no longer depends on first sending a message.
The existing auth and relay-confirmation gates remain mandatory. Fresh desktop ZFE logs confirm
automatic auth and Server binding without first sending a message, two Server-send echoes without
duplicate rows, and room continuity through one loading/fast-travel cycle. Later 2.10.109 tests
covered both xScal machines beyond the former queue-retirement failure boundary, and final
2.10.110 checks covered saved-auth restoration on both providers. This dated evidence does not
weaken the still-required room confirmation, roster freshness, hop, MainMenu, or lease gates.
The rejected unified decoder remains diagnostic-only. The invisible bridge remains
on its separate 0.1.6 decoder. See [build status](BUILD.md).

**Previous candidate: 2.10.102 (2026-09-15).** Same-server fast travel preserves the Server tab,
history, and session when the effective roster is unchanged or overlapping. Full map/player
snapshots take precedence over auxiliary nearby/team lists. A transient empty primary waits
up to 60 seconds without extending the existing relay confirmation lease. Main-menu exits,
disjoint nonempty rosters, and expired observations/confirmations still clear stale room state.
An empty map now permits a populated player/public-team fallback that overlaps the prior roster;
disjoint cached fallback names and nearby-only lists cannot override that empty primary.
Native 2.10.102 with xScal 0.2.16/hosted Dev passed history, General/Server send echoes and room
continuity through two loading transitions. The map stayed populated, so the exact empty-map
fallback was not established by that run. That build was subsequently retained **inactive** for the
separate FCMServerBridge test; the desktop is now testing the visible widget again. See the
[acceptance record](../../../docs/testing/hud-xscal-acceptance-2026-09-15.md).

ZFE sends and Server-room controls correlate the
provider's immediate `queued` request ID with the later `chat.send.accepted` or
`chat.send.failed` event. The receipt decoder now uses the bundled bounded `FcmJson` reader;
Fallout's GFx host does not expose the native Flash JSON global that made the same decoder appear
healthy in Ruffle. A source gate prevents that dependency from returning. The delayed six-row
renderer and row reuse remain unchanged.

Up/Down selects a visible message row while chat owns
the editor. The selected row has a configurable outline and translucent fill; users can change
`Selected message` under F11 → Customize → Colors, or set `selectedRowColor` in `FCMChat.ini`.
`activateLinkKey` (F8 by default) opens that row's
first HTTP(S) link through ZFE's capability-gated browser-v1 service. Full URLs remain literal
and selectable. ZFE validates HTTPS, owns consent and opens the system browser; absent capability
or current xScal retains readable links. No Flash `getURL`, relay or desktop fallback is used.
See [browser links and site allowances](../../../docs/overlay/zfe/browser-links.md) for the
configuration fragment, lifecycle, test coverage and native acceptance requirements.

For stability, automatic Server-room roster/leave controls use a capability gate. Current ZFE
builds advertise `zfe-chat-async-control-v1` and bind through that non-blocking path; older ZFE
builds remain fail-closed because their synchronous call can stall Fallout's UI thread for the
native timeout. xScal binds through its asynchronous `chatInterface` path.
From 2.10.94, ordinary ZFE sends are also accepted only when runtime info advertises
`zfe-chat-async-send-v1`; older synchronous builds show an update-required message instead of
allowing a stalled network call to block Fallout's Scaleform thread.

The feed builds delayed row batches in a hidden
snapshot and swaps them into view only after positioning is complete, preventing the overlapping
intermediate frame seen as a white flash. Windows 10 xScal measurements showed that the former
32-row work slices still occupied 32-65 ms of a frame, so rebuilds now process six rows per timer
turn while the last complete snapshot remains visible. The xScal/SharedHUDTools input path also records
privacy-safe editor metadata (length, caret, selection, focus, and maximum length) while an edit is
open. The single BA2 uses the visible SharedHUDTools editor with both providers and enables its
public TextField selection/caret behavior. It retains the active draft only in memory: if Enter
removes the host field but HUDModLoader fails to deliver its submit callback, a short watchdog
submits that draft once and releases the editor state; other sustained focus loss cancels and
re-arms Insert. Draft content is never logged. Provider detection keeps
ZFE native input as a fallback and prevents xScal from receiving ZFE-only calls. Source validation is complete;
fresh 2.10.85 in-game validation on both providers is still required. The preceding 2.10.84
production-target BA2 was validated locally with xScal for visible multi-character editing and
frame-budgeted message refresh; 2.10.85 is installed with xScal for final Delete-key acceptance.
This is not a claim of publication or hosted CI success.
See [BUILD.md](BUILD.md) for reproducible checks and installation, and the
[HUD documentation index](../../../docs/overlay/zfe/README.md) for owning guides.

## Feed and sends

General combines General, accepted Server rows from every room visited during the current
widget/game session, Trading, Events, Infests, and Raids. Each message retains its original
channel tag and canonical identity. Other tabs filter the same bounded history. Sending from
General targets `global`; no messages are copied or rebroadcast. Unknown, private, and system
channels are excluded. Leaving a room clears membership authority and room-scoped replay
identity, but retains already accepted Server rows as display-only session history; a new room's
authorized history appends to that transcript. A new widget/game session starts empty.

Replay rejection runs before pending-send matching. Retained canonical rows remain a duplicate
guard after cache eviction. A known ACK ID cannot match a different event through a same-body
fallback. Missing-ID compatibility matching is bounded and unique-only; ambiguous repeated sends
are not guessed together. Read-back mode preserves scroll position and counts new visible rows.

A pending own row is painted before a deferred native send call. Authoritative ACK/event data
reconciles that row once, including server-provided cosmetics. With negotiated retry support,
transient failures keep a bounded queued row; terminal failures remove it. The same local request
ID is reused for retries, with SERVER room pinning. See
[retry safety](../../../docs/overlay/zfe/hud-send-retries.md).

Initial history contains up to 15 messages per static channel and 50 from each freshly confirmed
SERVER room; the existing configured message cap bounds the retained session transcript. The
widget drains the up-to-125-event snapshot over multiple native polls. Empty/lost queues trigger
bounded authenticated recovery; SERVER history waits for a fresh room bind.
Account identity comes from the public HUD account handle, not a local character label or the
`Wanderer` placeholder. Limited identities see a pinned link code and cannot send.

## Provider and input contracts

`../FcmNativeApi.hx` discovers already-exposed objects, preferring a validated xScal
`chatInterface` when both providers are present. ZFE requires a positive chat capability response.
xScal requires chat methods and checks its optional runtime response when present. ZFE gets JSON
strings; xScal gets ActionScript objects or no arguments according to the selected method. Its
generic callback is separate from chat transport.

SharedHUDTools owns the main text editor and balances its game-control lock. A legacy ZFE input
fallback is retained; the widget does not dispatch ControlMap lock events itself. The public ZFE
`input.v1.*` text-session and `hotkeys.v1.*` APIs are different contracts and are not implemented
by renaming FCM's compatibility calls. See the [provider guide](../../../docs/overlay/zfe/modder-guide.md).

The shipped key map is `openKey=INSERT`, `channelNextKey=NextPage`, `channelPrevKey=PrevPage`,
`scrollUpKey=Up`, `scrollDownKey=Down`, `scrollBottomKey=`, `activateLinkKey=F8`, and
`hideKey=DELETE`. Insert opens chat; Enter sends a non-empty draft and, when it is the configured
link key, opens a selected link from an empty draft. Escape cancels. A custom link key acts only
while the OpenChat-owned editor is active and a link row is selected; it is inert during gameplay.
A missing host callback cannot leave Insert permanently latched. Provider-level physical keys are
registered from the active profile only: reloading/reapplying a profile unregisters the previous
set before installing the replacement set. Both providers include the configured open key in the
physical registration set. ZFE also updates its dedicated native watcher when that watcher accepts
the token; arbitrary mapped keys such as F12 continue through `Input.*` when it does not.
Page Up/Down switch channels while idle or editing. Up/Down moves the highlighted row selection
only while chat owns the visible editor and keeps it in view. The blank newest value leaves
Home/End as game controls.
Delete hides while idle, while `/hide` and the F11 menu also hide the feed. `KEYBINDS.txt` covers aliases,
rebinding, physical polling, and ZFE config precedence.
The default `hideKey=DELETE` hides only while input is idle. While either
provider owns an editor, Delete remains a text-edit key and cannot close or hide the widget.
xScal's numeric `Input.*` operations require Boolean results; ZFE's compatibility decoder also
handles its legacy envelopes. Registration does not promise gameplay suppression.

Slash shortcuts include `/g`, `/t`, `/e`, `/i`, `/r`, and `/s`; `/clear` clears the local feed,
`/hide` hides it, and `/relink` requests the provider's supported credential reset. Reset failure
must not claim a new identity. `/emoji` searches/sends bundled emoji. Staff-only `/mod` commands
resolve visible targets to immutable IDs and repeat permission checks on the backend. See
[staff commands](BUILD.md#staff-moderation-commands).

## Rendering and customization

Each row has a full-width native multiline plain-text field with `TextFormat` ranges for channel,
name, body, and staff reference. A supporter star and bundled emoji sprites share the row's
coordinate basis. Placement measures layout bounds and reserved slots after wrapping; it does
not require global transforms when the fields and decorations already share a parent.

The styled baseline survives optional emoji failures. Known Unicode/custom emoji use bundled
static vector sprites; unsupported custom emoji fall back to readable names. No remote emoji
images or GIF playback are loaded. Delayed row slices check their generation and catch their own
failures; fallback invalidates pending work. Flash/JavaScript tests do not establish GFx behavior.

Burst traffic (poll batches, optimistic echo, ACK reconciliation) coalesces into one deferred
render per tick; tab switches, resizes, and config changes still render immediately. Tail
appends reuse the committed snapshot's matching prefix rows and only construct the new suffix.
The visible prefix stays attached to the committed layer throughout delayed construction and is
reparented only at the synchronous commit edge, so cancellation cannot blank the old snapshot.
Reuse keys include every rendered message/cosmetic/delivery field plus moderation and theme state.
Rows take a single build pass (plain bodies skip the emoji planner via a fast prefilter),
`TextFormat` objects and font measurements are cached per font size, staging layers and the
slice size adapts within 4-12 rows to hold the per-tick UI budget. Only one slice timer can be
live, and its listener is removed on completion, cancellation, failure, or teardown. Pure planning
helpers live in `FcmFeedPlan.hx`/`FcmRenderCoalescer.hx` with
`test-feed-plan.hxml` coverage.

F11 → FCM → Customize changes position, independent panel dimensions, feed/input text size, input
height, backgrounds, text colors, opacity, and auto-hide. Input width/alignment follow the panel.
Server-resolved user colors override the default local sender color. Timestamps are not shown;
channel colors/tags, badges, emoji, and available/default channels are not appearance controls.
See [CUSTOMIZATION.txt](CUSTOMIZATION.txt) for active/retired INI keys and saved-setting precedence.

ZFE stores F11 settings in vendor-scoped storage. xScal uses per-linked-device relay persistence
only when the backend advertises the capability and supports the settings payload. Missing
persistence leaves changes session-local. A code checkout does not establish backend deployment.
The visible HUD does not call xScal `modStorage.register`, `load`, or `save`. On xScal
0.2.17, the separate optional Server Bridge uses named storage directly, leaving the HUD's
chat transport and other mods' storage documents independent.

## Browser HUD simulator

`simulator/` provides the non-game M0 smoke runner. It renders the exact normalized production SWF
with pinned, self-hosted Ruffle and verifies browser key delivery with Playwright:

```bash
cd simulator
npm ci --ignore-scripts
npx playwright install chromium
npm test
```

Playwright owns the loopback Vite process and closes it after the run; the test also removes the
Ruffle player in `afterEach`. Generated SWFs, copied runtime files, screenshots, video, and reports
are ignored. The default mode is the production artifact. A second browser test replays a sanitized
contract captured from the Nexus xScal 0.2.16 DLL (hash and supported runtime included), without
loading or redistributing that DLL. `?mode=harness` is an experimental
rendered contract-host spike based on the released xScal behavior, not fork additions, and is not
acceptance evidence because Ruffle 0.6.0
currently does not expose the compiled AVM2 callbacks. See
[the automation plan](../../../docs/testing/hud-automation-plan.md)
for the fidelity boundary and real-game tier.

The ZFE simulator contract identifies as 0.15.0 and retains the asynchronous chat capability gate
required to prevent synchronous network work from blocking Fallout's Scaleform thread.

To collect a sanitized contract trace from a game session you launched yourself, use
[`native-capture/Capture-HudSession.ps1`](native-capture/README.md). The collector fingerprints the
active artifacts and tails only fresh xScal/ZFE diagnostics; it never owns or stops Fallout.

## Files

| File(s) | Purpose |
| --- | --- |
| `FCMChatWidget.hx` | Widget lifecycle, input, native relay integration, rendering |
| `FcmCommand.hx`, `FcmHistory.hx`, `FcmEcho.hx`, `FcmOutbox.hx` | Channel/command, replay, echo, retry guards |
| `FcmConfig.hx`, `FcmHudLayout.hx` | INI settings and optional per-device persistence |
| `FcmRenderGeneration.hx`, `FcmFeedText.hx`, `FcmEmoji*.hx` | Delayed rendering, styled text, bundled emoji |
| `FcmFeedPlan.hx`, `FcmRenderCoalescer.hx`, `TestFcmFeedPlan.hx` | Pure render planning (coalescing, prefix reuse, slice budget) + tests |
| `FCMChat.ini`, `FCMChatWidget.ini`, `hudmodloader.ini` | Package configuration templates and loader line |
| `build.hxml`, `normalize_swf.py`, `emoji/` | Haxe build, FWS normalization, bundled sprite data/licenses |
| `package.py`, `test_package.py`, `test-*.hxml` | Target/provider/distribution packaging and checks |
| `FCMChatWidget.swf`, `FCMChatWidget.ba2` | Generated local artifacts; verify decoded payload equality |
| `BUILD-HISTORY.md` | Dated investigations and superseded build notes |
