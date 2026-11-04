# Pre-release dependency integration - 2026-11-03

Local validation of the combined Dev update passed. The integration PR records
fresh hosted CI and Dev merge status. This document records the tested scope;
it does not publish clients or deploy production. Release versions remain proposals in the
[readiness assessment](hud-bridge-release-readiness-20261103.md).

## Included updates

| Area | Resolved update | Origin |
| --- | --- | --- |
| Standalone MCP | SDK 1.32.1 to 1.32.2; Node types 26.6.6 | #637 |
| Desktop types | Node types 26.6.6 | #638 |
| Shared dashboard/overlay UI | Motion 14.7.1 to 14.8.0; Node types 26.6.6 | #639 |
| Backend storage/transport | S3 SDK 3.1160.0; Redis 6.3.1; rate-limit-redis 6.0.2; Inspector 2.13.0; Node types 26.6.6 | #641 |
| Backend HTTP limits | express-rate-limit 8.7.1 to 8.7.3 | Refreshes #641's 8.7.2 target |
| SSRF address policy | Top-level ipaddr.js 1.9.1 to 2.5.0 | #642 |
| Desktop runtime | Electron 44.10.0 to 44.10.2 | Same-major alternative to #640 |

Keep #640's Electron 45 upgrade separate. Prisma CLI, client and adapter remain
pinned together at 7.10.1. The address-parser update retains proxy-addr's separate
1.9.1 dependency; only the application's top-level parser is upgraded.

The prior release-readiness documentation and four-line simulator startup wait
fix are included. The controlled slow-load regression and unchanged deadlines
are documented in the [HUD automation plan](../testing/hud-automation-plan.md).
Approved 1.4.3 public notes remain unchanged.

## Validation

Clean lockfile installs succeeded in all four updated workspaces. Focused tests
use the actual new address-parser and limiter dependencies; no application-code
workaround was needed.

- Nine focused backend suites: 426 tests passed, covering SSRF/IP classification,
  OAuth remote metadata, report helpers, limits, shared rooms, nameplates and relay
  connection lifecycle.
- Complete backend Jest: 130 suites; 1,711 passed and nine existing skips.
- Backend TypeScript unit suites: 447 passed, including enabled real Redis checks.
- Backend build and Prisma tool/config typecheck passed.
- A disposable PostgreSQL 16 database passed schema validation/push, twice-applied
  MCP/embed migrations and the real Prisma adapter query/model/JSON/date/rollback/
  unique-error smoke. Updated Inspector initialize/list/call smoke passed.
- Dashboard: 491 unit tests, TypeScript check and production build passed.
- Overlay: 1,325 unit tests, TypeScript check and renderer build passed.
- Standalone MCP build and 12 contract tests passed.
- Production-dependency audits against the public npm registry: zero reported
  findings in backend, dashboard, overlay and MCP.
- Native Linux Electron 44.10.2 source and packaged interaction smokes passed,
  as did the isolated unpacked Linux build. Both exercised actual Electron,
  preload and shared renderer against a loopback relay and temporary profile.
- The unchanged HUD source/artifact manifest validates. Its exact current smoke
  source already passed all 102 Ruffle scenarios during readiness work. The new
  integration CI must rerun the complete Haxe/package/Ruffle gates and native
  Windows installer/portable execution checks before merging.

Local backend checks use owned, disposable loopback PostgreSQL/Redis containers;
both were removed afterward. Electron checks use a temporary profile and loopback
relay, separate from installed clients. Temporary logs/results are in this
conversation's `dev-dependency-integration-20261103` evidence folder.

The existing low-severity development-only Jest/deepmerge advisory has no patched
version. It is not dismissed or described as fixed. The npm install warning for
Smithy core 3.38.0 is also pre-existing: its resolved version is unchanged, and
FCM's S3 clients do not configure the custom logger implicated by the warning.
Empty audit results do not certify all browser/runtime behavior or replace native
gameplay acceptance.

## Dev integration and subsequent testing

Submit one reviewed integration PR against Dev. Require fresh authorized CI on its
final head, then squash-merge using the existing repository convention. Close the
covered patch PRs only after verifying their updates landed in Dev; leave the
separate major Electron upgrade open. Verify Dev's resulting tree equals the
tested candidate. Production remains a separate promotion decision.

Native two-client private/public-world acceptance, final versioned HUD/bridge
packages and signed/scanned public desktop artifacts remain release gates. A
successful Dev merge or automated provider fixture is not native acceptance.
