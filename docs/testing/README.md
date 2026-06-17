# Testing

> **HARD RULE — every feature ships with unit tests + CI coverage.** When you build or change a
> feature, write its unit tests in the **same** change and make sure they run in CI
> (`.github/workflows/ci.yml`). A feature is not "done" until its tests exist and pass in CI. If a CI
> job doesn't yet cover the new surface, wire it in and promote it into the required `CI Summary` gate
> once stable. (Mirrored in [CLAUDE.md](../../CLAUDE.md) Hard Rules.)

This is the entry-point doc for the Fallout Chat Mod test strategy. It covers the testing
philosophy, the three test layers, the tooling decisions per workspace, the directory layout, and
the exact commands you run locally. Deeper material lives in sibling docs:

- **[overlay-test-plan.md](overlay-test-plan.md)** — per-unit test plan for `cross-platform-overlay`
  and `ChatOverlay.tsx`: what's done, what's backlog, required refactors, and E2E scenarios.
- **[dashboard-test-plan.md](dashboard-test-plan.md)** — per-feature test plan for
  `admin-dashboard`: LandingPage, moderation panel, system tab, wiki/camp UI, and E2E scenarios.
- **[backend-test-plan.md](backend-test-plan.md)** — per-controller/service test plan for the
  Express backend: what exists, priority gaps (device auth, message service, mod actions, job crons),
  and the two-runner setup (Jest + node:test).
- **[ci-cd-pipeline.md](ci-cd-pipeline.md)** — the GitHub Actions workflow (`ci.yml`), the job
  graph, branch protection, the hermetic mock relay, and the coverage rollout.

> This is a living plan. Several units cited below are **not yet directly testable** because the
> code has no `module.exports` / named exports or runs side effects at import time. Those are
> tracked as refactors in [overlay-test-plan.md](overlay-test-plan.md) — write the refactor and the
> test in the same change.

## Philosophy

1. **Test behavior at the right altitude.** Pure logic gets fast unit tests; UI gets narrow
   component slices; cross-process integration (real Electron window, real WebSocket frames) gets a
   small number of E2E checks. We do **not** mount the 8399-line `ChatOverlay.tsx` in full to assert
   a string — we extract the helper and unit-test it.
2. **Extraction before mocking.** When a behavior is trapped in a closure or reads module-level
   mutable state (the overlay's visibility/hysteresis/keybind machines, the inline reconnect
   backoff, the `Trading → Trade` tag map), the cheapest path to coverage is to extract a pure
   function that takes its inputs as arguments. Prefer that over an ever-growing electron/DOM mock.
3. **Hermetic by default — never touch prod.** No test may hit `https://falloutchatmod.com`. The
   current `tests/e2e/chat-smoke.spec.ts` defaults to prod and **must be repointed** at the local
   mock relay (see [ci-cd-pipeline.md](ci-cd-pipeline.md)). The only prod-facing check is an
   explicit, manual `workflow_dispatch` smoke run.
4. **Respect the hard rules.** Tests must not fork `ChatOverlay.tsx` (mock its import to isolate the
   Electron shell, never duplicate it) and must assert the **public-mode lockdown** as a
   first-class behavior: in public mode the authed WebSocket is never opened and private
   party/member/invite data is never rendered.
5. **Assert side effects, not throws.** Much of the overlay main process is fire-and-forget with
   swallowed errors. Tests spy on the side effect (IPC send, `setBounds`, `register`) rather than
   expecting a thrown error or return value.

## The three layers

### 1. Unit — pure logic, no DOM, no Electron

Fast, deterministic functions over primitives. The highest-value, zero-or-low-refactor wins:

- **Shared overlay component helpers** — `findTheme`, `hexToRgba`/`hexAlpha`, `menuBgColor`,
  `truncateUrl`, `classifyMedia`, `splitParts`/`splitMentions`, `contentMentionsName`,
  `loadSettings`/`saveSettings`, `resolveAvatarUrl`/`resolveMediaUrl` (all in
  `admin-dashboard/src/features/chat/ChatOverlay.tsx`; need **named exports** added first).
- **Overlay renderer helpers** — `accelFromEvent`, `prettyAccel`, `collectChannels`,
  `resolveAvatarUrl`, the extracted `computeResizeBounds` and `valueFromFraction`, `isDragTarget`
  (in `cross-platform-overlay/src/shell.ts` / `main.tsx`; need exports + extraction).
- **Onboarding + bridge logic** — `deriveInitialOnboardingState`, the nav/name-taken reducers,
  `applyRelayBase`, the fetch-shim path routing (`cross-platform-overlay/src/onboarding.ts`,
  `bridge.ts`).
- **Main-process pure helpers** — `stateHasRealData`, `isCfChallenge`, `isSinglePrintableChar`,
  and the to-be-extracted `canShowOverlay`, `desiredTopmost`, `resolveAppVersion`,
  `resolveAppClientKey` (in `cross-platform-overlay/main.js`).

### 2. Component — jsdom + React Testing Library

Narrow renders of one component with its external seams mocked (`api` singleton, global
`WebSocket`, `localStorage`, `window.__FCM_OVERLAY_SHELL__`, react-query, react-router outlet
context). High-value targets:

- **`ChatOverlay.tsx` public-mode lockdown** — composer absent, mod context-menu items absent,
  authed `WebSocket` constructor never called, party queries disabled.
- **`ChatOverlay.tsx` surface parity** — `isPublicMode` is derived from **both** `user` (outlet
  context) and the shell global; tests must control both.
- Sub-components once exported — `Avatar`, `BlockManagerBody`, `SettingsModal`.
- **Overlay renderer chrome** — the `Shell` auth state machine (`main.tsx`), the `updater-ui.ts`
  banner machine, onboarding step navigation and prefill.

### 3. E2E — Playwright

- **Electron** — Playwright's `_electron` API (`electron.launch({ args: ['.'] })`) against the
  **hermetic mock relay** (local Express + `ws` server injected via the existing `RELAY_HTTP` /
  `RELAY_WS` env vars). On Linux CI this runs under `xvfb-run -a` and likely needs
  `--no-sandbox`/`--disable-gpu` plus the overlay's QUIC-disable flags.
- **Dashboard browser** — existing `admin-dashboard/playwright.config.js` (chromium, baseURL
  `:7075`) against a local `vite preview` + mock relay, not a running dev server or prod.

Representative scenarios (full list in [overlay-test-plan.md](overlay-test-plan.md)): cold-start
onboarding-without-game tray handoff; game-scan hysteresis (no flip until `PRESENCE_FLIP_SCANS`
consecutive agreeing scans); explicit-hide-then-relaunch `userHidden` semantics; idle
collapse/expand preserving user width; update notification (`app:update-available` → OS toast,
once-per-session guard, Nexus link on click); public-mode lockdown (no authed WS handshake reaches
the mock relay).

## Tooling decisions

| Workspace | Unit / Component | E2E | Rationale |
| --------- | ---------------- | --- | --------- |
| `backend` | **Jest 29** (existing, supertest) | — | 21 passing CommonJS suites, Postgres+Redis integration; no Vite. Not worth churning. |
| `admin-dashboard` | **Vitest + @testing-library/react + jsdom** (new `test:unit`) | `@playwright/test` (existing) | Owns the canonical `ChatOverlay.tsx` — highest-value coverage. Vitest reuses the Vite 6 + plugin-react transform with zero extra config. |
| `cross-platform-overlay` | **Vitest + @testing-library/react + jsdom** (new) | `@playwright/test` `_electron` | Same Vite reuse; jsdom needs no native electron, so units run on `ubuntu-latest`. |
| repo root `tests/` | — | `@playwright/test` (`_electron` + chromium) | Cross-process E2E driving the real Electron app against the mock relay. |

**Why Vitest, not Jest, for the two frontend packages.** Both already run Vite 6 with
`@vitejs/plugin-react`. Vitest reuses that exact transform pipeline (esbuild TS/JSX, path aliases,
Tailwind), native ESM (both packages are `"type": "module"` posture), jsdom env, RTL compatibility,
and v8 coverage out of the box. Jest would require babel/ts-jest, a manual `moduleNameMapper` for
aliases, and a parallel build graph that drifts from the real build.

**Backend runner caveat.** `npm test` (Jest) globs only compiled `tests/**/*.test.js`, so you must
`npm run build` (tsc) **before** Jest or it finds nothing/stale. The newer TS unit suites under
`backend/src/services/__tests__/*.test.ts` run via the hand-rolled `src/testRunner.ts`
(`node:test` + tsx) and need a **separate** `npm run test:unit`. Until the backend is consolidated
onto one runner, CI must run **both** or the wiki TS units go unexecuted. See
[ci-cd-pipeline.md](ci-cd-pipeline.md).

**Don't clobber `test` in the dashboard.** `admin-dashboard`'s `test` script is already Playwright.
Add a **new** `test:unit = vitest run`; the Vitest config must `test.exclude` the `./tests`
(Playwright) directory so the runners don't collide.

## Directory layout per package

```
backend/
  tests/                       # Jest + supertest integration (compiled *.test.js)
  src/services/__tests__/      # node:test TS units (run via src/testRunner.ts -> npm run test:unit)

admin-dashboard/
  vitest.config.ts             # NEW: jsdom env, react+tailwind plugins, test.exclude ./tests
  vitest.setup.ts              # NEW: @testing-library/jest-dom matchers
  src/**/*.test.ts(x)          # co-located Vitest unit/component tests
  tests/                       # existing Playwright browser E2E (excluded from Vitest)
  playwright.config.js         # existing; add webServer (vite preview :7075 + mock relay)

cross-platform-overlay/
  vitest.config.ts             # NEW: jsdom env, react+tailwind plugins
  vitest.setup.ts              # NEW: jest-dom + a window.relayBridge mock factory fixture
  src/**/*.test.ts             # co-located Vitest unit/component tests

tests/                         # repo-root cross-process E2E
  e2e/                         # chat-smoke.spec.ts (REPOINT off prod), overlay-launch.spec.ts
```

Co-locate unit/component tests next to the source they cover (`*.test.ts`/`*.test.tsx`). E2E specs
live under the repo-root `tests/` tree. (The `tests/mock-relay/` hermetic fixture was removed when
the auto-update E2E it served was retired; a future Playwright suite would need a fresh fixture.)

## Running tests locally

> First-time setup for the two frontend packages adds the Vitest toolchain
> (`vitest`, `@testing-library/react`, `@testing-library/jest-dom`,
> `@testing-library/user-event`, `jsdom`) plus a `vitest.config.ts`. See
> [overlay-test-plan.md](overlay-test-plan.md) for the config skeleton.

### Backend (Jest + node:test)

```bash
cd backend
npm ci
npx prisma generate
npm run build            # tsc — Jest reads the compiled *.test.js
npm test                 # Jest + supertest (needs Postgres + Redis up)
npm run test:unit        # node:test TS units (wiki services) via src/testRunner.ts
```

Bring the dependencies up first with the dev stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

### Admin dashboard (Vitest units/components)

```bash
cd admin-dashboard
npm ci
npm run test:unit                # vitest run (jsdom)
npm run test:unit -- --watch     # watch mode
npm run test:unit -- --coverage  # v8 coverage
```

### Overlay (Vitest units/components)

```bash
cd cross-platform-overlay
npm ci
npm run test:unit                # vitest run (jsdom; no native electron needed)
npm run test:unit -- --coverage
```

### Dashboard browser E2E (Playwright)

```bash
cd admin-dashboard
npx playwright install --with-deps chromium
npm run build
npm test                         # serves vite preview :7075 + mock relay via webServer config
```

### Electron E2E (Playwright `_electron`)

```bash
cd cross-platform-overlay
npm ci
npm run build:renderer
# start the hermetic mock relay, then point the app at it:
RELAY_HTTP=http://127.0.0.1:<port> RELAY_WS=ws://127.0.0.1:<port> \
  xvfb-run -a npx playwright test ../tests/e2e
```

On macOS/Windows drop `xvfb-run -a`. The mock relay is launched as a Playwright fixture in CI; see
[ci-cd-pipeline.md](ci-cd-pipeline.md) for the exact job wiring and required-check graph.

## Related docs

- [overlay-test-plan.md](overlay-test-plan.md) — per-unit plan, refactors, e2e scenarios.
- [ci-cd-pipeline.md](ci-cd-pipeline.md) — GitHub Actions jobs, branch protection, mock relay.
- [../deployment/local-dev.md](../deployment/local-dev.md) — dev stack, ports, process hygiene.
