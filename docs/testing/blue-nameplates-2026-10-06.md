# Blue nameplates — 2026-10-06 testing candidate

Versions: DEV QA overlay **1.4.3**, HUD **2.10.138**, Server Bridge **0.2.10**. Public release and native
acceptance are pending. These builds also retain HUD 2.10.137's bare channel
navigation and sends that preserve the selected tab, plus bridge 0.2.9's xScal
unchanged-export write coalescing.

## In-game setup

Install the separate **Fallout Chat Mod QA 1.4.3** application and sign in through
the DEV QA Discord flow. The QA role is required. The matching backend is deployed
at `dev.falloutchatmod.com`; these packages use DEV exports and credentials.
The Windows QA installer, portable executable, Linux AppImage and `.deb` use a
separate QA identity. The installer updates only QA; stable settings remain in
their existing profile.

For existing game configs, merge the DEV endpoint explicitly instead of blindly
skipping an existing production INI: xScal `[Chat]`
`relayEndpoint=wss://dev.falloutchatmod.com/relay`, or the selected ZFE fragment's
`[TextChat] Endpoint=wss://dev.falloutchatmod.com/relay`. A ZFE global override
must match too. For the HUD, use the DEV `linkUrl` in the packaged `FCMChat.ini`
and link to the DEV account; retain your other keybinds and appearance settings.
For the bridge, enable its optional native cosmetic fragment/settings from
`INSTALL.txt`; desktop QA authentication continues to own Server membership.

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

The complete standard GitHub Ruffle gate passed **91/91 scenarios** (9.0 minutes)
on [run 37553620842](https://github.com/UNN-Devotek/FCM-Fallout-Chat-Mod/actions/runs/37553620842),
including both providers' HUD and isolated packaged-bridge blue-name scenarios.
The same run passed backend Jest (**130 suites, 1,668 tests; 9 skipped**), backend
TypeScript units (**445**), overlay Vitest (**1,303**) and dashboard Vitest (**490**).
All 27 pure HUD Haxe suites, both bridge suites, native adapter/auth checks,
SWF/BA2/package/emoji checks and the source/artifact manifest passed locally.
A legacy release-contract assertion expected only Default/Portable smoke targets;
it was updated for QA, and `Packaging/test-release-scripts.py` passed. The final
candidate push runs the complete required CI pipeline with that corrected guard.

The local Ruffle attempt was interrupted after two input setup-marker timeouts
and 65 passes; it is not claimed as complete regression evidence. The standard
hosted suite above completed without those failures on the same HUD inputs.
Native GFx acceptance remains pending.

Windows QA [run 37553658167](https://github.com/UNN-Devotek/FCM-Fallout-Chat-Mod/actions/runs/37553658167)
built the installer and portable EXE, verified embedded QA identity/version and
passed native `Packaging/smoke-test.ps1 -Artifact QA` before upload. Linux AppImage
and Debian package metadata identify QA 1.4.3; the packaged Linux executable passed
an isolated startup smoke. QA identity/build-file/smoke contracts passed locally
(61 tests). The Debian package name is `fallout-chatmod-qa`.

## Hosted DEV and build lock

The deployed backend image is
`sha256:e78fb80ff6bd6be34545a41a4a513c150d409b54c5de51b0655e3c251764b773`,
built from committed backend/dashboard source `d5cf21a9`. Subsequent QA identity
and smoke corrections do not change that source. External health reports connected
DB/Redis/Discord, the private native relay handshake succeeds, and a live cosmetic
control delivered only its subscriber's correlated zero-lease response for missing
desktop evidence. Two temporary unlinked test credentials were removed afterward.
Dev storage/tunnel containers and customized Compose remained unchanged; rollback
and staging details are in [the deployment runbook](../deployment/hosted-dev-environment.md).

`QA_BUILD_LOCK=true` and the active golden version is **1.4.3**. External QA polling
with `x-client-version: 1.4.3` returned HTTP 200; retired 1.4.0 returned HTTP 426.
This is DEV-only QA distribution. No production release record or Nexus publication
was created. The next public update requires the native matrix above.

## Download artifacts

Each package below is accompanied by `TESTING.txt`, `BUILD.json` and `SHA256SUMS.txt`
under the DEV QA download directory. The local staging directory is
`cross-platform-overlay/dist-electron/QA-1.4.3-DEV/`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| [FCMChatWidget-2.10.138-blue-nameplates-DEV-test.zip](https://dev.falloutchatmod.com/downloads/qa/1.4.3/FCMChatWidget-2.10.138-blue-nameplates-DEV-test.zip) | 12010145 | `c0038c28069cca80cb1b1a0135d896484587729e7789795b9b2c67e6a6cec5c0` |
| [FCMServerBridge-0.2.10-blue-nameplates-DEV-test.zip](https://dev.falloutchatmod.com/downloads/qa/1.4.3/FCMServerBridge-0.2.10-blue-nameplates-DEV-test.zip) | 40868 | `6941481dc3b51ae77f40fbe924558c07197bc620cdf8b88d048bb964bb235d05` |
| [Fallout Chat Mod QA 1.4.3.exe](https://dev.falloutchatmod.com/downloads/qa/1.4.3/Fallout%20Chat%20Mod%20QA%201.4.3.exe) | 95017045 | `261bdc68c5b3baf53b694d722b2f6346cc7004da1b6116819c89fd8a5c61e7b9` |
| [Fallout Chat Mod QA Setup 1.4.3.exe](https://dev.falloutchatmod.com/downloads/qa/1.4.3/Fallout%20Chat%20Mod%20QA%20Setup%201.4.3.exe) | 95285766 | `f5f7b895a0b1bc5bd7a49c9ad565fb31a3e2e544b8df55e5f3eea78492fa15eb` |
| [Fallout Chat Mod QA-1.4.3.AppImage](https://dev.falloutchatmod.com/downloads/qa/1.4.3/Fallout%20Chat%20Mod%20QA-1.4.3.AppImage) | 138116952 | `06d3daf1b1b95f397f130371776a363a586849d4b1a849f65bd89ad726f242fa` |
| [Fallout Chat Mod QA-1.4.3.deb](https://dev.falloutchatmod.com/downloads/qa/1.4.3/Fallout%20Chat%20Mod%20QA-1.4.3.deb) | 103528700 | `72d49f90ebb712dc26d9901d2191101b7b3680a792c8e6dcefabc4e886d0261b` |

The HUD SWF SHA-256 is `e738156f2233a03a09199314cd81f4bb119be06e53290ecae073292967f20838`;
its BA2 is `73e3a1aab3eca79c90184ab691869cb8292916644f3449a786958cfad5585b5a`.
The bridge DEV SWF is `a48da8b225411cc1c81bcf29471f4e52aa809fac212f4ef1d0a35c4cc9f0172c`;
its BA2 is `4325a21ed4c017d5321da653d04af4a23c2b293983f9bcc2f38b7a97cc91c26f`.
