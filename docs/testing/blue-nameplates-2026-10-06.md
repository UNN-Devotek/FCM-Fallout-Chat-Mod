# Blue nameplates — 2026-10-06 testing candidate

Versions: HUD **2.10.138**, Server Bridge **0.2.10**. Public release and native
acceptance are pending. These builds also retain HUD 2.10.137's bare channel
navigation and sends that preserve the selected tab, plus bridge 0.2.9's xScal
unchanged-export write coalescing.

## In-game setup

Use two separate FCM accounts in the same public world and the same backend
environment. Use the HUD on one client and the desktop overlay plus Server Bridge
on the other. **Never load both FCM BA2s on one client.** Keep HUDModLoader and
unrelated mods installed; back up the active archive list, loader registry and
provider config before replacing only the FCM files. Follow each ZIP's INSTALL.txt.
HUD accounts use their existing native link. Bridge users sign into the desktop
overlay only and enable the package's optional native cosmetic receiver.

1. Let Server become available on both clients, stand where vanilla overhead names
   are visible, and check that the other FCM user's name turns blue on both screens.
   An ordinary nearby player without FCM should keep the normal color.
2. Send one Server message each way. Confirm exactly one copy and common history;
   the blue-name controls should never appear as chat messages. Check that General,
   channel shortcuts, typing, key rebinding and Discord/community chat still work.
3. Check team/event teammates, a friendly nonteammate, player titles, distance/LOS
   hiding and recycled labels after someone leaves and another player approaches.
   Hostile/wanted players should retain game colors. No label should be made visible
   by the mod.
4. Fast travel within the world, open/close the map and Pip-Boy, then hop to another
   world. Blue from the old world must clear; fresh, confirmed peers can become blue
   in the new world. Main menu and game exit must stop the local renderer.
5. Sign the bridge desktop out or stop its game observations. The remote color must
   disappear by the 30-second observation deadline. Interrupt connectivity and check
   that colors expire, then recover without duplicates or a second bridge login.
6. Set HUD `blueNameplates=false`, restart with the game closed, and verify normal
   colors. For the bridge, omit its native fragment/disable native chat while keeping
   scoped storage and desktop sign-in: Server should still work with normal names.
7. Play for ten minutes and watch for flicker, stutter, UI errors and unrelated HUD
   damage. Reload/remove the child with the supported loader lifecycle and verify
   that old timers/subscriptions cannot recolor names or write exports.

## Compatibility matrix

| Client A | Client B | Native result |
| --- | --- | --- |
| HUD/ZFE | Bridge/ZFE | Pending |
| HUD/ZFE | Bridge/xScal | Pending |
| HUD/xScal | Bridge/ZFE | Pending |
| HUD/xScal | Bridge/xScal | Pending |
| HUD | HUD (both providers, including mixed) | Pending |
| Bridge | Bridge (both providers, including mixed) | Pending |

Record provider versions, operating system, account/roster-name mismatch outcome,
time to room discovery, blue appearance/expiry, bidirectional delivery/history,
travel/hop isolation and frame stability. Use fixed diagnostics and numeric error
IDs; do not share tokens, roster JSON or private account identifiers.

## Automated evidence

The CI backend Jest gate includes `nameplatePresence.test.js` and relay privacy/rate
tests. The existing `gamemod-anchors` gate runs `test-nameplates.hxml`, config and
native capability tests; `hud-ruffle` runs both provider HUD scenarios and isolated
packaged-bridge scenarios. Backend fixtures exercise all sixteen directed pairings
between HUD/ZFE, HUD/xScal, bridge/ZFE and bridge/xScal, with canonical-room isolation.
Native GFx frame ordering, provider permission forwarding, texture/font behavior,
real room discovery and performance remain game-only acceptance items.

Final gate counts and artifact hashes are recorded after the final regression run.
