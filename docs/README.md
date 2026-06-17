# Fallout Chat Mod — Documentation

Fallout Chat Mod is a governed, real-time community chat platform for Fallout 76. It delivers
community channels (General / Trading / Events / Raids) with a Discord bridge and a browser-based
moderation portal, rendered through a transparent in-game overlay.

> **EULA §4(F) — two tracks, kept separate.** The default **desktop overlay** is EULA-safe: it only
> checks whether the `Fallout76` process is running (to show/hide the overlay) and never reads game
> memory, modifies game files, injects code, or scans networks/ports. The optional **in-game HUD mods
> (`.ba2`)** are a separate, explicit opt-in install that swap UI assets only — never bundled into or
> required by the overlay. Neither track reads game memory, injects code, or scans networks/ports.

This folder is the central documentation hub. Each domain lives in its own subfolder, with a
`README.md` that orients you and deeper topic files alongside it.

## Map of the system

```
┌─────────────────┐   ┌──────────────────┐   ┌────────────────────┐
│  Electron        │   │  Admin Dashboard │   │  Public Website    │
│  Overlay         │   │  (React SPA)     │   │  (CHAT tab)        │
│  (in-game)       │   │  /chat           │   │  read-only         │
└────────┬─────────┘   └────────┬─────────┘   └─────────┬──────────┘
         │  all three render the SINGLE ChatOverlay.tsx component
         │                      │                       │
         └──────── WSS relay ───┼──── REST API ─────────┘
                                │
                     ┌──────────▼───────────┐      ┌──────────────┐
                     │  Backend             │◄────►│  Discord Bot │
                     │  Express + raw WS    │      │  (bridge,    │
                     │  + Prisma + Bull     │      │   voice,     │
                     └──────────┬───────────┘      │   embeds)    │
                                │                  └──────────────┘
              ┌─────────────────┼──────────────────┐
        ┌─────▼─────┐    ┌──────▼──────┐    ┌───────▼──────┐
        │ Postgres  │    │   Redis     │    │   MinIO      │
        │ (Prisma + │    │ (sessions,  │    │ (ban / report│
        │ Timescale)│    │  rate-limit)│    │  evidence)   │
        └───────────┘    └─────────────┘    └──────────────┘
```

## Domains

| Domain | Start here | Covers |
| ------ | ---------- | ------ |
| **Architecture** | [architecture/](architecture/README.md) | System overview, data flow, glossary — how everything connects |
| **Backend** | [backend/](backend/README.md) | REST API reference, services, auth model, jobs & queues |
| **Real-time** | [realtime/](realtime/README.md) | WSS relay protocol, presence & sessions, HUD push |
| **Frontend** | [frontend/](frontend/README.md) | Admin dashboard, the shared ChatOverlay component, theming |
| **Electron overlay** | [overlay/](overlay/README.md) | Window management, keybinds, update notification, building |
| **In-game HUD feed** | [overlay/zfe/](overlay/zfe/README.md) | ZFE/FCMBridge wire format, events, env vars, modder guide |
| **Discord bot** | [discord/](discord/README.md) | Chat bridge, Join-to-Create voice, embed builder, reaction roles |
| **Database** | [database/](database/README.md) | Prisma schema, idempotent migrations, Redis usage |
| **Moderation** | [moderation/](moderation/README.md) | Automod engine, reports & evidence, role model |
| **Deployment** | [deployment/](deployment/README.md) | Local dev setup, release pipeline, packaging, code signing |
| **Testing** | [testing/](testing/README.md) | Testing strategy, overlay unit/UI tests, CI/CD pipeline |

## Key facts worth knowing up front

- **One ChatOverlay component, three surfaces.** `admin-dashboard/src/features/chat/ChatOverlay.tsx`
  renders identically on the auth dashboard, the public website, and the Electron overlay. It branches
  only on `overlayShell` (Electron chrome) and `isPublicMode` (logged-out read-only lockdown). Never
  fork it. See [frontend/chat-overlay.md](frontend/chat-overlay.md).
- **Auth.** Overlay clients use an anonymous UUID install token → an ephemeral session token in Redis.
  The admin dashboard uses Discord OAuth2 with server-authoritative role re-verification on every
  request (owner/admin/moderator). See [backend/auth.md](backend/auth.md).
- **Message persistence is off the hot path.** WS broadcast happens immediately; a Bull/Redis queue
  (`messagePersist`) writes to Postgres asynchronously. Cross-instance fan-out uses Redis pub/sub, so
  the backend scales horizontally with no sticky sessions. See [architecture/data-flow.md](architecture/data-flow.md).
- **Migrations must be idempotent.** `baseline-migrations.sh` runs `prisma db push` before
  `migrate deploy`, so every migration must use `IF NOT EXISTS` / constraint guards / `ON CONFLICT DO
  NOTHING`. See [database/migrations.md](database/migrations.md).
- **Release gotchas that cause real breakage.** `productName` is `"Fallout Chat Mod"` **with spaces**;
  PowerShell release scripts must be **ASCII-only**. No `latest*.yml` feed — the overlay no longer
  auto-updates (Nexus Mods ToS compliance); update awareness is a passive OS notification delivered
  over the chat WebSocket (`app:update-available`). See [deployment/releasing-the-overlay.md](deployment/releasing-the-overlay.md).

## Reconciled code/doc discrepancies

These were surfaced by the code while documenting and have since been reconciled in code + docs:

- **Session TTL — standardized to 24h.** `SESSION_TTL_SECONDS` was 30 days; it is now `24 * 60 * 60`
  (`usersController.ts:20`, `server.ts:243`). The overlay silently re-registers via its install token
  on reconnect, so a shorter session is transparent to users. The 30-day Discord re-auth window
  (`discordAuthedAt`) is a separate mechanism and is unchanged.
- **WS rate limit — comment corrected to 5 msg/sec.** The implementation (`checkWsRateLimit`) always
  enforced 5 frames/sec; a stale comment said "2 msg/sec" (`websocket/handlers.ts:1882`). CLAUDE.md
  now states 5.
- **Voice service filename.** The real file is `voiceService.ts` (no `tempVoiceService.ts` exists);
  CLAUDE.md now points at the correct path.
- **Default overlay theme.** The startup default is `fo76-wasteland` (amber/gold); `vault-tec-green`
  (`#18FF62`, Phosphor Green) is the classic Pip-Boy look but not the default. CLAUDE.md now reflects this.
- **TimescaleDB hypertables.** `messages` and `audit_logs` are hypertables with composite PK
  `(id, created_at)` and 90-day retention; `audit_logs.target_id` is intentionally FK-less (polymorphic
  target — use raw SQL for joins). Documented in CLAUDE.md and [database/schema.md](database/schema.md).

## Reference documents (existing)

- [TERMS.md](TERMS.md) — terms of service

---

*This documentation set was built to support open-sourcing the project. When code changes, update the
relevant domain doc here rather than expanding CLAUDE.md — CLAUDE.md should link to these docs for depth.*
