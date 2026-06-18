# Discord ⇄ GitHub Ticketing

Turns Discord into the front door for our tracker. Members file **bug reports**,
**suggestions**, and **player reports** from a panel of buttons. Bug/suggestion
issues land on a single **master Project v2 board** (all issues + features) via
GitHub's Auto-add workflow; **player reports** go to the **moderation portal**
(not GitHub). Every report opens a **private thread**. Threads **auto-archive after 24h of
inactivity** — open (unlocked) threads re-open when someone posts (users can still
reply); **Closed/Locked** threads stay shut.

Implemented in [`backend/src/services/ticketService.ts`](../../backend/src/services/ticketService.ts)
(Discord wiring), [`githubService.ts`](../../backend/src/services/githubService.ts)
(GitHub API via native `fetch`, no Octokit dependency), and the pure helpers in
[`githubTicketHelpers.ts`](../../backend/src/services/githubTicketHelpers.ts)
(unit-tested). It attaches to the shared discord.js client via `register()` — no
second login — like voice channels and reaction roles.

> **Status:** Outbound flow is live — private-by-default threads; View on GitHub /
> Add to Roadmap / Close / Delete buttons; developer-role tagging; the optional
> milestone picker; a **Report a Player** button (→ moderation portal); and a single
> master project board. Still to come: the inbound GitHub webhook (comment→thread,
> close→thread) and thread→comment sync.

---

## Flow (increment 1)

1. An **overseer or server admin** runs **`/ticket-panel`** in a text channel
   (the command is locked to **Administrator** by default and the handler also
   accepts the **owner/overseer role**) → the bot posts an embed (brand color
   `#F1C40F`) with **🐞 Report a Bug**, **🚩 Report a Player**, and **💡 Suggestion**
   buttons (all the same Secondary style), plus a link to the master project board.
2. A member clicks a button → a **modal** collects *Title*, *Description* (and
   *Steps to reproduce* for bugs). Discord modals cannot accept files, so the issue
   is **text-only** — screenshots go in the thread.
3. On submit the bot:
   - creates a GitHub issue, labelled `bug` / `suggestion`;
   - the label drives GitHub's **Auto-add to project** workflow on the master board
     (see Project board setup below) — the bot does not write the project directly;
   - opens a **private thread** (all threads are private by default — reporter +
     staff via Manage Threads) named **`#<num> · <title>`** (≤ 100 chars), and
     **@-tags the reporter and the `SUPPORT_ROLE_ID` role**;
   - **deletes Discord's "started a thread" system message** in the parent channel
     so the panel embed stays at the bottom;
   - posts a summary embed carrying a **🔗 View on GitHub** link button, staff-only
     **🗺️ Add to Roadmap / ✅ Close / 🗑️ Delete** buttons, and an **optional
     milestone picker** (select menu of the repo's open milestones — reporter or
     staff may set one);
   - records the issue↔thread mapping in `github_issue_threads`.
4. Thread buttons (staff only):
   - **Add to Roadmap** → applies the `roadmap` label (marks planned features within
     the master board; there is no separate roadmap board).
   - **Close** → **immediately locks** the thread (done first and independently of
     the GitHub call, so a GitHub error can't leave it open) so only members with
     **Manage Threads** — admins/devs/mods — can post and everyone else is
     read-only; then closes + archives the GitHub issue. Lock failures surface to
     the closer (bot needs Manage Threads). For non-staff to be fully read-only,
     the admin/dev/mod roles must hold Manage Threads in the channel.
   - **Delete** (with a confirm step) → **deletes the GitHub issue** (falls back to
     closing it if the token lacks delete permission), removes the DB mapping, and
     **deletes the thread** — full teardown.

Attachments dropped in a thread stay in Discord; they are **not** copied to
GitHub (text-only issues by design). Increment 2's thread→comment sync notes the
attachment count on the GitHub side without uploading the files.

---

## Report a Player

The **🚩 Report a Player** button **and the website report form** submit to the
**moderation portal**, not GitHub. Every report gets a sequential **case number**
(`player_reports.report_number` — a Postgres sequence; assigned to Discord- **and**
web-filed reports, shown in the portal's `#` column).

1. Any member clicks it → a modal collects *What happened?* + *Player name(s) involved*.
2. The bot writes a `player_reports` row directly via Prisma (in-process; it upserts
   the reporter's account, mirroring the website form) and fires the mod-log alert.
3. It opens a **private "lockdown" thread** titled **`Player Report · #<number> · <involved> · <reporter>`**
   (no emoji), **@-pings moderators + overseers** (`MODERATOR_ROLE_ID` +
   `OWNER_ROLE_ID`), and adds staff-only buttons: **✅ Close** (mark the report
   closed), **🔒 Lock** (lock the thread), **🗑️ Delete** (delete the report **and**
   tear down the thread).
4. **Website-filed reports open the same thread** — created in the channel where
   `/ticket-panel` was last run (persisted as `tickets.panel_channel_id`), so every
   report lands in Discord with the same number, title, pings, and buttons.
5. Screenshots dropped in that thread are uploaded to MinIO and attached to the
   report (up to 3, matching the web form) — the bot reacts ✅ on success. Uploads
   are hardened: only **https Discord-CDN** URLs are fetched (SSRF guard), each must
   be `image/*` and **≤ 5 MB** (pre- and post-download), the fetch has a 10s timeout,
   and `uploadReportImages` magic-byte-validates before storage. The 3-image total
   cap bounds storage abuse.

It appears in the moderation portal's **Player Reports** view next to web-submitted
ones. Implemented in
[`playerReportService.ts`](../../backend/src/services/playerReportService.ts) +
[`playerReportHelpers.ts`](../../backend/src/services/playerReportHelpers.ts); the
thread↔report link is `player_reports.discord_thread_id`
([migration](../../backend/prisma/migrations/20260617120000_player_report_discord_thread/migration.sql)).

---

## Configuration

Environment variables (see [`backend/.env.example`](../../backend/.env.example)):

| Var | Meaning |
|-----|---------|
| `GITHUB_PAT` | Fine-grained PAT (owner `UNN-Devotek`). Needs **Issues: R/W** (Projects write NOT required — boards are Auto-add/label driven). Empty ⇒ feature disabled. |
| `GITHUB_OWNER` / `GITHUB_REPO` | Target repo (`UNN-Devotek` / `FCM-Fallout-Chat-Mod`). |
| `GITHUB_PROJECT_NUMBER` | The single master Project v2 board number (`5`). |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for inbound webhooks (future). |
| `OWNER_ROLE_ID`, `ADMIN_ROLE_ID`, `MODERATOR_ROLE_ID`, `DEVELOPER_ROLE_ID` | Staff roles (button gating). Player-report threads ping `MODERATOR_ROLE_ID` + `OWNER_ROLE_ID` ("overseers"). |
| `SUPPORT_ROLE_ID` | Role @-pinged in **bug/suggestion** ticket threads (replaced the old developer-role ping). |

### Project board setup (important)

**Boards are populated by GitHub's built-in "Auto-add to project" workflow, not by
the bot.** Fine-grained PATs (`github_pat_…`) **cannot** write to *user-owned*
Projects v2 — `addProjectV2ItemById` returns `FORBIDDEN: Resource not accessible by
personal access token` regardless of the token's permissions. So the bot only sets
**labels** (which it can do), and each project's Auto-add workflow places the item.

Enable, in the master project → **⋯ → Workflows → Auto-add to project**:
- filter `is:issue is:open` to add every issue (or `is:issue is:open label:bug,suggestion`
  to scope it). The `roadmap` label marks planned features within the board.

The bot does **not** call the project API at all — board placement is entirely the
Auto-add workflows above. (To add items directly instead, you'd need a **classic**
token with the `project` scope, or org-owned projects, plus re-introducing an
`addProjectV2ItemById` call in `githubService`.)

## Bot permissions

The bot needs, in the panel channel: **Create Private Threads**, **Send Messages
in Threads**, **Manage Threads** (so staff/devs see private threads and the bot
can lock/archive/delete), **Manage Messages** (to delete the "started a thread"
system message), **Mention @everyone, @here, and All Roles** (to ping the
developer role), **Embed Links**, **Read Message History**. (`/ticket-panel` is
registered on `ready`, guild-scoped, upsert-by-name.)

Bug/suggestion threads @-ping `SUPPORT_ROLE_ID`; player-report threads ping
`MODERATOR_ROLE_ID` + `OWNER_ROLE_ID`. Set those role IDs for the pings to fire.

## Persistence

`github_issue_threads` (Prisma model `GithubIssueThread`,
[migration `20260617000000_add_github_issue_threads`](../../backend/prisma/migrations/20260617000000_add_github_issue_threads/migration.sql))
maps `issueNumber` ⇄ `discordThreadId` for both sync directions, plus `type`,
`isPrivate`, and the reporter. The migration is idempotent (`IF NOT EXISTS`).

## Tests

- [`tests/githubTicketHelpers.test.js`](../../backend/tests/githubTicketHelpers.test.js) — custom-id round-trip, thread-name truncation, issue-body shaping, `isStaff` gating, type mappings.
- [`tests/githubService.test.js`](../../backend/tests/githubService.test.js) — `fetch`-stubbed: issue create/close/delete, milestones, label no-op.
- [`tests/playerReportHelpers.test.js`](../../backend/tests/playerReportHelpers.test.js) + [`tests/playerReportService.test.js`](../../backend/tests/playerReportService.test.js) — player-report sanitisation, image cap, user upsert, MinIO attach.

All run under the CI `backend-jest` gate.
