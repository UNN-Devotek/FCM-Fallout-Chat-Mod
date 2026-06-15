<!-- Thanks for contributing! PRs target the `dev` branch. -->

## What this changes

A clear description of the change and why.

Closes #<!-- issue number, if applicable -->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor / cleanup
- [ ] Docs
- [ ] CI / tooling

## Checklist

- [ ] **Tests** added or updated, and passing locally (backend Jest, dashboard/overlay Vitest as applicable).
- [ ] **Typecheck** clean (`npx tsc --noEmit`) for every workspace touched.
- [ ] **Docs updated** in `docs/` for any changed endpoint, socket message type, env var, schema/migration, auth/session behavior, keybind, or config key.
- [ ] **Migrations are idempotent** if the schema changed (`IF NOT EXISTS` / constraint guards / `ON CONFLICT DO NOTHING`).
- [ ] **EULA §4(F) respected** — no game-memory reading, no code injection, no network/port scanning. The desktop overlay stays EULA-safe; in-game `.ba2` HUD mods remain an opt-in, asset-only install.
- [ ] **No secrets / private infra identifiers** added (tokens, real IPs, server/container names).

## Testing notes

How you verified the change (commands run, manual steps, screenshots).
