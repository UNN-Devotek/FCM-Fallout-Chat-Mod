# Frontend — Admin Dashboard

`admin-dashboard/` is a React 18 + Vite + Tailwind single-page application. It
serves two distinct purposes simultaneously:

1. **Admin / moderation portal** — staff-only tools (users, bans, auto-mod,
   embeds, audit log, etc.) behind Discord OAuth2 role guards.
2. **Host for the shared `ChatOverlay` component** — the same overlay that
   renders inside the Electron desktop client and on the public landing page.
   See [chat-overlay.md](./chat-overlay.md) for the one-component / three-surfaces
   rule.

## Tech Stack

| Layer | Library | Notes |
|-------|---------|-------|
| UI framework | React 18 | functional components, hooks |
| Build tool | Vite | `strictPort: true` on port 7075 (dev) |
| Styling | Tailwind CSS (v4 `@theme`) + inline styles | `index.css` maps CSS custom properties into Tailwind tokens; see [theming.md](./theming.md) |
| Server state | TanStack Query (`@tanstack/react-query`) | `staleTime: 30s`, `retry: 1`, `refetchOnWindowFocus: false` — `admin-dashboard/src/lib/queryClient.ts` |
| UI / auth state | React Context | `AuthContext` (`admin-dashboard/src/contexts/AuthContext.tsx`) |
| Routing | React Router v6 (`createBrowserRouter`) | `admin-dashboard/src/App.tsx` |
| HTTP client | custom `api` wrapper | `admin-dashboard/src/services/api.ts` |

## Routing and Auth

`admin-dashboard/src/App.tsx` defines all routes. Public routes (`/`, `/login`,
`/report`, `/apply`) are accessible without authentication. Everything else is
wrapped in `AuthGate` → `AdminLayout`.

Role-gating uses the `RoleGuard` component which redirects non-staff users to
`/chat` if they lack the required role. The roles `owner`, `admin`, `moderator`
unlock staff tools; any other authenticated user lands on the chat overlay.

`AuthContext` additionally supports a **"view as role"** impersonation mode
(`viewAsRole`) for owners and admins. Toggling it re-skins the entire app
without a reload because everything reads the effective `user.role` from
context. The real identity is always preserved in `realUser`.

Auth is Discord OAuth2: `GET /auth/discord` → callback → cookie session. The
`/auth/me` endpoint provides the hydrated `AuthUser` on load.

## Feature Folder Structure

Source code follows a feature-folder convention:

```
admin-dashboard/src/
  features/
    auth/            # landing page, login, moderation-tab component
    chat/            # ChatOverlay (shared), LiveFeed, pickers, hooks
    moderation/      # all staff tools (bans, reports, automod, etc.)
    profile/         # user profile page
    public/          # unauthenticated report / apply forms
    system/          # audit log, server health, help, devices
  components/        # shared layout components (AdminLayout, BannedSplash, etc.)
  contexts/          # AuthContext
  lib/               # queryClient
  services/          # api.ts HTTP wrapper
```

Each feature folder contains components and, when needed, a `hooks/` sub-folder
for TanStack Query hooks (e.g. `features/system/hooks/useCommunityStats.ts`). Complex features
additionally have a `pages/` sub-folder.

## State Management Summary

| State kind | Tool | Where stored |
|-----------|------|-------------|
| Auth session | `AuthContext` (React Context) | in-memory; hydrated from `GET /auth/me` |
| Server / async data | TanStack Query | in-memory query cache |
| Chat overlay settings | `useState` + `localStorage` | key `fcm_web_overlay_settings` |
| Role impersonation | `AuthContext` + `sessionStorage` | key `fo76.viewAsRole` |
| Electron overlay state | `overlay-state.json` in Electron `userData` | managed by the Electron shell, not React |

## SEO and crawler markup

The public landing page (`/`) is served from `admin-dashboard/index.html`, which
carries the SEO surface:

- **`index.html` `<head>`** — descriptive `<title>` + `<meta name="description">`,
  `<link rel="canonical" href="https://falloutchatmod.com">`, Open Graph
  (`og:*`) and Twitter card (`twitter:*`) tags, and a `SoftwareApplication`
  JSON-LD `<script type="application/ld+json">`.
- **`admin-dashboard/public/robots.txt`** — allows crawling but disallows
  `/api/`, `/auth/`, `/admin/`; points at the sitemap.
- **`admin-dashboard/public/sitemap.xml`** — lists the apex URL.
- **`<noscript>` fallback** — a descriptive `<p>` block for no-JS crawlers. It
  lives in `<body>` (flow content like `<p>` is invalid inside a `<noscript>`
  in `<head>`, which fails HTML validation) and **must not** contain a
  `<meta http-equiv="refresh">`: the page IS served at the apex origin, so a
  refresh to `https://falloutchatmod.com` redirects the page to itself and traps
  no-JS crawlers in an infinite reload loop.

Guarded by `admin-dashboard/src/test/indexHtmlSeo.test.ts` (runs in the
`unit-vitest` CI job), which asserts the SEO tags are present/valid and that no
self-redirecting `<noscript>` meta-refresh is reintroduced.

See also:
- [chat-overlay.md](./chat-overlay.md) — the shared overlay component
- [theming.md](./theming.md) — CSS variable theming
- [features.md](./features.md) — per-feature walkthrough
- [../overlay/](../overlay/) — Electron shell (window management, IPC)
- [../realtime/](../realtime/) — WebSocket protocol
