# Mothership production definition

This definition is preparation for the
[return runbook](../../docs/deployment/return-production-to-mothership.md).
It has not been applied to production. G3–G10 acceptance still controls startup.
Keep Dokploy Compose `3GsIKasZFoGsbum6d9XoZ` auto-deploy disabled during preparation.

The project retains `chat-mod-fallout-chat-mod-dprwq2` and the existing tunnel's
`chat-mod-fallout-chat-mod-dprwq2-backend-1:7676` origin. Stores share a dedicated
internal network; only the backend and connector share the app network. The
backend's single host port is loopback-only. There are no public store ports.

## Images and persistent state

`.env.example` records the imported local config IDs proven against the exact
Hostinger image archive. PostgreSQL stays 15.17 and TimescaleDB stays 2.26.2.
Set `FCM_BACKEND_IMAGE` to the accepted Hostinger image's verified local config ID
after import; confirm architecture, config hash and every rootfs layer against
the recovery manifest. All images use `pull_policy: never`; missing images fail
instead of rebuilding a checkout or retrieving a mutable tag.

The four external volumes are explicit:

| State | Restored destination volume |
| --- | --- |
| PostgreSQL | `fcm-return-prod-20261013-postgres` |
| Redis | `fcm-return-prod-20261013-redis` |
| MinIO | `fcm-return-prod-20261013-minio` |
| Downloads | `fcm-return-prod-20261013-downloads` |

Create them only through the approved fresh-volume restore procedure. Missing
volumes fail startup. Preserve all older Mothership volumes. Inspect actual
mounts and volume identities after both deploy and redeploy; a successful
definition check alone does not prove a complete restore.

Copy current Hostinger configuration securely to
`/home/devotek/fcm-return-mothership-20261013/config/`, with directories 0700 and
files 0600. The backend consumes `runtime.env`; PostgreSQL consumes `postgres.env`
with `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`; Redis consumes `redis.env`
with `REDIS_PASSWORD`; MinIO consumes `minio.env` with its two root credential keys.
Only the connector consumes `edge.env`. Preserve secret equality and all intentional
empty values. Normalize backend `DATABASE_URL` and `REDIS_URL` hostnames to
`postgres` and `redis` while preserving URI-encoded credentials. Require
`MINIO_BUCKET=avatars` and verify the restored bucket. Never print resolved env.
Verify every consumer uses that same endpoint: `DB_HOST=postgres`, `DB_PORT=5432`,
`REDIS_HOST=redis`, and `REDIS_PORT=6379`, with matching URL credentials. The pg
pool and Bull use the discrete fields even when Prisma/common Redis use URLs.
Validate the accepted image's complete production guard, including an explicit
`SUPPORTER_TIER_ENABLED=true` or `false`, while preserving the operator's setting.
These files use Compose `format: raw`: write literal `KEY=value` lines without
quote wrappers or interpolation escapes. Compare resolved values in memory
against the source containers' effective environment, not just the source file's
text; ordinary env-file parsing can change dollar signs in stored credentials.
Reject multiline values until an explicitly tested encoding is available. The
source and destination Compose versions must support this format.

Copy the source's `/app/releases.json` to `config/releases.json` even if current
release records also live in PostgreSQL. Restore the full downloads volume with
matching advertised sizes/hashes; do not seed it from a newer build. The release
metadata bind is writable and must already exist as a file.
Verify every download is readable under the accepted backend UID/GID with all
capabilities dropped, preserving restored ownership and modes. Successful helper
reads with broader privileges do not prove the public route will serve the file.
The control directory and release file must be owned by the accepted backend's
effective UID/GID (currently root, `0:0`). With all capabilities dropped, a root
process cannot bypass a different owner's 0700/0600 permissions. Verify actual
ownership and a harmless read/write probe using the accepted image before startup.

## Frozen startup and validation

Create the writable host directory
`/home/devotek/fcm-return-mothership-20261013/runtime-control/` with mode 0700 and
an operation-specific `maintenance.json` before any destination application starts.
Mounts cannot silently create missing directories/files. The controller uses
`/app/runtime-control`, a 120-second drain deadline and a 180-second Docker grace.
Do not use Docker's eventual force-kill as successful drain evidence. Persist C4
before starting the backend or any schema patch, including private acceptance.
Before cold backup, require the persisted runtime checkpoint to report `closed`
and `ingressClosed: true`, with no active work or failures, matching inspection
epochs and cleared restart evidence; independently verify the exact backend
container stopped cleanly. A nonclosing drain does not authorize a cold copy.
Transfer the complete cold runtime-control directory with both forward and
reverse state, including receipts, failure/recovery journals, cursors and fence
evidence. Restore its private ownership/modes and retain any unresolved restart
evidence for operator disposition before startup.

Use a protected `.env` containing the nonsecret deployment fields from the example.
Persist those exact fields and protected configuration references in Dokploy.
Render without resolving secret files, then validate with pipeline error checking:

```bash
set -o pipefail
docker compose --profile edge --env-file /path/to/protected/deployment.env \
  -f deploy/return-mothership/docker-compose.yml \
  config --format json --no-env-resolution \
  | node deploy/return-mothership/validate-definition.cjs
```

Check each protected configuration file's existence, ownership, key scope and
required settings separately without returning values. The healthcheck requires
connected PostgreSQL and Redis; it deliberately permits frozen private startup.
Discord, MinIO, authenticated delivery, sessions and downloads remain separate
functional acceptance checks. Health does not authorize opening producers.
The profile flag above includes the connector in the rendered validation only;
`config` starts no services. Omit the profile from pre-C5 startup commands.

After storage restore and C4, start only stores/backend through the recorded
Dokploy definition. The `edge` profile remains unset. Complete controlled recovery
and private acceptance, verify Hostinger writers and connector are stopped, then
follow C5 to start the sole connector. Only after public acceptance set
`COMPOSE_PROFILES=edge` in the persistent Dokploy environment so future redeploys
retain that connector.

## Dokploy and later deployments

Before applying the definition, back up the existing provider settings, command,
Compose path, environment and local overrides. Point the production service at
`deploy/return-mothership/docker-compose.yml`; replace the old root Compose/MinIO
override build command with the validated pinned definition. Do not use fresh
volume or `down --volumes` controls. Rehearse the exact saved command and settings
on isolated synthetic resources before making this production change.

The saved trigger currently uses **On Tag**. A Git push/tag alone cannot replace
these pinned images. Stage and verify each accepted artifact, update its immutable
ID, and pass the repository review/CI gates before authorizing a deployment.
An existing operator maintenance marker survives every stop/redeploy: a new process
remains frozen until the recorded local recovery procedure disposes unresolved
failures and explicitly clears the marker while all prior writers are stopped.
Routine graceful-restart activation must be separately tested: only the exiting
process's own transient restart fence may clear after a fully verified clean
shutdown; operator maintenance, unknown/other fences or unresolved failures remain
closed. Do not enable the trigger until this complete deployment/resume sequence
is rehearsed. No automatic operator-marker removal is authorized by this definition.

`backend/tests/mothershipDeploymentDefinition.test.js` exercises isolation and
unsafe redeploy cases in the required backend Jest CI job. The validator checks
rendered identities and attachments; live image/config provenance, restore
integrity and single authority still require the runbook's evidence.
