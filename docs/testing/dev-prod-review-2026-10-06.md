# Dev / Prod and open PR review — 2026-10-06

Initial refs: Prod `a6e8df12`, Dev `86a363f4`. The committed Dev-only range
contains 11 commits and changes 43 files, primarily QC2 ZIP contract enforcement,
native xScal input defaults, named local appearance storage, and rebound-key
handling. The uncommitted shared slowdown feature and pre-existing native
acceptance edits were preserved separately, outside this branch comparison.

## Finding repaired

**Blocking: backend dependency PR #566 does not compile with tar-stream 3.2.1.**
After clean installation and Prisma generation, TypeScript reports four errors
in `migrationController.ts` at its archive stream boundaries. The newer package
ships stream types incompatible with the existing Node stream interfaces.
Restoring exact `tar-stream: 3.2.0` in manifest and lockfile makes the backend
build pass. Repair commit: `22addba1` on the existing PR branch. This preserves
the same compatibility pin already present in consolidation PR #560.

## Review scope and checks

Reviewed all 22 initially open PRs and their manifest/lock changes. PR #560
consolidates the earlier application, packaging and dependency work, with the
Electron/Hono/fast-uri repairs recorded in its description. Its existing checks
passed; its branch was then updated to current Dev and fresh CI authorized.
The author account cannot supply its own required review. The user explicitly
authorized the admin override for that review requirement; merge remains gated
on passing CI for the refreshed head.

PRs #562 (Undici) and #564 (Axios) are limited to existing development dependency
lock entries; scope and registry provenance remain unchanged. They were reviewed,
approved and authorized for required CI. PR #566 was authorized again after the
compatibility repair. Newer grouped updates and overlapping originals must be
reconciled against the consolidation before merging; blindly applying their
older lockfile versions could discard its dependency repairs.

Local validation of current Dev plus #560: six QC2 contract tests, HUD package
checks, Haxe named-layout and layout validator tests, and all 487 dashboard tests
passed. The merged preview is conflict-free and `git diff --check` passed.
The complete local Ruffle run and refreshed hosted CI were started separately;
completion results and actual merges are recorded when available.

The complete local Ruffle suite subsequently passed all 83 tests. PR #564's
authorized CI run 37483136735 passed on `b1a2d1d230c24d886d3eecfd0f475e983b5b05c1`,
with approval on that exact head. It merged into Dev on 2026-10-06 as
`39acf60def3faaedf0d36ff70f9d72019c2e06c1` without an admin override.
PR #566's repaired backend build and tests passed CI; its Ruffle suite reported
82 passes and one cleanup HTTP socket disconnect. Failed jobs in run 37483656733
were rerun and all jobs passed on the repaired `22addba1` head. After #564
merged, #566 was updated with latest Dev as `2293652e`; fresh CI is required
before merging. #560 was likewise updated as `905046ab` and fresh CI authorized.
All CI jobs subsequently passed on #566's `2293652e` head, including Ruffle.
It is behind Dev after #562 merged and awaits reconciliation after #560.

PR #562's updated `279530a9` head passed all CI jobs and held approval on that
exact commit. It merged into Dev on 2026-10-06 as
`e9978ed0ab5f7a786ab628cdf53663c4f5bff496` without an admin override.

After #562 merged, #560 was updated again to `1141ccba` and CI authorized after
the label-removal guard completed. Prioritize this consolidation before updating
overlapping dependency PRs again, preserving its security version floors.
The refreshed #565 overlay group was reviewed for matched React packages, Node
engine compatibility, npm registry provenance, and Undici 8.11.2 preservation.
PRs #567 (MCP proxy-addr), #568 (promo selector parser), #569 (promo source maps),
and #570 (backend Joi) contain only patch manifest/lock updates; their complete
diffs were reviewed and approved. These five remain unmerged pending authorized
CI on current Dev and reconciliation with the consolidation and grouped updates.

No additional blocking defect was found in the reviewed committed Dev-to-Prod
application/packaging changes. This review does not certify native game input or
appearance behavior beyond existing acceptance evidence, and it does not deploy
anything to production.

## Remaining dependency integration

#560 merged into Dev as `da4ff85f` after every CI gate passed on `1141ccba`.
The authorized admin override covered its missing independent review.
Remaining updates are reconciled in #566 across backend, dashboard, overlay,
MCP and promo. This incorporates refreshed groups #565/#546/#551/#533, the
ip-address patch #556, and updates #567–#572. Manifest/lock pairs and npm registry
provenance pass checks. Electron 43.7.6, tar-stream 3.2.0, MCP Hono 4.13.11 and
fast-uri 3.1.8 are retained. Refreshed transitive patches are retained; related
Remotion packages resolve together to 4.0.533. Local dashboard tests passed (487).
Final hosted CI is required before merging this consolidated diff.
Duplicates #559/#558/#555/#554/#550/#532/#525/#524/#523/#522/#498/#497 are closed
after verifying their changes are included or superseded in Dev.
The original checkout and user-owned native acceptance edit remain untouched.

## Completed dependency integration and slowdown handoff

#566 passed every hosted CI check on `1bd30d16`, including backend, frontend,
MCP, native source/package, standard Ruffle and both overlay packaging gates.
It merged into Dev as `fd1959a0`. GitHub repeatedly dismissed approval with
"The merge-base changed after approval" despite the unchanged tested head
containing current Dev; the authorized admin review override was used. Branch
protection settings were not changed and failed CI was never bypassed.
The remaining source PRs #551/#567/#569/#571/#572 and refreshed replacement
groups #573/#574/#575 were verified against the merged manifests and locks and
closed as included or superseded. No dependency PR remains from this review.

The slowdown feature is committed separately in #576. Every hosted CI check
passed on `405efe17`, including the standard Ruffle harness and real Redis tests.
It was updated against the merged dependency baseline and requires final CI on
that updated head before merging. Original dirty workspace changes remain intact.

Local validation was interrupted by T3 restarts. A standard local Ruffle attempt
hit browser-context teardown timeouts; its diagnostic rerun without video passed
the previously affected scenarios before cancellation, but did not finish the
full suite. These interrupted runs are not claimed as successful regression
evidence; hosted standard Ruffle passed. Local parallel installs and browser
tests were stopped after the user reported PC load. The owned harness server and
temporary Redis container were removed, and no processes remained in either
validation worktree. Further checks run on GitHub-hosted CI rather than locally.
