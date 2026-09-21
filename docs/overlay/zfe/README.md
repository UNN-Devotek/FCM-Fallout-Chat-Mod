# FCM in-game HUD: ZFE and xScal

This is the maintained entry point for the optional in-game HUD mod. It is separate from the
default desktop overlay. The overlay does not install game files or require an extender. The
HUD mod uses UI assets and already-exposed HUD data through an extender's sanctioned API; it
must not add game-memory reads, code injection, or network/port scanning.

## Current implementation and verification

**Background bridge 0.2.6 source candidate:** retains 0.2.4's local-export path and
prefers the roster-visible local name for `ownName`, with AccountInfo as fallback. It is
native-unverified and not installed. The bridge replaces native networking/linking
with provider-scoped local exports. Sign into the overlay only. Visible HUD native
authentication stays unchanged; both paths share canonical Server rooms/history
across ZFE/xScal. Full mixed-client and native storage acceptance is required;
older 0.1.x results below are historical, not acceptance of this candidate. See
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

**Visible HUD 2.10.117 private candidate:** retains 2.10.116's session transcript and reserves
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
Native acceptance remains pending. 2.10.110 remains the current public release.

2.10.117 adds capability-gated ZFE owner-scoped text input for keyboard use while a controller is
connected and rejects mixed ZFE/xScal installs. Bridge 0.2.6 removes every menu, hotkey, editor,
SharedHUDTools, and HUD user-event dependency. Pure Haxe, package, and the complete 64-scenario
Ruffle matrix pass; native acceptance is pending. No
public release, local install, or backend deployment has been performed for these candidates.

**Current production HUD release (2026-09-16):** visible FCMChatWidget **2.10.110** reapplies an authoritative
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
The background bridge remains unpublished and separate; its current 0.2.6 candidate status is above.
The visible widget is published as 2.10.110; its startup, Server-send/echo and same-room travel
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
| Open key, channel navigation, scrolling | [Packaged keybind guide](../../../game-mods/FCMBridge/hudmodloader-chat/KEYBINDS.txt) |
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
| ZFE | `FCMChat.ini` `openKey`, synchronized to ZFE after discovery | ZFE `isChatKeyPressed` | File key wins over persisted appearance and the packaged ZFE default |
| xScal | `FCMChat.ini` `openKey` only | Numeric `Input.RegisterKey` / `Input.IsKeyPressed` | `xscal.ini` has transport settings only and must not contain `OpenChatKey` |

| Behavior | ZFE | xScal |
| --- | --- | --- |
| Shared package | One provider-neutral `FCMChatWidget.ba2` | Same BA2 |
| Provider selection | Validated only when no supported xScal chat surface is active | Preferred when its required `chatInterface` methods validate |
| Primary visible editor | Owner-scoped `input.v1.begin/poll/end` when both input capabilities are advertised | SharedHUDTools `TextEdit` |
| Compatibility fallback | SharedHUDTools, then the legacy ZFE buffer on older builds | Never receives ZFE-only input calls |
| Multi-character typing | Focused public field has selection/caret enabled | Same shared field rule |
| Missing submit callback | Enter draft recovered once after 225 ms; other focus loss cancels | Same shared recovery rule |
| Delete while typing | Deletes characters; an optional Delete hide binding is suspended | Same shared priority rule |
| Default open key | `OpenChatKey=INSERT`, matching `openKey=INSERT` | `openKey=INSERT` only |
| Channel / feed keys | Page Up/Down; Arrow Up/Down after input opens | Same behavior through named actions and numeric physical polling |
| Feed refresh | Atomic hidden staging, six rows per timer turn | Same renderer; verified locally without recurring over-30 ms message turns |
| Transport payload | Command plus JSON string | ActionScript object or no arguments according to method |
| Settings persistence | ZFE vendor-scoped storage | Relay persistence only when the capability is advertised |

Provider-level physical registrations are derived exclusively from the active profile. On reload
or profile reapplication, the widget unregisters the complete previous set before registering the
new channel, scroll, link, hide, and open-chat keys. ZFE also attempts to replace its narrower native
open-chat watcher through `updateChatHotkey`, while generic `Input.*` handles physical tokens such as
F-keys that the native watcher rejects. Thus a
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

Channel and scroll bindings always come from `FCMChat.ini`. Current ZFE builds use owner-scoped
`input.v1` sessions with raw suppression and a stable release barrier; older ZFE and xScal use
SharedHUDTools, and only ZFE can use the legacy native draft buffer afterward. Provider acceptance
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

Current ZFE builds use `input.v1.begin/poll/end` when both `zfe-input-v1` and
`zfe-input-release-v1` are advertised. The widget retains the opaque token, polls every 40 ms,
requires raw suppression and a stable release barrier, and ends its session on every terminal
path. SharedHUDTools remains the compatibility fallback and the xScal editor. The widget does not
dispatch its own ControlMap lock events.

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

Packages do not redistribute extenders or Bethesda HUDMenu assets. Website ZIPs may include
optional Windows xScal setup helpers; Nexus ZIPs omit executable/script files; xScal/unified variants include a
helper-download note. All builds include manual setup, keybind, customization, and emoji-license
files. See the [build guide](../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md).

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

## Historical material

The generic remote-data feed and TCP/WebSocket HUD bridge are retired implementation references,
not installation instructions for FCMChatWidget. Their legacy line protocol named `FCMHUD/1` is
separate from the **active** `FCMHUD/1;...` metadata envelope in native-chat `targetUserId`.

- [Remote-data pattern](fcmbridge-data-pattern.md), [socket transport](realtime-socket.md),
  [two-way socket patch](two-way-chat-implemented.md), [old Proton proxy](linux-proton-relay-proxy.md).
- [Native protocol snapshot](native-chat-relay/protocol-spec.md) and
  [older send investigation](ingame-send-investigation-2026-08-06.md).
- [Widget build history](../../../game-mods/FCMBridge/hudmodloader-chat/BUILD-HISTORY.md).

Keep dated observations as history. New behavior belongs in the maintained guides and must
state separately what is in source, built locally, tested in-game, installed, and published.

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
