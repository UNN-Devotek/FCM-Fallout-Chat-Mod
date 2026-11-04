# Combined dependency and backend maintenance integration - 2026-11-04

The owner authorized integrating the six remaining Dev PRs and testing on the
Linux desktop and MSI Windows laptop. This is a Dev integration, with no Prod
operation or public client release. Base: `65124fae40a856cc146cb4abce32f79ebb6dda6c`.
The [November 3 record](dependency-integration-20261103.md) remains the historical
record for the preceding merge; this assessment supersedes its open-PR snapshot.

## Scope

| PR | Change |
| --- | --- |
| #605 | Backend accepted-work drain, persistent process/maintenance fences, required-effect accounting and bounded recovery planning |
| #644 | Development HTTP redirect dependency: follow-redirects 1.16.2 |
| #645 | Overlay ws 8.22.1 |
| #646 | Shared renderer Motion 14.9.0 and matching runtime packages |
| #647 | Backend S3 SDK 3.1161.0, Discord.js 14.28.0 and ws 8.22.1 |
| #640 | Deferred: Electron 45.2.1 and 45.2.2 intermittently fail the MSI compositor animation gate; retain supported Electron 44.10.2 |

Current Dev's HUD, private-world recovery and input changes are preserved. Older
HUD changes in #605 were already integrated; no HUD source or binary changes are
included here. Source versions and approved public notes are unchanged.

## Reproduced blockers corrected

- Frozen health returns HTTP 503; deployment probes require ready status and
  connected stores. A reachable frozen process cannot pass activation readiness.
- Root and laptop-cutover Compose definitions retain the control directory in an
  independent volume and allow a 180-second stop grace for the 120-second drain.
- Native Windows uses a credential-protected named pipe and private retained-file
  ACLs. Unix socket permissions and directory-sync paths are preserved. Windows
  file flushing does not certify power-loss durability or a full-volume restore.
- The older recovery fixtures now use the production Prisma 7 adapter factory.
  Their schema and raw-SQL search path point to independently owned test schemas.
- Known PostgreSQL atomic refusals are recognized from Prisma 7's structured
  SQLSTATE. Unknown transport and COMMIT outcomes remain unresolved.
- An instance-scoped Prisma adapter keeps SDK parser/watchdog lifetimes separate
  while retaining awaited operations, admitted transaction callbacks and detached
  application work through drain. No global SDK patch is installed.
- Source-extraction fixtures preserve current room diagnostics and the actual
  configured CLI directory. Windows frozen-boot tests allow the bounded native
  ACL setup; their store, producer and HTTP refusal assertions remain unchanged.

See [runtime maintenance](../backend/runtime-maintenance.md) for operator behavior.
A failed drain deliberately retains a fence; it never authorizes automatic repair,
replay, deployment or deletion of unresolved evidence. Existing hosting and
automatic-deployment fences are unchanged.

## Security scope

Production-dependency audits against the public npm registry report zero findings
in backend, dashboard, overlay and standalone MCP. Modern minimatch/glob callers
use patched versions ([glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)),
and the overlay's Joi is patched ([Joi advisory](https://github.com/advisories/GHSA-4528-x5fx-h6hg)). Legacy callable minimatch
3/5 remains in Electron build tooling: the advisory's `optimizationLevel` and
`firstPhasePreProcess` algorithm is absent from those implementations. The blanket
version-range scanner still reports those development paths under
[the minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249). Replacing them with
minimatch 11 would break their callable API and is not a safe blanket override.

The development-only Jest/deepmerge advisory still has no patched version. These
alerts are not dismissed, and no forced audit downgrade is used. Dev integration
does not close alerts on the default Prod branch before a separate promotion.

## Validation

- Backend: 195 Jest suites, 3,031 passed and 10 existing skips; 517 TypeScript tests.
- Real PostgreSQL recovery/transaction/schema isolation: 77 tests passed. These
  include lost-COMMIT evidence, rollback, admitted callbacks after freeze and
  detached work that must prevent a clean drain.
- PostgreSQL schema/adapter smoke, twice-applied compatibility migrations, MCP
  Inspector, backend build and Prisma tool typecheck passed.
- Dashboard: 491 unit tests, typecheck and production build passed.
- Overlay: 1,325 unit tests, typecheck and renderer build passed.
- Standalone MCP: build and 12 contract checks passed.
- Haxe/source/package checks and all 102 Ruffle scenarios passed. The rebuilt
  harness SWF was restored to the exact pre-existing artifact bytes afterward.
- MSI: final backend build and 24 native control/CLI, restart-fence, private ACL
  and actual frozen-startup tests passed.
- Final Electron 44.10.2: Linux source and packaged Dev interaction smokes and the
  MSI packaged Dev interaction smoke all passed, including animations, visibility,
  reconnects, persistent settings, message/history behavior and account boundaries.
  Linux native drag also passed. The actual copied executable/ASAR hashes were
  verified after local Dev installation on both machines.

Electron 45 is excluded from this integration. Both 45.2.1 and 45.2.2 failed the
unchanged MSI native animation assertion; 45.2.1 also completed a subsequent full
run successfully. No specific Chromium root cause or fix is claimed. The combined
updates on 44.10.2 passed the MSI suite, so #640 stays open for separate work.
Review/CI and final Dev merge status are recorded in the integration PR. Early MSI tests accidentally used a development React
renderer because test environment variables leaked into the build; those results
are retained as invalid for comparing production runtime versions. Production
renderer reruns exposed an intermittent compositor-animation sampling failure on
Electron 45. Both the failures and successful rerun are retained; they are not
represented as an unconditional native pass.

The desktop already has the current HUD 2.10.152 BA2 installed, byte-identical
to the checked-in artifact (SHA-256 `600948b678c562fc1f8f4818d14e41568ace8a7610bc93f93ffebaf33f264125`).
The MSI background bridge was updated to the current Dev source with a verified
backup and SHA-256 `7ed28ac609df76c4ef8f16b092dda7c651552942ab81af9bc9a1b2d1f658cfe1`.
Its existing ZFE configuration already targets Dev and is preserved. These remain the existing HUD↔overlay
test pairing; the visible widget and background bridge are never coinstalled.

The existing Dev shortcuts on both machines now point to the validated packages
and retain their existing isolated Dev profiles. The MSI's one-off native-test task
was removed after completion; it has no remaining schedule.

The existing interaction fixture now supplies the actual completed QA-status
response on its loopback server when testing a Dev-channel package. Its initial
missing-QA-response failure is retained separately; no application auth behavior
or hosted role gate was changed.

Tests use owned loopback services, temporary profiles and unpacked native builds.
They do not modify installed Prod clients or game files. Linux CI's 1920x1080 Xvfb
display is used for native interaction checks; the initial mismatched-display,
concurrent runs are retained separately and do not constitute final acceptance.

Full native two-client private/public world acceptance remains a release gate,
including all HUD/provider and bridge/provider pairings, equal canonical rooms,
exactly-once bidirectional delivery, common history, isolation, travel/hops,
expiry and stale-confirmation rejection. No gameplay acceptance, signed artifact,
completed VirusTotal release gate, or public publication is claimed here.
