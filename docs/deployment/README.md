# Deployment Overview

This section covers production hosting, the Electron overlay release pipeline, packaging, and local development environment setup.

---

## Production Infrastructure

| Concern | Detail |
|---------|--------|
| Hosting | Self-hosted VPS running Docker Compose, managed by **Dokploy** |
| Public URL | `https://falloutchatmod.com` |
| Edge | **Cloudflare Tunnel** (`cloudflared` → backend container, port 7676) |
| Reverse proxy | **Not Traefik** — the Cloudflare Tunnel is the only ingress; `traefik.enable=false` is set on the backend service label |
| Auto-deploy | Every push to `prod` triggers Dokploy to rebuild and redeploy |
| Monitoring | Uptime Kuma |
| Backups | Dokploy built-in S3-compatible backup job (no manual steps) |

### Services (docker-compose.yml)

| Container | Image | Role |
|-----------|-------|------|
| `postgres` | `timescale/timescaledb:latest-pg15` | Primary database |
| `redis` | `redis:7-alpine` | Session store + rate-limit counters |
| `minio` | `minio/minio:latest` | Object storage (internal only, port 9700) |
| `backend` | Custom (`backend/Dockerfile`) | API + WebSocket + Discord bot + static SPA |

The backend serves the compiled admin dashboard SPA same-origin (baked into the Docker image via a `dashboard-builder` stage). No separate dashboard container is deployed.

No host ports are published for the backend in production — it is reachable only through the Cloudflare Tunnel over `dokploy-network`.

### Standby / Failover

`dokploy-standby.yml` defines a `backend-standby` service that polls the primary backend at `$PRIMARY_URL/api/health`. When the primary is down it starts its own `node dist/server.js` process; when the primary recovers it kills it. The standby connects to the same Postgres and Redis over the shared Docker network. An Nginx config (`backend/infra/failover.conf`) shows the intended upstream pool:

```
upstream backend_pool {
    server backend:7676 max_fails=2 fail_timeout=10s;
    server backend-standby:7677 backup;
}
```

The standby stack is deployed once manually as a separate Dokploy compose service; it is not rebuilt on every push.

> **Warning — schema-dropping migrations:** because the standby is not rebuilt on push, any migration that drops or renames database objects (e.g. removing the `client_metrics` telemetry table) requires a **manual rebuild and redeploy of the standby** before it is put into service. Failing to do so means the standby would start on failover running stale code that references dropped tables. The standby is not currently active, but this step is required whenever it is brought online after such a migration.

### Cloudflare Tunnel Rollback

If the tunnel goes down:
1. Point the `falloutchatmod.com` DNS A record to the origin VPS IP.
2. Re-enable the Traefik router in Dokploy (`traefik.enable=true` + an explicit `Host` router).
3. CF credentials live at `~/.config/fcm/cf.env`; restart `cloudflared` with that token to restore.

---

## Backend-only vs. Overlay Releases

**Backend / dashboard changes** — push to `prod`; Dokploy rebuilds automatically. No client release needed.

> **Promote `dev` → `prod` with a merge commit — never squash or rebase that PR.** Feature PRs are
> squash-merged into `dev` (fine), but the `dev` → `prod` promotion PR **must** be merged as a *merge
> commit* (`gh pr merge <n> --merge`). Squashing/rebasing the promotion replays every change as a *new*
> commit SHA on `prod`, so `prod` and `dev` end up with byte-identical content but divergent histories —
> both branches then perpetually report as ahead/behind each other (git compares SHAs, not file content).
> `prod` is a protected branch (no force-push); the sole code owner is also the author, so use
> `gh pr merge <n> --merge --admin` to bypass the self-approval requirement.

> **Before promoting: the backend fails closed on unset MinIO config in production.** The startup
> guard (`collectMinioProductionErrors` in `backend/src/config/environment.ts`) calls `process.exit(1)`
> if `MINIO_ENDPOINT`, `MINIO_BUCKET`, or `MINIO_PUBLIC_URL` is unset (or `MINIO_ENDPOINT` is left at the
> Docker default `http://minio:9700`, or the root user/password are at their dev defaults). `MINIO_ENDPOINT`
> is the server-side, Docker-internal S3 endpoint; `MINIO_PUBLIC_URL` is the browser-reachable URL. Confirm
> the prod `.env` defines all three before the next `dev` → `prod` promotion, or the backend will refuse to
> boot. (`MINIO_BUCKET` may be any non-empty name, including `avatars`.)

**Electron overlay changes** — require a full packaging and publish pipeline. See [releasing-the-overlay.md](releasing-the-overlay.md).

---

## Documents in This Section

| File | Contents |
|------|----------|
| [local-dev.md](local-dev.md) | Local stack setup, dev port map, per-platform instructions |
| [hosted-dev-environment.md](hosted-dev-environment.md) | Isolated hosted dev stack for contributors: sanitizing seed pipeline, secure remote DB/object-store access, dev Discord |
| [qa-builds.md](qa-builds.md) | QA-tester builds: the dev-guild QA role gate + golden-build lock, and the build / bless / distribute / retire runbook (Linux `dist:qa` + the Build Windows QA runner workflow) |
| [releasing-the-overlay.md](releasing-the-overlay.md) | Full Electron release pipeline, step by step |
| [packaging.md](packaging.md) | What each `Packaging/` script does |
| [code-signing.md](code-signing.md) | AV / SmartScreen situation; Azure Trusted Signing path |
| [secret-rotation-runbook.md](secret-rotation-runbook.md) | Procedure for rotating a DB credential (consistent backup + minimal downtime) and scrubbing secrets from git history |

### Related docs

- Overlay internals: `../overlay/README.md`
- Update notification runbook: `../overlay/auto-update.md`
- Code signing detail: `../CODE-SIGNING.md` and `../AZURE-CODE-SIGNING-SETUP.md`
