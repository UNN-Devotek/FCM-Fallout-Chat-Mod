# FCM in-game HUD: ZFE and xScal

This is the maintained entry point for the optional in-game HUD mod. It is separate from the
default desktop overlay. The overlay does not install game files or require an extender. The
HUD mod uses UI assets and already-exposed HUD data through an extender's sanctioned API; it
must not add game-memory reads, code injection, or network/port scanning.

## Current implementation and verification

As of **2026-09-12**, the local source and rebuilt SWF/BA2 are **FCMChatWidget 2.10.78**.
This is a review candidate, not a publication or installed-game claim. Local Haxe, relay,
source-anchor, packaging, and SWF/BA2 checks passed during the review; hosted CI and in-game
acceptance of this candidate have not been run. The last recorded desktop ZFE confirmation
covers 2.10.74 name colors and emoji, not every later change or every provider. See
[styling test history](../../testing/hud-emoji-status.md) and
[recovery acceptance](../../testing/hud-recovery.md).

| Need | Maintained reference |
| --- | --- |
| Build, install, package, and validate | [Widget build guide](../../../game-mods/FCMBridge/hudmodloader-chat/BUILD.md) |
| Widget source and behavior | [Widget README](../../../game-mods/FCMBridge/hudmodloader-chat/README.md) |
| Native relay, authentication, controls, cosmetics | [FCM integration](native-chat-relay/fcm-integration.md) |
| Extender API distinctions and current author links | [Provider API guide](modder-guide.md) |
| Appearance, fonts, emoji, persistence | [Appearance](ingame-chat-appearance.md) |
| Open key, channel navigation, scrolling | [Packaged keybind guide](../../../game-mods/FCMBridge/hudmodloader-chat/KEYBINDS.txt) |
| Rendering, input ownership, artifact constraints | [Scaleform engineering guide](scaleform-ui-guide.md) |
| Owned files and install conflicts | [Surface manifest](hud-surface-manifest.md), [compatibility](hud-mod-compatibility.md) |
| Duplicate/reconnect/send behavior | [Recovery checks](../../testing/hud-recovery.md), [retry receipts](hud-send-retries.md) |
| Background HUDModLoader mod for desktop Server chat | [Background bridge implementation and acceptance](background-server-bridge.md) |

The separate [FCMServerBridge 0.1.0 background candidate](background-server-bridge.md) uses
HUDModLoader and the same native provider adapter. It has no chat widget: status/linking live
in the loader menu and chat appears in the desktop overlay through a private account/room
lease. Backend and renderer changes are local; hosted deployment and in-game acceptance are
pending. The visible widget's room alone does not enable desktop Server chat.

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

## Combined General feed

In local candidate 2.10.78, General shows **General, current-room Server, Trading, Events,
Infests, and Raids**. The six allowed slugs are `global`, `server`, `trade`, `events`, `infests`,
and `raids`. Tabs filter one retained record list; each row keeps its source channel and message
identity. Sending from General still sends to `global`. No message is copied or rebroadcast.
Private, system, and unknown channels do not enter the combined view. SERVER rows require a
confirmed current room and are removed on leaving it; static-channel history remains.

Replay rejection precedes pending-send reconciliation. A retained canonical row rejects the
same channel/message ID even after bounded-cache eviction. Different nonempty ACK/event IDs
cannot match by body or sender fallback. Legacy matching is bounded and unique-only, so an
intentional repeated send is not silently merged. Provider event IDs cover older events without
a durable message ID. These guards do not merge distinct server-assigned messages or suppress
a second independently loaded renderer.

Initial history is bounded to 15 rows per static channel plus 50 for the current SERVER room
(up to 125 events), drained across the native 64-event poll limit. Authenticated recovery and
world rebinding preserve that partition. New-message notices count only rows visible in the
selected tab. Delayed render slices have generation checks and their own exception handling;
stale work cannot replace a newer feed with a fallback.

## Input and appearance

The shipped key map is `openKey=INSERT`, `channelNextKey=NextPage`, `channelPrevKey=PrevPage`,
`scrollUpKey=Up`, `scrollDownKey=Down`, `scrollBottomKey=`, and `hideKey=`. Insert opens chat by
default; Enter sends and Escape cancels. Page Up/Down switch channels while idle or typing.
Configured feed scrolling acts only while chat owns a visible input session. The blank newest and
hide values are intentional: Home/End remain unassigned, and `/hide` plus F11 → FCM → Hide chat
remain available. F11 → FCM → Scroll to newest is always available.
Aliases and reversed Up/Down bindings use the same navigation policy. Edge guards key on
normalized action names; different aliases are not universally one shared latch. Test simultaneous
named/physical delivery on the installed loader before claiming one action per physical press.

ZFE users keep `Data/FCMChat.ini` `openKey` aligned with `[TextChat] OpenChatKey` in the effective
extender config. xScal users change `openKey` only; xScal has no `OpenChatKey` setting. Its physical
key API takes numeric VK codes and returns Booleans. Registration does not promise keyboard
suppression. FCM's ZFE `Input.*` route remains a tested compatibility path on specific builds,
not the public `zfe-input-v1` contract. That capability names owner-scoped `input.v1.*` text
sessions. The public [hotkey contract](https://www.nexusmods.com/fallout76/articles/270) is now
available; migration to `hotkeys.v1.*` is not implemented in 2.10.78 and needs separate tests.

Both providers use the host's SharedHUDTools editor first. The widget does not dispatch its own
ControlMap lock events. A legacy ZFE editor fallback has different ownership guarantees and must
not be described as the public owner-scoped text-session API.

F11 → FCM → Customize controls panel/input dimensions, text sizes, backgrounds, text colors,
opacity, position, and auto-hide. Input width/alignment follow the panel. Channel tags/colors,
badges, emoji, and available/default channels are fixed; timestamps are not displayed.
The [appearance guide](ingame-chat-appearance.md) lists active and retired settings.

## Configuration and packaging

Use `package.py` with an explicit `--target dev|prod`, `--provider unified|zfe|xscal`, and
`--distribution website|nexus`. Target stamps set both relay endpoint and web link destination.
A generated filename is not proof of which endpoint the game loaded.

The modern ZFE fragment is `Data/ZFE/TextChat/fragments/FCMChatWidget.ini`; `FCM.ini` belongs to
the legacy standalone build. A global `Data/configuration/zfe.ini` `[TextChat]` override wins over
the fragment. xScal uses `[Chat] enabled=true` and `relayEndpoint` in `xscal.ini` beside the game
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
