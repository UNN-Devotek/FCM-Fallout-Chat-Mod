# HUD and Server Bridge release readiness - 2026-11-03

The reviewed source is suitable for preparing release candidates. Publication still
requires new overlay/bridge version numbers, native acceptance and the artifact
release gates below. The proposed set is **Overlay 1.4.4, HUD 2.10.152 and Server
Bridge 0.2.20**; these versions and the [draft notes](hud-bridge-next-release-notes.txt)
have not been approved for publication. No runtime version or release pin was
changed during this assessment.

The owner subsequently authorized integration of the recommended dependency
updates into Dev and testing of the combination. Follow the
[dependency integration record](dependency-integration-20261103.md) for that
candidate's exact versions and validation. The snapshots and recommendations
below describe the initial assessment, before that integration.

## Source and published baseline

- Latest website and GitHub release: Overlay 1.4.3, HUD 2.10.151, published
  2026-10-23. The published portable archive contains Bridge 0.2.19, BA2 SHA-256
  `47da68022ac5d2865d934c637a24e9eb4a4471155aadfdebf43eeaa727134c45`.
- Dev: `ec1ede54a6acc3b28422511221b0da0eea64da44`.
- Prod: `0358c88bf1fa00b13fcd6396cb70e65881a0473a`.
- Both have tree `eacb5ccb69c9bea6f5a7a6063b714f25ea19d327`. The analysis
  checkout initially had a different commit with that same tree.
- [Exact Prod CI](https://github.com/UNN-Devotek/FCM-Fallout-Chat-Mod/actions/runs/40989824688)
  passed all 14 jobs, including backend, dashboard, overlay, native Windows/Linux
  interaction smoke, Haxe/package checks and the complete Ruffle harness.
- At the initial snapshot, six newer Dependabot PRs (#637-642) were open and
  unmerged. Their subsequent disposition is in the integration record. Draft
  #605 remains excluded. The one remaining open Dependabot alert
  is the low-severity development-only Jest/deepmerge advisory
  `GHSA-gcqx-w48m-w2h4`, with no patched version reported.

## Changes since 1.4.3

1. HUD 2.10.152 draws a client-only blinking insertion cursor in the existing
   editor. ZFE/shared input reads the host field; native xScal reads optional
   validated UTF-16 `caretIndex` metadata. Left/Right remain owned by the editor;
   the cursor never enters draft text or messages. Older xScal builds without
   metadata retain their existing native input without this marker. The owner
   reported the xScal caret working; that is narrower than the full release matrix.
2. Bridge recovery carries bounded self aliases and the selected roster source,
   advances the evidence sequence when identity evidence changes, and preserves
   the preceding observation while holding during loading. These changes address
   reproduced account/character-label discontinuities, not every possible private-
   world failure. Observation expiry and generation isolation are unchanged.
3. Backend matching preserves a corroborated self-label switch within the same
   generation. Interrupted relay upgrades release their connection reservation.
   Bounded diagnostics omit raw names, message bodies, tokens and account IDs.
4. Desktop readers accept the additional bridge fields and continue accepting old
   exports. Dependency/security updates include the Prisma runtime and packaged
   desktop dependencies; implementation details belong in internal documentation.

See the [private-world test plan](../testing/private-world-recovery.md) and
[input contract](../overlay/zfe/text-input-contracts.md).

## Confirmed compatibility and packaging blockers

**The new bridge cannot be paired with released Overlay 1.4.3.** A synthetic
export was passed through both the actual tagged 1.4.3 reader and the current
reader. The old reader accepts legacy exports but rejects `ownAliases` and
`rosterSource`; the current reader accepts both formats. A backend-only update
does not change installed desktop readers. Update the desktop before the bridge.

**Bridge source still reports the already-published version 0.2.19.** Change both
`FcmBridgeExport.hx` and `hudmodloader-bridge/package.py` to the proposed 0.2.20
before freezing the new artifact. The HUD already reports 2.10.152; the desktop
package and lockfile still report 1.4.3 and need the proposed 1.4.4 bump.

**Overlay packaging deliberately pins the old bridge.** Both
`Packaging/package-downloads.ps1` and `Packaging/package-nexus-downloads.ps1`
pin the previous ZIP; the latter also checks its BA2. They and
`Packaging/test-release-scripts.py` still expect 0.2.19 and the old hashes.
After the new bridge passes native acceptance, freeze one exact PROD ZIP, update
all version/hash references and the release runbook together, and retain that ZIP.
Do not substitute a rebuilt archive or relax the integrity checks.

A HUD-only 2.10.152 release could proceed independently after its own gates. It
would leave the desktop/bridge recovery update undistributed.

## Current hosting and backend readiness

Read-only checks on 2026-11-03 found Prod on **Mothership**, container
`fcm-return-prod-20261030-backend-1`, image ID
`sha256:bb9ad44566f4d286ca3470358f1cc15e622805c6261119fb096d8f85695f391b`.
The localhost origin is `http://127.0.0.1:27677`. Health reports database, Redis
and Discord connected, with zero container restarts. The previous Hostinger
backend and connector are stopped; SSH Manager labels Hostinger as standby.
Use the current authoritative host for any later authorized artifact upload.

The active image has no revision/tree OCI labels. Instead, a fresh local backend
build was compared with the running container: all 331 compiled JavaScript paths
and SHA-256 values match. The canonical manifest hash is
`22637905c90166a288316eeff8f1ed7f2480fd5db2407738a46ca94298dd4cff`.
This verifies application code, not every image layer, dependency or backup.
No deployment, service restart, migration or deployment-fence change was made.
The observed hosted Dev container still identifies as `fcm-reviewed-dev:eb3d93d3`;
verify/update an isolated test backend to the candidate before using hosted Dev
for the new bridge's native acceptance.

## Verification for this assessment

- All 32 pure Haxe suites and nine Python source/package checks passed.
- The JavaScript-target xScal UTF-16 decoder check passed.
- Both desktop bridge-reader/relay suites passed: 54 tests.
- Backend TypeScript build passed. Required wider backend/dashboard/overlay
  results are the exact-Prod CI linked above, not newly rerun full local suites.
- Initial full Ruffle rerun: **100 passed, two failed**. The xScal shared-input
  scenario exhausted its behavior wait during slow player startup; the ZFE
  fast-travel test exhausted its five-second construction wait while only the
  boot message was visible. Both passed unchanged in a two-case focused rerun.
  A controlled six-second SWF-response delay reproduced the old construction
  failure, then passed after adding the existing bounded ready-status precondition.
  Behavior assertions and the overall 30-second test limit are unchanged. The
  temporary delay was removed. The corrected complete suite passed **102/102**
  in 582.63 seconds (9.6 minutes reported by Playwright), with the test source
  unchanged during the run. The initial failure and controlled red/green evidence
  are retained. These local test/doc changes still require CI when submitted;
  the earlier exact-Prod CI result describes the base source.
- The checked-in widget source/SWF/BA2 manifest validates. Its SWF SHA-256 is
  `90828c6b816680e1736c9d060e5c1505ffe7df04f2ba750bb2aa41c50257d85d`;
  BA2 SHA-256 is
  `600948b678c562fc1f8f4818d14e41568ace8a7610bc93f93ffebaf33f264125`.
  A fresh compile validates as FWS v32. It differs by nine bytes, solely the
  compiler's consistently renamed boot symbol at three references; replacing
  that symbol for comparison makes the complete SWF bytes equal. Preserve the
  exact manifest-bound artifact for testing and packaging.

Temporary logs, manifests, compatibility proof and the rebuilt SWF are
in this conversation's `hud-bridge-readiness-20261103` evidence folder. Assessment
builds retain current source versions; final release ZIPs are not frozen yet.

## Remaining release sequence

Complete the dependency review below before freezing the final release tree.

1. Prepare a reviewed Dev change for the proposed version metadata and current
   installation requirements. Candidate preparation does not approve publication;
   confirm the final versions and exact notes with the owner before publishing.
   State explicitly in the bridge's packaged instructions that 0.2.20 requires
   the matching desktop release, and update the desktop before replacing the BA2.
2. Build the versioned test candidates on a matching backend. Run source/package
   checks and the complete Ruffle suite on the final versioned source before
   packaging/installing; the earlier tree's CI does not accept later source edits.
3. Use two distinct FCM accounts for fresh two-client private-world and public-control acceptance for all
   four HUD/ZFE or HUD/xScal to bridge/ZFE or bridge/xScal combinations, plus
   HUD-to-HUD and bridge-to-bridge. Require equal rooms, exactly-once messages in
   both directions, shared history, stationary blue names, travel/interiors,
   reconnect/reload, expiry and genuine world-hop isolation. Exercise the caret
   on both providers: empty/long text, arrow editing, send/cancel/reopen and normal
   gameplay arrows after closing. Record actual game/provider versions. The new
   bridge requires the matching desktop; HUD and bridge must not be coinstalled.
4. Freeze and pin the native-accepted PROD bridge ZIP, update its script/test/doc
   references, and pass final reviewed CI. Promote Dev to Prod with a merge commit.
   Build both desktop platforms, signed Windows installer and portable plus Linux AppImage/`.deb`;
   run the exact packaged smoke/interaction gates and completed VirusTotal scans
   before any publication. CI execution smoke is not release signing or scanning.
5. Package website and executable-free Nexus HUD archives, preserve edited INIs,
   verify target stamps, BA2 payloads and final ZIP hashes. Keep the optional bridge
   clearly separate from the visible HUD and from automatic game installation.
6. After version/note confirmation, carry forward the owner's prior distribution preference: website
   Windows/Linux/HUD, Nexus Linux/`.deb`/HUD, using `-SkipWindowsNexus`.
   There is no independent bridge file group in the current wrapper; it ships
   inside overlay archives. Any additional standalone download needs an explicit
   publication choice. Verify current-host served bytes and Nexus descriptions,
   register once, then verify website metadata, GitHub release and the Discord
   footer's complete set of direct download links.

The approved older 1.4.3 notes must remain intact. Do not announce that private
worlds, stationary blue names or emote cancellation are universally fixed on the
basis of the automated scenarios.

## Expected published artifacts and announcement links

The version numbers below remain proposals. After approval and all gates, the
website would serve Windows installer/portable EXEs and ZIPs, Linux AppImage,
`.deb` and ZIP, and both platform-neutral HUD provider folders in one ZIP.
The optional versioned bridge ZIP is the frozen input embedded in overlay ZIPs.
Keep the website and Nexus HUD variants separate.

The announcement footer must link the Windows installer ZIP, Windows portable
ZIP, Linux AppImage, Linux `.deb`, Linux ZIP with documentation, HUD ZIP and
download page, with the usual Nexus endorsement link. Use the existing backend
URL generator, read back the actual post, and verify all served files first.
The current wrapper has no standalone bridge release metadata/button; add one
only if that distribution is chosen explicitly.

GitHub-hosted Windows release builds are available. The workflow's three Azure
credential secret names exist, but this assessment did not exercise their current
validity or create signed 1.4.4 binaries. New signing and VirusTotal receipts remain
required for those binaries.

## Dependency review before the release freeze

All six open Dependabot PRs lack a successful authorized CI run. Their failed
summary checks accompany skipped authorization/jobs; they do not establish a
dependency regression. None is approved for immediate merge by this assessment.

- **Prioritize #641, updating its rate-limiter target to 8.7.3.** The PR includes
  `express-rate-limit` 8.7.2, which fixes the low-severity
  [GHSA-j3cq-92fq-qg5f](https://github.com/express-rate-limit/express-rate-limit/security/advisories/GHSA-j3cq-92fq-qg5f).
  The affected version range includes our 8.7.1. Its required skip-failed or
  skip-successful options were not found in application source, and Redis stores
  are not affected by that advisory. This is a precautionary patch recommendation,
  not a demonstrated FCM exploit. The newer 8.7.3 also fixes rejected async handler
  and message-callback errors; see the
  [maintainer changelog](https://express-rate-limit.mintlify.app/reference/changelog).
  Recheck rate limits, Redis fallback, MCP token limits, S3 and the inspector smoke.
- **Include #637, #638 and #639 after checks.** These update the standalone MCP
  workspace's SDK 1.32.1 to 1.32.2, Node type definitions and Motion 14.7.1 to
  14.8.0. Run MCP contracts, dashboard/overlay units and effects/reduced-motion
  checks. These are routine maintenance candidates, not asserted security fixes.
- **Validate #642 before deciding.** `ipaddr.js` 1.9.1 to 2.5.0 changes a production
  dependency used by `publicNetworkAddressPolicy.ts`. Require the existing SSRF,
  reserved-address and IPv4-mapped IPv6 tests in `embedAssetService.test.js`,
  `mcpOAuth.test.js` and related consumers, plus TypeScript compilation. The PR
  retains a separate 1.9.1 copy for `proxy-addr`; that is expected dependency
  isolation, not proof that the top-level update failed.
- **Prefer Electron 44.10.2 over #640's 45.1.0 major jump.** The
  [44.10.2 release](https://github.com/electron/electron/releases/tag/v44.10.2)
  was published 2026-11-03, includes upstream engine fixes, Node 24.22.2 and a
  Wayland hidden-parent crash fix. Staying on the tested major is the smaller
  change before a client release. This replacement patch still needs native
  Windows/Linux interaction, installer and portable checks. Major 45 remains a
  separate upgrade candidate; the recommendation is not a claim that it is broken.

The repository alert list still reports only low-severity development-only
Jest/deepmerge `GHSA-gcqx-w48m-w2h4`, without a patched release. The additional
rate-limiter advisory above was verified in upstream documentation rather than
in that repository alert list. No dependency PR was merged or relabeled here.

Fresh `npm audit --omit=dev` checks against the public npm registry reported zero
findings in backend, dashboard, overlay and MCP. Initial checks in three workspaces
hit a configured registry without an advisory endpoint; a command-scoped public
registry override resolved that setup issue without changing npm configuration.
An audit feed's empty result does not supersede the verified upstream advisory
or scan Chromium/Electron itself.
