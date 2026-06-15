# Feature Folders

All feature modules live under `admin-dashboard/src/features/`. Each folder
groups related components and hooks. When a folder grows complex it adds
`components/`, `hooks/`, or `pages/` sub-folders.

---

## `auth/`

| File | Purpose |
|------|---------|
| `LandingPage.tsx` | Public marketing page. Hosts the Pip-Boy nav bar, the shared `ChatOverlay` (public/read-only mode), a moderation preview tab, and a help section. Renders the CHAT, MODERATION, and SYSTEM tabs without a logged-in user. |
| `LoginPage.tsx` | Discord OAuth2 login prompt. Redirects to `/auth/discord`. |
| `ModerationTab.tsx` | Read-only preview of moderation features shown on the landing page MODERATION tab. Exports `MODERATION_SUBTABS`. |

The landing page mounts `ChatOverlay` directly (not via a route), so `user` is
never passed through `OutletContext` — this is what triggers `isPublicMode`.

---

## `chat/`

| File | Purpose |
|------|---------|
| `ChatOverlay.tsx` | **The** single shared chat overlay component. Three surfaces, one file. Includes the inline `WikiPanel`, `WikiAcThumb`, and wiki autocomplete. Full documentation: [chat-overlay.md](./chat-overlay.md). |
| `LiveFeed.tsx` | Staff-only raw message feed (`/feed` route). Shows all channels unfiltered; requires `moderator` role or higher. |
| `EmojiPicker.tsx` | Emoji picker popup used by `ChatOverlay`'s input box. |
| `GifPicker.tsx` | GIF search / picker popup. |
| `usePickerInsert.ts` | Hook coordinating emoji/GIF selection → cursor-aware insertion into the message input. |

---

## `client-performance/`

Tracks Electron overlay client telemetry (memory, CPU, GIF cache, FPS).
Staff-only (`/client-performance` route, `moderator+` role).

| File | Purpose |
|------|---------|
| `pages/ClientPerformancePage.tsx` | Top-level page. Renders window/source selector, charts, and outliers table. |
| `components/MetricLineChart.tsx` | CRT-styled line chart for time-bucketed metrics (p50/p90/p99 series). |
| `components/OutliersTable.tsx` | Table of individual high-memory / high-CPU Electron client sessions. |
| `hooks/useClientMetrics.ts` | TanStack Query hook. Fetches `GET /api/admin/client-metrics?window=<w>&source=<s>`. `staleTime: 60s`, `refetchInterval: 5min`. |

---

## `moderation/`

The bulk of staff tooling. All routes are protected by `RoleGuard` with
`['owner', 'admin', 'moderator']`. Admin-only actions (e.g. ban create/edit,
certain user actions) do a secondary `ADMIN_ROLES` check inside the component.

| File | Route | Purpose |
|------|-------|---------|
| `Users.tsx` | `/users` | Search, view, mute, and ban users. Shows Discord link, Steam ID, ban/mute status. |
| `Bans.tsx` | `/moderation/bans` | Paginated ban list with search. Links to BanDetail. |
| `BanForm.tsx` | `/moderation/bans/new` | Create a new ban (user lookup, reason, duration). |
| `BanDetail.tsx` | `/moderation/bans/:id` | View / edit / lift a specific ban. Embeds evidence uploads. |
| `Evidence.tsx` | `/moderation/evidence` | Evidence file browser (images/files attached to ban cases). |
| `PlayerReports.tsx` | `/player-reports` | Open to all authenticated users. Staff see full admin table; regular users see their own submitted reports (self-service view). |
| `BugReports.tsx` | `/bug-reports` | Same dual-view pattern as PlayerReports. |
| `Applications.tsx` | `/applications` | Moderator applications. Staff review; users see their own application status. |
| `AutoModeration.tsx` | `/moderation` | Word filter (regex-capable), spam settings, and Discord alert-channel config. |
| `AutoModViolations.tsx` | `/moderation/violations` | Log of auto-mod rule hits with context. |
| `ChatCommands.tsx` | `/commands` | Manage custom slash commands served by the backend. |
| `NameBlacklist.tsx` | `/name-blacklist` | Blocked username patterns. |
| `Channels.tsx` | `/channels` | Create / edit chat channels (name, color, parent). |
| `Telemetry.tsx` | `/telemetry` | User-action telemetry / analytics. |
| `Voice.tsx` | `/voice` | Join-to-create Discord voice channel configuration (lobby ID, category, name template). |
| `EmbedBuilder.tsx` | `/discord-embeds` | Rich Discord embed builder. Compose fields/images, post via bot, save as template, configure reaction roles. |
| `selfService/MyApplications.tsx` | (sub-view) | Non-staff view of own applications. |
| `selfService/MyReports.tsx` | (sub-view) | Non-staff view of own reports. |

---

## `profile/`

| File | Route | Purpose |
|------|-------|---------|
| `Profile.tsx` | `/profile/:userId` | Public user profile. Shows username, Discord info, message history snippet, moderation notes (staff only). |

---

## `public/`

These routes are accessible without authentication.

| File | Route | Purpose |
|------|-------|---------|
| `ReportPage.tsx` | `/report` | Unauthenticated player report submission form. Uses `MentionInput` for the reported player field. |
| `ApplyPage.tsx` | `/apply` | Moderator application form. |
| `MentionInput.tsx` | (shared) | Input with `@username` autocomplete, used in report/apply forms. |

---

## `system/`

| File | Route | Purpose |
|------|-------|---------|
| `ServerHealth.tsx` | `/server-health` | Live backend health panel: database, Redis, Discord bot status, DB pool stats. Uses `CrtLineChart` and `CrtBarChart`. |
| `AuditLog.tsx` | `/audit-log` | Paginated staff action log (ban, unban, mute, kick, etc.). |
| `Devices.tsx` | `/devices` | Registered Electron client installs. Shows install-token prefix, last-seen, version. |
| `HelpPage.tsx` | `/help` | Help content wrapper. Open to all authenticated users. |
| `HelpContent.tsx` | (embedded) | Canonical built-in slash-command reference (the `BUILTIN_COMMANDS` list) for **both** the auth dashboard (`variant="dashboard"`) and the public landing-page SYSTEM tab (`variant="public"`). Includes the Fallout 76 lookups `/serverstatus` and `/nukecodes`. Keep in sync with `ChatOverlay`'s `BUILTIN_FORMS` autocomplete list and `commandService`'s built-in handlers. |
| `components/CrtLineChart.tsx` | — | Recharts line chart styled to match the Pip-Boy CRT aesthetic. |
| `components/CrtBarChart.tsx` | — | Recharts bar chart, same CRT style. |
| `components/CrtRangeSelector.tsx` | — | Time-range selector (`1h / 24h / 7d / 30d`) used by ServerHealth and ClientPerformancePage. |
| `hooks/useCommunityStats.ts` | — | TanStack Query hook for community stats (message/user counts over time). |

---

## Shared Components (`components/`)

| File | Purpose |
|------|---------|
| `AdminLayout.tsx` | Shell for all authenticated pages. Renders the Pip-Boy navigation sidebar/header, active-user chip, and `<Outlet>` for page content. |
| `BannedSplash.tsx` | Full-screen overlay rendered when a banned user lands on any protected route. Shown globally via `App.tsx`. |
| `ErrorBoundary.tsx` | Generic React error boundary used in the router. |
| `RoleViewSwitcher.tsx` | Owner/admin UI chip for toggling the "view as role" impersonation mode from `AuthContext`. |
