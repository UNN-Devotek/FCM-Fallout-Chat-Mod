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
lint  backend  unit-vitest  overlay-e2e  overlay-autoupdate
check  -jest   (matrix)     -linux       -e2e-windows
                                              │
                                    (bonus, continue-on-error)
                                    overlay-autoupdate-e2e-
                                    windows-exec
        │
        ▼ (all of the above)
   [ci-summary]   ← the single required branch-protection check
```

## Job list (9 jobs total)

| Job | Runner (default) | Required? | Notes |
| --- | ---------------- | --------- | ----- |
| `authorize` | `ubuntu-latest` | **Gate** | Skipped for unlabeled PRs → fails `ci-summary` |
| `osv-scan` | `ubuntu-latest` | **Not required** (`continue-on-error: true`) | OSV (osv.dev) vulnerability scan of every lockfile (`osv-scanner scan source -r .`); advisory only — results in the job log, PR step summary, and an `osv-report` artifact. NON-BLOCKING pilot; see [Dependency scanning](#dependency-scanning-osv--dependabot) |
| `lint-typecheck` | `ubuntu-latest` | **Required** | `tsc --noEmit` matrix over backend, admin-dashboard, cross-platform-overlay |
| `backend-jest` | `ubuntu-latest` | **Required** | `postgres:16` + `redis:7` service containers; service containers on `localhost` (hosted) or `docker` hostname (self-hosted DinD); `prisma generate` + `db push`; `npm run build` then `npm test` + `npm run test:unit` |
| `unit-vitest` | `ubuntu-latest` | **Required** | **Consolidated matrix** (`cross-platform-overlay`, `admin-dashboard`); replaced the former `overlay-unit-component` + `dashboard-unit-component` jobs |
| `overlay-e2e-linux` | `ubuntu-latest` | **Required** | **Consolidated**: builds once, runs (1) packaged-launch smoke (`ci-launch-smoke.mjs`) then (2) auto-update E2E (`tests/mock-relay/auto-update.e2e.mjs`); replaced former `overlay-launch-smoke` + `overlay-autoupdate-e2e` |
| `overlay-autoupdate-e2e-windows` | `windows-latest` | **Required** (prod+PRs) | Builds the NSIS installer **natively** on `windows-latest` (no Wine/Docker/GHCR); runs `win-artifacts-check.mjs` artifact verification |
| `overlay-autoupdate-e2e-windows-exec` | `windows-latest` | **Not required** (`continue-on-error: true`) | Runs the built `.exe` natively; bonus coverage |
| `ci-summary` | `ubuntu-latest` | **The single required gate** | `if: always()`; fails if any listed job is `failure`, `cancelled`, or `skipped` |

All runner values above are defaults (no `CI_RUNNER` / `CI_RUNNER_WINDOWS` variable set). See
the [runner toggle](#runner-toggle-github-hosted-default--self-hosted-fallback) section above for
how to switch to self-hosted runners.

**Job consolidation vs. the old design:** the pipeline previously had 11 jobs. The two Vitest jobs
(`overlay-unit-component`, `dashboard-unit-component`) merged into a single matrix job
`unit-vitest`; the two Linux overlay jobs (`overlay-launch-smoke`, `overlay-autoupdate-e2e`) merged
into `overlay-e2e-linux` (one shared setup, two sequential steps); the placeholder
`dashboard-playwright` job was removed; the `osv-scan` job was later added (non-blocking). Result: 9 jobs.

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

## Linux overlay E2E details (`overlay-e2e-linux`)

Shared setup (one build, two checks):

1. **Packaged-launch smoke** — `npx electron-builder --linux dir` then
   `xvfb-run -a node scripts/ci-launch-smoke.mjs`. Catches crash-on-launch regressions (e.g.
   v1.3.82's `Cannot find module './overlay-core'` which bricked users and could not self-update).
2. **Auto-update E2E** — `tests/mock-relay/auto-update.e2e.mjs` drives the overlay against a
   hermetic mock relay. The overlay must detect and download N+1 against the mock (never prod).

A shared-setup failure blocks both checks at once (accepted tradeoff vs. separate job overhead).

## Windows NSIS CI (`overlay-autoupdate-e2e-windows`)

Builds the NSIS installer **natively on `windows-latest`** (no Wine, no Docker, no
`ghcr.io/unn-corp/win-electron-builder` image). The prior Wine/DinD/docker-cp strategy was
superseded by the GitHub-hosted runner migration — native Windows is simpler and avoids the
`STATUS_BREAKPOINT` crash that plagued Wine execution of Electron 31+.

Build steps: install admin-dashboard deps (renderer cross-imports require it), install overlay
deps, build renderer, run `electron-builder --win nsis --publish=never` natively. Verification
is artifact-based: `tests/mock-relay/win-artifacts-check.mjs` asserts the right files are
present, the correct prod URL is in `app-update.yml`, and `latest.yml` has all required feed
fields.

The Linux `overlay-e2e-linux` job already exercises the `electron-updater` code path end-to-end.
`overlay-autoupdate-e2e-windows-exec` covers native exe execution as bonus coverage
(`continue-on-error: true`).

See [windows-nsis-ci-fixes.md](windows-nsis-ci-fixes.md) for the full Wine/DinD failure history
that motivated the migration to native windows-latest.

## Hermetic mock relay (no prod traffic — mandatory)

The `tests/mock-relay/` fixture is a hermetic Express + `ws` server injected via the overlay's
existing `RELAY_HTTP` / `RELAY_WS` env vars. All CI overlay tests talk to this mock; they never
touch `https://falloutchatmod.com`. Any direct prod access must go through an explicit, manual
`workflow_dispatch` "prod-smoke" run only.

## Runner details

- Linux jobs default to **GitHub-hosted `ubuntu-latest`**. Set the `CI_RUNNER` repo variable
  to switch to self-hosted (see toggle commands above).
- Windows jobs (`overlay-autoupdate-e2e-windows`, `overlay-autoupdate-e2e-windows-exec`) default
  to **GitHub-hosted `windows-latest`**. Set `CI_RUNNER_WINDOWS` to switch to self-hosted.
- `backend-jest` service containers (`postgres:16`, `redis:7`) are reachable on **`localhost`**
  on GitHub-hosted runners. On self-hosted DinD runners the hostname is **`docker`** (the DinD
  sidecar interface). The workflow uses `vars.CI_RUNNER && 'docker' || 'localhost'` to select
  the correct host automatically.
- `overlay-autoupdate-e2e-windows` builds the NSIS installer natively on `windows-latest` — no
  Wine, no Docker, no GHCR image.
- `overlay-autoupdate-e2e-windows-exec` runs the built `.exe` natively; `continue-on-error: true`.
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
`overlay-autoupdate-e2e-windows` job builds the NSIS installer natively on `windows-latest`
(no Wine/Docker). The `overlay-autoupdate-e2e-windows-exec` (native Windows execution) is wired
but `continue-on-error` — bonus coverage only.

The `dashboard-playwright` browser E2E placeholder was removed from the pipeline; it will be
re-added as a proper job once a mock-relay-targeted Playwright suite exists.

Phase 2 (enforce coverage thresholds + promote E2E to required) triggers after ~20 stable green
runs of the relevant jobs.
