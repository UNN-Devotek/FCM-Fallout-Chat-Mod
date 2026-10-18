# Blue nameplates — 2026-10-06 testing candidate

Original distributed versions: DEV QA overlay **1.4.3**, HUD **2.10.138**,
Server Bridge **0.2.10**. The desktop and MSI laptop now use the local
**HUD 2.10.150 stationary-retention candidate**, after required local gates passed.
Fresh 147 and 148 native acceptance fails with zero requests and repeated 1014
on both providers. **2.10.149** passed all local gates, including 93/93 Ruffle
cases, and is installed with settings and login preserved. Fresh 149 requests/replies
now progress on both providers without 1014 or paint errors, but native stability
fails with intermittent colors. The source candidate is **2.10.150** / shared bridge
**0.2.18**, separating fresh acquisition from already admitted visible association
continuation. All local gates pass, including 93/93 Ruffle cases, and 150 is
installed with archives/backups and settings/login verified. Native acceptance
and hosted CI are pending; see the
[current policy and evidence](blue-nameplates-2026-10-12-recovery.md).
The preceding **2.10.146** cleanup/renewal candidate exposed a private reply-ordering
gap during review. The new candidate does not extend submission TTLs or marker source age.
The preceding 2.10.145 native logs confirm recurring cleanup errors and
private-lease gaps, as described in the
[2026-10-12 record](blue-nameplates-2026-10-12-recovery.md). The preceding
2.10.142 diagnostic still failed in the fresh native trace. Public release and native
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

Use two separate FCM accounts for the full compatibility matrix, with distinct
Bethesda player identities in the same public world and backend environment.
Two separate HUD credentials may also link to one FCM account: the presence
service excludes the viewer's native identity, not every client linked to that
account. Use the HUD on one client and the desktop overlay plus Server Bridge
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

## Installed test machines — 2026-10-06

[Confirmed] The desktop and MSI laptop initially received the DEV HUD 2.10.138
BA2 listed below, before the 2.10.139 diagnostic installation. Installed payload
SHA-256 values matched the tested package. Both games
were closed for installation; keybinds, appearance settings, other loader
entries and archive lists were preserved. Neither has a loose FCM SWF override.
Each machine has an `INSTALLATION.json` with exact backup paths and file hashes.

| Machine | Game | Provider | Open / hide | Input setting |
| --- | --- | --- | --- | --- |
| Desktop | Steam/Proton 1.7.26.22 | xScal 0.2.20 | Home / Delete | `xscalInputMode=shared` preserved |
| MSI laptop | Steam/Windows 11 1.7.26.22 | ZFE 0.21.1 | Period / Delete | ZFE host editor; xScal setting inactive |

[Confirmed] The laptop initially had runtime 1.7.26.10 during installation.
On its next startup, fresh `Fallout76/zfe.log` lines 3–5 reported runtime
1.7.26.22 and explicitly disabled ZFE 0.15.0 because it expected 1.7.26.10.
The official [ZFE changelog](https://www.nexusmods.com/fallout76/mods/4065)
adds Steam 1.7.26.22 support in 0.21.1. The exact official Nexus package
(mod 4065, file 23830) replaced only `dxgi.dll`; all HUD/config/activation files
were verified unchanged afterward. The provider DLL SHA-256 is
`0314f7b82499169f7ea500ca3b1ce9f0853178d93622683cdccafefa9403262f`;
the source ZIP SHA-256 is
`739cf5b92d1adb938e4678b7718f0a7efc02c3161c0c97ad588ba3837bd9da56`.
The previous DLL, failure log, source ZIP and repair manifest are saved under
`C:\Users\White\Documents\FCM-Repro-Backups\before-zfe-0.21.1-runtime-fix-20261007T030818Z`.
[Confirmed] The next startup at 23:20 EDT (03:20 UTC on October 7) passed
provider discovery. Fresh `zfe.log` lines 11–13 report runtime 1.7.26.22,
`runtime decision=supported Steam Fallout 76 runtime`, and
`ZFE compatibility initialized`. Lines 65–69 confirm HUD 2.10.138 loaded,
`zfe-chat-online-v1 OK`, input/release-barrier readiness and automatic
non-blocking Server-room controls. Lines 72/77 configure Period/VK 190;
line 223 records the physical Period open-key edge. The installed provider
and HUD hashes still match their verified artifacts. The user also reports
that the HUD detects ZFE. The log retains the earlier 23:02 failure; it is
superseded by these timestamped startup records.

This accepts provider startup/discovery only. Typing, gameplay-control
recovery, blue names, Server delivery and the full compatibility matrix
remain pending for this candidate.

### First HUD/xScal ↔ HUD/ZFE color check

[Confirmed] The user reported no blue overhead names while both players were
in the same world and both HUDs were linked to one FCM account. Read-only DEV
session-history diagnostics confirm two distinct linked native identities, one
linked account and one latest canonical-room reference. Both published native
roster observations; their last recorded roster counts were 16 and 23.
The games were closed by the time of the later inspection, so live observation
leases had expired; that empty live state is not evidence of a discovery failure.

[Confirmed] The registered handles are distinct and both are eight characters
long; neither client recorded self-aliases. Both fresh startup logs report an
eight-character AccountInfoData handle, and neither active INI sets a manual
display-name override.

The earlier claim that neither roster matched the peer is **retracted**. The
one-off inspection did not normalize the registered handle before hashing it.
More importantly, DEV has no configured `HUD_IDENTITY_HASH_SECRET`, so
`roomDiagnostics.ts` uses a random process-local HMAC key. A separate Node process
cannot compare a newly computed name fingerprint with the running backend's
retained fingerprints. The zero comparisons do not establish a name mismatch or
an empty private presence reply. Name eligibility and native rendering remain
unresolved; the user's color check remains failed.

### HUD 2.10.139 diagnostic candidate

This candidate adds fixed/count-only `nameplates` log records every ten seconds:
the first request gate, lifetime generated/accepted/rejected counts, pending state,
remaining cosmetic lease, eligible-name count, automatic frame count, and the
painter's marker/plate/painted counts or numeric error. It does not log names,
account IDs, request IDs, contexts or tokens. Counters remain across world resets;
lease and ownership checks are unchanged. No backend change is needed.

The native failure is not fixed or accepted by these diagnostics. The next repro
must load this exact candidate on both providers and remain together with visible
overhead labels long enough to record requests, a private reply and painting.

[Confirmed] Local validation passed: all 27 pure HUD Haxe suites, both native
adapter/auth suites, both bridge suites, compiler diagnostics (`[]` for production
and the harness), source/package/SWF/BA2/emoji checks, and the backend presence
suite (28/28). The complete final Ruffle suite passed **91/91** in 7.3 minutes,
including both providers' request gates, native submit path, private replies,
diagnostic privacy/cadence and teardown. Its server closed port 41739 afterward.
The first complete run passed 90 cases and failed the old literal 2.10.138 smoke
assertion; after updating that assertion, the entire final suite passed. Existing
required CI jobs cover these checks; this candidate has not yet run hosted CI.

[Confirmed] With both games closed, only `Data/FCMChatWidget.ba2` was replaced on
each machine. Provider DLLs, settings, keybinds, loader/archive activation and
the laptop's ZFE fragment were verified unchanged by SHA-256. Both installations
match archive SHA-256
`e625e27a87b22517d34ba40167a37b530cdd30ab600e94686540781dc3014a0c`.
The SWF SHA-256 is
`804b563740c91de490ce07e14ad936804cfb912477ba7215dbbbc127491c961a`.
Backups and `INSTALLATION.json` are at:

- Desktop: `/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-hud-2.10.139-nameplate-diagnostics-20261007T040902Z`.
- Laptop: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.139-nameplate-diagnostics-20261007T040913Z`.

The local DEV-only ZIP is
`game-mods/FCMBridge/hudmodloader-chat/.build/FCMChatWidget-2.10.139-nameplate-diagnostics-DEV-test.zip`
(12,011,057 bytes; SHA-256
`3baaa816973669e7ee5c15ddbf87e8e12fd17e69a8ebe4b18cb358faae9af2af`).
Both provider folders contain the identical tested archive; DEV relay/link
stamps were verified. No release record or Nexus publication was created.
Fresh startup and the two-client trace are recorded below.

### Fresh HUD 2.10.139 native repro — 2026-10-07

[Confirmed] Both fresh logs identify HUD 2.10.139 and authenticated native
sessions. The user reports that both players are in game and overhead names
are still not blue. Both clients reach `gate=active`, accept private replies,
and record a live lease with one eligible name while the painter sees one
native plate, zero copied markers and zero painted labels. Desktop elapsed
02:08 records accepted=11, names=1, markers=0, plates=1, painted=0; the laptop
at 00:20:08 EDT records accepted=6, names=1, markers=0, plates=1, painted=0.
Subsequent desktop records still have markers=0 while plate counts grow.
The existing desktop roster reader logs `TeamMarkers snapshot names=1` and
later TeamMarkers updates, showing that this source is available to that reader.

[Confirmed] A read-only live DEV inspection finds two fresh linked native
clients, one linked FCM account and one canonical room. Each client's observed
names include its fresh peer. Evaluating the deployed presence service against
that evidence yields one eligible name for each client. The native reply logs
independently confirm receipt; this is not inferred from historical HMAC hashes.

[Deduced] The remaining failure is in the painter's marker-source path before
entity/name matching. Authentication, room assignment and private reply receipt
worked in this repro. Which subscription, envelope flag or row-copy step fails
is not yet established. No freshness or eligibility gate has been weakened.

### HUD 2.10.140 marker-source diagnostic candidate

This candidate leaves rendering and presence behavior unchanged and extends
the existing ten-second record with the bound/subscribed state, lifetime
bind/pull/push/observation counts, fixed bind/read phases, ready/test flag states,
bounded row/skipped/eligible counts, numeric bind error and roster-manager match.
It excludes native payloads, names, identifiers and private error text.

The installed desktop HUDModLoader archive was inspected read-only with the
repository's verified BA2 reader and FFDec 26.3.0. Its HUDTools provider/event
classes have the same `data`, `dataReady`, `isTest` and `fromClient` accessors
as the pinned upstream contract. This establishes the installed class contract,
not the values exposed by the live provider. The compiled 2.10.139 widget was
also inspected; no replacement Bethesda class or asset is shipped.

The Ruffle HUD scenario now exercises the actual painter subscription with
sealed accessor-backed provider/event fixtures rather than directly passing an
anonymous envelope to `observe`. Before adding the new instrumentation, both
provider scenarios passed. Native marker flags/phases remain to be captured
with this distinct candidate after the complete regression gates.

[Confirmed] Final local validation passed: all 27 pure HUD Haxe suites, two
native adapter/auth suites, two bridge suites, nine source/package checks,
compiler diagnostics (`[]` for production and harness), SWF/BA2/emoji checks,
and the complete Ruffle suite **91/91** in 7.4 minutes. That final run covers
the additional subscription/flag/error diagnostics on both providers and all
packaged-bridge cases. Port 41739 closed afterward. Explicit `Dynamic` flag
locals preserve missing/throwing accessor values in Flash; the compiled
scenario rejects missing flags rather than coercing them to false.
Existing required CI jobs cover these checks; this candidate has not run hosted CI.

[Confirmed] With both games closed, only `Data/FCMChatWidget.ba2` was replaced
on each machine. Six desktop and seven laptop provider/config/activation file
hashes were preserved. The prior native logs were backed up too. Both installed
archives match SHA-256
`bfdd6d0bf7e60892cfce916e85b5a08c145e9e877442d8f342bdf7786e7f7392`
(7,219,663 bytes); the SWF SHA-256 is
`8b5c9376d61fc0408db756b83a3ff0c6e80cbb0174a75412e792c6049af464ff`
(7,219,574 bytes). Backups and `INSTALLATION.json` are at:

- Desktop: `/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-hud-2.10.140-marker-diagnostics-20261007T044433Z`.
- Laptop: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.140-marker-diagnostics-20261007T044505Z`.

The local DEV-only ZIP is
`game-mods/FCMBridge/hudmodloader-chat/.build/FCMChatWidget-2.10.140-marker-diagnostics-DEV-test.zip`
(12,012,414 bytes; SHA-256
`8960eef37256ac75cfd32cf84791ac1232e5ddda4afd05ec3aa204dfaae40eb2`).
It was packaged after the complete suite passed. Both provider folders contain
the identical tested archive and verified DEV relay/link stamps. No release
record or Nexus publication was created. The fresh two-client trace is below.

### Fresh HUD 2.10.140 native repro — 2026-10-07

[Confirmed] The user placed both characters nearby in one world with overhead
names visible. Read-only captures at 05:06 UTC find the current 2.10.140 startup
on both machines and both games running. Each accepts private presence replies
containing one eligible peer during the capture. Both painters see seven native
plates but copy zero markers and paint zero labels.

| Machine | Accepted replies | Marker pushes / observations | Ready / test | Read phase | Bind error |
| --- | --- | --- | --- | --- | --- |
| Desktop, elapsed 04:43 | 29 | 867 / 868 | false / true | not-live | 0 |
| Laptop, 01:06:28 EDT | 11 | 99 / 100 | false / true | not-live | 0 |

[Confirmed] Both report `bound=true subscribed=true`, one successful bind/pull,
`bindPhase=complete`, and `rosterManager=true`. All sampled marker envelopes are
rejected by the readiness/test filter before row copying. This identifies the
failing condition; it does not establish why a populated native source retains
those flags or justify treating test envelopes as live. Short-lived observation
expiry also produces empty cosmetic replies at other points in the trace.

[Confirmed] Read-only extraction/FFDec inspection finds different embedded BSUI
implementations in the installed HUDMenu, HUDTools and HUDModLoader movies.
HUDMenu's four manager/connector/provider/event decompiles match the current
game's `SeventySix - Interface.ba2` copies. The installed loader requests a shared
ApplicationDomain, but its native GFx definition resolution has not been captured.

[Hypothesized] A definition resolved from the child widget may differ from the
HUD movie's manager. A host-domain source-selection candidate can test this while
preserving ready/non-test rejection and all room/lease/hostility gates. No root
cause, corrective native acceptance or public release is claimed from 2.10.140.

### HUD 2.10.141 host-domain source-selection candidate

This candidate selects the public BSUI manager from the HUD movie owning the
vanilla plates, instead of assuming that the widget's supplied manager is the
same definition. It checks the required read/subscribe/unsubscribe callables and
retains the existing supplied-manager path when the host definition is unavailable.
Selection performs no provider reads or watch mutation. The ten-second diagnostic
adds fixed manager scope, same/different/failure relation and numeric domain error.
Strict ready/non-test validation and all private-presence, room, hostility, wanted,
visibility, recycling, expiry and teardown gates remain unchanged.

[Confirmed] A new Ruffle fixture defines a harness-only public manager in the
actual host ApplicationDomain, while supplying a different unready/test child
manager. Both provider cases fail on the unchanged painter with
`host domain wins over unready child manager`, then pass with host-source
selection. Pure tests cover missing/throwing domains, incomplete callables,
same-manager detection, numeric error bounds and zero provider reads during
resolution. The existing required CI jobs discover these tests.

[Confirmed] Initial local gates pass: all 31 pure Haxe suites, nine
source/package checks, and production/harness compiler diagnostics (`[]`).
The exact production SWF/BA2 pair and source/artifact manifest match. FFDec
exports only `FcmNameplateSource` when selecting it alongside the harness BSUI
names: no replacement Bethesda manager or harness class is shipped.

The final complete Ruffle suite passes **91/91** in 8.4 minutes, including
both providers' new host-source checks and all isolated packaged-bridge cases.
Automatic teardown closes port 41739. The first full attempt was interrupted
after the new repeated-bind assertion incorrectly assumed a zero lifetime bind
count; it now verifies an unchanged count, and both focused cases pass before
the final complete run. Production artifacts were unchanged by that test correction.
Hosted CI has not run for this local candidate.

The candidate is installed as recorded below. Its fresh native trace selects
`hostManager=same` on both providers and retains the readiness rejection: this
source-selection remedy is refuted for the reported setup. A different native
manager has not been established. The previously distributed bridge 0.2.10 test ZIP remains the prior artifact;
the shared painter change is exercised in source-built packaged-bridge fixtures.

[Confirmed] Packaged after the full suite passed, the local DEV-only ZIP is
`game-mods/FCMBridge/hudmodloader-chat/.build/FCMChatWidget-2.10.141-host-domain-DEV-test.zip`
(12,013,333 bytes; SHA-256
`f1e514f906c292882a70ddb334f076a4dbe12bc7f1e539147c2755fffb3ea6d5`).
Both provider folders contain the same tested BA2 (7,220,706 bytes; SHA-256
`ffc8dabce5618bf19e08843cf7347569579c04eedbc83bf0602e446d9966ce6f`).
The exact embedded SWF is 7,220,617 bytes, SHA-256
`5e6f6a0956561959c0d23ff96017e477c67f511b7a58be15ac11a24a58ae0f41`.
ZIP CRC, both payload copies, bare DEV link URLs and both native DEV relay
configurations are verified. No release record, hosted upload or Nexus
publication was created. The laptop payload/install script were staged in its
temporary directory before the closed-game installation below.

### HUD 2.10.141 installation — 2026-10-07

[Confirmed] After the user reported both games closed, independent process
checks confirmed exit on both machines. The tested archive replaced only
`Data/FCMChatWidget.ba2`, with another closed-game check immediately before
each copy. Both installed payloads match SHA-256
`ffc8dabce5618bf19e08843cf7347569579c04eedbc83bf0602e446d9966ce6f`
(7,220,706 bytes). Post-install checks verify the previous 2.10.140 archive
backups and all six desktop/seven laptop provider/config/activation hashes.
Prior native logs were backed up too. Providers remain xScal 0.2.20 and ZFE
0.21.1; Home/Delete, Period/Delete and all appearance settings are preserved.
Each backup contains `INSTALLATION.json`:

- Desktop: `/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-hud-2.10.141-host-domain-20261007T055557Z`.
- Laptop: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.141-host-domain-20261007T055558Z`.

Both games remained closed at post-install verification. The user then restarted
both, joined one world and stood nearby for the fresh capture below.

### Fresh HUD 2.10.141 native repro — 2026-10-07

[Confirmed] Read-only captures at 06:01:26 UTC (desktop) and 06:04:14 UTC
(MSI) find each current 2.10.141 startup and both games running. Both clients
accept private replies containing one peer, see seven native plates, and retain
zero copied markers and zero painted labels.

| Machine / sampled log time | Accepted replies | Pushes / observations | Ready / test | Host manager | Bind error |
| --- | --- | --- | --- | --- | --- |
| Desktop, elapsed 02:39 | 15 | 78 / 79 | false / true | same | 0 |
| Laptop, 02:04:10 EDT | 31 | 467 / 468 | false / true | same | 0 |

[Confirmed] Each reports `managerScope=host-domain`, `domainError=0`,
`rosterManager=true`, one successful bind/pull, `readPhase=not-live` and
`rows=-1`. Host-domain selection chooses the same supplied manager; the proposed
selection remedy did not fix the native symptom. The sampled private leases are
live, so an expired presence reply cannot explain every zero-marker sample.

[Confirmed] The active HUD's `TeammateMarkersManager.onTeamMarkersUpdate` reads
`event.data.Markers` directly. Its installed manager creates an unready/test
placeholder when native Watch returns no provider. The connector changes flags
only on successful Watch, while Flush dispatches changes without updating them.
These are source contracts, not proof of which registration path this session took.

[Hypothesized] The dynamic manager's populated cache retains placeholder metadata,
or dynamic lookup reaches a different cache from the public HUD's native data.
The next diagnostic separates these: event/provider/getter identity comparisons,
the proposed HUD CharacterInfoData payload comparison, raw bounded row/eligibility/
visible-plate counts, and public manager/provider method shape. Matching payloads
and valid rows would support a registration-metadata discrepancy; divergent HUD
ownership would support a separate cache. The CharacterInfoData comparison was
subsequently invalidated by the private-field declaration recorded below.
Neither outcome permits silently
manufacturing flags or weakening the current readiness gate.

### HUD 2.10.142 payload-ownership diagnostic

This changes diagnostics only. Samples read existing `TeamMarkers` and
`CharacterInfoData` with `GetDataFromClient(key, false)` at most once per ten
seconds, compare event/provider/getter payload references transiently, and emit fixed labels,
bounded counts and numeric errors. The public watch-removal/SetReady methods are
inspected for shape, never invoked. Native payloads are neither retained nor
logged. Probe rows cannot feed the painter, room evidence or observation freshness.
Strict readiness, hostility, wanted, visibility and private lease gates remain.

Pure and sealed-accessor Ruffle tests cover ownership/divergence, bounds, privacy,
preserved flags, populated placeholder rejection and cached-read throttling.
[Confirmed] Artifact inspection caught an inferred Array in the probe's native
Vector plate traversal. Replacing the fixture's anonymous Array with the game's
Vector representation reproduces Error 1034 on both providers. Explicit Dynamic
locals prevent the Array coercion. This is a diagnostic implementation correction,
not the original native zero-marker root cause. The complete run against the old
fixture was interrupted; all gates must pass with the corrected Vector fixture.
[Confirmed] Both corrected Vector/provider scenarios pass (2/2), all 31 pure
Haxe suites and nine source/package checks pass, and production/harness compiler
diagnostics are empty. FFDec exports only the production probe when selecting it
alongside the harness manager/provider names; its native collection locals have
no inferred Array type. The first complete Vector run passes 90/91; the artifact
test still expected 2.10.141 while the actual build correctly reports 2.10.142.
That assertion is corrected and its focused artifact smoke passes (1/1).
The final complete suite passes **91/91** in 7.1 minutes with exit code 0.
Automatic teardown closes port 41739. Hosted CI has not run for this local diagnostic.

The reviewed SWF is 7,222,829 bytes, SHA-256
`6e2b8508c212e91c15aab2e64b88c2878726d673bc048c738a4c30e40831e80c`.
The matching BA2 is 7,222,918 bytes, SHA-256
`accbf1d4bd4287476e7d1367fdb219ae5fcab33a0c8b945d2d65585059550b04`.
Exact decoded payload equality and source/artifact manifest pass.

[Confirmed] Packaged after the final complete suite passed, the DEV-only ZIP is
`game-mods/FCMBridge/hudmodloader-chat/.build/FCMChatWidget-2.10.142-payload-probe-DEV-test.zip`
(12,015,083 bytes; SHA-256
`ea55e48da5f3921835ac31652540c18892d329f83af16dd64e835d8a287b5a00`).
ZIP CRC, both identical tested BA2 copies, both bare DEV link configurations and
both native DEV relay configurations are verified. No hosted upload, release
record or Nexus publication was created. The distributed bridge ZIP is unchanged.

### HUD 2.10.142 installation — 2026-10-07

[Confirmed] Independent process checks find both games closed before installation.
The user's existing two-machine local testing authorization remains in effect;
neither game was stopped by the agent. Each installer backs up its exact archive,
preserved files and prior native log, then checks game exit again immediately
before replacing only `Data/FCMChatWidget.ba2`. Both post-install payloads match
SHA-256 `accbf1d4bd4287476e7d1367fdb219ae5fcab33a0c8b945d2d65585059550b04`.
Each prior archive matches the tested 2.10.141 hash. All six desktop/seven laptop
provider/config/activation hashes are unchanged; Home/Delete, Period/Delete,
provider selection and appearance settings are preserved. Each backup contains
`INSTALLATION.json`:

- Desktop: `/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-hud-2.10.142-payload-probe-20261007T063811Z`.
- Laptop: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.142-payload-probe-20261007T063827Z`.

Post-install verification finds both games closed. The user then restarted the
games and requested a live log tail. Fresh evidence follows; this diagnostic does
not fix native coloring or accept the blue-name feature.

### Fresh HUD 2.10.142 native repro — 2026-10-07

[Confirmed] Read-only captures at 06:55:06–07 UTC and 06:58:58–59 UTC identify
the current 2.10.142 startup on both machines and both games running. Each accepts
private presence replies, including samples with one peer and a live lease. The
later captures show one raw marker, one eligible row and one visible name/entity
match on each client. Sampled event/provider/getter payload references are equal.
All sampled painters still copy zero markers and paint zero labels.

| Machine / sampled log time | Accepted replies | Pushes / observations | Raw / eligible / matched plates | Ready / test | Painted |
| --- | --- | --- | --- | --- | --- |
| Desktop, elapsed 06:34 | 35 | 11 / 12 | 1 / 1 / 1 | false / true | 0 |
| Laptop, 02:58:04 EDT | 38 | 14 / 15 | 1 / 1 / 1 | false / true | 0 |

[Confirmed] Both report `bound=true subscribed=true`, one bind/pull,
`managerScope=host-domain`, `hostManager=same`, `rosterManager=true`,
`nativeManagerApi=true`, `readyArity=1`, and zero bind/domain/probe errors.
The early capture's zero plate matches are superseded by these later matched
samples; they do not establish a player-name mismatch. Some presence samples
expire or contain zero names, but samples with fresh names still paint zero.
Sanitized captures are saved locally in
`/tmp/fcm-hud-2.10.142-native-capture-1.json` and
`/tmp/fcm-hud-2.10.142-desktop-native-capture-2.json` and
`/tmp/fcm-hud-2.10.142-msi-native-capture-2.json`. Logs contain fixed/count-only
diagnostics and redact the local instance marker.

[Confirmed] A follow-up tail at 07:03:02–03 UTC still finds both games running
with no painting. Probe samples now count seven raw rows, seven eligible rows and
one visible name/entity match on each client. Marker updates continue: the latest
desktop record has 889 pushes/890 observations, and the laptop has 662/663.
The same-payload comparisons, unready/test flags and zero numeric errors persist.
Separate sanitized `desktop-native-capture-3.json` and
`msi-native-capture-3.json` files use the same `/tmp/fcm-hud-2.10.142-` prefix.

[Confirmed] The CharacterInfoData ownership probe used an invalid assumption.
The active `HUDMenu.as:255` declares `private var CharacterInfoData:Object`;
it is not a public child-widget surface. The normal public field lookup cannot
read it. `characterPayload=missing` is therefore inconclusive, not evidence of
different native/cache ownership. The fixture's public field does not model
that native declaration. The next code candidate must remove the comparison and
correct the fixture rather than attempt private-field access.

[Deduced] The immediate painting failure is the readiness/test gate before row
copying, despite populated data corroborated by a visible plate. The public
game manager's `Flush` dispatches provider changes without changing those flags
(`Shared/AS3/Data/BSUIDataManager.as:80–89`), and the native
`TeammateMarkersManager.onTeamMarkersUpdate` consumes `event.data.Markers`
directly. These installed source contracts explain why a populated update and
unchanged registration flags can coexist, but do not prove the exact native
registration path taken here. No flags, shared watches, readiness/world gates,
provider configurations or game archives were changed during the tail.

The targeted backend presence suite passes **28/28** tests, including a new
regression that permits separate HUD identities linked to the same FCM account
and still requires the viewer to have observed the peer's name. The existing
backend Jest CI gate discovers this suite. Shared FCM login alone is not a
reason to classify this result as expected or to accept the blue-name feature.

## Independent review and HUD 2.10.143 — 2026-10-07

Three independent agents reviewed captured native evidence, the full published
HUDModLoader wiki/source contract, and comparable author-published Nexus mods.
The [dated synthesis](blue-nameplates-2026-10-07-review.md) records sources,
evidence strength, proposed resolutions and rejected alternatives. The native
registration cause remains unresolved; the candidate addresses the confirmed
FCM rejection point through a separately corroborated cosmetic source.

The shared painter requires a real post-bind host-domain update, identical
event/provider/canonical cached envelopes and payloads, explicit anomalous flags,
complete bounded scalar marker rows, a visible native entity/name match and
current safe eligibility. Generic readiness stays strict. Source age is below
30 seconds and associated with the current private presence reset generation.
Getters, probes, frames and private lease replies cannot renew it. Final tint
runs after vanilla's deferred stage RENDER redraw; complete display visibility
and owned teardown remain mandatory. The invalid private CharacterInfoData
probe is removed, and terminal HUD auth/link failures retire colors immediately.

Regression tests first reproduced the 2.10.142 zero-color result on both
simulated providers, then passed with the candidate. Actual packaged bridge
tests separately reproduced the first-snapshot context-order failure and an
xScal hop requesting the wrong cosmetic export generation. Bridge source
0.2.11 establishes context before painter binding and requires the current
world to match its last successfully saved export, including after native calls.
Deferred/failed saves cannot authorize a new cosmetic world. Server room policy
and the distributed DEV bridge 0.2.10 ZIP remain unchanged.

| Local final gate | Result |
| --- | --- |
| Haxe pure suites, including parent native/auth and bridge state/export | 31 passed |
| Source, artifact, BA2, package and release-contract checks | Nine passed |
| Production widget and native scenario compiler diagnostics | Empty |
| Complete Ruffle suite, both HUD providers and actual packaged bridge | 93/93 passed, 7.7 minutes |
| Backend Jest, including pairing/private presence and Server integration | 130 suites / 1,669 tests passed; nine intentional skips |
| Backend TypeScript with disposable real Redis | 445 passed; zero skips |
| Overlay Vitest | 59 files / 1,303 passed |
| Dashboard Vitest | 49 files / 490 passed |
| DEV ZIP CRC, endpoint stamps and both provider archive copies | Passed; copies equal the tested BA2 |

The first broad Jest run inherited local dotenv settings and failed four
unrelated assertions in two suites. The final run used a clean working directory,
CI test session/admin values and disposable loopback-only Redis. Two temporary
TypeScript runner setups were rejected for missing module/fixture paths before
the complete clean run passed. The owned Redis was removed and checked absent;
no product environment code or tests were weakened. Existing required CI jobs
discover all new regressions. No new hosted CI run or publication was triggered.

Final local artifacts:

- `.build/FCMChatWidget-2.10.143-correlated-nameplates-DEV-test.zip`, 12,017,944
  bytes; SHA-256 `3b4b0c3022236a5e9c3af5e4fff437bd1fa6dc95091ddfd48a595f4375bc31df`.
- BA2, 7,227,057 bytes; SHA-256
  `c403e25d1654171ff8684b45d93854bee808393689d0fbf894bcebc0640780ba`.
- Normalized FWS v32 SWF, 7,226,968 bytes; SHA-256
  `2c310befb5844599566a2c54ae681d6cd730dda023bf016bf699081a8c006559`.
- Local rebuilt bridge 0.2.11 DEV fixture: SWF SHA-256
  `ce811276755a965eb352309686b3625c05f00d94e79f52207140b90c94b6e9ed`;
  BA2 SHA-256 `1bfc4423925ec33c743f6b71909b45f2abc846921037975bcc9735ca9831893f`.

[Confirmed] Both games were independently closed, then only their HUD archive
was replaced: desktop at **07:55:57 UTC**, MSI at **07:56:27 UTC**. Both installed
BA2 hashes equal the tested archive; the transferred laptop ZIP also matches.
The previous 2.10.142 archives/logs are backed up. All six desktop/seven laptop
preserved file hashes pass, including the providers, HUDModLoader, INIs and
archive lists. Home/Delete with shared xScal input and Period/Delete with the
ZFE host editor remain unchanged.

Exact rollback backups:

- Desktop: `/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-hud-2.10.143-correlated-nameplates-20261007T075557Z`.
- MSI: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.143-correlated-nameplates-20261007T075627Z`.

Gate and installation JSON is recorded in `/tmp/fcm-hud-2.10.143-test-gates.json`
and alongside the test ZIP as `.build/FCMChatWidget-2.10.143-DEV-GATES.json`.
`.build/FCMChatWidget-2.10.143-DEV-TESTING.txt` gives the focused native procedure.
The public research cache and red/green logs listed in the dated synthesis
remain local evidence, not package dependencies.

**Native acceptance is pending for this exact candidate.** Join the same world,
walk briefly with overhead names visible, verify both eligible FCM peers turn
blue and ordinary players keep native colors, then check redraw, chat, travel
and hops. Also stand still for over 30 seconds: captured native push gaps already
exceed that bound. Blue must safely expire if the source stops advancing and
recover only after a genuine update and fresh private presence. Do not mask
stationary availability with getter/heartbeat renewal or infer native success
from the 93-case automated result.

## Follow-up review and HUD 2.10.144 — 2026-10-07

The 2.10.144 follow-up review reproduced and fixed immediate link-notice
retirement and recovery after a failed subscription to the exact same manager.
Both providers also pass sealed UInt upper-range matching and explicit rejection
of conversation suffixes. Healthy bindings preserve source age; old pending
replies stay rejected after relinking. Native acceptance remains pending.

[Confirmed, Ruffle] Two focused 143 provider runs reproduced both lifecycle
failures. The rebuilt 144 focused runs pass 2/2 (13.9 seconds), including the real
system parser, delayed reply after relinking, same-manager retry, no healthy
rebind/source-age renewal, balanced listeners, sealed UInt ID 4294967294 and
conversation-suffix rejection. The exact red/green/browser logs are under
`/tmp/fcm-hud-2.10.144-review-*`.

All 31 pure suites, nine source/package checks and empty widget/scenario compiler
diagnostics pass. The complete final Ruffle rerun passes 93/93 (7.5 minutes),
including both actual packaged 0.2.12 bridge providers. The initial full run
rejected only stale widget/bridge version expectations (91/93 passed); these
checks now compare against the respective source constants without relaxing
artifact, build-format, timing or teardown checks. The artifact smoke additionally
checks the exact SWF fetched by Ruffle and its compiled version, rejecting stale
143 bytes beside fresh 144 metadata. Its intermediate review run was interrupted
before the final complete suite. The initial failed run's log/traces remain at
`/tmp/fcm-hud-2.10.144-ruffle-version-stamps-red*`. Final backend Jest passes
130 suites/1,669 tests with nine intentional skips; backend TypeScript passes
445 with zero skips, overlay 1,303 and dashboard 490. Backend used the isolated
working directory and disposable loopback Redis; removal is verified. Existing
required CI jobs discover the scenarios. No hosted CI run or publication occurred.

Final DEV artifacts:

- `.build/FCMChatWidget-2.10.144-reviewed-nameplates-DEV-test.zip`, 12,017,952 bytes;
  SHA-256 `c09481dd4839df3c9d6f8807de664ec6f56a3949a8dfdf787382d7aec714a206`. CRC and both provider archive copies pass.
- BA2, 7,227,077 bytes;
  SHA-256 `c6ab4a154c1ec798827257548c4433f66a675c88e48919d099bf712a3067101e`.
- Normalized FWS v32 SWF, 7,226,988 bytes;
  SHA-256 `a4839280d396605dac509c6bb25f8e8e5fa390ac82d46984747f472915963409`.
- Local bridge 0.2.12 DEV regression fixture: SWF SHA-256
  `d66d73486d71d699bea71b5c91aaac4dc12e3fcd393382666229c8be8edc4556`; BA2 SHA-256
  `514151e1c2d1182211eb2c4a91e20a039bc9c6e7b5c5ba6380268c409063a691`. Distributed 0.2.10 remains unchanged.

[Confirmed] Both games were independently closed. Only their HUD BA2 was
replaced, desktop at `20261007T084957Z` and MSI at
`20261007T085050Z`. Installed hashes equal the tested payload;
all six desktop/seven laptop preserved files retain their earlier hashes.
The prior 143 archives/logs are recoverable in these exact rollback backups:

- Desktop: `/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-hud-2.10.144-correlated-nameplates-20261007T084957Z`.
- MSI: `C:\Users\White\Documents\FCM-Repro-Backups\before-hud-2.10.144-correlated-nameplates-20261007T085050Z`.

Gate/install metadata is `/tmp/fcm-hud-2.10.144-test-gates.json` and
`.build/FCMChatWidget-2.10.144-DEV-GATES.json`; focused native instructions are
`.build/FCMChatWidget-2.10.144-DEV-TESTING.txt`. The game has not accepted this
artifact yet. Move briefly for a genuine marker update, verify both overhead
names are blue and ordinary names are unchanged, then stand still for over
30 seconds. If native publications stop, blue must expire and require a fresh
update to return. Check redraw, typing, Server, travel/hops and frame stability.
The native leader conversation suffix intentionally remains vanilla; crowded-HUD
cost and continuous stationary availability remain unverified.

## MSI complete ZFE reinstall — 2026-10-12

[Confirmed] Steam's current Fallout 76 installation is
`D:\SteamLibrary\steamapps\common\Fallout76`, runtime **1.7.26.22**.
The earlier C: game folder is absent. The game was closed throughout restoration.
The new folder contained none of the seven FCM/provider/loader files; the
existing Documents profile still activated HUDModLoader and FCM once each.

Restored **FCMChatWidget 2.10.144**, **ZFE 0.21.1**, **HUDModLoader v70**,
root provider settings, the HUD configuration, loader registry and ZFE TextChat
fragment. The trusted matching ZFE ZIP and saved dependency/configuration files
survived in the earlier recovery backups. All seven installed files match their
pinned source hashes. The profile and archive list remain byte-identical;
its backup is verified.

- HUD BA2 SHA-256:
  `c6ab4a154c1ec798827257548c4433f66a675c88e48919d099bf712a3067101e`.
- ZFE DLL SHA-256:
  `0314f7b82499169f7ea500ca3b1ce9f0853178d93622683cdccafefa9403262f`.
- HUDModLoader BA2 SHA-256:
  `a0287e33c27cd5baa7f7a1f23acb571c77ccd27d25b6b2df83d25b56c9578b11`.
- Preserved bindings: **Period / Delete**. The HUD and ZFE fragment point to
  **DEV**, with native ZFE input and `blueNameplates=true`.

The existing 144 ZIP passed fresh CRC, provider-copy and source/artifact
equality checks. Its earlier 31-pure/nine-source/compiler/**93/93 Ruffle** gate
record remains regression evidence for the unchanged source/artifact bytes;
the suite was not rerun for this file restoration. This installation is
**native-unverified** until its own startup and acceptance are captured.

Before-state, profile backup and installation manifest:
`C:\Users\White\Documents\FCM-Repro-Backups\before-full-hud-2.10.144-zfe-reinstall-20261012T042540Z`.
The native chat-login cache was absent from the new game folder and recovery
files, so a fresh DEV link may be required. Start Fallout 76, use Period
to open chat and complete the displayed DEV link if prompted.

## Compatibility matrix

| Client A | Client B | Native result |
| --- | --- | --- |
| HUD/ZFE | Bridge/ZFE | Pending |
| HUD/ZFE | Bridge/xScal | Pending |
| HUD/xScal | Bridge/ZFE | Pending |
| HUD/xScal | Bridge/xScal | Pending |
| HUD | HUD (both providers, including mixed) | Mixed xScal/ZFE failed on 2.10.139–142; 2.10.144 is installed and its fresh native check remains pending |
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
