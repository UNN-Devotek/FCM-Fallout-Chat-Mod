# FCMChatWidget build, install, and verification

## Private giveaway feedback candidate (2026-09-25)

**Widget version:** 2.10.130. Standalone `/help`, `.help`, or native
slash-stripped `help` adds a local command guide to the feed, covering every
implemented channel, visibility, relink, emoji, giveaway, and moderation
command. Successful giveaway joins and attempts to join
one's own giveaway now create local `[Vault-Tec]` feed rows in the command's
channel. They carry no relay message ID or sender ID and are never sent as
ordinary chat, so only the submitting HUD sees them. The automatic winner is
still a persisted channel bot message. The xScal and ZFE simulator scenario
checks both private outcomes, private help, and the winner's feed order.
The 25 Haxe suites, compiler diagnostics, source/package/emoji/SWF/BA2 checks,
backend giveaway tests, and all 79 Ruffle scenarios passed. The normalized
FWS v32 SWF is SHA-256
`b0d97324754cf100f3610e13d80e070de1a7da97635aff031e1b02fc3b900f35`.
The rebuilt one-entry BTDX v1 GNRL BA2 extracts that SWF byte-for-byte and is
SHA-256 `1f5937426cc7628486ecaf77e85f5fba3c598cfb8a3a487196d9cb72c2d836d8`.
With Fallout 76 closed, the BA2 was installed on the local Steam/Proton
desktop. The old BA2 and hash manifest are backed up under
`/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-hud-private-help-20260926T024752Z-me7dk2ua/`.
The Dev relay/link, `xscalInputMode=shared`, xScal 0.2.18 DLL, loader registry,
and other configs were verified unchanged. Fresh native game acceptance is pending.

## Local Steam/Proton xScal shared-input install (2026-09-25)

With Fallout 76 closed, the SWF was rebuilt from `dev` revision `17a2a876` and
normalized; its SHA-256 is
`c94b591310b06754de0771357439a700dcd6d0d1054ff49a834b221b9d311d26`.
The rebuilt one-entry BTDX v1 GNRL BA2 extracts that exact SWF and matches the
committed archive byte-for-byte (SHA-256
`aa6125aeae3b0d7f828110676c6e939e18f28eaeb8e1590c4e21a72c94c947a6`).
Compiler diagnostics, 25 Haxe suites, native adapter/auth and source/package
checks, and the complete 79-case Ruffle suite passed; the revision's CI run
`36209681621` passed. Only the BA2 and two existing configuration files were
changed on the local Steam/Proton installation. `Data/FCMChat.ini` now sets
`xscalInputMode=shared` and `linkUrl=dev.falloutchatmod.com/link`, while the
root `xscal.ini` uses `wss://dev.falloutchatmod.com/relay`. `openKey=INSERT`,
xScal 0.2.18, and the HUDModLoader registry remain unchanged. The prior files
and SHA-256 manifest are under
`/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-xscal-shared-local-20260926T015953Z-snw8610p/`.
The version stamp was absent and remains absent. This is a local test install;
fresh native typing and Dev authentication are pending the user's game launch.

## Temporary Windows xScal SharedHUDTools workaround (2026-09-25)

`FCMChat.ini` now accepts `xscalInputMode=native|shared`. Native remains the
default and worked in the Linux/Steam Proton test with xScal 0.2.18. The
native failure reproduced on the Windows laptop; its test uses `shared` to
bypass xScal 0.2.18 `Input.BeginInput` and open HUDModLoader's
`SharedHUDTools.TextEdit` instead.
The setting does not affect ZFE or the eight configurable action keys. It is
explicit because `input_unavailable` also covers an existing native owner.
Controller text entry is unsupported in shared mode. The Ruffle harness checks
that configured shared mode never calls native BeginInput and releases its
host editor on shutdown. The 25 Haxe suites, compiler diagnostics, source and
package checks, native adapter/auth checks, and all 79 Ruffle scenarios passed.
The normalized FWS v32 SWF is SHA-256
`c94b591310b06754de0771357439a700dcd6d0d1054ff49a834b221b9d311d26`.
The BTDX v1 GNRL BA2 has one entry; its extracted SWF matches the tested
artifact byte-for-byte. BA2 SHA-256:
`aa6125aeae3b0d7f828110676c6e939e18f28eaeb8e1590c4e21a72c94c947a6`.
The production xScal Nexus-layout ZIP at
`.build/FCMChatWidget-2.10.129-xscal-shared-config-test-nexus.zip`
embeds that exact BA2. With Fallout 76 closed, the same BA2 was installed on
the Windows laptop and verified by hash. Only `xscalInputMode=shared` was
appended to the laptop's `Data/FCMChat.ini`; `openKey=PERIOD` remains intact.
The prior BA2 and config are backed up under
`C:\Users\White\Documents\FCM-Repro-Backups\before-xscal-shared-config-20260925`.
The user's first laptop run after installation reported that typing seemed to
work. The fresh `xscal.log` identified the exact `xscal-shared-config-1` build,
registered Period as VK 190, and logged `selected editor=shared
xscalInputMode=shared` after its physical open-key edge. `FormatTextEdit`,
`FormatOnScreenKeyboard`, and `TextEdit` opened successfully. The focused
input field reached length two; Enter reserved the draft, the callback ran,
xScal acknowledged the send, and the next relay poll matched one own echo.
There were zero `BeginInput` log lines and no editor failure in this run.
The log does not directly measure whether gameplay actions were blocked while
typing; the user's visual report is the only evidence for that aspect so far.
The user subsequently confirmed that this workaround worked on the laptop.
It remains a local test candidate, not a published fix or a diagnosis of the
native xScal failure. Provider-side diagnostics should distinguish the
`BeginInput` refusal branches, especially foreground HWND validation and
`SetWindowSubclass` success on the window-owning thread.

## xScal key-release diagnostic candidate (2026-09-25)

The next FCM BA2 keeps xScal's native `Input.BeginInput` / `PollInput` /
`EndInput` route. After `input_unavailable` on a physical open-key down edge,
it attempts `BeginInput` exactly once on that key's release, within two seconds
and only while the HUD is allowed to own input. Startup marker:
`diagnostics=dup-v1,xscal-native-begin-probe-2`. The log identifies press and
release outcomes and release delay. No text or auth data is logged. This probe
can establish whether refusal depends on key timing; it cannot distinguish the
internal refusal branches of the public xScal 0.2.18 DLL. ZFE keeps its existing
SharedHUDTools editor. Record the tested BA2 hash and native result after the
full Ruffle suite and laptop run.

The candidate passed 25 pure Haxe suites, compiler diagnostics, native
adapter/auth and source/package/SWF/BA2/emoji checks, and all 78 Ruffle
cases. FWS v32 SWF SHA-256:
`fde7e3f49bbdeffbcfedee15576b6d2fdb46fc5a5e3004c083fff559be0af3a0`.
The BTDX v1 GNRL BA2 has one entry, its extracted SWF matches exactly, and
its SHA-256 is
`2e36c5aeefb745d2de65efff459a5ed1cbd6fa12a2acdf98b3a539f556d6a236`.
The production xScal Nexus-layout ZIP embeds that same BA2. With Fallout 76
closed, only `Data/FCMChatWidget.ba2` was replaced on the Windows laptop;
the installed hash matches and `openKey=PERIOD` is unchanged. The prior BA2
and config are backed up at
`C:\Users\White\Documents\FCM-Repro-Backups\before-xscal-release-probe-20260925`.
The next launch supplied the native result below.
The user's laptop run loaded the exact BA2 (`probe-2` marker). Period registered
as VK 190 and produced two physical press edges. Both press-time
`BeginInput` calls returned `input_unavailable`, and the corresponding
release probes at 78 ms and 80 ms returned the same refusal. FCM had no local
session and no uncertain release. Typing still failed, so **this candidate is
native-rejected on the laptop**. The key-release timing hypothesis is ruled
out for this run; the public 0.2.18 reply still does not reveal which internal
branch refused the session. Do not publish this as a typing fix.

An independent Windows foreground probe then ran in the laptop's interactive
session while Fallout 76 was open. On three Period down/up pairs, the foreground
HWND stayed `1248560`, its owner PID stayed `3188` (the Fallout76 process),
and its window-owner thread stayed `20784`; both probe and game were in session
`1`. The matching FCM log again records physical VK 190 edges and rejected
press/release `BeginInput` attempts. This rules out loss of foreground focus
for those attempts. It does **not** reveal xScal's callback thread ID or prove
that `SetWindowSubclass` failed; that still needs native branch diagnostics.
The read-only foreground probe CSV is kept in the laptop repro backups.

Static inspection of the *exact installed* public xScal 0.2.18 `dxgi.dll`
(SHA-256 `78cb91d6e9e53bcf97f55dd82a60931aec94cc4cc2b6dc74da198d6b9dd311e4`)
found two `input_unavailable` returns in `Input.BeginInput` (handler RVA
`0x26728`). One follows a failed begin helper (RVA `0x28a70`), which combines
active session, missing/foreign foreground HWND, failed `SetWindowSubclass`,
and changed prior HWND. The other follows a failed initial snapshot helper
(RVA `0x28bc0`) and cleanup. The begin helper's foreground getter (RVA
`0x28294`) uses `GetForegroundWindow`, `GetWindowThreadProcessId`, and
`GetCurrentProcessId`. COMCTL32 ordinals 410/412/413 were verified against
the laptop's Windows DLL as Set/Remove/DefSubclassProc. No native callback
thread ID or branch code is logged. Subclass failure is the leading inference,
not a confirmed branch; do not patch the external DLL based on this alone.

## xScal 0.2.18 diagnostic-build prerequisite (2026-09-25)

The current public xScal GitHub `main` is commit `2c073777b8399960122c4971694f5b6e8be2a8ba`.
It contains no `Input.BeginInput`, `Input.PollInput`, `Input.EndInput`,
`input_unavailable`, or text-session implementation. Its only public tag is
`v0.1.1`, and GitHub has no published release. The official Nexus 0.2.18 ZIP
contains only `dxgi.dll` and `xscal.ini`, with no source or debug symbols.
Consequently, an instrumented **0.2.18 native DLL cannot be built from the
published source**. Do not replace the laptop's working chat transport with a
rebuild of this older, incomplete tree.

Request for an author-supplied diagnostic build or the missing 0.2.18 input
source: keep the native session behavior unchanged and emit a distinct failure
reason at each `Input.BeginInput` refusal: existing active session; foreground
Fallout window not found or rejected; `SetWindowSubclass` failure. For the
window/subclass branches, log the selected HWND, current thread ID, window
owner thread ID, and Win32 error captured immediately after the failed call.
Avoid text, player identity, tokens, and chat payloads. Reproduce on the clean
Windows laptop with xScal 0.2.18, HUDModLoader v70, FCMChatWidget 2.10.129,
`openKey=PERIOD`, and only the required archives. A successful diagnostic run
must show which branch refused `BeginInput`; a proposed fix then needs an
accepted session, visible characters, blocked gameplay actions during input,
and balanced `EndInput`/reopen across cancel, submit, and focus loss. Repeat
the same test on the previously working Proton desktop and run the ZFE HUD
regression suite before shipping a changed FCM BA2.

## Laptop retest and editable physical keys (2026-09-25)

The laptop loaded the 2.10.129 native diagnostic BA2 (startup marker
`diagnostics=dup-v1,xscal-native-begin-probe-1`) with `openKey=PERIOD`.
`xscal.log` records accepted VK 190 registration and repeated `physical openKey
edge key=190` events, each followed by `xScal text session busy` with
`localSession=none` and `releaseUncertain=false`. This confirms the rebind
worked and isolates the typing failure to xScal refusing `Input.BeginInput`;
the log does not distinguish an existing provider session, missing foreground
game window, or failed Windows subclass installation. The next candidate shows
this refusal in the HUD prompt and accepts named punctuation, numpad keys,
F1-F24, and decimal `VK_###` tokens across all eight config key lines.
`hideKey=` now disables the hide binding as the shipped guide already promised.
This candidate is a keybind and diagnostic improvement, not a confirmed repair
for the native refusal. Keep Fallout closed while installing it, then collect
fresh native results from that exact BA2.

The candidate passed 25 pure Haxe suites, compiler diagnostics, native
adapter/auth checks, source/package/emoji/SWF/BA2 checks, the complete
78-case Ruffle suite (including ZFE editor/rebind flows), and the focused
website keybind guide test. Compiled FWS v32 SWF SHA-256:
`53127ac882e232bde16091b2999880051a000b31bcaa64f89562a319f34f884c`.
One-entry BTDX v1 GNRL BA2 SHA-256:
`4ca5fae83ae7f7d39e748f25626a9997bf3f1e86a4ad92117b7c67befa4a1002`;
extracted SWF bytes match the compiler output. The production xScal ZIP
contains that exact BA2 and passed package validation. With Fallout closed,
only `Data/FCMChatWidget.ba2` was replaced on the laptop. The remote installed
hash matches; `Data/FCMChat.ini` remains `openKey=PERIOD`. Backup:
`C:\Users\White\Documents\FCM-Repro-Backups\before-keybind-native-diagnostic-20260925`.
The user's next game launch loaded this exact BA2. Its fresh `xscal.log`
records accepted VK 190 registration, two `physical openKey edge key=190`
events, and two `xScal text session busy` results with `localSession=none`
and `releaseUncertain=false`. No native session was accepted and typing still
failed. Therefore this candidate is **native-rejected for text input** on the
Windows laptop, while its Period rebind is accepted. Do not publish it as a
typing fix.

Provider issue handoff: on a fresh Steam Fallout 76 1.7.26.10 / xScal 0.2.18 /
HUDModLoader v70 install, `Input.RegisterKey(190)` returns true and physical
polling observes the key, but the generic callback `Input.BeginInput` returns
`{"success":false,"error":"input_unavailable"}` every time. The laptop has
no previous FCM session or uncertain release. xScal 0.2.18 should distinguish
and log its three known refusal conditions (already active session, foreground
game HWND lookup, and `SetWindowSubclass` failure), including the HWND/thread
and Win32 error where applicable. If subclassing fails because the call is on
a different thread, install/remove it on the window's owner thread; Microsoft
documents the cross-thread restriction. This is a hypothesis until xScal's
own branch diagnostics identify which condition failed.

## Laptop xScal native input diagnostic candidate (2026-09-25)

The clean Windows laptop reproduced the reporter's failure on the public 2.10.125
BA2 and xScal 0.2.18 DLL: Insert registered as VK 45, but every attempted
`Input.BeginInput` returned `input_unavailable` (16 busy lines, no accepted
session). The same DLL accepted a native session on the Steam/Proton desktop.
No xScal text session had been accepted earlier in the laptop log. The laptop
game was launched before `FCMChat.ini` changed from Insert to Period, so that
run tested Insert only. Its period press surfaced as an unmapped HUD action.

The private source candidate retains xScal's native `Input.BeginInput` /
`PollInput` / `EndInput` path and the fail-closed busy behavior. It maps
`openKey=PERIOD` to VK_OEM_PERIOD (190) and adds a bounded busy diagnostic
showing whether this widget already holds a local native session, the configured
open key code, and whether a prior release is uncertain. The startup marker is
`diagnostics=dup-v1,xscal-native-begin-probe-1`. These changes can distinguish
key detection and local ownership from a rejected xScal session; they do not
claim to repair `input_unavailable` inside the xScal DLL. A Ruffle scenario
exercises Period opening and closing the native xScal session. All Haxe,
native-adapter/auth, package, SWF, emoji, and complete 78-case Ruffle checks
passed. The FWS v32 SWF is SHA-256
`962dec9a8a4e509cc4379b89303b46f2895c6a4fc5d47cd926406de05f6cf70f`;
the one-entry BTDX v1 GNRL BA2 is SHA-256
`d287172f555c874499cb1889b003a2e683439fb6e6e686c67408dbc4ae1c511a`.
Extraction matched the compiled SWF byte for byte, and the original BA2's
path and record metadata were retained. A production xScal ZIP was checked
against its embedded BA2 and production link URL. With Fallout 76 closed, only
`Data/FCMChatWidget.ba2` was replaced on the laptop, retaining the Nexus
xScal DLL, HUDModLoader and `FCMChat.ini` `openKey=PERIOD`. The prior BA2,
config and log are backed up at
`C:\Users\White\Documents\FCM-Repro-Backups\before-xscal-native-probe-20260925T184343`.
Installed BA2 SHA-256 matches the candidate. Native acceptance on the laptop
remains pending the user's next game launch.

Read-only examination of the installed xScal 0.2.18 binary shows its
`input_unavailable` response also follows failure to find the foreground game
window or failure of Windows `SetWindowSubclass`; an existing xScal session is
another branch. [xScal's public source](https://github.com/DCHoaxer/xScal)
omits the text-session implementation, so the exact failed branch on Windows
has not been observed. [Microsoft documents](https://learn.microsoft.com/en-us/windows/win32/api/commctrl/nf-commctrl-setwindowsubclass)
that the subclass helper cannot subclass across threads. This is a hypothesis
for the Windows/Proton difference, not a confirmed cause; the native xScal
provider needs its own diagnostic or fix if the candidate stays busy.

## Fresh Nexus xScal input reproduction (2026-09-25)

After local 2.10.129 typing continued to work with only required HUD mods and
with `xScalPriority` disabled, the user requested a clean install from Nexus.
With Fallout 76 closed, the current public Nexus ZIPs were fetched directly and
their SHA-256 hashes matched the files listed on Nexus:

| Nexus mod | Version | ZIP SHA-256 |
| --- | --- | --- |
| FCM HUD (4082) | 2.10.125 | `e1e6983d81d3c8c5c49836e7f1bb14770c15ebc8d1e6676638d71c77157f8e65` |
| HUDModLoader (3144) | 70 | `7f8b320e1779ba9e8a4d2e10935a2cc53ecc36da4518aa0633e10cb1f3016874` |
| xScal (4183) | 0.2.18 | `30fad6aa50649a38d9ba83a718cbca9970a2c9299f5a722fc2cbfc04657a1baa` |

The xScal provider folder of the unified FCM package supplied
`Data/FCMChatWidget.ba2` (`66d1d90246723d99838ab5620192b50fe1083a23cf55f80c11b8e47527ef464e`)
and `Data/FCMChat.ini`; the xScal ZIP supplied root `dxgi.dll` and its default
`xscal.ini` with production relay and `xScalPriority` disabled. The loader ZIP
supplied `Data/HUDModLoader.ba2` (`a0287e33c27cd5baa7f7a1f23acb571c77ccd27d25b6b2df83d25b56c9578b11`)
and its default registry; one `FCMChatWidget` line was appended. The custom
archive list contains exactly `HUDModLoader.ba2,FCMChatWidget.ba2`. Prior mod
files, auth cache, settings, and logs were moved to
`/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/fresh-nexus-input-repro-20260925T220601Z/`;
the manifest records every path and the source ZIPs. Non-mod display settings
in `Fallout76Custom.ini` were preserved. Native typing on this exact install
remains pending the user's next launch.

The same source ZIPs were transferred through SSH Manager to the MSI Windows 11
laptop and verified there by SHA-256 before installation. Fallout 76 was closed.
The prior active `FCMServerBridge.ba2`, older HUDModLoader BA2, FCM/extender
files, caches, settings, and logs were moved to
`C:\Users\White\Documents\FCM-Repro-Backups\before-nexus-clean-20260925T221153Z`.
The manifest lists 58 moved paths and installed hashes. The fresh game Data
folder has only HUDModLoader and FCMChatWidget mod BA2s; the custom archive
list is `HUDModLoader.ba2,FCMChatWidget.ba2`, the loader registry has one
`FCMChatWidget` line and no bridge line, and the old xScal log is absent.
Installed DLL, widget, loader BA2, and provider config hashes match the desktop
Nexus trial; the merged registry uses Windows line endings.
The laptop's production desktop overlay was outside this game-mod reset.
Native typing on the laptop is pending the user's launch.

## Local xScal typing reproduction setup (2026-09-25)

With Fallout 76 closed, the local Steam/Proton install was switched from ZFE
0.15.0 to the previously native-tested xScal 0.2.18 DLL. Only the root
`dxgi.dll` changed. The installed `Data/FCMChatWidget.ba2` remains the current
2.10.129 source build (SHA-256
`4407256d7af0ddbf33e17b7bad21b6a8c66553acd923b5c4f0366d43fbed4de3`);
compiling and normalizing the current source reproduced its embedded SWF hash.
The existing xScal configuration still targets hosted Dev. FCM configuration,
HUDModLoader registration, archive list, and the inert ZFE fragment were unchanged.
The loader and archive list each contain one visible widget and no legacy or
background FCM bridge. Exact-file rollback copies and hashes are in
`/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-xscal-typing-repro-20260925T204901Z/`.

Pure Haxe, native adapter/auth, source/package/SWF/emoji checks and all 77 Ruffle
cases passed before the provider swap. The subsequent in-game trial accepted
typing, gameplay lock, submission, Delete hide/reopen, and a map cycle. The
reporter's xScal log shows repeated `Input.BeginInput` busy responses with no
accepted session; their visible Data mod list shows only HUDModLoader and one
FCMChatWidget as apparent HUD input components, but does not identify the
native input owner.

## Channel-local giveaway and ZFE command receipt candidate (2026-09-25)

**Widget version:** 2.10.129. A giveaway command now stays in the selected
community channel. ZFE's terminal accepted command clears the outbox and shows
the private feedback without hiding the chat feed; a synthetic chat echo is no
longer required. General-channel xScal/ZFE Ruffle scenarios cover routing,
private feedback, and announcement/result visibility. Native acceptance remains
pending.

The compiled FWS v32 SWF SHA-256 is
`50b58a9c415dc71f08c047f9bef291a6df4f94f09021fd6de9b4b0ac8efc08c5`.
The one-entry BTDX v1 GNRL BA2 SHA-256 is
`4407256d7af0ddbf33e17b7bad21b6a8c66553acd923b5c4f0366d43fbed4de3`.
The path, hashes, flags, and sentinel were retained from 2.10.128; its
extracted SWF matches the compiler output byte for byte. Pure Haxe, source,
package, SWF, emoji, and complete 77-case Ruffle provider checks passed. With
Fallout 76 closed, this BA2 replaced only the local Dev `Data/FCMChatWidget.ba2`
and the root version stamp was set to 2.10.129. The installed hash matches the
reviewed BA2; Dev relay and link settings were preserved. Exact-file rollback
copies and a manifest are in
`/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-giveaway-channel-dev-77a3sex0/`.

## Chronological giveaway help candidate (2026-09-25)

**Widget version:** 2.10.128. The private help row now carries a UTC ISO
timestamp matching relay messages. It remains in chronological feed order as
new messages arrive, instead of sorting permanently after every dated row.
Pure feed-plan and ZFE/xScal Ruffle scenarios cover the order. Native acceptance
of this corrected artifact remains pending.

The compiled FWS v32 SWF SHA-256 is
`afd1b1c6b01a42533abca5a397bb24a01c6bf21e3fdc470ebc1abd1de56120b9`.
The one-entry BTDX v1 GNRL BA2 SHA-256 is
`fb3491d717cc8756916f2e545e485581c6b7a8ae6fa6688a6622df3fb5484256`.
Its original path, hashes, flags, and sentinel were retained; the extracted
SWF matches the compiled output byte for byte. Pure Haxe, package, source,
SWF, and emoji checks plus the complete 77-case Ruffle provider suite passed.
With Fallout 76 closed, this BA2 replaced only the local Dev
`Data/FCMChatWidget.ba2`; the root version stamp was set to 2.10.128. The
installed BA2 hash matches the reviewed hash. Dev relay/link settings and
their hashes were preserved. Exact-file rollback copies and a manifest are in
`/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-giveaway-help-order-dev-j30lnn_j/`.

## Private giveaway help candidate (2026-09-25)

**Widget version:** 2.10.127. Entering bare `giveaway`, `/giveaway`, or
`giveaway help` adds a local, private help row to the current HUD feed. The
command never goes to the relay or Discord. The row uses the normal chat feed
renderer and scrolls into view. The ZFE/xScal Ruffle scenario checks both
slash and slash-stripped input, private local storage, and rendered feed output.
The user's native ZFE screenshot confirms the help row. In the first native
giveaway trial, the command reached Dev but its bot announcement failed the
Dev `messages_source_check`. After the DB rule was repaired, the queued
announcement persisted, Discord's card repair linked the card, and the draw
result reached the ZFE feed. A fresh start-to-card trial remains pending.

The compiled FWS v32 SWF SHA-256 is
`c7d38eaf32766ee8356a2c6c36f7d1faf2026233fab33d7e0c48124f7e789d93`.
The one-entry BTDX v1 GNRL BA2 SHA-256 is
`cada8c6cbbf5b008d41c715eeed567b54909c7a0491d0cdc3015d79a4e87c85b`.
The original name, hashes, flags, and sentinel were retained; the extracted
SWF matches the compiler output byte for byte.
The pure Haxe, source, package, SWF, emoji, and complete 77-case Ruffle suite
passed. With Fallout 76 closed, this BA2 replaced only the existing local Dev
`Data/FCMChatWidget.ba2`, and the root version stamp was updated to 2.10.127.
The installed BA2 hash matches the reviewed hash above. ZFE 0.15.0, the Dev
relay/link settings, loader and archive registries were unchanged. Exact-file
rollback copies and config hashes are in
`/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-giveaway-help-dev-vai8dcu6/`.

## Giveaway candidate (2026-09-25)

**Widget version:** 2.10.126. The HUD now routes linked-account giveaway
start/list/last/join/leave/stop commands through the Events channel, suppresses
the command's public optimistic row, and displays a private send receipt. The
Events feed receives the persisted announcement and result text. Pure Haxe and
the complete 77-case Ruffle suite passed on this source, including both provider
routes. Native ZFE/xScal acceptance has not yet been performed for this build;
the game install remains untouched.

The compiled FWS v32 SWF SHA-256 is
`c2b79c34604e3ec541e31df08898b13abebb4b57cbb2e37d95ba36eb978b09c4`.
The rebuilt one-entry BA2 SHA-256 is
`ab193241111297cbd61da4cf9e6f64913dea4d9fddbdacf283a75c47eafdbf2d`.
The BA2 retained the BTDX v1 GNRL header, path, hashes, flags and sentinel;
its extracted SWF equals the compiled SWF byte for byte. No package was published.

**Local hosted-Dev install (2026-09-25):** With the Steam/Proton game closed,
the reviewed 2.10.126 BA2 replaced only `Data/FCMChatWidget.ba2`, and the root
version stamp was updated. The existing ZFE fragment and inactive `xscal.ini`
each had only their relay endpoint changed from Prod to
`wss://dev.falloutchatmod.com/relay`. A follow-up corrected the separate
`Data/FCMChat.ini` `linkUrl` from the Prod `/link` page to
`dev.falloutchatmod.com/link`; the first install had missed this field. The
game was closed, only that line changed, and its exact rollback file is under
`/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-giveaway-dev-link-siwl8bgh/`.
The ZFE 0.15.0 DLL, other settings, HUDModLoader entry, and archive list were
unchanged. The installed BA2 hash
matches the reviewed hash above; the widget has one loader entry and one
archive-list entry, with no `FCMServerBridge.ba2`. Exact-file backups and
pre-install hashes are in
`/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-giveaway-dev-1sp3d8ri/`.
Native acceptance is pending. Hosted Dev was healthy at install time, but its
running backend initially predated the giveaway service changes. On 2026-09-25,
the pushed `3075209f` Dev source was staged separately and only `backend-dev`
was rebuilt; the new backend is healthy and the Dev Events channel retains its
Discord mapping. The pre-deployment HUD giveaway command was rejected by the
old relay and must be submitted again. Fresh native result/Discord acceptance
is still pending.

## ZFE controller keyboard visibility correction (2026-09-24)

The user confirmed that physical Insert now opens chat with a controller active, but the
SharedHUDTools 300×180 controller keyboard appears below the text entry. The widget explicitly
placed that keyboard on-stage. `FormatOnScreenKeyboard` remains required by the host editor,
so the widget now positions it off-screen at `(0, -300)` while retaining the physical-keyboard
focus handoff to the visible host entry and the host ControlMap lock. The controller-mode Ruffle
scenario asserts this position and focus handoff. Fresh in-game Insert, typing, gameplay lock,
and Escape acceptance were subsequently reported by the tester for this corrected artifact.

The focused scenario failed before the placement change and passed afterward. All 75 Ruffle
scenarios, including both xScal input routes, then passed. Pure Haxe, native adapter/auth,
compiler diagnostics, source/package/SWF/BA2/emoji checks passed. The rebuilt one-entry BA2
contains the compiled SWF byte-for-byte (SWF SHA-256
`a40ab20a1e7e2c839c7c5833e6ebd2ee729ffd457ee7c6f6acdf9fab43574787`; BA2 SHA-256
`66d1d90246723d99838ab5620192b50fe1083a23cf55f80c11b8e47527ef464e`). The ZFE-only
Prod test ZIP is `FCMChatWidget-2.10.125-ZFE-No-OSK-Test.zip` (SHA-256
`233e62fe5c894b19f81dfdc3e2c9702b6ef0c703d2716fe87d2d0ffa76409912`). With the game
closed, the BA2 was installed locally; ZFE and all configuration files were hash-checked
unchanged. Rollback backup: `.extender-backups/before-zfe-no-osk-20260925T031013Z/`.

Native provider cross-check (2026-09-25): with this same BA2, the tester reported that
controller-active physical Insert, `MIW` keyboard entry without the extra on-screen keyboard,
gameplay/map lock while editing, and Escape control recovery worked on xScal 0.2.18 and ZFE
0.15.0. The fresh xScal log independently records widget 2.10.125 loading, `provider=xscal`,
a physical Insert edge, and `invalid_session` confirmation after ending input. The ZFE log
records the corrected `FormatOnScreenKeyboard ok x=0 y=-300` and physical-keyboard focus
handoff from the earlier in-game run on this exact BA2. It did not advance after the final
return swap, so that last ZFE report has no separate fresh log. The local active DLL is again
ZFE 0.15.0; the xScal DLL and settings are backed up under
`.extender-backups/before-zfe-recheck-no-osk-20260925T043604Z/`.

## Local ZFE controller-mode keyboard candidate (2026-09-24)

The user confirmed that the restored SharedHUDTools path locks gameplay keys in keyboard mode,
but physical Insert does not open chat while a controller is active. The previous widget registered
Insert with `hotkeys.v1` and then omitted its numeric `Input.*` registration. This candidate
keeps both ZFE open-key routes, while leaving xScal's native text session unchanged. In
controller mode HUDTools focuses an off-screen controller field; FCM now focuses the visible
host entry field from the public display list so a physical keyboard can type while the host
ControlMap lock stays active. A failed host editor still refuses an unlocked ZFE draft.

The full 75-case Ruffle suite, including the new controller-mode open/focus scenario and both
xScal input routes, passed. Pure Haxe, compiler diagnostics, source anchors, SWF, emoji,
BA2-tool, and package checks passed. The rebuilt one-entry BA2 preserves the GNRL header and
record identity and contains the compiled SWF byte-for-byte. SWF SHA-256:
`f90ea768649d5f27f3d67bbe92bb3031db979c67fffa690e798297bcad207e62`.
BA2 SHA-256: `f89e089030c5cf0ecfda1b9b526e9ffbe211b138f313a896de1bc540f9ee6fbb`.
With the Steam/Proton game closed, only `Data/FCMChatWidget.ba2` was replaced locally;
three existing configuration files were hash-checked unchanged. Rollback backup:
`.extender-backups/before-zfe-controller-keyboard-20260925T003431Z/` in the game root.
ZFE 0.15.0 was not replaced. Native controller-mode Insert, physical-keyboard text entry,
ControlMap suppression and post-close recovery remain unverified on this exact build.

## ZFE ControlMap editor restoration (2026-09-24)

The latest local trial proved that ZFE `input.v1.begin` opened while Fallout still handled
Forward, StrafeRight, Activate, QuickInventory, and Map. The 2.10.116 route used the
SharedHUDTools host editor, which starts the game's balanced ControlMap text lock;
2.10.117 changed ZFE to prefer `input.v1`. This candidate restores SharedHUDTools as the
automatic ZFE route. xScal still selects its native text session when available and the
shared host editor otherwise. An unavailable ZFE host editor now refuses entry rather than
starting an unlocked `input.v1` or legacy-buffer draft. M/`Map`/`QuickMap` and
I/`QuickInventory` no longer act as editor-exit commands, and the host consumes unhandled
gameplay actions while editing. Native acceptance remains pending.

The pure Haxe, native-adapter, auth, source/package/SWF/emoji and BA2 checks pass,
along with the full 75-case Ruffle suite. The installed one-entry BA2 contains the
compiled SWF byte-for-byte and has SHA-256
`9608f878fd1e669e75ca5488c3f985e2d54b80eb763a235caa213cfae79e9eae`.
Only `Data/FCMChatWidget.ba2` was changed in the closed Steam/Proton game. The previous
archive and install manifest are in
`.extender-backups/before-zfe-controlmap-20260925T000136Z/`. ZFE remains the validated
0.15.0 DLL. In game, Insert must log `input path: shared-hud-tools` followed by
`FormatTextEdit ok`, `FormatOnScreenKeyboard ok`, and `opened`; M, I, and W must type
without opening game UI or moving the player. Enter/Escape must release the editor and
restore normal controls.


## Local ZFE input-guard follow-up (2026-09-24)

The previous local run opened a native chat session but pressing M delivered `QuickMap`;
the widget closed that session and allowed the map to open. ZFE recorded 26 raw suppressed
inputs and zero async suppressed inputs. The earlier `input path` log used a category with
a space and did not appear, so its absence did not establish that `input.v1.begin` failed.
This follow-up keeps the owner-scoped session active on QuickMap, consumes unhandled HUD
gameplay actions while it is open, and logs `input path: zfe-input-v1 controller-test`
under the ordinary `input` category. This does not establish that native game input is
fully suppressed; the in-game M/W trial remains required.

All pure Haxe suites, package/source/SWF/emoji checks, and the full 75-case Ruffle suite
passed. The rebuilt BA2 contains the compiled SWF byte-for-byte and has SHA-256
`06b1f4443b069bae6cea24d6a0d627bfe2279ca9aef3d7d8cecbb9edcc7a5f04`.
With the game closed, only `Data/FCMChatWidget.ba2` was replaced in the local ZFE test
install. The prior archive and install manifest are in
`.extender-backups/before-zfe-input-guard-20260924T232822Z/`. ZFE remains the same
validated 0.15.0 DLL. Native acceptance and public release remain pending.

## Local 2.10.125 ZFE hotkey test candidate (2026-09-24)

The ZFE hotkey poll decoder now accepts the documented `success`/`presses` response without
requiring a registration echo. It still rejects a mismatched echo and logs rejected polls. The
pure Haxe, source, package, SWF, emoji, and full 74-case Ruffle gates passed. This is a local
native test candidate, not a new public release or an in-game accepted fix. It retains the
2.10.125 version string; identify this build by BA2 SHA-256
`50fc046109db386ae20426cb8fd1d235dcb89d103ba5b317a012ad8e84c87f08`.

With Fallout 76 closed, the Steam/Proton desktop was switched from xScal plus the invisible
`FCMServerBridge` to the visible widget plus the previously validated ZFE 0.15.0 DLL
(SHA-256 `3431d70517fd979e4f5193b1d9fd9d76dae7a8d341fae9838e5249b8f3fcb8b0`).
The active loader/archive registries contain `FCMChatWidget` and no `FCMServerBridge`; the
existing `FCMChat.ini`, provider auth data, unrelated archives, and inert `xscal.ini` were
preserved. The installed BA2's extracted SWF matches the source SWF byte-for-byte. Rollback
copies are under the game directory's
`.extender-backups/before-zfe-hotkey-widget-20260924T225426Z/`.

Native acceptance is pending. In game, press Insert, confirm an `input path` marker for
`input path: zfe-input-v1 controller-test`, type M without opening the map, submit and cancel with
Enter/Escape, and verify ordinary movement/map controls resume after input closes.

## Isolated 2.10.125 release candidate

**Widget version:** 2.10.125. The bounded cancel diagnostics remain in the
exact native-tested BA2; release-candidate packaging leaves its bytes unchanged.

In the 2.10.124 native run, Escape immediately made the game appear frozen,
although the HUD continued logging for roughly 47 seconds. xScal reported
`cancelled`, `EndInput` returned an undocumented non-Boolean value, and the old
session ID then returned `invalid_session`. Those observations do not prove
that keyboard capture or gameplay input recovered. This build adds only
privacy-safe timings around EndInput and the release probe, an exit marker,
a one-second UI heartbeat, and a one-shot next-HUD-event marker. It must not
be considered native-accepted unless Escape and gameplay recovery pass in game.
Two subsequent native Escape trials completed with `invalid_session` release
confirmation and later HUD input; the user reported no freeze. The cause of the
earlier apparent freeze remains unknown. The full 72-case Ruffle matrix, Haxe,
source, package, emoji, SWF and BA2 checks passed for 2.10.125. The user accepted
the local native test; the available log independently establishes only the two
cancel/recovery cycles, not every action in the wider input matrix. The
public xScal Nexus files page listed 0.2.17 on 2026-09-23 and 0.2.18 on
2026-09-24. The public-version gate is cleared, but the public DLL has not been
byte-compared with the locally tested provider.

This branch targets the author-supplied xScal 0.2.18 `Input.BeginInput`,
`Input.PollInput(sessionId)`, and `Input.EndInput(sessionId)` contract. xScal
returns full native-edited text and terminal submit/cancel state as JSON;
FCM never synthesizes characters from key codes. The widget uses the session
route only when a valid begin succeeds and keeps SharedHUDTools for older xScal.
The attached DLL is test evidence, not bundled or installed by the HUD package.
Controller-connected typing, suppression through Enter/Escape release, and
gameplay recovery were tested locally; retain the distinction between the
user's acceptance and the narrower logged observations. See the worktree's
`XSCAL-SESSION-INPUT-READINESS.md` for artifact hash and acceptance gaps.
The 2.10.122 native run detected Insert and opened one session but logged no
message send; later Insert edges did not reopen input. The session lacked poll/
end diagnostics. This revision logs sanitized begin, rejected/terminal poll,
end result, and blocked reopen status. A validated submitted poll now dispatches
its text regardless of EndInput's undocumented return value. An unconfirmed
end still blocks reopening until reload to avoid overlapping native owners.
The fresh 2.10.123 native run sent and reconciled one message but logged
`xScal end result=other`, then blocked Insert. Version 2.10.124 makes one
post-end `Input.PollInput(oldId)` probe. Only the native `invalid_session`
response confirms release; an active or malformed response remains blocked.

## Local 2.10.121 quoted-message candidate (2026-09-22)

Received `chat.message` bodies are JSON-decoded exactly once in `parseAndRenderEvents`, before
control handling, self-echo reconciliation and row creation. The previous raw escaped body did
not match the unescaped optimistic send, leaving a pending copy that sorted beneath newer dated
messages. Keep `FcmEcho`'s strict body and message-ID matching; the fix is at the input boundary.
`FcmConfig.decodeJsonText` now handles quoted strings, backslashes, escaped slashes, control
escapes and basic Unicode escapes. `TestFcmConfig` and the compiled `quoted-echo` scenario cover
the decoded single-row behavior on xScal and ZFE.

All 23 pure Haxe suites, the 67-case Ruffle matrix, SWF structure, emoji linkage, package checks,
and BA2 extraction/decoded-SWF byte comparison passed locally. The resulting one-entry BA2 has
SHA-256 `1b9393d1a210d27fa182a56db2c8dcf37ba2d9882bcbfc0139098efbf6892492`.
With Fallout 76 closed, that exact BA2 was installed on the local Steam/Proton desktop.
`Data/hudmodloader.ini` now registers `FCMChatWidget` and `ImprovedBars`; the active archive list
contains `FCMChatWidget.ba2`, `ImprovedHBS21.ba2`, `NoRewardScreen.ba2`, and `HUDModLoader.ba2`.
The optional `FCMServerBridge.ba2` was removed from the active game directory. The pre-switch
files are recoverable under
`/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/.extender-backups/before-quoted-widget-TOhLzv3c/`.
The widget uses the existing xScal production relay settings. No fresh in-game test, hosted CI,
release, or publication is claimed for this candidate.

**Widget version:** 2.10.121. XSCAL-SHAREDHUDTOOLS-ROLLBACK restores the verified
capability-gated ZFE owner-scoped text input and configured hotkeys. xScal continues to poll every
supported configured physical key through its documented `Input.*` API and uses SharedHUDTools
for best-effort text entry. Controller-active xScal typing is not supported. It is not approved for publication or promotion. It
retains 2.10.116's Server transcript and
bounded authenticated room diagnostics, and retains accepted Server rows in memory across room
changes for the current widget/game session. Live authorization and sends still use only the
current confirmed room; the existing message cap bounds the transcript. Fixed-enum lifecycle events are sent only on state
transitions through the existing capability-gated `chat.v1` control path. They contain provider,
selected roster source, count and build only; no names, IDs, messages or tokens. The backend's
24-hour pseudonymous evidence ring correlates them with changed roster, grace, split and assignment
decisions. The HUD sends only when `getAuthState` advertises `canSendRoomDiagnostics`, making
backend-first rollout and backend rollback safe.

The candidate retains 2.10.112's delayed Server-history ordering and a privacy-safe, one-shot identity-field inventory across supported BSUI roster
surfaces. The inventory records field names only and transmits no values. 2.10.112 slots delayed retained Server rows into
General by their original relay timestamp, excludes replay older than General's loaded history
horizon, and keeps the complete chronological replay in the Server subtab. It retains 2.10.111's
bounded roster-visible local-name evidence and token-owned authenticated identity/message
attribution. Fresh native acceptance is pending; 2.10.110 remains the current production release.
It reserves Enter for text submission, moves selected-link activation to F8 by default, and
recovers a stable draft from transient empty SharedHUDTools observations. This is the explicit
opt-in HUD-mod track. The desktop overlay never installs or modifies it.

2.10.117 prefers ZFE's owner-scoped `input.v1` text session when both input and release-barrier
capabilities are advertised and registers supported configured actions through `hotkeys.v1`. It
retains SharedHUDTools for older ZFE and xScal, rejects mixed-provider installs, and remains
native-unverified.

The 2.10.117 CONTROLLER-TEST results and hashes are recorded in
`CONTROLLER-TEST-MANIFEST.md`. The prior 2.10.116 complete Haxe/source/native-adapter/package/SWF/BA2/emoji gates passed, as did the
complete 60-case Ruffle suite (4.2 minutes). The rebuilt one-entry BA2 was extracted and its SWF
matched the normalized source artifact byte-for-byte. The reviewed prior 2.10.116 local artifacts are
SWF SHA-256 `0a4affef053a5eabf66dd5c01eeabcc9acf93057898a5ed7c9356dece315ef51`
(7,185,998 bytes) and BA2 SHA-256
`240759e5346be7db746b59dd603fcf35276e59eaa7b0ed0225b6b1756df9b65d`
(7,186,087 bytes). Private PROD Website and Nexus test packages are staged in Downloads. Version
2.10.117 CONTROLLER-TEST has not been installed or natively accepted and remains unpublished and
unapproved for public distribution.

## Status and scope

**Released 2026-09-16.** Commit `775905d0` was promoted to production through merge
`782024f6`. The complete local Haxe/source/package/SWF/BA2/emoji gate and 37-case Ruffle suite
passed, followed by hosted CI and fresh native checks. The exact production packages are:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `FCM HUD Mod-2.10.110 (PROD)-Nexus.zip` | 5,991,747 | `6883fa5f0ff734590027e82c053c116c5a235c7756633d0b9ce47b63567df0db` |
| `FCM HUD Mod-2.10.110 (PROD).zip` | 5,993,156 | `1a8be8f7b48d5f74ad2e992fbdce4ae4703e6e2a7d47047a64d4b97b0403fc90` |

Both packages contain BA2 SHA-256
`7db1b0149d637772c0c1db8b884c8dc41e3017c0833e23ad242db50edd7422b2`.
Nexus file `23572` is Main and the website release feed reports HUD `2.10.110` while retaining
desktop overlay `1.3.100`. The HUD-only Discord announcement was posted with suppressed
notifications. The [release record](../../../docs/deployment/hud-2.10.110-release-notes.md)
contains the public notes and evidence split.

Fresh 2.10.108 logs from both xScal machines prove its retention marker is contiguous with the
last consumed cursor at the 128-entry boundary. The old unconditional loss path replayed history;
that replay generated a 77-entry retirement marker and sustained the loop. 2.10.109 acknowledges
contiguous or stale retirement markers without resyncing. A marker that skips forward, lacks a
usable ID, or otherwise proves an unread gap still fails closed into the existing recovery path.
Pure tests and compiled scenarios cover both cases. The bounded numeric-only diagnostics remain.
Fresh 2.10.109 xScal runs on both test machines crossed the former failure boundary with no
history resync and no FCM errors; 2.10.110 retained that behavior.

2.10.105 native probes confirmed E1014 before the first instruction of `FcmRoster.readNative`,
including on empty/local synthetic payloads; numeric helpers passed. 2.10.106 restores the
pre-2.10.103 reading split: player/party/marker/voice rows are traversed in the widget, and
map/public-team rows use the earlier closure-based `FcmRoster.readNames` helper. The unified
`readNative` method remains diagnostic-only and is absent from the live collection path.
Invalid/damaged lists are rejected and lengths stay bounded. Copied observation timestamps,
effective-roster selection, history retention and relay confirmation/expiry safeguards remain.
Native 2.10.106 reads populated map/public-team/marker snapshots without the earlier errors.
The exact bytecode construct causing GFx's rejected unified method remains unidentified.

The exact 2.10.106 production-target ZFE candidate was installed on the desktop after passing the
local Haxe/source/package/artifact checks and all 33 Ruffle cases. Only the BA2 and root version
stamp changed; the prior files have a recoverable backup and settings are unchanged. This run
revealed a separate startup auth race: the first ZFE auth read precedes the native handshake,
but subsequent event polls only refreshed xScal. History/rosters arrive while Server joining
remains auth-gated. 2.10.107 refreshes pending/missing-identity ZFE auth on normal event polls,
retaining xScal's continuous checks and avoiding redundant reads once ZFE settles. No user
message, forced reconnect or weakened Server gate is needed. Delayed-auth Ruffle scenarios
exercise both providers through real timer-driven auth, roster and visible-tab recovery.
Fresh 2.10.107 desktop ZFE logs now confirm automatic authentication, history completion and
relay-confirmed binding, followed by a populated 23-name map roster, without a user send or
roster error. Two Server sends reconcile their echoes without duplicate rows, and one loading/
fast-travel cycle preserves the room despite empty auxiliary lists. In that intermediate run,
real hop/MainMenu, repeated/extended empty-primary fallback and laptop/xScal checks remained
outstanding; later release evidence is summarized above.
See the [fresh evidence](../../../docs/testing/hud-xscal-acceptance-2026-09-15.md#210107-desktop-zfe-automatic-startup-binding-passes).

2.10.107 passes all local Haxe/source/emoji/artifact/package checks and the complete **35-test**
Ruffle suite, including delayed authentication through both providers and automatic teardown.
Production-target ZFE/xScal Nexus and unified website artifacts are built under
`/tmp/fcm-hud-2.10.107-BAc2G4/`. The tested provider-identical BA2 and version stamp were installed
on the desktop after verifying the game closed. Exact prior files are recoverable under
`.extender-backups/before-fcm-hud-2.10.107-dJcA9w/`. Settings and loader configuration are
byte-identical; saved auth remains untouched. Desktop ZFE startup binding, Server send/echo
and one same-room travel cycle passed natively. This paragraph describes the unpublished
2.10.107 precursor, not current release status.

The subsequent authorized test setup installs the same 2.10.107 BA2/stamp on the MSI laptop
through SSH Manager and switches only the desktop provider DLL from ZFE to the verified
xScal 0.2.16 build. Both machines now have 2.10.107 with xScal configured for prod; each game
was closed during installation. Settings, archive registration and saved credentials are
untouched, with exact-file backups retained. Fresh native xScal acceptance is still pending
on both machines at install time; see the [installation evidence](../../../docs/testing/hud-xscal-acceptance-2026-09-15.md#210107-laptop-install-and-desktop-xscal-test-setup).

Subsequent xScal logs confirm automatic authentication and binding on both machines and a matched
desktop Server-send echo. However, both develop repeated dropped-event/history-RESYNC cycles
after roughly six minutes. This issue blocked 2.10.107. The 2.10.108 diagnosis established
contiguous queue retirement, and 2.10.109 fixed the recovery decision without weakening real-gap
handling; that correction shipped in 2.10.110.
The complete 35-case Ruffle rerun and local source/artifact checks pass, but do not accept the
soak-test failure. Fresh byte-identical builds and unified prod Nexus/website packages are in
`/tmp/fcm-hud-release-2.10.107-VbN645/`, recorded as blocked historical candidates in the
[release record](../../../docs/deployment/hud-2.10.110-release-notes.md).

### Previous diagnostic candidate

Native 2.10.104 loaded on desktop ZFE at 11:28:41 on 2026-09-16 and still threw E1014 on all
six roster sources. Removing the shared decoder classes did not resolve the Server-tab regression.
2.10.105 retains that decoder and adds fixed phase labels for acquisition, decoder entry,
length validation, name traversal and snapshot storage. Failures log numeric error IDs, throttled
to one per source per 30 seconds. After the first failure, one local synthetic probe checks numeric
helpers and empty/player/map/team decoding; it cannot write snapshots, send controls or renew leases.
The probe preserves the original failure phase. This build is diagnostic, not a confirmed fix.
The background bridge remains unchanged. Existing source selection, room gates and leases remain
in force. The 2.10.102 results below are historical evidence only.

2.10.105 passed the local Haxe/source/package/artifact gates and full **33-test** Ruffle suite,
including diagnostic isolation/privacy through both providers. The tested production-target ZFE
BA2 and version stamp are installed on the desktop after a game-closed check and exact-file backup.
Settings were unchanged. The subsequent native diagnostic result is recorded in the
[acceptance record](../../../docs/testing/hud-xscal-acceptance-2026-09-15.md#visible-widget-210104-failed-acceptance-210105-diagnostic-candidate).

The source and local SWF/BA2 include combined General, retained-message replay protection,
stricter own-echo matching, delayed-render failure recovery, and configurable scroll bindings.
The previous locally installed 2.10.100 targeted hosted Dev with ZFE. After relay/auth corrections,
the user confirmed linking works, and the reviewed log shows history completion and matched
self-echoes. Same-server fast travel then exposed an empty `TeamMarkers` snapshot incorrectly
clearing Server history. The previous 2.10.101 build was installed locally with official xScal 0.2.16 against
hosted Dev. Its native run confirmed startup/history/General sends but exposed a second same-world
reset: an empty map masked populated public teams until the empty grace expired. Candidate 2.10.102
corrects that selection in both HUD and bridge. The native 2.10.102 run confirmed history,
General/Server echoes and room continuity through two loading transitions with a populated map.
The exact empty-map fallback still needs native acceptance. That visible HUD was then retained
inactive for the separate FCMServerBridge/xScal/hosted-Dev test; the desktop is now testing the
visible widget again. The two must not share the native queue.
At that point Prod was unchanged and hosted CI was still required. This is historical evidence
for 2.10.102; see the release status at the top of this file for the current state.
The 2.10.100 correction keeps the low-end render coalescing/six-row slices while moving ZFE's
two-stage send/control receipt decoding onto the bundled GFx-safe JSON reader.
The 2.10.101 correction prefers fresh map/player rosters over nearby/team lists, waits through
bounded transient empties without extending relay leases, and preserves real hop/MainMenu
leave behavior. Its Ruffle scenario asserts real widget history/tab/nonce/control state through
both providers. Restoring the faulty auxiliary-boundary rule makes both regression cases fail.
The 2.10.102 selector uses an overlapping populated player/public-team fallback when a higher
priority map is empty. Disjoint cached fallback names cannot bypass that empty primary, while a
populated primary still detects a real hop. Nearby-only lists never override an empty primary.
Freshness, empty-grace and backend lease limits are unchanged; no new timer or network call is added.
The regression first failed on HUD and bridge under both adapters, then passed in the complete
28-test Ruffle suite (40.4 seconds). Repeated map/public-team source-switch cycles were subsequently
added for both consumers/providers; the complete suite passed again in 36.2 seconds. Native
empty-map fallback and real-hop acceptance remain required.
The game-closed 2.10.102 install changed only the widget BA2 and its two version stamps. Its
decoded SWF matches the tested normalized artifact byte-for-byte; xScal, settings, credentials,
loader registration and archive order were preserved. The prior HUD has a recoverable backup.
All local pure Haxe/native/source/package/SWF/BA2/emoji checks and the complete 28-test Ruffle
suite passed before the xScal installation (36.9 seconds). The extracted installed BA2 SWF matches the tested normalized artifact;
automatic teardown released the harness port. These results do not claim hosted CI or GFx
acceptance. The 2.10.101 game-closed install preserved the existing configuration and kept a recoverable
ZFE/HUD backup. See the [xScal acceptance record](../../../docs/testing/hud-xscal-acceptance-2026-09-15.md).
Earlier desktop ZFE colors/emoji confirmation is
recorded separately in [styling history](../../../docs/testing/hud-emoji-status.md).

For current Fallout 76 English assets, body/feed/input text uses `$MAIN_Font` and headings/names
use `$MAIN_Font_Bold`. `interface/fontconfig_en.txt` does not map `$MAIN_Font_Light`; do not restore
that alias or body glyphs will render as square placeholders.

[README.md](README.md) describes current behavior and install steps.

## Requirements

- Haxe and Python 3 for compilation, normalization, and packaging; these run on Linux CI.
- Node for the JavaScript/UTF-16 emoji checks and the existing backend/overlay suites.
- A validated HUDModLoader installation and one selected ZFE/xScal provider for in-game testing.
- The provider's required native-chat methods/capabilities, verified at runtime. A version number
  alone is not sufficient. Use the [provider guide](../../../docs/overlay/zfe/modder-guide.md).
- ZFE must advertise `zfe-chat-async-send-v1` for user messages. The widget refuses synchronous
  ZFE sends because native network stalls block Fallout's Scaleform/UI thread.
- ZFE must advertise `zfe-chat-async-control-v1` for automatic Server-room roster and leave
  controls. xScal uses its asynchronous `chatInterface` path. Older ZFE builds retain static
  community chat but cannot bind Server chat.

Modern widget builds do not require Bethesda's HUDMenu or FFDec recompilation. If FFDec or an
archive skill/tool is unavailable, identify that limit and use the repository's tested format
checks; do not claim those tools ran. The standalone HUDMenu path is a separate legacy build.

## Build the archive

From `game-mods/FCMBridge/hudmodloader-chat/`:

```bash
haxe build.hxml
python3 normalize_swf.py FCMChatWidget.swf
python3 ../tools/validate_swf.py FCMChatWidget.swf --require-signature FWS --require-version 32
python3 emoji/test_embedded.py
```

Normalization embeds the bundled emoji sprites for the widget and emits the required FWS v32
artifact. It is more than a version-byte edit. Validate declared length, frame rectangle, tags,
ABC blocks, and final End tag. For the reviewed candidate the stage is 400×300 at 30 fps; do not
substitute a guessed 1920×1080 SWF rectangle for the widget's actual contract.

Fingerprint an existing archive before changing it. The checked-in widget is **BTDX v1 GNRL**,
with exactly `interface/FCMChatWidget.swf`. Preserve that verified container's entry metadata:

```bash
python3 ../hudmenu-chat/ba2tool.py blobswap FCMChatWidget.ba2 /tmp/FCMChatWidget-rebuilt.ba2 \
  interface/FCMChatWidget.swf=FCMChatWidget.swf
python3 ../hudmenu-chat/ba2tool.py extract /tmp/FCMChatWidget-rebuilt.ba2 \
  interface/FCMChatWidget.swf /tmp/FCMChatWidget-extracted.swf
cmp FCMChatWidget.swf /tmp/FCMChatWidget-extracted.swf
```

Inspect the entry set/header/index metadata as well as exact decoded payload equality before
replacing the local generated BA2 with the rebuilt file. `ba2tool.py create` is available for a
new verified v1 GNRL widget archive; neither command is a universal BA2-format conversion tool.
Version-string presence alone does not prove the BA2 matches the compiled source.

## Required checks and CI

The repository's `.github/workflows/ci.yml` `gamemod-anchors` job covers the widget's Haxe logic,
source anchors, config/packaging, native adapter/auth, emoji catalogs/embedded assets, and SWF
compile validation. Run the same affected checks locally. From the widget directory:

```bash
for suite in test-*.hxml; do haxe "$suite" || exit 1; done
python3 emoji/generate.py --check
haxe -main TestFcmEmojiLayout -js /tmp/fcm-emoji-layout.js
node /tmp/fcm-emoji-layout.js
haxe -main TestFcmEmojiCommand -js /tmp/fcm-emoji-command-test.js
node /tmp/fcm-emoji-command-test.js
haxe -main TestFcmEmoji -js /tmp/fcm-emoji-test.js
node /tmp/fcm-emoji-test.js
python3 test_package.py
python3 ../hudmenu-chat/test_anchors.py
python3 ../hudmenu-chat/test_ba2tool.py
python3 ../tools/test_validate_swf.py
```

From `game-mods/FCMBridge/`, run `haxe test-native-api.hxml` and `haxe test-auth-flow.hxml`.
After Haxe edits, run available compiler diagnostics; the local fallback is
`haxe build.hxml --no-output --display FCMChatWidget.hx@0@diagnostics` in the widget directory.
From `backend/`, run `npm test -- --runTestsByPath tests/relayHandler.test.js` for relay behavior.
From `cross-platform-overlay/`, the existing `__tests__/fcm-chat-widget-logic.test.js` suite covers
JSON event boundaries. Run additional suites when their owning behavior changes.

Local success is not hosted CI success. PR CI is maintainer-label gated as described in
[the CI guide](../../../docs/testing/ci-cd-pipeline.md); follow that review process for promotion.

## Target-specific packages

After validating and selecting the rebuilt local `FCMChatWidget.ba2`:

```bash
python3 package.py --print-version
python3 package.py --target dev --provider unified --distribution website --output /tmp/FCMChatWidget-dev.zip
python3 package.py --target dev --provider unified --distribution nexus --output /tmp/FCMChatWidget-dev-nexus.zip
python3 test_package.py
```

`--target prod` stamps the production endpoint/link host. `--provider zfe|xscal` makes a
provider-specific ZIP; the default unified ZIP has complete `ZFE (Install for ZFE only)/` and
`xScal (Install for xScal only)/` folders.
Inside either folder, open `Data (drag the contents into data folder)/` and drag its contents into
the game's `Data/` folder. Do not copy the labeled folder itself. Skip edited INIs.
The main ZIP contains no `.cmd`/`.ps1` helper: users choose one folder and follow its `INSTALL.txt`.
For Quick Configuration 2 or NukaMods, users extract the main ZIP and import only the chosen
provider's `Data (drag the contents into data folder)/FCMChatWidget.ba2` as a BA2 mod. The manager owns its Data placement and archive
list entry; the chosen `INSTALL.txt` covers the separate HUDModLoader entry and provider/FCM INIs.
The combined ZIP itself must not be passed to a mod manager: it contains two copies of the same
BA2 under different roots. Verify one `Data/FCMChatWidget.ba2` and one archive-list entry after
deployment, and preserve edited INIs on update. Before calling a release manager-compatible, use
a clean test profile in each manager to import the selected BA2, enable/deploy it, confirm the
single Data file and archive-list entry, update the BA2 while retaining edited INIs, then disable
or uninstall and confirm that the manager removes its BA2/list entry without replacing the user
configuration. Repeat for ZFE and xScal. The packaging check cannot certify these manager actions.
The folder layout is a package-only behavior covered by `test_package.py`; Ruffle cannot exercise
ZIP extraction or INI merging. Native startup still requires the separate in-game acceptance matrix.
Production configuration is not deployment authorization or proof that the endpoint is enabled.

The packager checks the embedded version and target stamps. Validate both ZIP BA2 copies against the
reviewed BA2 bytes and inspect each provider folder. Nexus distribution omits executable/script
files and rejects executable magic. Legacy xScal-only website ZIPs may contain an optional Windows
setup helper; the main ZIP and Nexus variants contain manual xScal instructions only. No extender DLL is redistributed.

## Configuration and install layout

The main ZIP has `ZFE (Install for ZFE only)/` and `xScal (Install for xScal only)/` folders. Each has
`Data (drag the contents into data folder)/FCMChatWidget.ba2`, editable `FCMChat.ini`, and
`hudmodloader.ini` inside the labeled folder, with the
loader defaults and FCM line, and root `Fallout76Custom.ini` as an archive-list
merge template. `README.txt` at ZIP root combines setup, release notes, menu, keybinds,
customization, version, and provider metadata. Copy only the selected BA2 and missing FCM/ZFE
INIs; merge shared INIs without replacing existing files. Updates replace only the BA2.
Provider-specific ZIPs retain the single-provider root layout with a conventional `Data/` folder.
The packaged `Data/hudmodloader.ini` contains all 22 lines from HUDModLoader's
[upstream default file](https://github.com/GitCrazy-wc/hudmodloader/blob/71e2fde134933323777980b5e0fd0c6036c2408f/Config%20File/hudmodloader.ini)
plus `FCMChatWidget`. The snapshot is tracked in `HUDMODLOADER-UPSTREAM-DEFAULTS.txt` and
checked by `test_package.py`. Existing player registries must still be merged, never replaced;
the background `FCMServerBridge` belongs to its separate package.

| Provider package | Configuration |
| --- | --- |
| Unified | `ZFE (Install for ZFE only)/Data (drag the contents into data folder)/ZFE/TextChat/fragments/FCMChatWidget.ini` or `xScal (Install for xScal only)/xscal.ini`; open one provider folder only |
| ZFE | `Data/ZFE/TextChat/fragments/FCMChatWidget.ini` |
| xScal | `xscal.ini`, merged into `[Chat]` beside `Fallout76.exe` |

The modern ZFE fragment name matches the `FCMChatWidget` loader entry. The legacy `FCM.ini`
fragment is not its replacement. A DLL-only ZFE install is normal. The optional user-created
`Data/configuration/zfe.ini` `[TextChat]` section overrides fragment
keys, including endpoint and `OpenChatKey`. Keep `Data/FCMChat.ini` `openKey` aligned. xScal uses
`[Chat] enabled=true` and `relayEndpoint=wss://<target>/relay`; it has no `OpenChatKey` config.
The route is `/relay`, never `/zfe-relay`.

Follow the generated `README.txt`/provider `INSTALL.txt`: exit the game, merge the loader line exactly once, and append
the archive to the existing `[Archive] sResourceArchive2List`. If starting an otherwise empty
list with HUDModLoader, the relevant entries are:

```ini
[Archive]
sResourceArchive2List=HUDModLoader.ba2,FCMChatWidget.ba2
```

Preserve all existing archives and settings. Windows normally uses Documents/My Games/Fallout 76;
Proton uses the game's prefix Documents path. Restart after changing BA2/native configuration.
Reload alone can refresh widget settings but does not reload the extender's configuration.

## Input, fonts, and customization

Current ZFE builds use SharedHUDTools' host ControlMap editor for visible text entry.
The `input.v1` decoder remains for explicit diagnostics but is not selected automatically;
the legacy ZFE native buffer is not an unlocked fallback. xScal selects its native text
session when available and SharedHUDTools otherwise. Named HUD actions and physical key
polling share navigation handling, with guards keyed by normalized action name. Different aliases
can have separate latch keys; validate simultaneous named/physical delivery in-game. The shipped
navigation map is `NextPage`/`PrevPage` for Page Up/Down, `Up`/`Down` for feed scrolling, and
explicit blank values for `scrollBottomKey` and `hideKey`; feed scrolling requires a visible owned
editor. See [KEYBINDS.txt](KEYBINDS.txt).

Every hide entry point refuses to hide while an editor owns input. In particular, a configured
The default `hideKey=DELETE` is physically registered and returned to the SharedHUDTools or ZFE fallback editor so it deletes characters.
The binding resumes its hide behavior after the input session closes. `/hide` is evaluated after
submission and remains available, as does the idle F11 menu action.

The widget observes the host field's Enter/Escape/Tab edge and keeps its current draft only in
memory. It gives the normal SharedHUDTools callback a 225 ms grace window. If Enter removed the
field and no callback arrives, the widget submits the captured draft exactly once, calls the public
`EndTextEdit()` cleanup path, and invalidates the callback generation. Other sustained focus loss
cancels the stale session so Insert can open a fresh editor. Logs contain draft length and state,
never message text.

The widget uses runtime-proven Fallout font aliases with embedded-font mode; that is not proof
that arbitrary fonts/glyphs work. Rows use plain text plus formatting ranges, with row-local
vector decorations. See [appearance](../../../docs/overlay/zfe/ingame-chat-appearance.md) and
[CUSTOMIZATION.txt](CUSTOMIZATION.txt) for supported settings and persistence precedence.
xScal persistence needs a matching relay capability/payload implementation; deployment must be
verified separately. ZFE uses vendor-scoped settings storage.

### Staff moderation commands

A linked Discord moderator/admin/owner sees message references and the F11 moderation help.
Use an exact visible name (quote multi-word names), or a short visible `[#XXXXXXXX]` reference.
Duplicate names require a reference. The widget resolves immutable target IDs locally; the relay
repeats permission, protected-target, duration, and reason checks.

```text
/mod Alice mute <minutes> <reason>
/mod "Alice Smith" kick <reason>
/mod #XXXXXXXX delete <reason>
/mod #XXXXXXXX kick <reason>
/mod #XXXXXXXX mute <minutes> <reason>
/mod #XXXXXXXX unmute <reason>
/mod #XXXXXXXX ban <minutes|permanent> <reason>
/mod #XXXXXXXX unban <reason>
```

Every action requires a nonempty reason. Mute/temporary ban accept 1–43,200 minutes; permanent
ban must be explicit. Slow mode is not implemented. `/relink` uses a supported provider reset
operation and must not claim success on a rejected reset. Credentials remain extender-owned.

## In-game acceptance checklist

1. Record game distribution/version, provider version/probe, loader registration, archive order,
   effective endpoint, and actual `chatv1-widget-v2.10.88` startup marker. Compare the installed
   BA2's decoded SWF with the reviewed build. Do not infer target from a fragment alone.
2. Confirm exactly one FCM renderer. Test linked and limited states, late account data, correct
   public account handle, invalid-token recovery, and relink failure/success.
3. Send on all six allowed channels. General shows each once with its original tag; other tabs
   filter correctly; General sends only to `global`. Private/system/wrong-room SERVER content
   must not enter the view. Fast-travel within the same world: selected SERVER tab, history,
   and room must persist with no LEAVE. Then hop worlds: old membership must leave, new-room
   delivery must wait for confirmation, and the bounded accepted Server transcript must retain
   old rows while appending authorized new-room history. MainMenu/expiry must retain display rows
   but disable new Server delivery and sends.
4. Send identical messages intentionally, replay old history while a new send awaits ACK, and
   reconnect after retained-ID cache eviction. Distinct messages survive; old replays cannot
   consume a newer pending row. Exercise negotiated retry and ambiguous failure behavior.
5. Test Page Up/Down while idle and editing, arrows before/after input ownership, reversed/aliased
   bindings, blank newest binding, cancel, Pip-Boy transitions, rapid edges, and unload/reload.
6. Test short/wrapped/localized names, supporter stars, known/custom/unsupported emoji, independent
   colors, narrow/wide resize, clipped history, and new-message count while scrolled.
7. Select raw-link, Discord-channel, and scheduled-event rows
   using Up/Down. Confirm the highlight follows the row, the HUD displays a shortened URL, and
   empty Enter opens the full HTTP(S) target. Confirm unsafe schemes are inert and a missing desktop
   overlay produces the bounded prompt. Change `Selected message` through the F11 color submenu,
   restart both provider paths, and confirm the chosen color persists.
8. Exercise delayed render failure and stale callbacks across rebuild/reload; fallback stays
   readable and old work cannot overwrite the new feed. Confirm settings persistence separately
   on each provider with the matching backend.

Use [HUD recovery checks](../../../docs/testing/hud-recovery.md) for expanded scenarios.
Do not log tokens, message bodies, names, or stable account IDs. Record sanitized status/counts,
errors, timings, artifact hashes, and which behaviors were actually observed.

## Production rollout

Building or packaging does not deploy the relay, modify a game install, or publish downloads.
The backend defaults `RELAY_PRODUCTION_ENABLED` to false; verify deployment configuration and
an authenticated target handshake before a release. Keep backend permissions/migrations and
widget capability negotiation aligned. Complete hosted CI, target/provider runtime acceptance,
and the applicable release/distribution checks before publishing a future build. The 2.10.110
release evidence above is the completed instance of this gate.
