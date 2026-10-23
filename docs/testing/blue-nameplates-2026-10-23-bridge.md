# Server Bridge blue-name investigation, 2026-10-23

The user reports no blue overhead names with both players in the same world.
The visible widget has been removed on both machines. Desktop uses Steam
1.7.27.11, xScal 0.4.27 and Server Bridge 0.2.18 DEV; MSI uses the same game
and bridge with ZFE 0.24.0. The hosted Dev overlay is 1.4.3, with the separate
local QA-login polling fix. No production release or backend deployment is part
of this investigation.

- **[Confirmed]** Laptop authorization completed at 04:02:17 UTC and desktop
  authorization at 04:05:08 UTC. Fresh overlay logs show no later login timeout,
  HTTP 429 or terminal authentication failure during the captured run.
- **[Confirmed]** Hosted Dev room diagnostics contain fresh `bridge:zfe` and
  `bridge:xscal` roster observations through 04:12 UTC. Their final recorded
  canonical room references match and their observed roster sets intersect in
  19 entries. Account authentication and room discovery therefore succeeded.
- **[Confirmed]** Both games closed around 04:12:33–37 UTC. Subsequent roster
  expiry and missing active Redis rosters are expected cleanup, not evidence
  that the earlier room failed.
- **[Confirmed]** Normal bridge exports do not expose the color receiver's
  gate, caught native error, or lifetime private-presence counts. The existing
  captured provider logs do not resolve that stage. A post-exit absence of
  short-lived native request counters cannot prove that no request was sent.
- **[Confirmed]** The current vanilla HUDMenu asset still contains the
  `TeammateMarkerBase`, `TeamNameplates`, `Name_tf`, `entityID` and
  `NamePlateNameGroup_mc` symbol strings. Extracted asset SHA-256 is
  `01fed933c95527c3f6e76e572efe287bc212431a54d838643aaa0bd5f773d55c`.
  String presence alone does not prove native accessibility or attachment.
- **[Hypothesized]** Native receiver discovery, capability checks or a caught
  GFx error prevents private cosmetic presence. Confirm with the new gate/error
  probe; refute if the probe shows accepted private replies while names remain
  unpainted, which instead requires painter/source diagnostics.

The new `--nameplate-diagnostic` package writes fixed phase/error labels and
bounded request/accepted/rejected counts in the existing export's `build` field.
It adds no export fields, storage files, native calls, authentication, room
authority or input. Failed provider checks remain fail-closed. Normal packages
retain their exact version label. It is an unpublished diagnostic, not a color
fix or a native acceptance result.

Focused pure tests cover receiver error privacy and the diagnostic schema/cadence.
The isolated packaged Ruffle scenario exercises a missing public surface, later
surface attachment and painting, a numeric native failure, and automatic teardown
for both ZFE and xScal. The existing required `gamemod-anchors` and `hud-ruffle`
CI jobs discover these checks. Native acceptance remains pending a fresh run of
this exact diagnostic artifact. Local verification and installation hashes are
recorded with the conversation evidence and local test-setup runbook.

Local verification completed: 31 pure Haxe suites, seven source/package checks,
eight bridge package tests and 95/95 Ruffle cases. The full harness finished in
11.1 minutes and closed its listener on port 41739. Tested source hashes stayed
unchanged. Exact diagnostic BA2 SHA-256
`2ed8c482fab2bad989fedfe2d428fe9737f5d3c56c143178ffaa4b0ae945ec08`
and decoded SWF SHA-256
`df8d88dff4a763c6cb324a431fa208d29b376eefce1231f81a56fa740923b2d7`
were installed on both machines with their games closed. Provider, loader,
configuration and native-auth files verify unchanged. Both Dev overlays remain
running with their existing logins. Hosted CI remains unrun; the fresh native
capture below establishes failure of this diagnostic build. No color fix is claimed.

## Fresh two-client result and comparison with the working HUD

**[Confirmed]** At 06:00 UTC both games are running. Fresh desktop/xScal and
MSI/ZFE exports are active and both report
`0.2.18-np:receive:E1014:r0:a0:j0`. At 06:03 UTC they still report the same
failure with advancing observation/export sequences. Both Dev overlays remain
authenticated without a fatal startup error. Evidence: the sanitized
`desktop-probe-live-0607.json` and `msi-probe-live-0603.json` captures in the
conversation evidence directory. The desktop filename is a label; its embedded
capture time is 06:03:19 UTC. Backend observations through 06:08 UTC again match
one canonical room, with 17 common roster entries; this is historical room
evidence at that time, not a renewed observation at the later read.

**[Confirmed]** The working HUD and bridge instantiate the same
`FcmNameplates` and `FcmNameplatePainter` classes. Both establish a current
context before binding the same public nameplate surface. The HUD requests in
`hud` mode after its own linked native room is confirmed; the bridge requests in
`bridge` mode only after a current successful desktop export. These authority
differences are intentional. The bridge must not borrow the HUD's native room
or authenticate itself from roster names.

The material lifecycle difference is visible in `FCMChatWidget.startConnect`,
`refreshAuthState`, `pollEvents`, `parseAndRenderEvents` and `updateNameplates`,
versus the former combined `FcmBridgeNameplates.tick`. The HUD separates native
connect, status, event parsing and presence submission. The old bridge method
combines three JSON encoders, array decoding/casting, event traversal, native
calls and exception handling. FFDec 26.3.0 inspection of the exact installed
probe confirms those operations are in one compiled method. It does not identify
a particular missing class or prove a method-size limit.

**[Deduced]** `receive:E1014` with no receiver `failure` phase places the failure
before that method's handler can report it. That includes method verification
and its pre-try context step; the export alone cannot distinguish them. The
shared painter has not received private presence and cannot yet explain this
run's missing colors.

**[Hypothesized]** The combined compiled receiver encounters a GFx compatibility
failure. Candidate **0.2.19** separates orchestration, connect, auth, polling,
event-array processing, individual events and request/send methods, following
the working HUD's lifecycle. The orchestration method no longer encodes JSON
or casts/iterates events. Fixed call/entry phases and the outer failure boundary
retain the last receiver stage. Confirm this hypothesis only if a fresh native
run advances requests and accepted replies on both providers without E1014;
refute it if the same boundary or a new helper still fails. A simulation pass
does not reproduce Fallout's method rejection.

Provider capability gates, native call order, retry/poll bounds, exported-world
fences, private deadlines, authentication ownership and the shared painter are
unchanged. Unit checks exercise fault and unload at connect/auth/poll/send,
retain pending-connect behavior, and keep the failure phase during backoff.
The isolated Ruffle cases also unload synchronously inside native auth and
require subscription/timer teardown plus original-color restoration.

The first focused simulation exposed a refactor regression that overwrote the
failure phase during retry backoff; the candidate now retains it. The new unload
case initially expected the yellow redraw color without performing a redraw;
the fixture's actual original color is white and the assertion was corrected.
Neither initial failure is evidence of reproducing native E1014. All 31 pure
Haxe suites, seven source/package checks, eight bridge package tests and compiler
diagnostics pass on the corrected source. The four focused Ruffle cases and the
complete **97/97** suite pass, with automatic teardown in 9.8 minutes. Backend
passes 1,697 Jest cases (nine existing skips) and all 445 TypeScript units;
overlay passes 1,310 tests and dashboard passes 490. The backend runs used an
isolated working directory and owned Redis, with the CI session/admin fixtures;
earlier attempts exposed local `.env.local` contamination and missing working-
directory fixture files, not bridge regressions. Final unit results explicitly
report zero failures; the runner's exit status alone was insufficient. The owned
Redis containers and Ruffle listener are removed. All 191 source hashes remain
unchanged through packaging. Existing CI coverage includes these suites; no
hosted CI run, push or publication is claimed.

The final DEV probe ZIP is 48,132 bytes; its 83,032-byte BA2 and decoded SWF
match the exact packaged Ruffle fixture:

- BA2 SHA-256: `6f3f82dee825294c0985a7a6fa8b1b981e51fc7b3e1f88b60c72ef8c0e570acf`.
- SWF SHA-256: `d88d2a0e2e1804b41a9fc4e7e58fdb1f8a251f9ce27c367201c4819aeea809fd`.

Both games were independently confirmed closed at replacement. The same archive
is installed on desktop/xScal and MSI/ZFE, with six desktop and seven MSI
provider/config/loader/auth files unchanged. Backups are
`/home/devotek/FCM-Repro-Backups/before-serverbridge019-receiver-20261023T062203Z`
and `C:\Users\White\Documents\FCM-Repro-Backups\before-serverbridge019-receiver-20261023T022212`.
The permanent local setup runbook and conversation evidence manifest
`bridge019-source-gates.json` record installation hashes. Fresh native acceptance
remains pending; a saved 0.2.18 export after game exit cannot accept 0.2.19.

## Initial 0.2.19 native progress and mixed-client setup

**[Confirmed, user report]** The user reports blue names working with 0.2.19.
The desktop's final recent xScal export records `active:none:r43:a43:j1`;
the game had closed before the 06:57:34 UTC read, so this is a saved result of
that session. The laptop's fresh ZFE export at 06:57:35 UTC records
`active:none:r50:a50:j1` with the game and authenticated Dev overlay running.
The receiver therefore now sends and accepts private presence on both providers,
where 0.2.18 failed before its first request. These counters and the user report
support initial native recovery; they do not measure stationary availability or
complete the travel, expiry and provider-pair acceptance matrix. The exact GFx
verification trigger remains unidentified.

At the user's request, the desktop was switched to the already tested **HUD
2.10.151 DEV / xScal 0.4.27** for a mixed-client test against the laptop's
**Dev overlay / Server Bridge 0.2.19 / ZFE 0.24.0**. No HUD code or binary was
changed: the installed archive SHA-256 is
`3d79f5e6be6db00f34da06e88d605e94fd16c0fbf3b460c9471f49fc4c602e7a`,
and decoded SWF SHA-256
`fcdf893bdc3d79d64c5533bde6d270ce3a615f241232febe447eabef15f514c1`
matches the widget in the complete 97-case Ruffle run. Artifact/source freshness,
ZIP integrity and archive payload equality were checked before installation;
unchanged passing suites were reused.

The desktop game was closed. Only its exact Dev overlay instance was stopped to
avoid overlapping Insert handlers; production was untouched. Its bridge archive
was removed and loader/archive registrations now select the visible widget once.
All unrelated loader entries and INI values remain present. Prior HUD settings
were restored from the verified pre-bridge backup: Insert opens, Delete hides,
native input and blue names are enabled, and the relay/link hosts target Dev.
Five protected provider/loader/auth/address-library files verify unchanged.

Backup and restore script:
`/home/devotek/FCM-Repro-Backups/before-desktop-hud151-mixed-20261023T070152Z/`.
The conversation evidence directory `hud-overlay-mixed-20261023/` contains the
payload, installation and independent verification records. Laptop setup was
read-only; its 07:02:56 UTC export continues advancing (`r137:a136:j2`) with
no recorded receiver error. The user subsequently reports the mixed HUD/overlay
blue-name test working. This accepts the basic desktop HUD/xScal to laptop
overlay/bridge/ZFE color pairing for that run. The broader travel, expiry,
stationary-availability and bidirectional exactly-once Server/history matrix
remains separate and is not established by that color report.
