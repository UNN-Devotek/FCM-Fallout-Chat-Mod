# Blue nameplates: evidence review and candidate 2.10.144

Review date: 2026-10-07. This synthesis combines the current two-client logs,
independent source/documentation reviews and comparable author-published HUD
mods. **Installed: HUD 2.10.144** on desktop/xScal 0.2.20 and MSI/ZFE 0.21.1,
after passing the local automated gates and verifying both archive/settings
hashes. **Bridge source 0.2.12** passed rebuilt local regressions; the distributed
DEV bridge 0.2.10 ZIP is unchanged. Native acceptance and publication remain
pending; this review does not assert that the candidate fixes the game.
Final gate/install evidence belongs in the
[existing test matrix](blue-nameplates-2026-10-06.md).

## Findings and evidence strength

| Finding | Grade | Consequence |
| --- | --- | --- |
| Both native providers receive populated `TeamMarkers` with eligible rows matching a visible public native entity/name, but report `dataReady=false isTest=true`; 2.10.142 copies zero markers and paints zero labels. | Observed in both clients' fresh logs | The strict envelope check is the immediate rejection point. The underlying registration/flag cause is unresolved. |
| Host-domain selection returns the same supplied manager on both machines; subscriptions and pushes succeed, and sampled event/provider/getter payloads agree. | Observed | A different child-manager cache is not supported by these captures. Manager discovery alone did not fix painting. |
| The native nameplate redraw resets `Name_tf.textColor`; its base class defers dirty redraw to default-priority stage RENDER. FCM 2.10.142 paints during ENTER_FRAME. | Implementation confirmed; overwrite risk inferred | A later vanilla redraw can remove blue. Paint after native RENDER listeners and test the real ordering. This is not a proven cause of the current zero-paint result because the earlier gate already blocks it. |
| Native name visibility includes `NamePlateNameGroup_mc` and TextField ancestors; `plate.visible` alone is insufficient. | Implementation confirmed | Preserve the full current visibility chain. A pre-redraw callback can also see old/default label text, so early zero matches cannot establish a permanent name mismatch. |
| `HUDMenu.CharacterInfoData` is private in the active movie. | Implementation confirmed | The old public-property ownership comparison is invalid evidence and must be removed. Do not attempt private access. |
| Separate native identities linked to one FCM account are supported; fresh private peer replies were received during failed painting. | Backend/source and native-log evidence | Same FCM/Discord login is not the rejection cause. Peer-list expiry can explain individual empty replies, not the valid-peer intervals with zero paint. |
| The native title separator is `<`, already handled by FCM normalization. No source evidence establishes control-character normalization as this failure. | Implementation confirmed; alternative unsupported | Keep strict normalization; do not guess suffix/control-character cleanup rules or request the player names again. |

Later 2.10.142 samples supersede the earlier callback-time zero plate match:
both clients recorded one eligible visible-plate match, then seven raw/eligible
rows with a visible match, still with identical sampled payloads and zero painting.
The captures establish the rejection point, not an entitlement to treat arbitrary
unready/test data as live. A stationary desktop interval from elapsed
`00:06:09` through `00:07:09` holds `pushes=11` / `observations=12` while frames
and private-reply counts advance. The matching laptop capture holds `pushes=14` /
`observations=15` from 02:57:54 through 02:58:54 EDT. Thus source gaps beyond the proposed 30-second bound
are already observed. Later moving/world-populated captures show frequent pushes,
which do not resolve stationary availability. The new source can safely expire
and leave names vanilla even while fresh private FCM presence continues.

Native implementation references are the read-only installed HUDModLoader archive
and its public author source, including
[BSDisplayObject's deferred redraw](https://github.com/GitCrazy-wc/hudmodloader/blob/71e2fde134933323777980b5e0fd0c6036c2408f/hudmenu/scripts/Shared/AS3/BSDisplayObject.as),
[TeammateNameplate](https://github.com/GitCrazy-wc/hudmodloader/blob/71e2fde134933323777980b5e0fd0c6036c2408f/hudmenu/scripts/TeammateNameplate.as),
[TeammateMarkersManager](https://github.com/GitCrazy-wc/hudmodloader/blob/71e2fde134933323777980b5e0fd0c6036c2408f/hudmenu/scripts/TeammateMarkersManager.as) and
[BSUIDataManager](https://github.com/GitCrazy-wc/hudmodloader/blob/71e2fde134933323777980b5e0fd0c6036c2408f/hudmenu/scripts/Shared/AS3/Data/BSUIDataManager.as).
The reviewed installed archive SHA-256 is
`a0287e33c27cd5baa7f7a1f23acb571c77ccd27d25b6b2df83d25b56c9578b11`.
Public source describes implementation; it is not a promise that every future
native build has identical flags or event ordering.

## HUDModLoader documentation coverage

All three public wiki pages listed by the maintainer were reviewed, together
with the Nexus loader page and relevant public source. The wiki's 2025 content
does not document `TeamMarkers` readiness/test semantics.

| Primary document | Relevant contract | Limit |
| --- | --- | --- |
| [Wiki Home](https://github.com/GitCrazy-wc/hudmodloader/wiki) | Index/welcome; confirms the documentation entry point. | No nameplate or data-source contract. |
| [HUDTools Instructions](https://github.com/GitCrazy-wc/hudmodloader/wiki/HUDTools-Instructions) | Initialize a uniquely named SharedHUDTools client, preferably on ADDED_TO_STAGE; include shared classes; respect active text-entry state, callback failures and menu-specific capabilities. | Messaging/input behavior does not authenticate player presence or authorize test envelopes. |
| [SharedHUDTools](https://github.com/GitCrazy-wc/hudmodloader/wiki/SharedHUDTools) | Published v1.2 implementation subscribes listener events and provides owned shutdown/unsubscribe behavior. | Its HUD message-provider calls and listener priority are not a `TeamMarkers` flag workaround. |
| [HUDModLoader Nexus page](https://www.nexusmods.com/fallout76/mods/3144) | Version 70, dated 2026-09-15; describes compatible child mods, loader precedence and the special original Text Chat arrangement. | Load precedence is an integration rule, not proof that current FCM is bound incorrectly. Preserve working activation/configuration. |

The native manager's published event plumbing is relevant corroboration:
[FromClientDataEvent](https://github.com/GitCrazy-wc/hudmodloader/blob/71e2fde134933323777980b5e0fd0c6036c2408f/HUDTools/scripts/Shared/AS3/Data/FromClientDataEvent.as) and
[UIDataFromClient](https://github.com/GitCrazy-wc/hudmodloader/blob/71e2fde134933323777980b5e0fd0c6036c2408f/HUDTools/scripts/Shared/AS3/Data/UIDataFromClient.as)
expose public envelopes/accessors. Native marker consumers use event data; they
do not establish the child's authentication or freshness. A nonwatching canonical
getter can compare identity, but cannot itself authorize or renew the cosmetic
source. No shared watch or readiness flag should be repaired by the child.

## Comparable Nexus mods reviewed

The comparisons distinguish a similar feature from evidence of the same source
or render behavior. Author-published archives were inspected read-only, never
executed or redistributed; author assets and native class replacements are not
included in FCM.

| Mod and reviewed revision | Evidence | Recommendation and gap |
| --- | --- | --- |
| [Original Text Chat](https://www.nexusmods.com/fallout76/mods/151), 6.6, file 21745, 2026-04-22 | The author's replacement TeammateNameplate first assigns vanilla color, then matches rendered `Name_tf.text` against the mod-user list and sets `#167FAF`. Its marker consumer reads public event data without a ready/test gate. | Strong precedent for recoloring after vanilla assignment. Its replacement native class and server-provided user list differ from FCM's child/room-presence design. Independently implement the behavior; do not copy its restricted assets or infer current native acceptance from the feature description. |
| [Server Player List](https://www.nexusmods.com/fallout76/mods/2811), 1.3.1, file 23143, 2026-08-21 | Reads public map/team providers, removes `<` title suffixes and discovers the original Text Chat child's visible user list through the HUD tree. The author documents incomplete player coverage and a prior title fix. | Supports public-tree integration and the existing title separator. It renders a list, not overhead member colors; no readiness workaround or deferred nameplate render fix is demonstrated. |
| [Improved HUD](https://www.nexusmods.com/fallout76/mods/3106), main file 1.19.5, file 23625, 2026-09-20 | Public-provider reads, owned subscription/recovery and documented restore/cleanup behavior. No overhead `TeamMarkers`/`TeamNameplates` painter found in the inspected widget. The description also contains a 1.19.6 changelog; the reviewed main archive is 1.19.5. | Useful ownership/teardown precedent, not a selective blue-name solution. The author currently supports xScal; this does not establish ZFE parity. |
| [HUDEditor–iHUD](https://www.nexusmods.com/fallout76/mods/953), Nexus 3.3.2.4 and [author-linked source at 57dce09](https://github.com/Comrade-Assaultron/HUDEditor-IHud/blob/57dce090b03543ba3e852205645c9cfcbeb1820b/src/HUDEditor.as) | Uses the public HUD root, iterates `TeammateMarkerBase.TeamNameplates` for emote visibility and applies a floating-container color matrix. | Confirms a public nameplate surface is available to children. Container-wide coloring is unsuitable for selective FCM members; no ready/test or private-presence solution appears. |

Read-only archive provenance: Text Chat ZIP SHA-256
`68b774f8ff015b10e70e16efd5fc90f1be997ac59be7ca13c3edbedf21521f62`;
Server Player List ZIP
`ca3b60d0b3ba682375a20eb5d2f72e8f9406164bf639c9f98c3b9d5f70c9aabb`;
Improved HUD ZIP
`984a39b25e477c55011cd807cfb14804edacd6bbe57f8bf89d29878fc671b08c`.
Public review caches are under `/tmp/fcm-nameplate-nexus-review`; the original
Text Chat/native HUD cache is under `/tmp/fcm-original-nameplate-research`.
These paths are research provenance, not distributed dependencies.

## Candidate resolution and boundaries

Keep the **generic** source strict: explicit `dataReady=true`, `isTest=false`.
For the observed anomaly, implement an independent **local cosmetic correlated
source**, rather than changing those flags or trusting a populated getter. It
must satisfy every condition below:

1. Receive an actual post-bind push through the current host-domain manager's
   owned `TeamMarkers` subscription. The bound host and binding generation must
   remain current; a fallback manager or stale callback cannot qualify.
2. Confirm `event.fromClient` is the provider and canonical cached envelope, and
   `event.data` is that provider/cache payload, with explicit
   `dataReady=false` / `isTest=true`. Missing, throwing or
   other values reject. Initial snapshots and diagnostic samples cannot acquire
   the source. Canonical checks use a nonwatching getter.
3. Copy a complete snapshot of at most 128 rows into scalar records. Each ID is
   a finite numeric uint (`0` is valid) excluding the unassigned `4294967295`
   sentinel, IDs are unique, and each strictly normalized name is
   nonempty. Duplicate/malformed rows reject the correlated snapshot; no native
   row/payload/event reference is retained. The owned provider-envelope identity
   may be retained for provenance and current eligibility checks.
4. At every paint, require the current public native entity ID and name to match,
   with the plate, TextField and all relevant ancestors visible, including
   `NamePlateNameGroup_mc`. Recheck current nonlocal/nonhostile/not-wanted
   eligibility. Hidden, recycled, renamed, wanted or hostile plates remain vanilla.
5. Require current private FCM presence, its context **and reset generation**,
   plus the same bound host/generation. Presence reset invalidates old source
   provenance even if an identical context string later returns.
6. Require cosmetic source age **below 30 seconds**. Only genuine valid pushes
   renew correlated source time. Getters, snapshots, probes, render/expiry frames
   and private lease renewal do not. The existing private presence lease remains independent.

This source only authorizes the color of an already-rendered public name. It
cannot authenticate a user, merge/assign rooms, prolong a server observation or
presence lease, change provider flags, or create/remove shared watches. The
existing strict name normalization remains; no control-character or guessed
conversation-suffix loosening is proposed. Separately, a ready/non-test **generic
first-bind snapshot** can establish the initial bounded source time. Subsequent
getter/frame/probe calls cannot renew it; this does not authorize an anomalous
snapshot through the correlated source.

Move final color application to stage **RENDER priority `-10000`**, after the
native default-priority redraw. Keep a frame path for bounded expiry/cleanup and
remove both hooks on teardown. Avoid `SetIsDirty` during RENDER: native drawing
asserts that it does not become dirty while drawing. Restore vanilla color when
the source or presence expires, the feature is disabled, eligibility changes, or
the movie unloads. Do not force a hidden name group visible or add new labels.

Remove the invalid private CharacterInfoData probe. Retain count/fixed-label
diagnostics without names, entity IDs, tokens, request IDs, private context or
native payloads. Bridge source **0.2.11** establishes the cosmetic presence
context **before** binding the painter and taking its first generic snapshot.
The old order captured the snapshot under an empty/old context, then retired it
on the context change; a stable world without further pushes could remain vanilla.
Both rebuilt bridge providers now regress that first-snapshot path. A separate
xScal hop regression exposed a cosmetic request using an older successful-export
flag before the new world was saved. Source 0.2.11 tracks the last successfully
saved export world and requires it to match current state before receiver
activity and painter binding, including after native-call reentry. Deferred or
failed saves cannot authorize the new cosmetic context. Pure export and actual
packaged provider tests cover this fence; Server room policy is unchanged.
The distributed DEV **0.2.10** ZIP remains unchanged. The requested new deliverable
is the HUD build.

Terminal HUD authentication or native-link failures immediately retire private
presence and painted colors rather than waiting for lease expiry. The source's
reset-generation association prevents a later same-context return from restoring
old colors; recovery needs fresh valid source and private presence evidence.

## Rejected alternatives

- Globally accepting `ready || !test`, treating any populated snapshot as live,
  borrowing readiness from an unrelated provider, changing flags, or altering
  native/shared watches. None establishes current cosmetic provenance.
- Polling to renew source freshness or using private peer replies to refresh an
  old marker source. This would conceal stationary native push gaps and retain
  stale surface data.
- Reading private CharacterInfoData, game memory or private native state;
  injecting code; scanning ports/networks; or adding provider hooks outside the
  sanctioned UI/export channel. The review does not require any of these.
- Copying original Text Chat/Bethesda SWF classes, replacing native HUD assets,
  recoloring a whole marker container, or loosening name matching. These either
  violate the agreed architecture/permissions or lack evidence for this failure.
- Replacing working providers/loaders, reinstalling login state, or blaming the
  shared FCM account without evidence. Both providers reproduce the same gate
  with eligible private peers and matched public plates.

## Follow-up review: HUD 2.10.144

A second independent review found two concrete lifecycle defects in 2.10.143.
[Confirmed, source and Ruffle] The real non-`LINK COMPLETE` system notice set
`_needsLink` without retiring active cosmetic evidence. The same-manager binding
shortcut also returned after an earlier `Subscribe` exception, leaving no owned
listener and preventing recovery. Both failures were reproduced for xScal and
ZFE before changing production (`/tmp/fcm-hud-2.10.144-review-red.log`).

HUD 2.10.144 retires private presence and colors inside the system-notice parser
and only skips rebinding when the existing subscription is healthy. Retry clears
old evidence, advances ownership generation, removes the exact previous callback
and installs one new listener. No source-freshness or name-matching rule changes.
The shared local bridge source is now 0.2.12; distributed bridge 0.2.10 remains
unchanged.

[Confirmed, focused Ruffle] Both providers pass (2/2, 13.9 seconds): immediate
link retirement, old pending-reply rejection before and after `LINK COMPLETE`,
fresh recovery, same-manager subscription retry, no healthy rebind or source-age
renewal, and balanced listener teardown. The native fixture now uses a sealed
`UInt` getter and matches ID `4294967294` against the production painter.
The exact passing browser log is
`/tmp/fcm-hud-2.10.144-review-green-browser-evidence.log`.

[Confirmed native source; deduced limitation] The native nameplate appends
` $$InConversation` for a leader in conversation (`TeammateNameplate.as:633` in
the read-only active decompile). Exact displayed-name matching therefore leaves
that label vanilla; a regression covers rejection and ordinary-name recovery.
This does not explain the ordinary nearby-player failure. Public Vector/accessor,
visibility and default-priority RENDER contracts remain compatible in source.
Full frame and RENDER painting both revalidate bounded marker collections;
actual crowded-HUD cost and continuous stationary coloring remain unmeasured.

The complete 144 gate passes: 31 pure suites, nine source/package checks,
empty compiler diagnostics, 93/93 Ruffle cases (7.5 minutes), backend
Jest 130 suites/1,669 tests (nine intentional skips), backend TypeScript 445,
overlay 1,303 and dashboard 490. The first full run rejected only two stale
version assertions (91/93 passed); source-derived strict expectations fixed them.
A follow-up metadata review strengthened the
artifact smoke with exact fetched-byte and compiled-version checks; its
intermediate run was interrupted before the final complete suite. Both installed
archives match the tested ZIP;
previous archives/logs are backed up, and all six desktop/seven laptop preserved
file hashes pass. Historical 143 results below do not accept 144 native behavior.

## Historical gates and remaining native acceptance

The installed 2.10.142 passed 31 pure suites, nine source/package checks, empty
compiler diagnostics and the complete **91/91** local Ruffle suite. Those are
historical results. Candidate **2.10.143** passed **31 pure suites**, **nine
source/package checks**, empty widget/scenario compiler diagnostics and the
complete **93/93 Ruffle suite** (7.7 minutes), including actual deferred-render
scenarios for **both providers** and the rebuilt 0.2.11 bridge. Backend Jest
passed 130 suites / 1,669 tests (nine intentional skips); backend TypeScript
passed 445, overlay passed 1,303 and dashboard passed 490. Backend final runs
used an isolated working directory and a disposable loopback Redis; inherited
local dotenv failures and incomplete temporary unit setups were rejected.
No product environment code or tests were weakened to obtain green results.
Existing CI jobs discover these regressions; no new hosted CI run was triggered.
The DEV ZIP passed CRC, endpoint, provider-copy and artifact equality checks,
then only the HUD BA2 was replaced on both independently confirmed closed games.
Previous archives/logs were backed up, and all six desktop/seven laptop preserved
files passed hash checks. Native coloring remains unverified for this artifact. The
[automation plan](hud-automation-plan.md) specifies negative provenance,
malformed rows, per-paint eligibility, context/reset generation, expiry and
teardown coverage. Passing these gates permits a test build; it does not prove
native GFx behavior.

Two nearby clients must then verify blue only for fresh eligible FCM peers,
ordinary nonusers unchanged, wanted/hostile colors, hidden/recycled plates,
world/session loss, source and lease expiry, opt-out, unload, provider parity,
and typing/Server regressions. Include stationary observation for more than
30 seconds: native push gaps can safely expire the source and make blue disappear.
Measure that availability before deciding this implementation is shippable;
never mask it with getter-based renewal. Both different FCM accounts and separate
native identities linked to one FCM account are valid test arrangements.
