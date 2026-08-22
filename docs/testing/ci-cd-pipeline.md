# CI/CD Pipeline

The live pipeline is in `.github/workflows/ci.yml` (push to `prod`/`dev`, and label-triggered
PRs — see below). A companion workflow, `.github/workflows/pr-gate-delabel.yml`, handles the TOCTOU
guard.

CI defaults to **GitHub-hosted runners** (`ubuntu-latest` / `windows-latest`). Self-hosted runners
are available as a documented fallback via repo variables:

| Variable | Default (unset) | Self-hosted value |
| -------- | --------------- | ----------------- |
| `CI_RUNNER` | `ubuntu-latest` (GitHub-hosted) | `["self-hosted","linux","unn"]` |
| `CI_RUNNER_WINDOWS` | `windows-latest` (GitHub-hosted) | `["self-hosted","windows","unn"]` |

Toggle commands:
```bash
# Switch Linux jobs to self-hosted
gh variable set CI_RUNNER '["self-hosted","linux","unn"]'
# Switch back to GitHub-hosted (delete the variable)
gh variable delete CI_RUNNER

# Same for Windows jobs
gh variable set CI_RUNNER_WINDOWS '["self-hosted","windows","unn"]'
gh variable delete CI_RUNNER_WINDOWS
```

The **security boundary is the `ci-approved` label gate** (see `authorize` job below), NOT the
runner type. Untrusted fork code is blocked from CI regardless of which runners are in use.

`pr-gate-delabel.yml` runs on `ubuntu-latest` directly (plain — no toggle needed; it only calls
the labels API).

Source of truth for the test-tooling decisions cited here is the five-agent subsystem mapping.
Key constraints it surfaced:

- BACKEND keeps **Jest 29** for its compiled `backend/tests/**/*.test.js` supertest suites, plus
  a hand-rolled `backend/src/testRunner.ts` (node:test + tsx) for newer TS unit suites under
  `backend/src/services/__tests__/*.test.ts`. CI must run **both** paths.
- OVERLAY (`cross-platform-overlay`) and DASHBOARD (`admin-dashboard`) both use **Vitest + RTL +
  jsdom** (`test:unit`). They already run Vite 6 + `@vitejs/plugin-react`; Vitest reuses the exact
  transform pipeline with zero extra config. See [README.md](README.md) for the full tooling rationale.

## Triggers and the PR authorization gate

```yaml
on:
  pull_request:
    types: [labeled]   # label-triggered, NOT open-triggered
  push:
    branches: [prod, dev]
```

**PRs are label-triggered.** CI does not fire when a PR is opened or when a contributor pushes.
It fires only when a maintainer applies the **`ci-approved`** label. Applying a label requires
write/triage access, so fork authors cannot self-approve. This is the primary security boundary —
it protects CI from untrusted code regardless of whether GitHub-hosted or self-hosted runners are
in use.

Every job has `needs: authorize`. The `authorize` job itself has this condition:

```yaml
if: >-
  github.event_name == 'push' ||
  contains(github.event.pull_request.labels.*.name, 'ci-approved')
```

- **Push to `prod`/`dev`** → authorized automatically (code is already merged/trusted).
- **Any PR** → authorized only when the `ci-approved` label is present at label-application time.
- **Unlabeled PR** → `authorize` is skipped → every downstream job is skipped → `CI Summary`
  treats skipped required jobs as failure (no false green).

**Workflow for running CI on a PR:** review the diff; if safe, apply the `ci-approved` label.

## TOCTOU guard — `pr-gate-delabel.yml`

`.github/workflows/pr-gate-delabel.yml` runs on `pull_request_target: [synchronize]` and strips
the `ci-approved` label on every new push to the PR branch. This prevents a contributor from
sneaking a malicious commit in after a maintainer's label: any new push disarms CI and forces a
re-review + re-label.

The workflow runs in the trusted base-repo context (`pull_request_target`) so it can call the
labels API, but it **never checks out or executes PR code**. Permissions: `pull-requests: write`,
`contents: read`.

## Supply-chain hardening

All actions in both workflow files are **SHA-pinned** with `# vX.Y.Z` comments instead of moving
tags. A top-level `permissions: contents: read` defaults the GITHUB_TOKEN to least privilege;
individual jobs that need more (only the delabel workflow) opt in explicitly.

## Job graph

```
push / ci-approved label
        │
        ▼
   [authorize]
        │
   ┌────┼─────────────────────────────────┐
   ▼    ▼         ▼           ▼           ▼
lint  backend  unit-vitest  overlay-launch  overlay-build
check  -jest   (matrix)     -smoke-linux    -windows-nsis
        │
        ▼ (all of the above)
   [ci-summary]   ← the single required branch-protection check
```

## Job list (8 jobs total)

| Job | Runner (default) | Required? | Notes |
| --- | ---------------- | --------- | ----- |
| `authorize` | `ubuntu-latest` | **Gate** | Skipped for unlabeled PRs → fails `ci-summary` |
| `osv-scan` | `ubuntu-latest` | **Not required** (`continue-on-error: true`) | OSV (osv.dev) vulnerability scan of every lockfile (`osv-scanner scan source -r .`); advisory only — results in the job log, PR step summary, and an `osv-report` artifact. NON-BLOCKING pilot; see [Dependency scanning](#dependency-scanning-osv--dependabot) |
| `lint-typecheck` | `ubuntu-latest` | **Required** | `tsc --noEmit` matrix over backend, admin-dashboard, cross-platform-overlay |
| `backend-jest` | `ubuntu-latest` | **Required** | `postgres:16` + `redis:7` service containers; service containers on `localhost` (hosted) or `docker` hostname (self-hosted DinD); `prisma generate` + `db push`; `npm run build` then `npm test` + `npm run test:unit` |
| `unit-vitest` | `ubuntu-latest` | **Required** | **Consolidated matrix** (`cross-platform-overlay`, `admin-dashboard`); replaced the former `overlay-unit-component` + `dashboard-unit-component` jobs |
| `overlay-launch-smoke-linux` | `ubuntu-latest` | **Required** | Builds once, runs packaged-launch smoke (`ci-launch-smoke.mjs`); the former auto-update E2E step was removed when auto-update was retired; replaced former `overlay-e2e-linux` |
| `overlay-build-windows-nsis` | `windows-latest` | **Required** (prod+PRs) | Builds the NSIS installer **natively** on `windows-latest` (no Wine/Docker/GHCR); runs `.github/scripts/win-artifacts-check.mjs` — asserts the installer + exe are present and that `app-update.yml` / `latest*.yml` are **absent** (the overlay no longer auto-updates); renamed from `overlay-autoupdate-e2e-windows` |
| `ci-summary` | `ubuntu-latest` | **The single required gate** | `if: always()`; fails if any listed job is `failure`, `cancelled`, or `skipped` |

All runner values above are defaults (no `CI_RUNNER` / `CI_RUNNER_WINDOWS` variable set). See
the [runner toggle](#runner-toggle-github-hosted-default--self-hosted-fallback) section above for
how to switch to self-hosted runners.

**Job consolidation vs. the old design:** the pipeline previously had 11 jobs. The two Vitest jobs
(`overlay-unit-component`, `dashboard-unit-component`) merged into a single matrix job `unit-vitest`;
the two Linux overlay jobs (`overlay-launch-smoke`, `overlay-autoupdate-e2e`) merged into
`overlay-e2e-linux` and was later renamed `overlay-launch-smoke-linux` when the auto-update E2E step
was retired; the placeholder `dashboard-playwright` job was removed; the `osv-scan` job was later added
(non-blocking); `overlay-autoupdate-e2e-windows` was renamed `overlay-build-windows-nsis`; and the
native-Windows `overlay-autoupdate-e2e-windows-exec` job was removed when auto-update was retired.
Result: 8 jobs.

## Dependency scanning (OSV + Dependabot)

Two complementary supply-chain mechanisms guard dependencies:

**OSV scan (CI-time, per-PR).** The `osv-scan` job runs [`osv-scanner`](https://google.github.io/osv-scanner/)
against every lockfile in the tree (npm `package-lock.json` × 6, plus any Dockerfile base images) on
each `ci-approved` PR and on push to `prod`/`dev`. It is deliberately a **job inside `ci.yml`** rather
than a standalone `osv-scan.yml` triggering on bare `pull_request`: a PR-triggered standalone workflow
would execute untrusted fork code on the self-hosted runner *before* the `authorize`/`ci-approved` label
gate, defeating the fork-safety model. As a job it inherits `needs: authorize`. It is **non-blocking**
(`continue-on-error: true`, absent from `ci-summary.needs`) — findings surface in the job log, the PR
step summary, and an `osv-report` artifact, but never fail the merge. Exit codes: `0` clean, `1` vulns
found (expected, not an error), `>1` scanner error.

*Promote to a hard gate* once baseline findings are triaged and scans are reliably clean: (1) remove
`continue-on-error: true` from the `osv-scan` job, and (2) add `osv-scan` to the `ci-summary` `needs:`
list. It is then enforced on both branches through the existing single `CI Summary` required check — no
new branch-protection context needed.

*Optional webhook notifications:* add a `Notify webhook on findings` step gated on
`steps.scan.outputs.osv_result == 'vulnerable'` that POSTs to a `SECURITY_WEBHOOK_URL` repo secret
(Discord/Slack). Omitted by default.

**Dependabot (continuous, GitHub-native).** `.github/dependabot.yml` configures weekly **version
updates** — one npm entry per package dir (`/`, `/backend`, `/admin-dashboard`, `/cross-platform-overlay`,
`/mcp`, `/marketing/promo`) since this repo is not an npm workspace, plus a `github-actions` entry that
keeps the SHA-pinned actions current. Minor + patch bumps are grouped per ecosystem to reduce PR churn;
majors open individually. **Version-update PRs target `dev`** (`target-branch: dev`), the integration
branch. Dependabot **security** updates always target the repo's **default branch** — which is now
**`dev`** (the default was switched from `prod` to `dev`), so both version and security PRs land on
`dev` and reach `prod` only through the normal promotion PR. Dependabot **security alerts** (the continuous CVE feed, independent of PRs) are
enabled separately under repo **Settings → Security → Dependabot alerts** — turn that on to get alerts as
new advisories land. Note: a Dependabot PR does **not** auto-run CI — like a fork PR it needs a maintainer
to apply the `ci-approved` label.

### Transitive advisories — `overrides` in `package.json`

Dependabot only opens PRs for **direct** dependencies. When an advisory lands on a *nested transitive*
(something pulled in by `nodemon`, `glob`, `@electron/asar`, `dir-compare`, `test-exclude`, …) no version
bump reaches it, and the alert sits open indefinitely. Those are pinned with an npm
[`overrides`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides) block in the owning
workspace's `package.json`.

Use the **version-selector form** (`"pkg@<major>": "<range>"`) whenever a package has several majors live
in one tree — a blanket `"pkg": "^5"` would force consumers pinned to `^1` onto an incompatible major:

```jsonc
// cross-platform-overlay/package.json
"overrides": {
  "brace-expansion@1": "^1.1.16",   // GHSA-3jxr-9vmj-r5cp — under glob / @electron/asar / dir-compare
  "brace-expansion@2": "^2.1.4",    // second advisory, range 2.0.0 - 2.1.2
  "brace-expansion@5": "^5.0.7",    // root resolution
  "js-yaml@4": "^4.3.0"             // GHSA-52cp-r559-cp3m
}
```

> **Do not delete these entries** during dependency cleanups. Each one is holding a transitive off a known
> advisory; removing it silently reopens the alert. Drop an entry only once the parent package's own
> resolution has moved past the patched version on its own.

**Prefer bumping the parent when it can reach the fix.** `@hono/node-server` (GHSA-frvp-7c67-39w9, patched
in 2.0.5) was pinned by `@modelcontextprotocol/sdk@1.29.0` at `^1.19.9`; an override would have violated
that contract. SDK `1.30.0` widened to `^1.19.9 || ^2.0.5`, so bumping the SDK was the correct fix and no
override was needed.

**Verify with `npm audit`, not just the GitHub alert list.** The two are not equivalent — the alert feed
listed only the `<1.1.16` and `>=3.0.0,<5.0.7` `brace-expansion` ranges, while `npm audit` also surfaced a
second advisory covering `2.0.0 - 2.1.2`. Run `npm audit` in each workspace after any override change.

## `ci-summary` — no false greens on skipped jobs

```yaml
- name: Require all gate jobs to have succeeded
  run: |
    if [ "${{ contains(needs.*.result, 'failure') }}" = "true" ] || \
       [ "${{ contains(needs.*.result, 'cancelled') }}" = "true" ] || \
       [ "${{ contains(needs.*.result, 'skipped') }}" = "true" ]; then
      echo "A required job failed, was cancelled, or was skipped."
      exit 1
    fi
```

The `skipped` check is critical: an unlabeled PR causes `authorize` to be skipped, which cascades
to all downstream jobs being skipped, which would otherwise produce a misleading green gate.

## Linux overlay smoke details (`overlay-launch-smoke-linux`)

Single build + launch-smoke check:

1. **Packaged-launch smoke** — `npx electron-builder --linux dir` then
   `xvfb-run -a node scripts/ci-launch-smoke.mjs`. Catches crash-on-launch regressions (e.g.
   v1.3.82's `Cannot find module './overlay-core'` which bricked users; since auto-update is removed,
   such a crash requires a manual reinstall — gate is non-negotiable).

The former auto-update E2E step (`tests/mock-relay/auto-update.e2e.mjs`) was removed when
`electron-updater` was retired for Nexus Mods ToS compliance.

## Windows NSIS CI (`overlay-build-windows-nsis`)

Builds the NSIS installer **natively on `windows-latest`** (no Wine, no Docker, no
`ghcr.io/unn-corp/win-electron-builder` image). The prior Wine/DinD/docker-cp strategy was
superseded by the GitHub-hosted runner migration — native Windows is simpler and avoids the
`STATUS_BREAKPOINT` crash that plagued Wine execution of Electron 31+.

Build steps: install admin-dashboard deps (renderer cross-imports require it), install overlay
deps, build renderer, run `electron-builder --win nsis --publish=never` natively. Verification
is artifact-based: `.github/scripts/win-artifacts-check.mjs` asserts:
- the installer `*.exe` (NSIS Setup) and the `win-unpacked` exe are present and non-trivial in size
- `app-update.yml` and `latest*.yml` are **absent** (inverted check — these must not be generated,
  since the overlay no longer auto-updates)

The former native-exe smoke job (`overlay-autoupdate-e2e-windows-exec`) and the `tests/mock-relay/`
auto-update fixture were removed when auto-update was retired.

See [windows-nsis-ci-fixes.md](windows-nsis-ci-fixes.md) for the full Wine/DinD failure history
that motivated the migration to native windows-latest.

## Overlay CI never touches prod

The `tests/mock-relay/` hermetic fixture was removed together with the auto-update E2E it served.
The remaining `overlay-launch-smoke-linux` job builds and launches the packaged overlay and asserts a
clean startup (via `scripts/ci-launch-smoke.mjs`) without requiring a relay; it does not hit
`https://falloutchatmod.com`. Any direct prod access must go through an explicit, manual
`workflow_dispatch` "prod-smoke" run only.

## Runner details

- Linux jobs default to **GitHub-hosted `ubuntu-latest`**. Set the `CI_RUNNER` repo variable
  to switch to self-hosted (see toggle commands above).
- The Windows job (`overlay-build-windows-nsis`) defaults to **GitHub-hosted `windows-latest`**.
  Set `CI_RUNNER_WINDOWS` to switch to self-hosted.
- `backend-jest` service containers (`postgres:16`, `redis:7`) are reachable on **`localhost`**
  on GitHub-hosted runners. On self-hosted DinD runners the hostname is **`docker`** (the DinD
  sidecar interface). The workflow uses `vars.CI_RUNNER && 'docker' || 'localhost'` to select
  the correct host automatically.
- `overlay-build-windows-nsis` builds the NSIS installer natively on `windows-latest` — no
  Wine, no Docker, no GHCR image; asserts no auto-update feed files are emitted.
- `pr-gate-delabel.yml` always runs on `ubuntu-latest` (no toggle — it only calls the labels API).

## Branch strategy

```
feature/* ──PR──► dev ──PR──► prod ──► Dokploy auto-deploy (prod)
```

- **`prod` = production.** Dokploy auto-deploys on push to `prod`. CI runs as a post-merge
  safety net as well as on every labeled PR.
- **`dev` = integration branch.** Feature PRs target `dev`; when `dev` is green, open
  `dev → prod`.
- Required check on both branches = **`CI Summary`** (the single status check name).

## Branch protection via gh CLI

These require **admin** on the repo. Replace `OWNER/REPO` with the actual slug. The rules are
wired (CODEOWNERS, `ci.yml`, `dev` branch) but **branch protection is NOT
active** on the free-private-repo plan — it cannot be enforced until the repo goes public or moves
to a paid plan. See `CLAUDE.md` for the OPEN task details.

### prod

```bash
gh api -X PUT repos/OWNER/REPO/branches/prod/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["CI Summary"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

### dev

```bash
gh api -X PUT repos/OWNER/REPO/branches/dev/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["CI Summary"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "require_code_owner_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Keep `enforce_admins: false` so the project maintainer can merge their own PRs via admin bypass (GitHub forbids
self-approval); external contributor PRs still require the maintainer's review.

### Verify

```bash
gh api repos/OWNER/REPO/branches/prod/protection --jq '.required_status_checks.contexts'
gh api repos/OWNER/REPO/branches/dev/protection    --jq '.required_status_checks.contexts'
```

To promote additional jobs to required, add them to `ci-summary`'s `needs:` — the single `CI
Summary` context covers them automatically.

## Coverage thresholds

| Surface | Target (phase 2) | Rationale |
| ------- | ---------------- | --------- |
| backend | 60% lines | Most mature suite (Jest+supertest) |
| dashboard `ChatOverlay.tsx` critical paths | 50% | Highest-value (shared across all 3 surfaces) |
| overlay shell/main | 40% | Heavy Electron coupling; needs extraction first |

Notes:
- v8 coverage (Vitest) and jest coverage formats differ — do not share a single threshold number
  across runners.
- Set thresholds per-workspace in each `vitest.config.ts` / jest config, not globally.

## Rollout status

**GitHub-hosted runner migration (active).** All CI jobs now default to GitHub-hosted runners
(`ubuntu-latest` / `windows-latest`). Self-hosted runners remain available via `CI_RUNNER` /
`CI_RUNNER_WINDOWS` repo variables. All 8 jobs are wired and blocking. The
`overlay-build-windows-nsis` job builds the NSIS installer natively on `windows-latest`
(no Wine/Docker) and asserts no auto-update feed files are emitted (auto-update was retired).

The `dashboard-playwright` browser E2E placeholder was removed from the pipeline; it will be
re-added as a proper job once a Playwright suite exists.

Phase 2 (enforce coverage thresholds + promote E2E to required) triggers after ~20 stable green
runs of the relevant jobs.
