# Dashboard Test Plan

> **Status (2026-06-06):** Vitest + RTL wired (`test:unit`). ChatOverlay.tsx has good P0 coverage.
> All other features (moderation panel, system tab, wiki/camp UI, auth pages) have zero tests.

The admin dashboard (`admin-dashboard/`) has two test surfaces:
- **Unit/component** — Vitest + jsdom + @testing-library/react (`npm run test:unit`)
- **Browser E2E** — Playwright (`npm test`) — config exists but all jobs disabled in CI until the
  hermetic mock relay is built (see [overlay-test-plan.md](overlay-test-plan.md))

---

## What exists today

| Test file | What it covers |
|-----------|---------------|
| `src/test/smoke.test.ts` | Vitest harness is alive |
| `src/features/chat/__tests__/chatOverlayHelpers.test.ts` | 63 pure-helper unit tests: `findTheme`, `hexToRgba`, `menuBgColor`, `truncateUrl`, `classifyMedia`, `splitParts`/`splitMentions`, `contentMentionsName`, `loadSettings`/`saveSettings`, `backoffDelay`, `channelTag`, `getOverlayShell`, `resolveAvatarUrl`/`resolveMediaUrl`, `computePickerAnchor` |
| `src/features/chat/__tests__/publicModeLockdown.test.tsx` | Public-mode lockdown (no authed WS, no composer, no party data when `isPublicMode`) |

---

## What needs tests

### Priority 1 — LandingPage (public-facing)

`src/features/auth/LandingPage.tsx` is the public website home page. It fetches live stats, renders
feature descriptions, and hosts the install panel and patch notes.

| Behavior | Kind | Approach |
|----------|------|----------|
| `usePublicStats` — fetches `/api/public/stats`, populates tile values | unit | Mock `fetch`; assert `onlineNow`/`totalUsers`/`totalMessages` reach stat tiles |
| `usePublicStats` — handles fetch failure gracefully (tiles show `--`) | unit | Reject fetch; assert tiles show `--` not crash |
| `useReleases` — fetches `/api/version` + `/api/releases`, populates install panel | unit | Mock fetch; assert download button URL and version tag |
| `formatCount` — compact number formatter | pure unit | `1234→'1.2k'`, `1500000→'1.5M'`, `null→'--'`, `999→'999'` |
| `PipboyNav` — tab click switches content | component | RTL render; click CHAT/SYSTEM/ABOUT; assert panel visibility |
| `InstallPanel` — copy buttons change to "COPIED!" then revert | component | RTL render; click copy; fake timers; assert label changes |
| `PatchNotesPanel` — renders release history | component | Mock `useReleases`; assert version tags and "LATEST" badge |

### Priority 2 — ChatOverlay deeper coverage

The public-mode lockdown tests cover security invariants. What's missing is the **authed** surface.

| Behavior | Kind | Approach |
|----------|------|----------|
| Message composer visible when authenticated | component | RTL with `user` in Outlet context; assert textarea present |
| Channel tab switching updates active channel | component | RTL; click channel tab; assert `room:join` sent over mocked WS |
| Combined-feed renders messages with correct source tags | component | Seed WS frames; assert `[Discord]`/`[Trade]`/`[Server]` tags |
| Blocked-user messages hidden from feed | component | Mock blocked user IDs; assert their messages absent |
| `backoffDelay` used on WS reconnect (deterministic) | unit | Already testable — just add reconnect-attempt cases to `chatOverlayHelpers.test.ts` |
| Mention autocomplete opens on `@` and filters | component | RTL + fake `fetch` for `/api/users/mention-search`; assert dropdown |
| `useDebouncedSearch` hook | unit | Render hook; assert debounce timing with fake timers |

### Priority 3 — Moderation panel

`src/features/moderation/` contains the most business-critical admin UI. None of it is tested.

| Feature | Key behaviors to test |
|---------|----------------------|
| **User list** (`UserList.tsx`) | Loads users via `/api/users`; search+filter update query; pagination cursor |
| **Mute/Ban forms** | Submit fires correct API call; success closes modal; error shows message |
| **AutoMod rules** | Load existing rules; add/delete fires correct endpoints; regex toggle |
| **Message history** | Loads for a user; delete fires `DELETE /api/messages/:id`; renders content |
| **Reports queue** | Lists open reports; resolve/dismiss actions; evidence image preview |
| **Name blacklist** | Load + add + delete blacklist entries |
| **Audit log** | Paginated log with actor/action/target columns; date filter |

These are all interaction-heavy. Recommended approach per component:
1. Mock `api.get` / `api.post` / `api.delete` via `vi.mock('../../services/api', ...)`
2. RTL render with a `QueryClientProvider` wrapper
3. Assert: data loads correctly, forms submit correctly, error states render

### Priority 4 — System tab

`src/features/system/` — health, CRT charts, devices.

| Feature | Key behaviors to test |
|---------|----------------------|
| `CrtLineChart` | Renders SVG path for non-empty data; `NO DATA YET` placeholder for empty; dual-axis scaling |
| `CrtBarChart` | Bar heights proportional to max value; label formatting |
| `CrtRangeSelector` | Date range changes fire callback with correct ISO timestamps |
| `ServerHealth` | `/api/health` response renders as connected/disconnected badges |
| `Devices` | Lists enrolled devices; revoke fires `DELETE /api/devices/:installToken` |

### Priority 5 — Wiki and Camp UI

`src/features/wiki/` and any camp-related UI surfaces.

| Feature | Key behaviors to test |
|---------|----------------------|
| Wiki search page | `GET /api/wiki?q=<query>` results render; empty state; click navigates to detail |
| Wiki entry page | Renders infobox table; image sidebar; categories |
| Admin wiki sync trigger | POST to `/api/admin/wiki/ingest`; 202 → "started" toast; 409 → "already running" message |
| Camp admin ingest | Same pattern as wiki admin |

### Priority 6 — Auth / onboarding pages

| Feature | Key behaviors to test |
|---------|----------------------|
| `LoginPage` | Renders Discord login button; unauthenticated redirect from protected routes |
| Landing page auth flow | `ACCESS TERMINAL →` link navigates to `/login` |
| `ModerationTab` public | Renders public moderation log (read-only); no admin controls visible |

---

## Component test harness

Most dashboard components need this wrapper to mount without errors:

```tsx
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router';

function renderWithProviders(ui: React.ReactElement, { user } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Outlet context={{ user }} />}>
            <Route index element={ui} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
```

Mock the `api` service at the module level before importing components:

```ts
vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
  },
}));
```

---

## E2E scenarios (Playwright — blocked on mock relay)

The hermetic `tests/mock-relay/` fixture was removed when the auto-update E2E it served was
retired (see [overlay-test-plan.md](overlay-test-plan.md)); a future Playwright E2E suite would
require a fresh fixture effort. The priority browser E2E scenarios remain:

1. **Public website lockdown** — unauthenticated visitor sees landing page; chat tab shows read-only
   feed; no authed WS handshake reaches the mock relay.
2. **Authed dashboard happy path** — log in as member; channels load; send message in General;
   message appears with correct source tag.
3. **Mod actions gated by role** — member: no mute/ban/delete in context menu. Moderator: has mute
   but not ban. Admin: has ban.
4. **Reconnect resilience** — kill mock WS mid-session; assert reconnect with jittered backoff;
   feed resumes without duplicates.
5. **Public stats polling** — mock `/api/public/stats` returning incrementing values; assert tiles
   update on 30s interval (fake timers).
6. **Install panel copy buttons** — click PowerShell copy; assert clipboard contains the CLI command.

---

## Running tests

```bash
cd admin-dashboard

# Unit/component (jsdom — fast, no server needed)
npm run test:unit
npm run test:unit -- --watch
npm run test:unit -- --coverage

# Browser E2E (disabled until mock relay exists)
# npm test
```
