# Blue FCM nameplates — testing candidate

HUD **2.10.138** and Server Bridge **0.2.10** can tint an existing overhead player
name blue (`#167FAF`) when that player has fresh FCM presence in the viewer's
confirmed canonical Server room. This is a testing candidate for the next update;
native game acceptance and public publication are pending.

The renderer is shared by both optional HUDModLoader children. It uses the
installed HUD's public `TeammateMarkerBase.TeamNameplates`, `Name_tf` and
`entityID` properties, together with ready, non-test `TeamMarkers` HUD data.
It does not distribute a replacement HUDMenu, TeammateNameplate class, game font
or any original Text Chat asset. It changes only the existing name field's color.
Vanilla visibility, distance, titles, icons and hostile/wanted colors remain
authoritative. A recycled label must match its current marker before it is tinted.

The native renderer restores its last observed vanilla color when disabled,
expired, unloaded or excluded by a marker change, then marks the plate dirty for
the game's redraw. Frame ordering and performance must still be tested in GFx;
Ruffle passing does not establish native stability.

## Presence and authentication

The backend intersects the viewer's observed player names with fresh, authenticated
FCM peers already assigned to the **same canonical room** by the existing room
coordinator. Both public account handles and roster-derived self-name aliases
can match. Names are cosmetic evidence; they never authenticate accounts, grant
room authority or merge worlds. Nonusers remain their normal color. Discovery can
take longer when mutual roster evidence is missing.

HUD clients use their existing linked native identity and confirmed world request.
The Server Bridge keeps desktop sign-in and Server chat on the existing scoped
export path. Its optional native connection is only a cosmetic receiver: it sends
no roster/world controls or ordinary chat. A native transport token does not need
to be linked. The backend accepts a bridge request only when its exact movie
session and world generation belong to a fresh authenticated desktop observation,
the original connection owner is still current and its session still exists.
Another device's account-wide/native link cannot substitute for that observation.

Clients request at most once per five seconds. Replies are private system events,
addressed to that native subscriber only; they never enter history, community
feeds, Discord or public APIs. Responses contain at most 24 normalized names,
the request ID, context and a lease of at most ten seconds. Leases start at client
request submission, so delay or replay cannot extend them. World changes discard
old requests immediately. Server-side freshness remains bounded by the original
30-second roster/desktop observation deadline; transport heartbeats cannot refresh
it. A remote peer that stops producing observations can remain blue until that
deadline, while the viewer clears locally on its own world/session loss.

Reserved relay request bodies are `FCMCTL/1/NAMEPLATES;` followed by strict JSON:

```json
{"mode":"hud","requestId":"req-1","nativeRequestId":"world-1"}
{"mode":"bridge","requestId":"req-1","sessionId":"movie-1","worldGeneration":"world-1"}
```

The private `chat.message` has `channel:system`, `senderUserId:system` and a body
beginning `FCMNAMEPLATES/1;`:

```json
{"version":1,"requestId":"req-1","context":"bridge:movie-1/world-1","ttlMs":10000,"names":["peer"]}
```

Invalid contexts, replaced owners, logout, bans, stale evidence and mismatched
canonical rooms yield an empty, zero-duration response. Requests have an independent
four-per-ten-second limit and cannot consume room-control/chat-send budgets.
Normal linked-account chat and moderation gates remain enforced.

## Configuration and testing

HUD users can set `blueNameplates=false` in `Data/FCMChat.ini`; the default is true.
Existing configs without the key inherit that default. The bridge's Server export
continues to work without native chat. To enable its blue-name receiver, install
the package's **FCMServerBridge** ZFE TextChat fragment, or merge its xScal
`[Chat] enabled=true` and matching `relayEndpoint` settings. Choose exactly one
provider and one FCM child. There is no bridge editor, hotkey or linking screen.
ZFE must advertise asynchronous connect, send and control; older providers leave
the cosmetic receiver unavailable without blocking exports.
The contracts come from the provider's [ZFE Chat Relay Guide](https://www.nexusmods.com/fallout76/articles/256)
and [xScal](https://www.nexusmods.com/fallout76/mods/4183).

The default desktop overlay still reads only its bounded, explicitly installed
provider export files. It gains no game-file writes, direct native/game access,
injection or network scanning.

Use the [candidate test matrix](../../testing/blue-nameplates-2026-10-06.md) with
two separate signed-in accounts in one world. The matching backend must be deployed
to the chosen environment before the ZIPs can show blue names. Test packages are
kept separate from production release artifacts and the golden QA overlay lock.
