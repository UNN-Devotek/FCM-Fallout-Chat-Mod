# Background Server bridge for the desktop overlay

**Local candidate: FCMServerBridge 0.1.0, 2026-09-12.** The user revised the loader requirement:
this separate, invisible mod **uses HUDModLoader**. It has no chat widget or chat editor.
The matching backend and shared desktop renderer are implemented in this checkout. The DEV
ZIP is a local test build; hosted deployment, hosted CI and two-client in-game validation under
ZFE and xScal have not been performed.

## Install and build

Source and commands: [background mod README](../../../game-mods/FCMBridge/hudmodloader-bridge/README.md).
The package contains `Data/FCMServerBridge.ba2`, an append-only loader snippet, archive-list
example, provider configuration examples, `INSTALL.txt` and `BUILD.json`. Its one archive entry
is `Interface/FCMServerBridge.swf`. It does not include or patch HUDMenu, HUDModLoader, the
visible FCMChatWidget, native executables or installers.

For end-user steps, start with `INSTALL.txt` in the downloaded ZIP. It is generated from the
[installation guide template](../../../game-mods/FCMBridge/hudmodloader-bridge/INSTALL.template.txt)
with the build's exact environment, endpoints and link URL. The guide covers dependency setup,
game and Documents paths, merging existing configuration, switching from the visible widget,
account linking, automatic Server-tab changes, troubleshooting, updating and removal. This
candidate's instructions explicitly identify the matching service/desktop requirements and
pending in-game acceptance.

Install HUDModLoader and exactly one supported native provider. Add `FCMServerBridge` once to
the existing `Data/hudmodloader.ini`, and append `FCMServerBridge.ba2` to the existing
`sResourceArchive2List`. Preserve other entries. Use only the selected provider's example:

- ZFE: `Data/ZFE/TextChat/fragments/FCMServerBridge.ini`; `[TextChat]` uses the target `/relay`
  endpoint, `DefaultChannel=server`, `AllowedChannels=server`, `AutoConnect=false`. Existing
  `Data/configuration/zfe.ini` keys override the fragment. No chat hotkey is used by the mod.
- xScal: merge `[Chat] enabled=true` and the target `relayEndpoint` into the existing
  `xscal.ini` beside the game executable. Do not install ZFE configuration for this provider.

Disable the visible FCMChatWidget and legacy FCMBridge loader/archive entries before enabling
this bridge. Native providers have one event-consumer queue. A bounded display-tree marker
check pauses the bridge when another modern FCM widget/bridge is detected; this is a backstop,
not a substitute for inspecting the install configuration.

The desktop overlay remains an independent optional client. It never installs the mod, modifies
game files, reads native credentials, reads game memory, injects code or scans ports. The user
manually opts into the mod, which reads only already-published UI data and uses the existing
native outbound relay. There is no localhost game-data listener.

## Linking without a chat widget

The bridge registers only status/linking actions with SharedHUDTools. Open HUDModLoader's menu
(F11 / `DiagnosticSnapshot` with the standard mapping), select **FCM Server Bridge**, and read
the one-time code. Explicit loader menu aliases are handled once per key press; there are no
chat-input sessions, physical key registrations or game-control locks owned by the bridge.

Redeem the code at the target website's `/link` while signed into the **same account as the
desktop overlay**. The existing native device credentials and normal link service are reused;
credentials never enter the overlay. Codes expire after ten minutes; the mod reconnects to
refresh a limited session's code. The menu also offers **Reconnect bridge**. Revoked, invalid,
banned or kicked credentials stop automatic retries until the user requests a retry.

`FcmNativeApi` preserves the verified provider contracts: explicit xScal `chatInterface` methods
with object/no-argument calls, otherwise capability-validated ZFE commands with JSON strings.
Both providers may connect asynchronously. The background poller drains a bounded 16 events per
500 ms tick, retaining only system link and room-confirmation controls; ordinary chat is discarded.

## Fresh world observations

`FcmBridgeState` accepts real, ready `BSUIDataManager` providers only (`isTest != true`,
`dataReady == true`). A non-null empty placeholder does not establish an in-world session.
Account identity comes from `AccountInfoData`, never a character-name fallback. Known HUD
roster arrays are bounded to 2,048 examined rows and 24 distinct peer names of at most 64 characters.

MainMenu/LoadingMenu, manager replacement and a disjoint roster invalidate the room nonce and
clear prior snapshots. Cached old-world providers cannot seed the replacement session until
they change or emit a fresh update. Observations expire after 30 seconds without a valid refresh.
A transport-only reconnect retains current-world observations and starts a new nonce. All
callbacks/timers are disposed on unload; LEAVE is best effort, backed by server expiry.

Room inference still uses mutual HUD-visible name sightings. It does **not** expose an
authoritative Fallout world ID. Players on the same world can remain split when the HUD has
not exposed their names, and clusters can change as observations change. Opening the map may
supply additional names. Do not promise reliable world-wide discovery until two-client runtime
checks pass for each provider.

## Account and room lease

Only an authenticated native control can renew an overlay bridge:

```text
channel = server
body = FCMCTL/1/ROSTER:<name>|<name>...
targetUserId = FCMBRIDGE/1;<requestId>
```

The existing roster assignment and `FCMCTL/1/SERVER-READY:<requestId>|<room>` confirmation
remain in use. Visible widgets continue to send `FCMSESSION/1;<requestId>` and do not grant
background desktop access. Bridge LEAVE carries the same nonce; a stale LEAVE cannot clear a
newer session. Muted accounts may refresh/read room membership but cannot send chat.

`overlayServerBridge.ts` stores a **45-second independent lease** in
`relay:bridge:device:<relayUserId>` and a bounded, expiring account index in
`relay:bridge:account:<accountId>`. The mod sends a roster heartbeat every 15 seconds. Peer room
recomputation cannot renew this lease. The overlay watches every ten seconds; an idle disappeared
bridge is removed within lease expiry plus that watch interval. Every protected live/history/send
operation also checks current membership, so a stale displayed tab is never authorization.

Resolution requires exactly **one** fresh leased device, a non-revoked pairing token still linked
to the signed-in account, a matching roster request nonce, a current inferred `r:<session>` room,
and an available account. Zero devices is inactive; multiple active devices is ambiguous. No
newest-device guess, client-supplied world assertion or admin-observer bypass grants access.
Redis/DB errors fail the bridge closed. No database migration or new environment variable is needed.

## Private overlay transport and duplicate guard

`BridgeConnection` belongs to one authenticated desktop socket and begins work only after
`bridge:watch`. Public mode never sends that frame, and admin observer sockets have no bridge.
The shared `ChatOverlay` adds a local Server child under Fallout 76 only for a confirmed desktop
binding; `/api/channels` remains a static tree. Existing channel selection is preserved when
Server appears; an actively viewed Server tab follows a new confirmed room.

| Frame | Direction | Contents |
| --- | --- | --- |
| `bridge:watch` | client → server | Refresh account-derived binding and retained history |
| `bridge:state` | server → client | `status`: ready/inactive/ambiguous/unavailable; ready adds `channelId`, `bindingId` |
| `bridge:history` | server → client | Current `bindingId`, `channelId`, normalized `messages[]` |
| `bridge:message` | server → client | Same envelope for fresh live messages |
| `chat:send` | client → server | Existing `content`, `channelId`; Server requires `bridgeBindingId` |

The binding ID is an opaque correlation value, not a credential. The server derives account
and room from the lease, then checks that correlation value. Work is serialized per socket;
a snapshot is revalidated before release and queued live events follow it. The room's retained
50-message history also recovers missed pub/sub frames during watches. The web handler consumes
only the existing private Redis server-event channel, without a second direct local echo.

`serverMessageService` is shared by native and desktop sends: fresh account ban/kick/mute checks,
account-scoped flood guard, automod without global-channel exemptions, cosmetics and one ephemeral
room publication. Storage/publication failures are not acknowledged as successful. These messages
are neither copied into static General nor relayed to Discord. Server frames keep their canonical
`server:<room>:<sequence>` IDs. Account attribution is recorded at send time so block/profile
filtering cannot inherit the wrong owner after device relinking. Older history without that
attribution is omitted from the desktop projection.

The client merges history/live by exact canonical ID, including duplicate rows within a batch.
Distinct IDs with identical text remain distinct. General and Server filter the same records.
Room changes/reconnects remove old server records immediately and reject delayed frames from old
bindings. Server sends are never held in the offline outbox. Standard UUID history pagination,
legacy presence REST panels and global typing events are not used for bridge rooms.

## Verification and remaining acceptance

Local gates cover Haxe observation/session policy, both package targets, normalized SWF structure,
BA2 entry metadata/decoded-byte equality, backend lease/authorization/send/delivery tests and the
shared overlay's public-mode and canonical-ID guards. The existing `gamemod-anchors` CI job now
compiles and validates both background variants; the backend Jest and dashboard Vitest jobs
include the new suites automatically. Local tests do not constitute a hosted CI run.

Before distribution: deploy the matching backend/renderer to the selected environment, then
validate clean linking, two accounts on the same world, different-world isolation, intentional
repeated text, live/history overlap, map-driven roster changes, world hops, MainMenu/loading,
mod reload, network loss, expired codes, revoked linking, blocked senders, multiple devices and
coexistence with other HUDModLoader children under **both ZFE and xScal**. No game install or
live runtime test has been performed for this candidate.
