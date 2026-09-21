# Drop-in Server bridge: one room across HUD and overlay

Current packaged candidate: **FCMServerBridge 0.2.6**, native-unverified and not installed.
0.2.6 is fully input-silent: it registers no SharedHUDTools instance, loader menu, hotkey,
editor, or `HUDMod::UserEvent` listener. Provider/export status remains available through the
scoped export and privacy-safe provider logs. Mixed ZFE/xScal installs fail closed.
The PROD candidate BA2 SHA-256 is
`6a2bdb18ee53fc5be3c69a7842d246dca665bdb55cabfacd2844a100bcff9495`; its package and complete
Ruffle provider matrix pass. This is automated evidence only, not native acceptance.
The earlier laptop 0.2.3 native ZFE export recovery was verified on 2026-09-17; that evidence
does not accept the rebuilt 0.2.6 artifact. Provider discovery is now strictly read-only:
the bridge never creates or repairs xScal's provider-owned `__SFCodeObj` callback surface.
0.2.4 selects a fresh local-player name from the same accepted roster source for exported
`ownName`, falling back to `AccountInfoData`. This changes grouping evidence only; overlay
authentication and account attribution remain authoritative. Full mixed-client
room/message/travel acceptance remains pending.
The 0.2.2 laptop screenshot showed `__SFCodeObj parse E1014` with a fresh roster.
0.2.3 uses the unchanged visible HUD's bounded `FcmJson` reader for both runtime-info
and write acknowledgements. `success:true`, the storage capability and `status:saved`
remain required at their respective boundaries; malformed/oversized replies fail closed.
No visible HUD, roster or authentication architecture changes are needed for this correction.
The laptop 0.2.1 attempt still reported provider pending and no confirmed storage route.
0.2.6 reports discovery, native-call, JSON-parse, capability, and lifecycle failures only through
the scoped export and privacy-safe provider logs. These contain fixed reasons and numeric error
IDs only; no raw payloads or extra native calls. Keep all
capability/readiness checks and the existing visible-HUD architecture unchanged.
Desktop/xScal remains on 0.2.0 while the ZFE fallback is tested.
See [checks, deployment and installed hashes](../../testing/bridge-drop-in-acceptance-2026-09-16.md).
Native acceptance must be recorded separately. Historical
0.1.x native-network/link-code behavior is [archived](background-server-bridge-native-history.md);
its successful runs do not accept this new storage path.

## Install and authentication

See the [overlay channel customization and bridge safety review](../subtab-customization-and-bridge-review.md)
for the current local review, residual roster trust limitation, and pending native
performance acceptance. Channel visibility/default controls affect only the overlay.

Install the bridge BA2 through normal HUDModLoader archive/registry configuration,
then sign into the matching desktop overlay only. No bridge login, linking code,
pairing operation, helper process or extra service. Follow the package
[INSTALL template](../../../game-mods/FCMBridge/hudmodloader-bridge/INSTALL.template.txt).
Never coinstall the visible widget, legacy FCMBridge and background bridge.

ZFE requires `zfe-storage-v1`; xScal requires its runtime marker and callable
named `modStorage.load(name)` / `save(name, document)` on xScal 0.2.17 or newer,
with the registered `modStorage` contract retained only for older xScal builds.
Named storage allows the bridge and another HUDModLoader child such as Improved
HUD to keep independent JSON documents. The bridge writes only
`fcmserverbridge-dev` or `fcmserverbridge-prod` and never calls `register()` on
0.2.17+. The visible FCM HUD does not use modStorage at all. Neither bridge adapter connects to native chat or
consumes its event queue. The visible HUD retains existing native authentication.
For ZFE, a DLL-only installation is normal. The bridge does not use or require
`falloutchatmod.ini`, a TextChat fragment, a relay endpoint, or `zfe.ini`; do not create those
files for the bridge. Install exactly one provider.
0.2.1 also checks ZFE's legacy `BRG_OBJ.call` fallback, after the modern aliases,
on the scope/parents/movie root/global. It must positively advertise `zfe-storage-v1`;
missing, malformed, failed or throwing probes never enable writes. This restores
discovery compatibility with the existing HUD without reusing its chat/auth APIs.
The privacy-safe storage diagnostic identifies the confirmed alias; it is not evidence
of a successful write or backend room confirmation by itself.

The optional mod is explicit opt-in. The overlay never installs it, edits game files,
reads game memory, injects code or scans ports. It reads only bounded provider export
files for the locally detected game. Without an installed bridge, normal overlay
chat remains independent of extenders.

## Shared room contract

Peer departure preserves the survivor's canonical room and history while its
roster session remains live and unsplit. See [room continuity](../../realtime/server-room-continuity.md)
for generation, expiry and split boundaries.

Native HUD ROSTER controls and authenticated desktop `bridge:observe` enter one
room coordinator and the same `worldRosterService`. Provider and UI type are not
room namespaces. Account and roster-visible self names are normalized identically for
roster evidence; neither authenticates an account or changes message attribution.

Mutual roster sightings establish a shared canonical `r:` room. No authoritative
Fallout world ID is available. One-sided/missing sightings can leave players in
separate rooms until evidence converges. Never merge without evidence to hide this
limitation. The existing matching algorithm can re-root rooms as components merge;
pre-discovery solo-room history is not migrated.

Both transports use the same room history and `serverMessageService`: moderation,
account attribution, publication and canonical `server:<room>:<sequence>` IDs.
History/live/self-echo merge by ID, not message text. General is a view of canonical
Server rows, not another publication destination. Server messages do not enter
static General or Discord. When a previously visited room restores retained history,
the Server subtab keeps the complete replay. General includes only replay rows whose
original timestamps fall inside the static feed history currently loaded there, in
timestamp order, so an older room backlog does not replace the current General view.

## Local export contract

| Provider | Exact primary export |
| --- | --- |
| ZFE | `Data/ZFE/Storage/FCMServerBridge/{dev|prod}-state.json` |
| xScal | `Data/modsdata/fcmserverbridge-{dev|prod}.json` |

ZFE's documented `Documents/My Games/Fallout 76/ZFE/Storage` and
`LocalAppData/ZFE/Storage` fallback roots are also supported (note the space in `Fallout 76`).
Dev/Prod is compiled into the SWF and validated by the desktop and backend.
See maintainer contracts: [ZFE scoped storage](https://www.nexusmods.com/fallout76/articles/254),
[xScal modStorage](https://www.nexusmods.com/fallout76/articles/262),
[xScal runtime marker](https://www.nexusmods.com/fallout76/articles/259).

Schema 1 exports:

- `environment`, `provider`, `build`, `sessionId`, `worldGeneration`.
- Monotonic `sequence` for writes, `observationSequence` for fresh roster evidence.
- `state`: active / holding / inactive; `observationAgeMs`.
- `ownName` from the fresh selected roster source when available, otherwise AccountInfo,
  plus at most 24 roster `names`; each is at most 64 characters.

Maximum UTF-8 document: 8 KiB. No tokens, linking codes, account authentication,
room selection or credentials. Storage namespaces are organization, not security;
treat the file as untrusted input.

Changed snapshots write at most once per second; unchanged state has a five-second
heartbeat. Heartbeats increase sequence, never observation freshness. Holding
pins the last active roster/age and cannot activate a new binding. Thirty-second
observation expiry remains; startup loading cannot invent a world. Existing
split roster decoding, ready/live provenance, source precedence, fast-travel
overlap and old-world cache rejection remain.

The desktop reads asynchronously with bounded size/schema checks. A transient missing, partial or
invalid read during the provider's atomic file replacement retains only the last already-validated
sample until its existing twelve-second writer deadline and thirty-second evidence deadline; it
does not advance either clock. Persistent corruption therefore still expires and leaves normally.
A preexisting
file cannot activate Server: require advancement after attachment, fresh evidence
and a current authenticated/game lifetime. Logout, account change, exit, hop,
missing advancement or expiry retire stale authority. Never copy native credentials
into the overlay or borrow another device's account-wide lease.
Reads run at most once per second without overlap. Discovery retries every ten seconds only
until it finds a non-empty bounded candidate set; those exact paths are pinned for the current
authenticated game/watcher lifetime. Game exit, authentication/socket replacement, or overlay
restart creates a new watcher and therefore performs fresh discovery. This avoids repeatedly
launching the Windows process-metadata query during play while retaining game-before-overlay
startup recovery. An independent watchdog revokes a writer that stops advancing for twelve
seconds, including while discovery or a read stalls. Only known Steam manifests/process
locations and exact provider paths are inspected; no recursive filesystem or network scanning.

## Authenticated transport

| Frame | Direction | Role |
| --- | --- | --- |
| `bridge:watch` with `mode: local-export` | desktop → backend | Select session-specific authority; no legacy fallback |
| `bridge:observe` | desktop → backend | Validated schema-1 observation; no chosen room |
| `bridge:leave` | desktop → backend | Clear this connection's observation |
| `bridge:state` | backend → desktop | Confirm ready/inactive; ready includes canonical channel/binding and snapshot correlation |
| `bridge:history`, `bridge:message` | backend → desktop | Same binding plus canonical records |
| `chat:send` | desktop → backend | Existing send; Server requires current `bridgeBindingId` |

The backend derives the actor from the authenticated session and checks current
socket ownership, environment, generation, sequence and freshness. Another device,
stale confirmation, browser/public observer or client-selected room cannot grant
access. Same-observation heartbeats cannot extend the original expiry. Serialized
history/live delivery revalidates membership; peer recomputation cannot renew an
absent observer. Existing native HUD controls and confirmations remain compatible.

The shared ChatOverlay displays Server only after backend confirmation. Party is
independent: transient/auth/network errors must not permanently hide its tab;
confirmed feature-disabled responses remain distinct.

## Verification and rollout

Required [change-to-install flow](../../testing/hud-automation-plan.md):

1. Haxe state/export/provider checks, source/package checks, complete Ruffle suite.
2. Backend native/local-export integration plus overlay/dashboard suites.
3. Compatible backend to hosted Dev first; no production deployment.
4. Isolated Windows/Linux Dev overlays and matching bridge, game closed, exact
   recoverable backups, installed BA2/SWF equality with tested manifest.
5. Manual two-client native acceptance; no game input automation.

Mandatory pairings (repeat with two distinct accounts):

| HUD client | Bridge + overlay |
| --- | --- |
| ZFE | ZFE |
| ZFE | xScal |
| xScal | ZFE |
| xScal | xScal |

Each must establish equal canonical IDs, bidirectional exactly-once delivery and
common retained history. Retain HUD↔HUD and bridge↔bridge coverage. Also test
different worlds, missing/one-sided sightings, delayed discovery, repeated fast
travel, true hop, expiry, stale confirmations, malformed/oversized/stale exports,
storage failures, both startup orders, auth changes and teardown.

Ruffle checks the actual packaged SWF in an isolated domain; it does not prove
native disk timing, GFx verification, game stability or world identity. Current
native target: Steam Windows and Linux/Proton. Game Pass remains unverified.
Record native write durations/heartbeat timing without exporting names or tokens.
Remove temporary test environments; keep requested Dev clients and backups.
