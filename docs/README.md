# Fallout Chat Mod — Documentation

Fallout Chat Mod is a governed, real-time community chat platform for Fallout 76. It delivers
community channels (General / Trading / Events / Raids) with a Discord bridge and a browser-based
moderation portal, rendered through a transparent in-game overlay.

> **EULA §4(F) — two tracks, kept separate.** The default **desktop overlay** is EULA-safe: it only
> checks whether the `Fallout76` process is running (to show/hide the overlay) and never reads game
> memory, modifies game files, injects code, or scans networks/ports. The optional **in-game HUD mods
> (`.ba2`)** are a separate, explicit opt-in install that swap UI assets and may read the game's own
> UI-layer data the HUD already renders (e.g. `worldId` / nearby-player roster from `BSUIDataManager`)
> via the selected ZFE/xScal provider's sanctioned outbound channel — never bundled into or required by the overlay. Neither track
> reads game memory, injects code, or scans networks/ports.

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
| **In-game HUD feed** | [overlay/zfe/](overlay/zfe/README.md) | FCMChatWidget, native ZFE/xScal relay, packaging, input, appearance, recovery |
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
- **Delivery ordering depends on the producer.** Ordinary authenticated WS sends wait for the
  Bull persistence job before visibility. Native `/relay` sends ACK and fan out after durable queue
  acceptance to keep the synchronous HUD RPC bounded; database/Discord completion is separate.
  Cross-instance fan-out uses Redis pub/sub. See [HUD retry safety](overlay/zfe/hud-send-retries.md)
  and [architecture/data-flow.md](architecture/data-flow.md).
- **Migrations must be idempotent.** `baseline-migrations.sh` runs `prisma db push` before
  `migrate deploy`, so every migration must use `IF NOT EXISTS` / constraint guards / `ON CONFLICT DO
  NOTHING`. See [database/migrations.md](database/migrations.md).
- **Release gotchas that cause real breakage.** `productName` is `"Fallout Chat Mod"` **with spaces**;
  PowerShell release scripts must be **ASCII-only**. No `latest*.yml` feed — the overlay no longer
  auto-updates (Nexus Mods ToS compliance); update awareness is a passive OS notification delivered
  over the chat WebSocket (`app:update-available`). See [deployment/releasing-the-overlay.md](deployment/releasing-the-overlay.md).

## Reference documents (existing)

- [TERMS.md](TERMS.md) — terms of service
- [PRIVACY.md](PRIVACY.md) — privacy policy
- [product/supporter-tier.md](product/supporter-tier.md) — supporter tier + chat cosmetics design record
- [legal/monetization-policy.md](legal/monetization-policy.md) — binding rules for what may and may not be monetized
- [legal/nexus-disclosure-supporter-tier.md](legal/nexus-disclosure-supporter-tier.md) — proactive Nexus Mods disclosure (draft)

---

*This documentation set was built to support open-sourcing the project. When code changes, update the
relevant domain doc here rather than expanding AGENTS.md — AGENTS.md should link to these docs for depth.*
