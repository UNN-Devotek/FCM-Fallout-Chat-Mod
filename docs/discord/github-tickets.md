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

> **Status:** Increment 1 (outbound) is live, including the gated Private Bug
> button and the optional milestone picker. Increment 2 — the inbound GitHub
> webhook (comment→thread, `roadmap` label→board, close→thread), thread→comment
> sync, and a `/roadmap` command — is still to come.

---

## Flow (increment 1)

1. A staff member runs **`/ticket-panel`** in a text channel → the bot posts an
   embed with **🐞 Report a Bug**, **💡 Suggestion**, and **🔒 Private Bug**
   buttons, plus links to the two GitHub boards. (A button on a shared embed is
   visible to everyone; **Private Bug is gated on click** — non-staff get a
   "staff-only" ephemeral reply.)
2. A member clicks a button → a **modal** collects *Title*, *Description* (and
   *Steps to reproduce* for bug / private bug). Discord modals cannot accept
   files, so the issue is **text-only** — screenshots go in the thread.
3. On submit the bot:
   - creates a GitHub issue, labelled `bug` / `suggestion` / `bug`+`private`;
   - adds it to **Project v2 #2** (`addProjectV2ItemById`, GraphQL);
   - opens a thread named **`#<num> · <title>`** (≤ 100 chars) — **public**, or
     **private** (reporter + staff) for the private-bug flow;
   - **deletes Discord's "started a thread" system message** in the parent channel
     so the panel embed stays at the bottom;
   - posts a summary embed in the thread with a staff-only **🗺️ Add to Roadmap**
     button and an **optional milestone picker** (a select menu of the repo's open
     milestones — reporter or staff may set one; not required);
   - records the issue↔thread mapping in `github_issue_threads`.
4. **Add to Roadmap** (staff only) adds the issue to **Project v2 #3** and applies
   the `roadmap` label.

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

GitHub Projects v2 is **GraphQL-only**, and adding items requires the token's
**Projects: Read _and write_** permission. A token with Projects: read-only (or
`repo`/Issues only) can create issues but `addProjectV2ItemById` returns
`FORBIDDEN: Resource not accessible by personal access token` — board-add and
roadmap-add then silently fail (logged at `warn`; the issue + thread still get
created).

## Bot permissions

The bot needs, in the panel channel: **Create Public Threads**, **Create Private
Threads**, **Send Messages in Threads**, **Manage Threads**, **Manage Messages**
(to delete the "started a thread" system message), **Embed Links**, **Read
Message History**. (`/ticket-panel` itself is registered on `ready`,
guild-scoped, upsert-by-name.)

## Persistence

`github_issue_threads` (Prisma model `GithubIssueThread`,
[migration `20260617000000_add_github_issue_threads`](../../backend/prisma/migrations/20260617000000_add_github_issue_threads/migration.sql))
maps `issueNumber` ⇄ `discordThreadId` for both sync directions, plus `type`,
`isPrivate`, and the reporter. The migration is idempotent (`IF NOT EXISTS`).

## Tests

- [`tests/githubTicketHelpers.test.js`](../../backend/tests/githubTicketHelpers.test.js) — custom-id round-trip, thread-name truncation, issue-body shaping, `isStaff` gating, type mappings.
- [`tests/githubService.test.js`](../../backend/tests/githubService.test.js) — `fetch`-stubbed: issue create, project-id resolution + caching, GraphQL error surfacing, label no-op.

Both run under the CI `backend-jest` gate.
