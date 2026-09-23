# Historical native-network bridge (0.1.x)

Superseded by [the drop-in local-export bridge](../../../overlay/zfe/background-server-bridge.md).
The following is retained evidence, **not current installation/authentication guidance**.

# Background Server bridge for the desktop overlay

**Current candidate: FCMServerBridge 0.1.7 DEV; bounded desktop ZFE acceptance passed, not published.**
The user confirmed one Server-message echo and retained history through same-world fast travel;
fresh ZFE logs retain authentication and room binding throughout that travel. This is not full
two-provider/two-machine acceptance. The desktop is now switched to xScal 0.2.16 for its next
manual test; the Windows laptop has the same bridge with ZFE 0.15.0, awaiting native acceptance.
The visible widget was backed up and removed on 2026-09-16. An isolated packaged Dev overlay
1.4.0 was rebuilt and launched against `dev.falloutchatmod.com`; Prod was not modified.
See the [installation record](../../../testing/hud-xscal-acceptance-2026-09-15.md#017-local-install-and-dev-overlay-launch).
See the [bounded native result and provider switch](../../../testing/hud-xscal-acceptance-2026-09-15.md#017-desktop-zfe-acceptance-and-next-provider-setup).
It adapts the split roster reader proven by the visible HUD 2.10.106–2.10.109: the existing
map/public-team helper plus separate bounded auxiliary traversal. Copied signatures and
timestamps replace retained native payload identities; unchanged getter wrappers cannot renew
freshness. All provider/world/relay-confirmation and lease gates remain. Auth is already rechecked
on every bridge poll; the HUD's separate pending-auth and history-resync fixes are not applicable.
See the [candidate contract](../../../../game-mods/FCMBridge/hudmodloader-bridge/README.md#restored-reader-candidate-017).

**Previous installed candidate: FCMServerBridge 0.1.6 DEV; native roster acceptance failed.**
The fresh screenshot shows `payload E1014` on Voice/Party/Public Teams/Map, `test provider` on
Team Markers/Player List, eight subscriptions, world allowed and no observed roster.
`Missing class - not reported` still supplies no class identifier. See the
[0.1.6 native evidence](../../../testing/hud-xscal-acceptance-2026-09-15.md#016-native-result--payload-boundary-still-failing).

0.1.6 retained its unified native-data decoder and passed copied observations to session policy.
HUD 2.10.104 left that shared class but still failed native acceptance. HUD 2.10.105's synthetic
probe then confirmed method-entry failure, and restoring the older reader in 2.10.106 recovered
native roster reads. The exact rejected bytecode construct is still unknown; those visible-HUD
results do not certify the bridge. The 0.1.7 adaptation changes neither its outbound path nor any
authorization/lease limit. The [isolated package gate](../../../testing/hud-automation-plan.md#isolated-packaged-bridge-gate)
tests the exact compiled child without production helpers in its host. It does not emulate native
GFx or establish that E1014/the earlier freeze is fixed.

Historical 0.1.6 local gate: 33 Ruffle tests, reader/state/package checks and backend/desktop suites pass.
The installed failing 0.1.5 artifact also passes the new isolated lifecycle tests, so native
acceptance remains essential. Exact candidate hashes and test limits are in the
[verification record](../../../testing/hud-xscal-acceptance-2026-09-15.md#final-local-verification-and-native-failure-control).

**Previous diagnostic candidate: FCMServerBridge 0.1.5, 2026-09-16; native acceptance failed.** The user revised the loader requirement:
this separate, invisible mod **uses HUDModLoader**. It has no chat widget or chat editor.
The matching backend and shared desktop renderer are implemented in this checkout. A fresh DEV
0.1.5 ZIP was installed locally with xScal 0.2.16, paired with a rebuilt isolated Dev overlay 1.4.0.
**First native acceptance (0.1.1) failed:** the user saw “Waiting for a fresh world roster,” pressed
Reconnect, and reported a freeze. The exact new Dev overlay was stopped for isolation; the
game and Prod were left untouched. The stalled operation is unproven. See the
[dated failure/evidence record](../../../testing/hud-xscal-acceptance-2026-09-15.md#first-native-bridge-run--failed-acceptance-investigation-open).
Do not distribute this candidate. Hosted bridge-protocol acceptance, hosted CI and two-client
in-game validation under ZFE and xScal remain pending.

**Follow-up: the 0.1.3 run failed native roster acceptance; 0.1.4 diagnostics are now installed.** The 0.1.2 run reached
“Waiting for a fresh world roster” and stayed there after opening/closing the map. A read-only
Dev check found no active roster/world keys or background leases. The exact rejected native
data gate is unproven. The user's 0.1.3 screenshot shows `Menu - world allowed`, `Roster - not
observed` and all six roster sources reporting `read failed`. That catch surrounds both getter
and processing, so the failed operation is still unknown. Installed 0.1.4 separates their phases,
retains only numeric exception IDs and reports subscription count/errors in the cached F11 menu.
It does not relax readiness, extend leases or claim to resolve the native failure. See the
[exception diagnostics guide](../../../../game-mods/FCMBridge/hudmodloader-bridge/README.md#native-exception-diagnostics-014).

**Previous native result:** 0.1.4 registered eight subscriptions but every roster path reports
`processor entry E1014`, while the world menu is allowed. The runtime's missing-class identifier
is unknown. Installed 0.1.5 adds a narrowly parsed `Missing class` row; the user's fresh screenshot
reports `not reported`, not an identifier. See the [class diagnostic contract](../../../../game-mods/FCMBridge/hudmodloader-bridge/README.md#e1014-class-identifier-015).

0.1.2 consumes validated subscription envelopes even when getters lag, retains the push timestamp
instead of renewing stale evidence, queues/coalesces menu refreshes without disconnecting a healthy
transport, guards timer reentry and capability-gates ZFE controls. It adds bounded native phase/status
diagnostics. Both accessor-backed Ruffle provider scenarios pass; this does not prove the native
freeze resolved. See the [source/readiness/reconnect contract](../../../../game-mods/FCMBridge/hudmodloader-bridge/README.md#provider-events-and-reconnect-safety-012).

## Install and build

Source and commands: [background mod README](../../../../game-mods/FCMBridge/hudmodloader-bridge/README.md).
The package contains `Data/FCMServerBridge.ba2`, an append-only loader snippet, archive-list
example, provider configuration examples, `INSTALL.txt` and `BUILD.json`. Its one archive entry
is `Interface/FCMServerBridge.swf`. It does not include or patch HUDMenu, HUDModLoader, the
visible FCMChatWidget, native executables or installers.

For end-user steps, start with `INSTALL.txt` in the downloaded ZIP. It is generated from the
[installation guide template](../../../../game-mods/FCMBridge/hudmodloader-bridge/INSTALL.template.txt)
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

MainMenu, manager replacement and a disjoint effective roster invalidate the room nonce and
clear prior snapshots. A brief `LoadingMenu` preserves an already-observed world's nonce, but
cannot establish a world on startup. Roster reads/pushes during loading do not refresh evidence
or renew the backend lease. If observations reach their existing 30-second limit, the bridge
retires the room instead of extending the loading hold indefinitely.

The complete provider batch is evaluated before any roster-boundary control. Fresh `MapMenuData`
takes precedence, then `PlayerListData` and `PublicTeamsData`, with an auxiliary union only if
none is available. An empty higher-priority list permits a populated fallback only when it
overlaps the previous established roster. This fixes the native xScal same-world sequence where
the map remains empty after loading but public teams remain populated. Disjoint cached fallback
names cannot bypass the empty-primary hold, and a populated map still wins on a genuine hop.
An empty/disjoint nearby or team list cannot override a stable primary roster. A temporarily
empty primary after a nonempty roster gets a bounded 30-second recovery window; repeated empty
updates do not restart it. During the hold, neither LEAVE nor roster heartbeat is sent. Returning
same/overlapping names preserve the binding. Disjoint names or an expired empty window retire
the old nonce before rebinding, retaining only the selected new-world evidence.
Cached old-world providers cannot seed the replacement session until they change or emit a fresh
update. Observations expire after 30 seconds without a valid refresh.
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
Distinct IDs with identical text remain distinct. General and Server filter the same canonical
records, but their history windows intentionally differ: Server exposes the complete retained
room replay, while General admits replay rows only within its loaded static-feed time horizon and
slots those rows by their original timestamp. This prevents a prior room's older backlog from
appearing as a new burst in General without copying or discarding the Server history.
Room changes/reconnects remove old server records immediately and reject delayed frames from old
bindings. Server sends are never held in the offline outbox. Standard UUID history pagination,
legacy presence REST panels and global typing events are not used for bridge rooms.

## Verification and remaining acceptance

Local gates cover Haxe observation/session policy, both package targets, normalized SWF structure,
BA2 entry metadata/decoded-byte equality, backend lease/authorization/send/delivery tests and the
shared overlay's public-mode and canonical-ID guards. The existing `gamemod-anchors` CI job now
compiles and validates both background variants; the backend Jest and dashboard Vitest jobs
include the new suites automatically. Local tests do not constitute a hosted CI run.

The shared `hud-ruffle` gate also runs `bridge-fast-travel` with both ZFE and xScal. It creates
the actual invisible bridge with ready UI-provider envelopes, asserts the actual native adapter,
and checks same-world nonce/room preservation without extra controls, three repeated
map-recovery/loading/empty-map cycles with explicit overlapping PublicTeamsData selection,
a disjoint primary despite
stale auxiliary data, prolonged-loading expiry, MainMenu leave, and owned timer/subscription
teardown. It does not create the visible widget or send live messages. Pure state tests cover
exact 30-second boundaries, primary-empty recovery, overlapping/reordered lists, startup loading,
and rejection of test/unready/stale providers. The package gate excludes harness driver symbols
and validates both target variants against the exact decoded BA2 payload.

Local 0.1.1 verification (2026-09-15): 33 pure bridge-state checks, both target package tests,
empty Haxe compiler diagnostics, shared native/HUD/source/archive checks, and all 28 Ruffle
tests passed (39.5 seconds). The harness port was released after teardown. The Dev archive has
one 39,495-byte FWS v32 child; decoded payload equality passed. BA2 SHA-256:
`e336ab759260b5840c67cf697a5bcd5e5d73ffb66d4b97166ff01aec77e46e53`.
Nothing was installed, deployed, committed, or published by this verification.

The subsequent empty-map/public-team correction passed 34 pure bridge checks and all 28 shared
Ruffle tests (40.4 seconds). The original package hash above predates this correction and is
**superseded**. After adding repeated-cycle regression assertions, all 28 Ruffle tests passed
again (36.2 seconds); 34 pure bridge checks, both package targets, native/HUD/emoji/source checks,
empty compiler diagnostics, 1,148 overlay tests, 41 backend bridge tests and six dashboard
bridge-feed tests also passed locally. The harness released port 41739.

A fresh 0.1.1 DEV package was then built and installed with the game closed. Its sole decoded
SWF is 39,856 bytes, FWS v32, and matches `BUILD.json`; the installed BA2 hash is
`f8f76272c0a18e4b6631fbce29ec61fb5981579d58d6c1b5c1b37ba2569c8515`, and the SWF hash is
`ae6ba54c1c6d0d1d6f032dfac68a032b8665b86b3ca4aa1a06f642b07a40fba4`.
Only the FCMChatWidget entries in the loader/archive lists were replaced with FCMServerBridge.
The visible widget remains intact but inactive; prior registry/archive configuration and widget
are recoverable under `.extender-backups/before-bridge-0.1.1-VNj1Bt/` in the game directory.
xScal settings/native authentication were not changed. See the
[dated acceptance record](../../../testing/hud-xscal-acceptance-2026-09-15.md#background-bridge-phase--installed-awaiting-manual-game-test)
for the isolated Dev overlay install, same-account login and the next manual checks.

Before distribution: deploy the matching backend/renderer to the selected environment, then
validate clean linking, two accounts on the same world, different-world isolation, intentional
repeated text, live/history overlap, map-driven roster changes, world hops, MainMenu/loading,
mod reload, network loss, expired codes, revoked linking, blocked senders, multiple devices and
coexistence with other HUDModLoader children under **both ZFE and xScal**. Local installation is
complete, but it is not native acceptance or evidence of a hosted bridge lease.
