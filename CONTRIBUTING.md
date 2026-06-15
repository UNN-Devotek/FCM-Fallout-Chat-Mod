# Contributing to Fallout Chat Mod

Thank you for your interest in contributing. This document covers how to set up the stack locally, the coding conventions, and how to submit changes.

---

## Before You Start

**Read the EULA constraint first.** Fallout Chat Mod must remain compliant with Bethesda's EULA §4(F), which prohibits reading areas of RAM used by the game. Do not introduce any code that:
- Reads Fallout 76 process memory
- Scans the OS TCP/UDP connection table to infer game state
- Modifies or injects into game files or processes

Do not reintroduce world-detection or memory-reader code without written permission from ZeniMax under the §4(F) discretionary carve-out.

---

## Repository Structure

```
backend/              Node.js + Express + Prisma backend
admin-dashboard/      React admin dashboard (Vite + Tailwind v4)
cross-platform-overlay/  Electron overlay (React renderer)
shared/               Shared TypeScript types and Zod schemas
docs/                 Public documentation
```

---

## Local Setup

See the [README](README.md) for the full step-by-step setup. Quick summary:

```bash
git clone <repo-url>
cd fallout-chat-mod
npm install
cp .env.example .env   # fill in Discord credentials and secrets
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Individual packages:
```bash
cd backend && npm run dev           # tsx watch, port 7076
cd admin-dashboard && npm run dev   # Vite, port 3000
cd cross-platform-overlay && npm run dev:local  # Electron + Vite HMR against LOCAL backend
```

> Develop the overlay only against your local backend (`npm run dev:local` / `start:local`). `npm start` and `npm run dist:*` build the shipped binary that targets the production relay — not a dev workflow.

---

## Running Tests

```bash
# Backend (Jest + Supertest)
cd backend && npm test

# Admin dashboard (Playwright)
cd admin-dashboard && npm test

# Root-level Playwright tests
npm test
```

---

## Coding Conventions

### TypeScript
- Strict mode is enabled in all packages. Do not use `any` unless unavoidable — prefer `unknown` + narrowing.
- Use Zod schemas from `shared/` for data that crosses the WebSocket or REST boundary.
- Backend uses `src/` with `tsx` for development and `tsc` for production builds.

### Backend
- Controllers call services; services call Prisma. No DB logic in controllers.
- Error responses follow RFC 7807 Problem Details: `{ type, title, status, detail }`.
- Successful responses are wrapped: `{ "data": { ... } }`.
- New admin endpoints get both a Discord-OAuth-gated route and a debug mirror under `/admin/debug/*` gated by `X-Admin-API-Key`.
- Prisma migrations must be **idempotent** — use `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`. See the note in `CLAUDE.md`.

### React (Dashboard + Overlay Renderer)
- Components use functional style with hooks. No class components.
- Server state via TanStack Query; UI state via React Context or local state.
- Tailwind v4 utility classes only — no inline styles, no CSS modules.
- The overlay renderer (`cross-platform-overlay/src/`) and the admin dashboard chat overlay (`admin-dashboard/src/features/chat/ChatOverlay.tsx`) must remain visually and functionally in sync (Chat Overlay Parity Rule).

### Naming
| Layer             | Convention          | Example                     |
|-------------------|---------------------|-----------------------------|
| DB tables/columns | `snake_case` plural | `chat_rooms`, `audit_logs`  |
| Prisma models     | `camelCase` via `@map` | mapped from DB columns   |
| REST routes       | `kebab-case`        | `/api/moderation-logs`      |
| React components  | `PascalCase`        | `MessageHistory.tsx`        |
| TS modules        | `camelCase`         | `authService.ts`            |
| JSON keys         | `camelCase`         | all API payloads            |
| Socket events     | `domain:action`     | `chat:message`, `room:join` |
| Dates             | ISO 8601 UTC        | always                      |

---

## Submitting Changes

1. **Fork** the repository and create a feature branch from `prod`.
2. Make your changes. Keep commits focused — one logical change per commit.
3. Run tests before opening a PR:
   ```bash
   cd backend && npm test
   ```
4. Open a Pull Request against `prod`. Describe what changed and why, including any EULA-sensitive considerations.
5. A maintainer will review and merge. CI (GitHub Actions) runs lint + tests automatically.

### What Makes a Good PR
- Small and focused — easier to review and revert if needed.
- Tests for new backend logic (Jest + Supertest).
- No hardcoded credentials, server aliases, or internal deploy paths.
- No changes to files outside the documented public surface area of the repo.

---

## Reporting Security Issues

Do not open public GitHub issues for security vulnerabilities. Contact the maintainer privately via the repository's security advisory feature or through [falloutchatmod.com](https://falloutchatmod.com).

Sensitive surfaces to be aware of:
- `ADMIN_API_KEY` / `ADMIN_RELEASE_TOKEN` — never commit these
- Discord OAuth2 client secret — never commit
- The `/admin/debug/*` endpoints bypass Discord OAuth — they require `X-Admin-API-Key` and must never be exposed publicly without that guard

---

## License

This project is licensed under the [MIT License](LICENSE). By contributing,
you agree that your contributions will be licensed under the same MIT License.
No contributor license agreement (CLA) is required — the standard MIT
inbound=outbound licensing applies.
