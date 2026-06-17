# Discord ⇄ GitHub Ticketing

Turns Discord into the front door for our GitHub issue tracker. Members file
**bug reports** and **suggestions** from a panel of buttons; the bot creates a
GitHub issue, adds it to the **Bug & Suggestion board** (Project v2 #2), and opens
a public thread for discussion. Staff can promote a ticket onto the **Roadmap
board** (Project v2 #3).

Implemented in [`backend/src/services/ticketService.ts`](../../backend/src/services/ticketService.ts)
(Discord wiring), [`githubService.ts`](../../backend/src/services/githubService.ts)
(GitHub API via native `fetch`, no Octokit dependency), and the pure helpers in
[`githubTicketHelpers.ts`](../../backend/src/services/githubTicketHelpers.ts)
(unit-tested). It attaches to the shared discord.js client via `register()` — no
second login — like voice channels and reaction roles.

> **Status:** Increment 1 (outbound) is live — private-by-default threads, the
> View on GitHub / Add to Roadmap / Close / Delete buttons, developer-role tagging,
> and the optional milestone picker. Increment 2 — the inbound GitHub webhook
> (comment→thread, `roadmap` label→board, close→thread), thread→comment sync, and a
> `/roadmap` command — is still to come.

---

## Flow (increment 1)

1. A staff member runs **`/ticket-panel`** in a text channel → the bot posts an
   embed with **🐞 Report a Bug** and **💡 Suggestion** buttons, plus links to the
   two GitHub boards.
2. A member clicks a button → a **modal** collects *Title*, *Description* (and
   *Steps to reproduce* for bugs). Discord modals cannot accept files, so the issue
   is **text-only** — screenshots go in the thread.
3. On submit the bot:
   - creates a GitHub issue, labelled `bug` / `suggestion`;
   - the label drives GitHub's **Auto-add to project** workflow on board #2 (see
     Project board setup below) — the bot does not write the project directly;
   - opens a **private thread** (all threads are private by default — reporter +
     staff via Manage Threads) named **`#<num> · <title>`** (≤ 100 chars), and
     **@-tags the reporter and the `DEVELOPER_ROLE_ID` role**;
   - **deletes Discord's "started a thread" system message** in the parent channel
     so the panel embed stays at the bottom;
   - posts a summary embed carrying a **🔗 View on GitHub** link button, staff-only
     **🗺️ Add to Roadmap / ✅ Close / 🗑️ Delete** buttons, and an **optional
     milestone picker** (select menu of the repo's open milestones — reporter or
     staff may set one);
   - records the issue↔thread mapping in `github_issue_threads`.
4. Thread buttons (staff only):
   - **Add to Roadmap** → applies the `roadmap` label; GitHub's Auto-add workflow
     on board #3 places it on the Roadmap.
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

## Configuration

Environment variables (see [`backend/.env.example`](../../backend/.env.example)):

| Var | Meaning |
|-----|---------|
| `GITHUB_PAT` | Fine-grained PAT (owner `UNN-Devotek`). Needs **Issues: R/W** + **Projects: R/W**. Empty ⇒ feature disabled. |
| `GITHUB_OWNER` / `GITHUB_REPO` | Target repo (`UNN-Devotek` / `FCM-Fallout-Chat-Mod`). |
| `GITHUB_PROJECT_BUGS_NUMBER` | Project v2 number for the bug+suggestion board (`2`). |
| `GITHUB_PROJECT_ROADMAP_NUMBER` | Project v2 number for the roadmap board (`3`). |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for inbound webhooks (increment 2). |
| `OWNER_ROLE_ID`, `ADMIN_ROLE_ID`, `MODERATOR_ROLE_ID`, `DEVELOPER_ROLE_ID` | Staff roles allowed to promote to the roadmap. |

### Project board setup (important)

**Boards are populated by GitHub's built-in "Auto-add to project" workflow, not by
the bot.** Fine-grained PATs (`github_pat_…`) **cannot** write to *user-owned*
Projects v2 — `addProjectV2ItemById` returns `FORBIDDEN: Resource not accessible by
personal access token` regardless of the token's permissions. So the bot only sets
**labels** (which it can do), and each project's Auto-add workflow places the item.

Enable, in each project → **⋯ → Workflows → Auto-add to project**:
- **Board #2 (Bug & Suggestion):** filter `is:issue is:open label:bug,suggestion`.
- **Board #3 (Roadmap):** filter `is:issue label:roadmap`.

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

`DEVELOPER_ROLE_ID` must be set for the developer-role @-tag to fire; on the dev
stack it mirrors `DEV_DEVELOPER_ROLE_ID`.

## Persistence

`github_issue_threads` (Prisma model `GithubIssueThread`,
[migration `20260617000000_add_github_issue_threads`](../../backend/prisma/migrations/20260617000000_add_github_issue_threads/migration.sql))
maps `issueNumber` ⇄ `discordThreadId` for both sync directions, plus `type`,
`isPrivate`, and the reporter. The migration is idempotent (`IF NOT EXISTS`).

## Tests

- [`tests/githubTicketHelpers.test.js`](../../backend/tests/githubTicketHelpers.test.js) — custom-id round-trip, thread-name truncation, issue-body shaping, `isStaff` gating, type mappings.
- [`tests/githubService.test.js`](../../backend/tests/githubService.test.js) — `fetch`-stubbed: issue create, project-id resolution + caching, GraphQL error surfacing, label no-op.

Both run under the CI `backend-jest` gate.
