# FCM in-game HUD: ZFE and xScal

This is the maintained entry point for the optional in-game HUD mod. It is separate from the
default desktop overlay. The overlay does not install game files or require an extender. The
HUD mod uses UI assets and already-exposed HUD data through an extender's sanctioned API; it
must not add game-memory reads, code injection, or network/port scanning.

## Current implementation and verification

**Giveaways (2.10.129 candidate, native acceptance pending):** The selected channel now
receives the giveaway announcement and winner text through ordinary
persisted chat history and live relay events. Enter `giveaway start <item> [minutes]`,
`giveaway list`, `giveaway last`, `giveaway join <id>`, `giveaway leave <id>`, or
`giveaway stop <id>` in the HUD editor. A leading `/` or `.` is also accepted;
the native keyboard path may consume the leading character. These commands use
the linked FCM account, stay in the selected community channel, and do not create a public echo of the
command itself. Entering `giveaway` or `giveaway help` alone inserts a local
private help row into the current HUD feed without contacting the relay; it is
visible only to that player, including when the game strips a leading `/`.
The help row has a UTC timestamp and scrolls upward as newer chat arrives.
The ZFE terminal command receipt clears the command outbox, so it no longer
waits for a chat echo and reports a false delivery warning. Command feedback
uses the prompt without hiding the feed. The send receipt shows a short result; `list` and `last` include
up to three compact entries. Other HUD slash commands remain unsupported. The
ZFE and xScal Ruffle giveaway scenario checks private help in the feed, routing,
receipt handling, and announcement/result rows. The user's ZFE 0.15.0 screenshot
confirms the private help row in the native feed. The command reached hosted Dev;
the first 2.10.127 announcement failed to persist because Dev's
`messages_source_check` omitted `bot`. After the constraint was expanded, the
exact failed persistence job completed, Discord's card repair linked the card,
and the draw's `giveaway_winner` row was persisted and appended to the live ZFE
feed. A later native General-channel attempt was created and persisted in Dev;
Discord API confirmed its embed and buttons in Events. The HUD's forced Events
route and the missing ZFE command receipt handling caused the visible mismatch.
A fresh start-to-card native trial after the channel and receipt correction remains required.
The 2.10.129 BA2 is installed on the local Steam/Proton desktop for a hosted-Dev
trial with ZFE 0.15.0; the ZFE fragment and inactive xScal config both target
`wss://dev.falloutchatmod.com/relay`, and `Data/FCMChat.ini` now points its
separate `linkUrl` at `dev.falloutchatmod.com/link`. The provider and archive
registration are unchanged. The exact rollback files are listed in the
[build guide](../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md).
Pure Haxe, source/package checks, and the full 77-case Ruffle suite pass for
this candidate. The matching giveaway backend was deployed to hosted Dev on
2026-09-25; the pre-deployment HUD command was rejected by the old backend.

**HUD 2.10.125 input and installer patch:**
the xScal 0.2.18 test DLL exposes native text sessions through
`__SFCodeObj.call("Input.BeginInput")`, `Input.PollInput(sessionId)` and
`Input.EndInput(sessionId)`. This branch adds a validated session route with
SharedHUDTools fallback for older xScal builds. ZFE instead uses the host
SharedHUDTools editor and its ControlMap lock. The corrected 2.10.125 candidate
was locally installed with ZFE 0.15.0 and xScal 0.2.18; the corrected BA2 is in
source revision `4865d668` (SHA-256 `66d1d90246723d99838ab5620192b50fe1083a23cf55f80c11b8e47527ef464e`).
The [text-input contracts](text-input-contracts.md) give the exact provider calls,
response checks, ownership, and fallback rules. Two earlier xScal Escape cancels
completed, the native session was released, and later HUD input arrived. The
user reported that the game remained responsive. A prior 2.10.124 run appeared
to freeze immediately on Escape, and its cause is not established.
The production overlay is unchanged. The 512-UTF-16-unit buffer, session identity,
revision, terminal state and teardown are checked in the widget. The user
accepted the local native test. On the corrected BA2, the tester subsequently reported
controller-active physical Insert, keyboard typing without the extra on-screen keyboard,
gameplay lock while editing, and Escape recovery working on both providers. The available
logs confirm specific provider/session/focus events, not every action in the wider matrix.
The [public xScal Nexus files page](https://www.nexusmods.com/fallout76/mods/4183?tab=files)
showed 0.2.17 on 2026-09-23 but lists 0.2.18 on 2026-09-24. The public-version
gate is cleared; the locally downloaded 0.2.18 archive's DLL was byte-compared with the
earlier tested DLL (SHA-256 `78cb91d6e9e53bcf97f55dd82a60931aec94cc4cc2b6dc74da198d6b9dd311e4`).
The provider must not be bundled with the HUD.

The published production versions before this patch are desktop overlay **1.4.2**,
visible HUD **2.10.125**, and optional background bridge **0.2.9**. This patch
keeps the HUD version but replaces its package with the corrected 2.10.125 BA2
and separate provider install folders. An earlier local 2.10.121 test candidate
contained additional quoted-message changes under that same version; the last
native-tested local install was the corrected 2.10.125 BA2 described above.

**Background bridge 0.2.8 release:** published as a separate optional HUDModLoader child.
It was installed locally with xScal 0.2.17 for testing, but native mixed-client acceptance
remains pending. It retains the roster-visible `ownName` fallback from the earlier 0.2.6
candidate. The bridge replaces native networking/linking
with provider-scoped local exports. Sign into the overlay only. Visible HUD native
authentication stays unchanged; both paths share canonical Server rooms/history
across ZFE/xScal. Full mixed-client and native storage acceptance is required;
older candidate results below are historical, not acceptance of this release. See
[current bridge contract](background-server-bridge.md) and
[automated checks, Dev deployment and installed candidates](../../testing/bridge-drop-in-acceptance-2026-09-16.md).
Desktop/xScal's 0.2.0 export worked; laptop/ZFE created no export. The 0.2.1 laptop
candidate restores capability-checked `BRG_OBJ` discovery and exposes the selected
storage route in the loader menu, but the laptop still reported provider pending.
0.2.2 adds privacy-safe probe/lifecycle diagnostics without relaxing storage gates.
The native screenshot then localized E1014 to the storage parse phase, with fresh roster
data. 0.2.3 reuses `FcmJson` for runtime-info/write acknowledgements and forbids packaged
`JsonParser` linkage. The 2026-09-17 laptop check confirmed active, advancing, fresh ZFE
exports and the user reported it working. Full mixed-client shared-room/message/travel
acceptance remains pending; the overlay log did not independently confirm room assignment.
These 0.2.0–0.2.3 observations are historical and do not accept 0.2.8.

**Historical visible HUD 2.10.121 candidate:** previously installed on the Steam/Proton desktop;
its native acceptance was pending. It decodes received JSON chat bodies before matching them to the
optimistic send, preventing quoted messages from leaving a second pending row beneath newer
messages. The local pure Haxe and complete 67-case Ruffle suite pass, including one-row checks
for xScal and ZFE. It also removes the failed widget-owned xScal TextField experiment and
restores SharedHUDTools as the xScal text-entry path. xScal `Input.*` remains limited to
configured action-key polling. Keyboard typing while controller mode is active is unsupported
pending a native xScal text-input API. At that time ZFE retained the owner-scoped input path.
The local game configuration used `FCMChatWidget` with `ImprovedBars`; `FCMServerBridge` was removed.
See [build and install evidence](../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md#local-210121-quoted-message-candidate-2026-09-22)
and the [native test checklist](../../testing/hud-recovery.md#quoted-message-native-regression).

**Visible HUD 2.10.117 CONTROLLER-TEST:** isolated, native-unverified test build. It retains
2.10.116's session transcript and reserves
Enter for text submission. Selected-link activation defaults to F8, and transient empty
SharedHUDTools samples no longer erase the stable draft. It keeps accepted
Server rows as bounded in-memory history across every room visited during the current widget/game
session. Delivery and sends remain fenced to the current confirmed room; restarting the widget
starts an empty transcript. It also retains 2.10.113's identity-field inventory and
2.10.112's use of original relay timestamps to slot delayed newly confirmed-room Server history
into General chronologically. Replay older than General's loaded
static-history horizon appears only in the complete Server subtab, preventing a previously visited
room's backlog from arriving as a tail burst. Live Server rows remain in General. The candidate
retains 2.10.111's roster-visible `@self:` evidence; authentication, sender attribution, mutual
sightings and room gates are unchanged. It adds capability-gated, transition-only fixed-schema
room diagnostics with no player names, roster contents, messages, raw identifiers or tokens.
It adds capability-gated ZFE owner-scoped text input and configured hotkeys. xScal retains
configured physical-key polling and best-effort SharedHUDTools text entry. Native acceptance
remains pending. This paragraph records the earlier isolated test build, not the current release.

2.10.117 adds capability-gated ZFE owner-scoped text input for keyboard use while a controller is
connected and rejects mixed ZFE/xScal installs. Bridge 0.2.6 removes every menu, hotkey, editor,
SharedHUDTools, and HUD user-event dependency. Pure Haxe, package, and the complete 64-scenario
Ruffle matrix pass; native acceptance is pending. No
public release, local install, or backend deployment had been performed for those candidates
at the time of that test.

**Previous production HUD release (2026-09-16):** visible FCMChatWidget **2.10.110** reapplies an authoritative
supporter projection to retained rows from the same authenticated sender IDs, fixing old feed rows
that remained unstyled after a later self-echo gained the star. Same-name foreign rows are excluded.
It retains 2.10.109's queue-retirement recovery behavior. The final BA2 passed the complete local
HUD gate, hosted CI, and final ZFE 0.15.0 startup checks on the desktop and MSI laptop. Both final
ZFE runs restored saved authentication/history; the desktop received relay-confirmed Server
membership without sending a message first. xScal's native recovery evidence is from 2.10.109,
whose queue logic is unchanged in 2.10.110; the final artifact retained compiled xScal coverage.
Nexus file `23572` and the website release feed publish 2.10.110.

**Previous 2.10.107:** adds automatic pending-ZFE
auth refresh after native 2.10.106 restored populated roster reads but still failed to join
Server: the startup auth read preceded the handshake and only xScal was rechecked afterward.
The real-widget delayed-auth scenarios cover both providers. Fresh desktop ZFE/prod 2.10.107
logs confirm automatic authentication and Server-room binding before any ordinary chat send,
with populated roster reads and no decoder errors. Two Server-send echoes reconcile without
duplicates, and one loading/fast-travel cycle retains the room with empty auxiliary lists.
At that intermediate point, real hop/MainMenu, extended empty-primary fallback and laptop/xScal
acceptance remained pending; subsequent 2.10.109/2.10.110 evidence supersedes the laptop/provider
startup portion without turning one observed transition into universal hop acceptance.
2.10.106 restored earlier traversal after **2.10.105 confirmed** decoder method-entry E1014 even
on synthetic payloads. The rejected method is diagnostic-only;
probe results never become roster evidence or renew leases.
The widget retains copied names plus source timestamps only; unchanged getter reads do
not renew freshness. Historical FCMServerBridge **0.1.7** adapted that native-accepted split
reader and was installed with ZFE for hosted Dev on 2026-09-16. Its desktop ZFE test confirmed
initial binding, one message echo and retained history through same-world fast travel;
xScal and laptop acceptance remained pending for that build. The previously
installed **0.1.6** failed (`payload E1014` on four sources, `test provider` on two, no roster).
Do not transfer visible-HUD acceptance or publication status to the background bridge.
The background bridge was unpublished at that point; current 0.2.8 release status is above.
The visible widget was published as 2.10.110; its startup, Server-send/echo and same-room travel
evidence is recorded in the [release record](../../deployment/hud-2.10.110-release-notes.md).
See [bridge architecture](background-server-bridge.md) and the [test gate](../../testing/hud-automation-plan.md#isolated-packaged-bridge-gate).

Historical **2026-09-15** acceptance: the source and rebuilt SWF/BA2 candidate were
**FCMChatWidget 2.10.102**, tested locally with official xScal 0.2.16 against hosted Dev and now
retained inactive for the separate background bridge test.
The preceding 2.10.101 same-world travel test failed when an empty map masked populated public
teams. Candidate 2.10.102 permits an overlapping populated player/public-team fallback, retaining
the existing expiry and disjoint-roster safeguards. Native history, General/Server echoes and
room continuity through two populated-map loading transitions passed; the exact empty-map
fallback was not established by that run. That 2.10.102 build was not published. The previous
2.10.100/hosted-Dev ZFE run confirmed linking, history completion, and message
self-echoes, but same-server fast travel falsely reset Server chat on an empty `TeamMarkers`
update. The new candidate uses effective map/player roster continuity and bounded empty recovery;
the Ruffle scenario exercises actual widget state through both ZFE and xScal. Fresh in-game
empty-map fast-travel and real-hop acceptance is still required. The
[xScal acceptance record](../../testing/hud-xscal-acceptance-2026-09-15.md) separates automated
coverage from remaining native checks. See
[styling test history](../../testing/hud-emoji-status.md) and
[recovery acceptance](../../testing/hud-recovery.md).

| Need | Maintained reference |
| --- | --- |
| Build, install, package, and validate | [Widget build guide](../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md) |
| Widget source and behavior | [Widget README](../../../game-mods/FCMBridge/hudmodloader-chat/README.md) |
| Current public changes and publication evidence | [HUD 2.10.110 release record](../../deployment/hud-2.10.110-release-notes.md) |
| Native relay, authentication, controls, cosmetics | [FCM integration](native-chat-relay/fcm-integration.md) |
| Extender API distinctions and current author links | [Provider API guide](modder-guide.md) |
| Appearance, fonts, emoji, persistence | [Appearance](ingame-chat-appearance.md) |
| Open key, channel navigation, scrolling | [Keybind source, included in ZIP README.txt](../../../game-mods/FCMBridge/hudmodloader-chat/KEYBINDS.txt) |
| Rendering, input ownership, artifact constraints | [Scaleform engineering guide](scaleform-ui-guide.md) |
| Owned files and install conflicts | [Surface manifest](hud-surface-manifest.md), [compatibility](hud-mod-compatibility.md) |
| Duplicate/reconnect/send behavior | [Recovery checks](../../testing/hud-recovery.md), [retry receipts](hud-send-retries.md) |
| Background HUDModLoader mod for desktop Server chat | [Background bridge implementation and acceptance](background-server-bridge.md) |

The separate [FCMServerBridge candidate](background-server-bridge.md) uses HUDModLoader
and a storage-only adapter. It has no loader menu, hotkey, or input listener; status is exported
to the overlay and written as privacy-safe provider diagnostics.
The overlay authenticates observations from its own local game; another device's HUD
link never grants access. Backend confirmation, not file presence, enables Server.

Historical 0.1.3 run: an allowed world menu but exceptions on all six roster sources.
Installed 0.1.4 adds cached getter/processing phases, numeric exception IDs and subscription
counts; native acceptance is pending and it does not claim to fix the failure. See the background bridge
guide for current evidence and next checks.

The subsequent native 0.1.4 screenshot shows eight successful subscriptions but
`processor entry E1014` on all roster paths. Installed (not native-accepted) 0.1.5 adds a bounded
missing-class identifier diagnostic. The unresolved dependency and functional fix remain pending.

## Native transport and provider selection

`FCMChatWidget.ba2` contains only `interface/FCMChatWidget.swf`. HUDModLoader loads this child
widget; FCM does not patch HUDModLoader's HUDMenu for this package. The widget calls
`FcmNativeApi`, which selects already-exposed xScal `chatInterface` first, or a validated ZFE
dispatcher. Both use `wss://<target>/relay`. The native extender owns credentials and network
transport; a call-only `__SFCodeObj` is not sufficient provider identification.

ZFE receives command names and JSON strings. xScal chat methods receive ActionScript objects,
with no arguments for designated state/runtime/reset operations. Its optional generic callback
is used separately for logging and numeric `Input.*` key calls. Required chat methods gate xScal;
when its optional runtime-info method exists, its response must also pass validation.

Unlinked users receive a pinned link notice and cannot send. Linking is completed at the target
website's `/link` page. Connection success alone does not establish a linked account. SERVER
membership uses authenticated controls built from HUD-published account/world/roster data.
See the [native relay guide](native-chat-relay/README.md) for the full data path.

### Current game font aliases (2.10.97)

FCMChatWidget body text, prompt text, status text, and punctuation use `$MAIN_Font`; tab labels
and sender names use `$MAIN_Font_Bold`. This is based on the active Fallout 76 English
`interface/fontconfig_en.txt`, which maps those two aliases to Roboto Condensed faces. It does
not map `$MAIN_Font_Light`. Using that nonexistent alias renders the body range as square
placeholder glyphs, which can make the `Name: message` separator appear missing even though the
serialized message includes it. The Ruffle harness uses the corresponding direct face names,
`Roboto Condensed` and `Roboto Condensed Bold`.

### Provider-gated automatic roster safety (2.10.98)

The visible widget enables automatic Server-room roster/leave controls through ZFE only when the
runtime advertises `zfe-chat-async-control-v1`. Older ZFE builds perform that operation
synchronously on Fallout's Scaleform/UI thread, so they remain fail-closed; static community
chat/history still works. xScal retains Server-room binding through its asynchronous
`chatInterface`. Native Haxe tests execute the capability gates and exact provider payloads. The
Ruffle suite verifies both packaged provider paths and the GFx-safe receipt decoder source gate;
pure Haxe executes the exact queued/control completion envelopes. The final
BSUIDataManager-to-`SERVER-READY` observation remains bounded in-game acceptance because Ruffle
0.6 does not expose the movie callbacks or Fallout's cross-domain manager boundary needed to
drive and inspect that private state.

The current unreleased typing-renewal candidate keeps automatic membership controls running
while the chat editor is open. Confirmed rooms renew at the existing 30-second interval;
unconfirmed attempts retain the 10-second retry interval. Editor ownership no longer suppresses
these capability-gated nonblocking calls. Authentication, fresh roster evidence, world-generation
checks and the 60-second relay-confirmation timeout remain unchanged. A native send receipt
cannot renew the confirmation, and unchanged cached observations cannot become fresh merely
because a renewal was attempted. The draft, caret/selection and editor focus stay owned by chat.
This corrects the local xScal capture where repeated typing postponed renewal until the room
confirmation expired, then the same room was restored five seconds later. Native acceptance of
the correction remains pending; see the [regression coverage](../../testing/hud-automation-plan.md#typing-and-server-membership-renewal).

From widget 2.10.94, ordinary ZFE sends require the runtime capability
`zfe-chat-async-send-v1`. A ZFE build without it gets an update-required message instead of a
potentially blocking native call. The gate uses the advertised capability, not a version string.

### ZFE asynchronous completion (2.10.100)

With `zfe-chat-async-send-v1`, `chat.v1.sendMessage` returns `status=queued` and a provider-local
numeric `requestId`; this is not proof that the relay accepted or stored the operation. The widget
retains the optimistic send or pending Server control and matches that ID against the later
`chat.send.accepted` or `chat.send.failed` event returned by `pollEvents`. User sends remain
pending until their durable relay echo/private receipt arrives. Server controls remain pending
until `FCMCTL/1/SERVER-READY`; terminal failures keep the Server tab hidden and log the stable
failure code. A 750 ms follow-up poll covers the observed worker completion window without
waiting for the normal five-second background interval.

The decoder uses the bundled bounded `FcmJson` implementation. In 2.10.99, in-game logs showed
a 48-byte response taking the synchronous-success path before the network response arrived.
The exact response body and parser failure were not captured; the build already enabled
`haxeJSON`, so a missing native JSON global was not established as the cause. Fresh 2.10.100
logs confirm queued request IDs and terminal failures are now recognized. They also reveal
`permission_denied` after a HUD reload consumed the original sign-in notice. The relay recovery
correction below addresses that separate failure. Low-end render coalescing, six-row slices,
and reusable rows remain enabled.

### Missing sign-in code after a HUD reload

On 2026-09-15, ZFE delivered a link notice at 19:54:52, then loaded a new widget instance at
19:55:19 while retaining its native subscriber. The new instance had no pinned notice and
its `RESYNC`, roster, and message requests were denied because the relay identity was unlinked.
The local backend correction accepts only the exact limited-identity `RESYNC` control to
reissue that account's private notice, rate-limited and routed across backend replicas.
It does not grant chat permissions or reset credentials. See the
[auth recovery contract](native-chat-relay/fcm-integration.md). The correction is deployed to
hosted Dev as `73bd38be` (2026-09-16 UTC), but not Prod. The public Dev `/relay` smoke test
consumed the original notice, retained the subscription, and recovered the same valid code on
two RESYNCs with newer delivery cursors. Unlinked sends remained denied. The initial snapshot
contained 40 records across all five static channels and exactly one completion marker.
Temporary test tokens/link codes and sockets were cleaned up. This is live relay evidence,
not native ZFE/GFx acceptance. The local 2.10.100 ZFE widget now targets hosted Dev; its archive
is unchanged and its former Prod settings/auth file were backed up before the target switch.

Local verification: 149 relay/auth/link-code tests, TypeScript no-emit checking, the full
24-test Ruffle suite, Haxe logic/provider/auth suites, and source/package/BA2/SWF checks passed.
The new WebSocket regression consumes the original notice before requesting recovery on the
same subscriber, checks a newer cursor and cross-instance delivery, and proves other identities
receive no code. Additional tests cover code reuse, rate limits, revoked tokens, and service
failure. Ruffle remains regression evidence, not proof of the native ZFE/GFx lifecycle.

## Combined General feed

In the 2.10.115 session-transcript candidate, General shows **General, accepted Server rows from
every room visited during the current widget/game session, Trading, Events, Infests, and Raids**.
The six allowed slugs are `global`, `server`, `trade`, `events`, `infests`, and `raids`. Tabs
filter one retained record list; each row keeps its source channel and message identity. Sending
from General still sends to `global`. No message is copied or rebroadcast. Private, system, and
unknown channels do not enter the combined view. New Server delivery and sends require a
confirmed current room; leaving it retires authority and room-scoped replay identity, while
already accepted rows remain display-only in the bounded session transcript. A new widget/game
session starts empty. When a confirmed room restores retained Server history after the static
feeds, the widget slots replay whose original timestamp overlaps General's loaded static-history
horizon into that feed in chronological order. Older replay remains available in the Server
subtab without flooding General. The timestamp controls projection/order only and is not rendered
in the HUD.

Replay rejection precedes pending-send reconciliation. A retained canonical row rejects the
same channel/message ID even after bounded-cache eviction. Different nonempty ACK/event IDs
cannot match by body or sender fallback. Legacy matching is bounded and unique-only, so an
intentional repeated send is not silently merged. Provider event IDs cover older events without
a durable message ID. These guards do not merge distinct server-assigned messages or suppress
a second independently loaded renderer.

Initial history is bounded to 15 rows per static channel plus 50 for each freshly confirmed
SERVER room, then one terminal completion frame, drained in 16-event native polls. The existing
message cap bounds the session transcript. Authenticated recovery and world rebinding preserve
that partition. New-message notices count only rows visible in the
selected tab. Delayed render slices have generation checks and their own exception handling;
stale work cannot replace a newer feed with a fallback.

## Input and appearance

The shipped key map is `openKey=INSERT`, `channelNextKey=NextPage`, `channelPrevKey=PrevPage`,
`scrollUpKey=Up`, `scrollDownKey=Down`, `scrollBottomKey=`, `activateLinkKey=F8`, and
`hideKey=DELETE`. Insert opens chat by
default; Enter sends a non-empty draft and Escape cancels. Page Up/Down switch channels while idle
or typing. Up/Down selects a message row and paints a bounded highlight. The configured link key
(F8 by default) activates the selected row's first HTTP(S) URL through the
capability-gated ZFE browser-v1 service. Full URLs remain literal and selectable; ZFE accepts
only validated HTTPS targets. No generic Flash, Electron, relay or alternate-provider launcher
is used. Unsupported providers retain readable links. See [browser links and site allowances](browser-links.md)
for configuration, request lifecycle, native acceptance limits and the xScal maintainer proposal.
Activation requires the visible editor and a selected link; incoming messages never open links.
The highlight color is independently configurable as `Selected message` in F11 → Customize →
Colors or as `selectedRowColor` in `FCMChat.ini`; it persists through ZFE storage and the xScal
device-scoped layout relay.
Configured feed scrolling acts only while chat owns a visible input session. The blank newest and
newest value is intentional: Home/End remain unassigned. Delete hides only while idle; `/hide` plus
F11 → FCM → Hide chat remain available. F11 → FCM → Scroll to newest is always available.
Aliases and reversed Up/Down bindings use the same navigation policy. Edge guards key on
normalized action names; different aliases are not universally one shared latch. Test simultaneous
named/physical delivery on the installed loader before claiming one action per physical press.

`Data/FCMChat.ini` is authoritative for FCM's `openKey`. After discovery the widget updates ZFE's
process-level chat watcher to that value, so an older persisted F11 snapshot or a packaged
`OpenChatKey=INSERT` cannot silently restore Insert. xScal also reads `openKey` only from that file;
xScal has no `OpenChatKey` setting. Its physical
key API takes numeric VK codes and returns Booleans. Registration does not promise keyboard
suppression. FCM's ZFE `Input.*` route remains a tested compatibility path on specific builds,
not the public `zfe-input-v1` contract. That capability names owner-scoped `input.v1.*` text
sessions. The public [hotkey contract](https://www.nexusmods.com/fallout76/articles/270) is now
available; migration to `hotkeys.v1.*` is not implemented in 2.10.85 and needs separate tests.

| Provider | Authoritative open key | Detection | Configuration precedence |
| --- | --- | --- | --- |
| ZFE | `FCMChat.ini` `openKey`, synchronized to ZFE after discovery | Owner-scoped `hotkeys.v1`, numeric `Input.*` open-key fallback, and legacy `isChatKeyPressed` | File key wins over persisted appearance and the packaged ZFE default |
| xScal | `FCMChat.ini` `openKey` only | Numeric `Input.RegisterKey` / `Input.IsKeyPressed` | `xscal.ini` has transport settings only and must not contain `OpenChatKey` |

| Behavior | ZFE | xScal |
| --- | --- | --- |
| Shared package | One provider-neutral `FCMChatWidget.ba2` | Same BA2 |
| Provider selection | Validated as the sole active extender | Validated as the sole active extender; the adapter checks `chatInterface` before ZFE if both surfaces appear, but the widget rejects that mixed install |
| Primary visible editor | SharedHUDTools `TextEdit` with the host ControlMap lock | Native xScal text session when `BeginInput` validates |
| Physical keyboard with controller active | ZFE focuses the host's visible entry field while retaining its ControlMap lock | Native xScal text session when `BeginInput` validates |
| Compatibility fallback | No unlocked editor fallback; a failed host editor refuses entry | SharedHUDTools when the native session is unsupported |
| Multi-character typing | HUDTools' focused entry field has selection/caret enabled | Native session returns complete bounded text snapshots; the host fallback uses its entry field |
| Submit/cancel recovery | Missing host Enter callback can recover the draft once; other stale focus loss cancels | Native terminal poll decides submit/cancel; release must be confirmed before reopening. Host fallback uses the HUDTools recovery rule |
| Delete while typing | Edits the host field; the optional hide binding is suspended | Native session owns editing; host fallback edits its field |
| Default open key | `FCMChat.ini` `openKey=INSERT`, synchronized with the ZFE watcher; the fragment defaults to `OpenChatKey=INSERT` | `FCMChat.ini` `openKey=INSERT` only |
| Channel / feed keys | Page Up/Down; Arrow Up/Down after input opens | Same behavior through named actions and numeric physical polling |
| Feed refresh | Atomic hidden staging, six rows per timer turn | Same renderer; verified locally without recurring over-30 ms message turns |
| Transport payload | Command plus JSON string | ActionScript object or no arguments according to method |
| Settings persistence | ZFE vendor-scoped storage | Relay persistence only when the capability is advertised |

The [text-input contracts](text-input-contracts.md) separate physical-key polling,
ZFE owner hotkeys, ZFE diagnostic `input.v1`, the HUDTools ControlMap editor, and xScal's
native text session. None of those calls is interchangeable with another provider's
chat transport.

Provider-level physical registrations are derived exclusively from the active profile. On reload
or profile reapplication, the widget unregisters the complete previous set before registering the
new channel, scroll, link, hide, and open-chat keys. ZFE also attempts to replace its narrower native
open-chat watcher through `updateChatHotkey`. Its configured open key stays registered with numeric
`Input.*` even when the owner-scoped hotkey accepts it, so physical Insert has a second edge path in
controller mode. Other keys use `Input.*` when the owner-scoped API cannot represent them. Thus a
superseded default such as Insert or Page Down is neither dispatched nor retained as an active FCM
binding after a successful rebind.

### Verified ZFE rebind procedure

In-game acceptance on 2026-09-15 with ZFE 0.12.26 and FCMChatWidget 2.10.96 confirmed the
provider-neutral physical-key path. Exit Fallout 76, edit the existing `[FCMChat]` keys in
`Data/FCMChat.ini`, and keep the ZFE fragment `OpenChatKey` aligned with `openKey`. Restart the game;
the widget first attempts ZFE's native `updateChatHotkey`, then registers every mapped profile key,
including `openKey`, through the compatibility `Input.*` surface. A native update returning `false`
for an F-key is expected and is not fatal when physical registration succeeds. Verify `zfe.log`
contains `FCMChatWidget 2.10.96 loaded`, one accepted registration for each expected Windows VK,
and a `physical navigation poll started provider=zfe` line listing only the new profile. Exercise
every action and confirm the superseded bindings are inactive. The accepted profile was F12 open,
F8/F7 channels, F6/F5 scroll, F4 newest, F3 selected-link activation, and F2 hide.

Do not validate rebinds by editing persisted appearance storage alone, and do not infer success
from `updateChatHotkey` alone. `Data/FCMChat.ini` is authoritative; replacing the BA2 or fragment
requires a full game restart.

That 0.12.26 result remains historical in-game evidence. Nexus ZFE 0.15.0 targets Steam and
Xbox/Game Pass runtime 1.7.26.10. Static artifact inspection on 2026-09-15 confirmed that it retains
FCM's `__ZFE` dispatcher, `zfe-chat-online-v1`, `zfe-chat-async-send-v1`,
`zfe-chat-async-control-v1`, storage, input, hotkey, and physical `Input.*` contracts. The Ruffle
provider mock now identifies as 0.15.0. Fresh in-game acceptance is still required before treating
that static and simulated result as native acceptance.

### Verified xScal rebind procedure

In-game acceptance on 2026-09-15 with the installed xScal 0.1.15 contract and FCMChatWidget
2.10.96 confirmed the same physical-key lifecycle. Exit Fallout 76, select the xScal extender,
set `[Chat] enabled=true` and the intended `relayEndpoint` in the root `xscal.ini`, and edit only
the existing `[FCMChat]` bindings in `Data/FCMChat.ini`. xScal has no `OpenChatKey` setting; do not
copy ZFE's `[TextChat]` keys into `xscal.ini`. Restart the game and verify `xscal.log` contains the
2.10.96 startup marker, `provider=xscal`, one accepted `Input.RegisterKey` result per new VK, and a
physical-poll line whose `openKey` and key set match the complete replacement profile.

The accepted rotated profile was F2 open, F3/F4 channels, F5/F6 scroll, F7 newest, F8 selected-link
activation, and F12 hide. The log confirmed accepted VKs 113 through 119 plus 123, then delivered
Dev history across 16/16/10-event polls and emitted `replay completed` with 41 retained records.
Manual in-game testing confirmed the rotated actions worked. As with ZFE, exercise every action
and verify superseded bindings are inactive; registration itself does not suppress an overlapping
Fallout gameplay action.

That 0.1.15 result remains historical in-game evidence. Nexus xScal 0.2.16 targets Fallout runtime
1.7.26.10. Static artifact inspection on 2026-09-15 confirmed that it retains FCM's required
`XSCALCHATV1`/`chatInterface` methods and `Input.RegisterKey`, `Input.IsKeyPressed`,
`Input.UnregisterKey`, and `Input.ClearKeys` callbacks. The Ruffle contract fixture and suite now
exercise 0.2.16. Fresh 1.7.26.10 in-game acceptance is still required before promoting that static
and simulated compatibility result to native acceptance.

Channel and scroll bindings always come from `FCMChat.ini`. The current ZFE route uses
SharedHUDTools' host-owned editor and its balanced ControlMap text lock. xScal uses its native
text session when available and SharedHUDTools on older builds. The ZFE `input.v1` and legacy
native-buffer paths are not automatic fallbacks because the local 0.15.0 trial still allowed
gameplay actions during a reported owned session. Provider acceptance
must verify Insert opens one visible editor, `hello` remains five characters, Page Up/Down switch
channels only during the owned edit, Escape cancels, and Enter submits once. If the host editor
loses focus without its callback, the widget waits 225 ms, recovers an Enter submission once, or
cancels other stale sessions so Insert works again. The recovery draft stays in memory and logs
only its length. Do not infer xScal
key support from ZFE commands or route ZFE input verbs through xScal's `chatInterface`.

Provider hotkeys remain observable globally, but FCM will not acquire the editor in a configured
`hideInHUDModes` state. The default includes `ContainerMode`; this prevents a letter binding such
as T from stealing Fallout's Deposit All action. A held key is latched while blocked, so leaving
the container does not open chat until a fresh key press. Letter bindings can still overlap
ordinary gameplay controls outside blocked modes and should be chosen accordingly.

### Inspection, prompts and manual hiding

The current source defaults also block `InspectMode`, `ExamineConfirmMode`, and `MessageMode`,
names defined in [HUDModLoader's current HUDMenu contract](https://github.com/GitCrazy-wc/hudmodloader/blob/71e2fde134933323777980b5e0fd0c6036c2408f/hudmenu/scripts/Shared/HUDModes.as).
These cover item inspection, examine/scrap confirmation, and modal-message HUD modes. Bethesda's
HUD team widget also suppresses itself for `ExamineConfirmMode` in that pinned source. Native
weapon/armor inspection and scrap-confirmation transitions still require acceptance on the
current game build; not every on-screen prompt necessarily uses `MessageMode`.

For an existing `Data/FCMChat.ini`, append `InspectMode,ExamineConfirmMode,MessageMode` to your existing
`hideInHUDModes` list. Explicit custom lists (including an empty list) are preserved, not migrated
or overwritten. The supplied default is:

```ini
hideInHUDModes=MainMenu,Pipboy,WorkshopMode,WorkshopNoCrosshairMode,CampPlacement,ContainerMode,MapMenu,InspectMode,ExamineConfirmMode,MessageMode
```

Manual hiding (`/hide`, F11 **Hide chat**, or the configured hide key) now stays hidden until the
configured Open Chat key is pressed in an allowed mode. Escape, menu exit, incoming messages,
and turning off inactivity auto-hide do not undo it. History continues accumulating while hidden.
Inactivity auto-hide remains separate: incoming messages can wake it, but cannot bypass a blocked
HUD mode. These changes affect the visible HUD widget on both providers, not the desktop overlay
or background bridge. Updating the INI adds mode coverage; fixing sticky manual hide also requires
the rebuilt widget `.ba2`. Source/test candidate only until native acceptance and release.

ZFE now opens SharedHUDTools `TextEdit` first. That host editor owns the balanced
`ControlMap::StartEditText`/`EndEditText` lifecycle; the child widget does not dispatch those
events. The public `input.v1.begin/poll/end` decoder remains in the build for explicit
diagnostics, but it is not the default ZFE editor. If SharedHUDTools cannot open, the widget
reports input unavailable and leaves gameplay unlocked rather than presenting a draft that
allows game actions to fire.

For ZFE hotkeys, `hotkeys.v1.register` returns the registration token. A successful
`hotkeys.v1.poll` is decoded from `success` and `presses`; the poll response need not echo
the token. If it does echo one, FCM rejects a mismatch. A rejected poll emits a warning and
stops that registration set. On a report that gameplay keys still fire after Insert, look for
`input path: shared-hud-tools`, `FormatTextEdit ok`, `FormatOnScreenKeyboard ok`, and `opened`
in `zfe.log`. A `zfe-input-v1 controller-test` marker identifies the earlier route, which
the 2026-09-24 in-game trial showed did not lock Fallout controls despite native suppression
counts. The Ruffle hotkey scenario checks selection of the host editor; only an in-game test
can confirm Fallout's actual ControlMap behavior. `Map`, `QuickMap`, `QuickInventory`, and
other ordinary gameplay actions stay in text mode while the editor is open. Explicit modal
actions such as PipBoy and Social still close the editor.

With a controller active, the ZFE open key is also polled through numeric `Input.*`; the log
records `zfe physical openKey edge` if this route detects it. HUDTools normally focuses an
off-screen controller field in this mode. FCM finds the visible host entry field on the public
display list and focuses it for physical keyboard typing while HUDTools retains the ControlMap
lock. The log records `ZFE controller mode: physical keyboard focused host entry` on that
handoff. The host's 300×180 controller keyboard is positioned outside the stage. Ruffle
covers the focus handoff and open-key fallback. For the corrected 2.10.125 BA2, the tester
reported controller-active physical Insert, keyboard entry without the extra controller
keyboard, gameplay/map lock, and Escape recovery working on ZFE 0.15.0 and xScal 0.2.18.
The ZFE log records the off-screen placement and focus handoff from the initial run; no
additional ZFE log was produced after the final provider return swap.

F11 → FCM → Customize controls panel/input dimensions, text sizes, backgrounds, text colors,
opacity, position, and auto-hide. Input width/alignment follow the panel. Channel tags/colors,
badges, emoji, and available/default channels are fixed; timestamps are not displayed.
The [appearance guide](ingame-chat-appearance.md) lists active and retired settings.

## Configuration and packaging

Use `package.py` with an explicit `--target dev|prod`, `--provider unified|zfe|xscal`, and
`--distribution website|nexus`. Target stamps set both relay endpoint and web link destination.
A generated filename is not proof of which endpoint the game loaded.

The modern ZFE fragment is `Data/ZFE/TextChat/fragments/FCMChatWidget.ini`; `FCM.ini` belongs to
the legacy standalone build. A DLL-only ZFE install is normal. The global
`Data/configuration/zfe.ini` file is an optional user override that may be created when needed;
its `[TextChat]` values win over the fragment. xScal uses `[Chat] enabled=true` and `relayEndpoint` in `xscal.ini` beside the game
executable. Merge existing sections, loader registrations, and archive lists; never replace
unrelated settings. Install only the selected provider's configuration and restart the game
after changing a BA2 or native extender configuration.

Packages do not redistribute extenders or Bethesda HUDMenu assets. The main website and Nexus
ZIPs contain complete `ZFE (Install for ZFE only)/` and `xScal (Install for xScal only)/` folders without setup scripts; choose only one.
Quick Configuration 2 and NukaMods users should extract the ZIP and import only their chosen
folder's `Data (drag the contents into data folder)/FCMChatWidget.ba2` as a BA2 mod. The combined ZIP has two provider roots and
is not a direct mod-manager import. The manager owns BA2 deployment and the archive-list entry;
copy only missing provider/FCM INIs, merge the HUDModLoader entry, and preserve edited INIs on
updates. Check for exactly one BA2 in the game's `Data` folder and one archive-list entry.
Legacy xScal-only website ZIPs may include an optional Windows helper. All builds include
manual setup, keybind, customization, and emoji-license files. See the
[build guide](../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md).

## Client version handshake (`clientVersion`)

The widget identifies itself as `chatv1-widget-v<VERSION>` to the native relay. Backend feature
negotiation uses that identity and permission flags; a numerically newer extender is not proof
that an optional API exists. Verify the actual startup build, provider, auth, endpoint, and
capabilities. HUD feature negotiation is separate from the desktop overlay QA-build lock.

## Diagnostics

Current source emits build/instance, provider, receive/echo counts, render row/layout/name-color
counts, and bounded error context. Check actual log statements before documenting additional
fields: the `FcmDiagnostics` helper/tests do not establish that every planned summary is wired
into the renderer. Repeated content alone is not evidence of duplicate delivery. Keep diagnostics
free of raw tokens, chat bodies, player names, and stable account IDs.

The generic remote-data feed and TCP/WebSocket HUD bridge have been retired. The
active `FCMHUD/1;...` metadata envelope in native-chat `targetUserId` remains in use.

## Retained Server history compatibility

The current candidate accepts authorized carried Server history through the
existing `FCMHUD/1;` metadata carrier, with the confirmed room in `h`. That marker identifies
replay separately from live Server traffic so General can apply its bounded history horizon while
the Server tab retains every authorized row. Both ZFE and xScal use the same validation;
authentication and world-exit gates are unchanged.
See [Server room continuity](../../realtime/server-room-continuity.md) for the
backend/overlay/HUD rollout order, tests and native-acceptance limitation.

## Staff Server labels (local candidate)

The visible HUD uses its existing server-authoritative moderation permission
snapshot to label its own confirmed room **Your server** for staff. Regular users
still see **Server**, without a numeric ID. This applies to feed tags, sub-tabs,
loader channel choices and empty-feed text. Permission changes rerender the labels.
No cross-room subscription, overlay authentication dependency, provider fork or
native room-assignment change is introduced. Numeric labels for other rooms and
room muting are overlay-only. Pure config tests and both delayed-auth Ruffle provider
scenarios cover regular → staff → revoked labeling; native game acceptance of this
candidate remains pending, independently of earlier released builds.
