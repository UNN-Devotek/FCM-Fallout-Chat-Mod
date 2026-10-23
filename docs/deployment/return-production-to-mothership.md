# Return production from Hostinger to Mothership

**Version:** 0.2 — 2026-10-13

**Status:** Reviewed plan; execution blocked by the open gates below.

**Sequence:** Integrate code → accept Dev → accept the promoted version on Hostinger → rehearse → transfer that same version and final state to Mothership → hold Hostinger for 48 hours.

This is the current return plan, superseding the earlier laptop rehearsal as the
active objective. Include merged remote work and all intended local changes;
leave unmerged dependency PRs separate. Preserve public downloads and the
`falloutchatmod.com` hostname. The outage target is **at most 30 minutes**,
conditional on measured forward and rollback timings. Do not claim readiness
from a written checklist alone: every gate requires recorded evidence.

This document authorizes no live transition by itself. Planning and read-only
inventory may continue. Present a concrete readiness record for approval before
the production write freeze; a reverse transfer requires its own approval unless
the cutover approval explicitly includes the rehearsed rollback procedure.

## 1. Observed state and changes since the first plan

Read-only checks on 2026-10-13 at approximately 13:20–13:24 UTC established:

| Surface | Observation | Consequence |
| --- | --- | --- |
| Hostinger, SSH Manager `hostinger-vps` | `fcm-cutover-prod` has healthy backend, Postgres, Redis and MinIO; cloudflared is running. Health reports DB/Redis/Discord connected; backend restart count is zero. | This is the current production source. Health alone does not establish full recovery readiness. |
| Running production backend | `fcm-hostinger-prod-backend:a6e8df12a730a421b7dea22c83c08726e4310b3f` | Pin the accepted promotion later; do not mistake branch HEAD for the running artifact. |
| Production database | PostgreSQL **15.17**, TimescaleDB **2.26.2**, host `x86_64` | Transfer using the exact compatible runtime; do not combine a storage upgrade with the move. |
| Source persistent mounts | `fcm-cutover-prod_postgres_data`, `_redis_data`, `_minio_data`, `_releases_downloads` | Inventory any additional bind mounts and writable-layer state before backup. |
| Hostinger deployment gates | Repository `HOSTINGER_PROD_AUTODEPLOY=true`; local `HOSTINGER_AUTODEPLOY_ACTIVE` exists. | A Prod push currently deploys independently of CI completion. |
| Mothership, SSH Manager `mothership` | Hosted Dev is healthy under `compose-reboot-back-end-hard-drive-q7s37s`; no old production containers appeared in the FCM container inventory. | Preserve Dev, its volumes, network and tunnel throughout the production return. |
| Mothership production Dokploy service | Compose ID `3GsIKasZFoGsbum6d9XoZ`, app name `chat-mod-fallout-chat-mod-dprwq2`, branch `prod`, **`autoDeploy=true`**, displayed status `idle` | Dormant does not mean fenced. Disable and verify this trigger before any Prod push. |
| Mothership Dev Dokploy service | Compose ID `iWO0FprKUe9j0CXg7k5yq`, branch `dev`, `autoDeploy=false`; laptop deploy variable is false. | Dev deployment must deliberately install and prove the accepted revision. |
| Local code, cached Git refs | 41 changed/new files; HEAD is five commits behind cached `origin/dev`; cached Dev/Prod divergence is 73/3. | Preserve work, fetch, then recompute. These counts are not a live remote inventory. |
| Current HUD acceptance | 2.10.149 failed native stability; 2.10.150 has local automated gates and is `installed-native-pending`. | The earlier 2.10.149 promotion assumption is superseded. Native acceptance remains required. |
| Edge control | No callable Cloudflare MCP is present in the executing session. | No edge operation or production write freeze until capability testing succeeds. |

The earlier inventory estimated about **15.7 GB** of live state. Remeasure after
promotion. Capacity must cover images, source recovery backup, fresh restored
volumes, a reverse-transfer backup, temporary extraction and growth on each host.
Do not delete the only recovery copy to make room.

## 2. Gaps found in the implementation

These are source findings, not features already implemented by this plan.

| Finding | Required resolution and evidence |
| --- | --- |
| `.github/workflows/deploy-hostinger-prod.yml` reacts to Prod pushes without waiting for `CI Summary`. | Fence its repository flag and local marker before promotion; inventory running/queued jobs. Deploy only the exact accepted SHA after checks succeed. Alternatively implement and test CI gating first. |
| `.github/scripts/deploy-hostinger-prod.sh` rolls back only the image; startup runs `db push` and compatibility/data patches. | Prove old-image compatibility on the changed schema, or prepare full state restoration while writes remain frozen. Never assume an image rollback undoes a schema or data change. |
| The script rewrites `.env` before installing its `ERR` rollback trap and has no transition lock or final authority recheck. | Keep it fenced for this operation. Use a rehearsed explicit deploy procedure with atomic checkpoint/config updates and a shared deployment/cutover lock; failure between any two steps must be recoverable. |
| `backend/src/server.ts` has no explicit SIGTERM/SIGINT freeze/drain handler; the image launches Node through `sh -c`. | Implement and test the drain contract in §5, including signal delivery to Node. Increasing the Compose stop timeout is insufficient. |
| `discordService.ts` keeps outbound closures in memory, shifts them before send completion and logs send/link failures. | Observe queued **and in-flight** sends and durable source-to-Discord links; preserve/reconcile ambiguous outcomes. An empty array or quiet log is not proof of delivery. |
| `ingestMessage.ts` permits relay success after Bull enqueue, before Postgres persistence; Discord relay is fire-and-forget. | Verify every accepted marker has one canonical persisted row and, where expected, one Discord copy/link. Account for delayed, failed and stalled Bull jobs. |
| Jobs, giveaway timers and party reaping start during module loading/startup; Discord can receive events before public ingress is opened. | Mark destination state as changed **before starting any backend, migration runner, bot or worker**, not at connector startup or first public message. Prevent blind rollback to stale source state. |
| Reaction-role startup hydrates panel configuration but does not reconcile users' reactions; inbound chat has no verified outage backfill. | Rehearse a bounded, deduplicated Discord recovery procedure. A gateway reconnect or warm panel cache does not prove missed messages or role changes were recovered. |
| `/api/health` can report `status: ok` and return HTTP 200 while a dependency field is disconnected. | Parse `data.database`, `data.redis`, `data.discord`; separately test object storage, queues, authenticated delivery, revision and downloads. |
| The root Compose uses mutable image tags/builds and project-derived volumes; Dokploy can regenerate configuration. | Install an explicit durable, pinned production definition with exact fresh-volume mappings and origin aliases; prove a redeploy preserves them. |

The complete source-specific acceptance record must include
[native HUD recovery evidence](../testing/blue-nameplates-2026-10-12-recovery.md),
[migration behavior](../database/migrations.md),
[Discord reaction roles](../discord/reaction-roles.md) and
[room/history freshness](../realtime/server-room-continuity.md).

## 3. Readiness gates

All gates are **open** until evidence is attached. An unknown result fails a gate.
Assign an operator, UTC timestamp, accepted revision, evidence location and rollback
action to each. A command's success status cannot substitute for its postcondition.

| Gate | Passing evidence |
| --- | --- |
| G1 — code preservation/integration | Restricted backup of tracked/untracked work and refs; reviewed integration preserving Prod-only fixes; final source/artifact manifests match. |
| G2 — deployment fencing | Mothership Prod trigger disabled before Prod push; Hostinger flag/marker fenced; no queued/running deploy, scheduled restart, standby or alternate writer can restart production. Actual containers/processes agree with control-plane state. |
| G3 — code acceptance | Required CI succeeds for the actual integration/promotion revision; Dev and native compatibility acceptance pass; diagnostic/DEV packages are not published as PROD. |
| G4 — Hostinger promotion | Verified pre-upgrade recovery backup, rehearsed schema rollback, exact accepted running image, full functional checks and 30 minutes stable operation. |
| G5 — target definition/config | Pinned image archives/digests; fresh explicit volumes; correct Dokploy source and overrides; secure runtime/edge settings; isolated networks and no direct data-store exposure; redeploy preserves the mappings. |
| G6 — freeze/drain/recovery | Tested §5 contract, queue accounting, clean shutdown and Discord outage reconciliation; all accepted sentinels survive both directions without duplicate side effects. |
| G7 — backup/restore | Encrypted complete state restored on fresh volumes, source/target checksums and semantic inventories match, encryption key recoverable independently of either host. |
| G8 — edge/transport | Cloudflare MCP capability-tested for read/snapshot/exact restore; source/target connector inventory; origin DNS reachable from connector network; authenticated `/ws` and `/relay`, native providers and all discovered production hostnames pass. |
| G9 — timing/reverse transfer | Representative measured forward and reverse runs, restart overhead and external validation fit the 30-minute budget with reserve; no untested delta-copy shortcut. |
| G10 — approved window | Exact date/start/end/timezone, operator, outage accounting, freeze/drain commands, latest rollback decision time and preapproved rollback scope recorded. |
| G11 — acceptance/operations | Post-transfer checks in §8 pass, external monitoring/backup jobs point at Mothership, Dev remains healthy; only the selected Mothership deployment path is enabled. |
| G12 — retirement | 48 hours after acceptance with stable monitoring, independent tested recovery backup, dependency audit and removal of Hostinger FCM deployment/runner credentials; operator accepts power-off. |

No new backend drain or deployment behavior may be considered complete without
meaningful unit/integration tests in the required CI jobs. This plan's review is
documentation work; the implementation and rehearsal gates remain separate work.

## 4. Integrate and promote without starting a second service

1. Snapshot local tracked changes, untracked source/binary artifacts, branch refs
   and worktree status outside the repo in restricted storage. Check backup
   completeness before any stash/reset/merge. Do not commit secrets, raw logs or
   unrelated evidence. Avoid a blanket staging command.
2. Inventory deployment flags, current jobs and other worktrees/PRs. Disable the
   dormant Mothership Prod trigger before anything can push `prod`. Use supported
   Dokploy configuration controls and read back the saved value. If the MCP
   cannot mutate a Compose trigger, use a documented UI step; do not substitute
   an Application mutation or direct database edit.
3. Fetch remote refs, record SHAs and recompute divergence. Use a separate
   integration branch/worktree; reconcile the three Prod-only commits by content
   and ancestry against refreshed Dev. Keep unmerged dependency PRs out of scope.
   Preserve both branch histories; never reset Prod to Dev or force-push Prod.
4. Apply intended local work, resolve source conflicts, then rebuild generated
   artifacts. Verify SWF/BA2/source manifests and environment-specific endpoints.
   Record the current native failure/pending evidence without converting it into
   an acceptance claim. Further edits invalidate affected test/artifact results.
5. Use a Dev PR and the repository's review/`ci-approved`/`CI Summary` gates.
   Pushes delabel the PR: review and rerun against its updated head. Link created
   or worked-on PRs to this conversation. Run backend, dashboard, overlay,
   type-check, pure Haxe/source/package and complete Ruffle checks on the final
   integrated content, then deploy that precise revision to existing hosted Dev.
   A Dokploy redeploy that only rebuilds an old checkout does not install new code.
6. Require the six native pairings: HUD/ZFE ↔ bridge/ZFE, HUD/ZFE ↔ bridge/xScal,
   HUD/xScal ↔ bridge/ZFE, HUD/xScal ↔ bridge/xScal, HUD↔HUD, bridge↔bridge.
   Exercise common rooms/history, both-direction exactly-once delivery, discovery,
   travel/hops, expiry, stale confirmations, auth and isolation. Accept the current
   candidate's stationary nameplate behavior and negative cases as well.
7. Fence Hostinger's deployment flag and local marker **before merging Prod**;
   stop/drain any running deployment safely, cancel queued jobs and recheck just
   before the merge. Job-level flags may already have been evaluated. Marker
   removal alone cannot stop a deployment that already passed that check.
8. Promote accepted Dev via a **merge commit**, never squash/rebase the Dev→Prod
   promotion. Preserve Prod-only behavior and require checks on the resulting
   revision. Do not use an admin bypass to waive required tests.
9. Rehearse the new image's startup schema/data patches on isolated Dev fixtures.
   Capture a verified production recovery set under an approved write freeze
   before applying an incompatible upgrade. A live pre-upgrade copy is not a
   guaranteed cross-store rollback point. Validate on Hostinger first; either
   prove the old image can serve the changed schema or keep writes frozen until
   upgrade acceptance and full restoration are possible without discarding state.
10. Deploy the exact accepted artifact explicitly while other triggers stay
    fenced. Verify image identity, dependency fields, functional checks and 30
    minutes stable operation. Upgrade failures are resolved here, before migration.
    A newly built HUD/overlay does not automatically authorize publication: follow
    the separate release version/notes, native, smoke and VirusTotal rules.

## 5. Freeze, drain and external recovery contract

**Blocking implementation gap:** a working procedure is not present in the
current reviewed source. Define, implement and test this contract before G6.
Do not invent a maintenance URL or assume it exists.

- Freeze every new mutation producer: REST/admin/upload/MCP, new and existing
  `/ws` and `/relay` sessions, native transports, Discord message/interaction
  handlers and all scheduled/worker producers. Return an explicit retriable
  refusal without success acknowledgement. Record the final accepted IDs/cursors
  and per-Discord-channel high-water IDs before disconnecting the bot.
  The destination must start with the same freeze enforced before module-loading
  producers run; permit only explicitly scoped acceptance probes and controlled
  recovery work until private acceptance. Test inheritance across restart. A
  source-only in-memory flag does not protect the destination.
- Leave drain consumers and their DB/Redis/Discord dependencies available until
  accepted work finishes. Track active HTTP/upload transactions, ingest promises,
  moderation and external sends. Stopping the connector alone leaves Discord,
  existing sockets and jobs as possible writers.
- Stop new scheduler ticks/timers and await in-flight work. Inventory giveaways,
  scheduled events, party reaping, wiki/camp sync, supporter/role reconciliation,
  voice operations, object processing and every other registered job. Preserve
  due work and test its recovery once; do not reschedule side effects blindly.
- Observe Bull waiting/active/delayed/paused/failed/stalled state and account for
  every accepted message through its canonical ID/creation time. The default path
  requires no pending accepted work and no unresolved failed job. Historical
  failures need an explicit disposition. If transferring pending jobs instead,
  prove payload/ID preservation, lock recovery and idempotent replay in both
  directions; this is a different, explicitly accepted mode.
- Drain Discord queue entries **and in-flight promises**, then verify expected
  Discord copies and durable links. A send may succeed while its link save fails.
  Reconcile that ambiguity before retrying, using bounded channel history and
  canonical IDs; otherwise a retry can create a duplicate. Send/link failure,
  permission errors or timeout fail the drain rather than disappear into a log.
- Close sockets, stop the Discord client and process only after the drain record
  passes. Test actual container PID/signal forwarding and a bounded shutdown
  timeout. Docker can force-kill after its grace period; an exit 137/forced kill
  is a discrepancy requiring accepted-ID and integrity recovery, not success.
  [Docker stop behavior](https://docs.docker.com/reference/cli/docker/container/stop/)
- Verify no processes, connector, standby or deployment supervisor can write or
  restart the old backend. Check DB activity for non-backup clients/transactions;
  stop stores only after application consumers finish. Record clean Postgres
  shutdown using logs and the matching `pg_controldata`, not merely PID-file
  absence. Require completed Redis persistence/no errors and clean MinIO stop.

During bot downtime Discord remains independently writable. Rehearse an explicit
recovery interval from recorded channel/event checkpoints through reconnect:
paginated message backfill with canonical Discord-ID deduplication; reaction-role
adds **and removals** with panel/role ownership respected; supporter boosts/lapses;
scheduled-event subscribers and due giveaways; applicable ticket/voice actions.
Define race-free reconciliation with new live events. Deleted/edited messages or
transient events may be unrecoverable from current Discord state alone. Where
needed, use a proven event/audit source or prevent the affected activity during
maintenance with an approved, reversible control. If neither is possible, zero
loss is unproven and remains a blocker; do not silently weaken the success signal.
No public Discord notice or user-role mutation is authorized by this planning work.

## 6. Prepare Mothership and rehearse both directions

Use SSH Manager for host discovery, staging, inventory, commands, transfers and
log capture. Cloudflare edge operations must use the capability-tested MCP.
Application MCP observations do not replace infrastructure backups. Never read
or copy production data into hosted Dev; use synthetic fixtures and synthetic
objects to reproduce representative size/count/chunk/queue distributions.

Prepare a durable Dokploy definition with the recorded project identity,
digest-pinned exact images, backend alias, explicit **fresh** production volumes
and private service network. Keep retained Mothership production volumes untouched
as historical state; they are not the return source. Preserve any locally customized
Compose routing/resources through versioned nonsecret overrides that Dokploy
actually loads. Save runtime variables in Dokploy's persistent environment store
as well as generated runtime files. Prove a sandbox deploy/redeploy does not attach
old/empty volumes, rebuild a different image or start an extra connector.

Transfer current configuration securely from Hostinger, not the stale Mothership
store. Compare required keys, intentional empty values, secret equality locally
without returning values/digests to chat, public origins and secret references.
Preserve session signing, relay/device auth, OAuth clients, guild/channel IDs and
internal Dev-role verification credentials. Verify GitHub and other outbound
integrations separately. Keep tunnel credentials out of backend env. Do not rotate
identity/session secrets during the move. Config validation must use quiet Compose
output; archives/config/key files are access-restricted and excluded from Git/logs.

Inventory the named tunnel, DNS record, ingress configuration/version, origin TLS
settings, Access policies and **all** production hostnames/routes, including any
media/download/OAuth/MCP/HUD routes. Record exact rollback values. The previously
recorded origin hostname is `chat-mod-fallout-chat-mod-dprwq2-backend-1`; refresh it.
The target connector must resolve/reach that alias on its own Docker network.
Reusing a named tunnel can preserve the DNS record, but requires verified origin
configuration and single connector ownership.
[Cloudflare tunnel DNS](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)
Count connector **instances**, not the multiple edge connections one cloudflared
process can establish. Both Docker process inventory and Cloudflare evidence must
agree. SSH alone cannot prove the absence of a connector on an unexamined host.

Map actual deployed client transport requirements from current releases and
[the native relay guide](../overlay/zfe/native-chat-relay/README.md). Test real
authenticated native ZFE/xScal traffic independently of browser upgrades. Do not
introduce the retired raw TCP transport; if inventory finds an active dependency
on it, stop and resolve scope/route support explicitly rather than silently drop it.
No data-store host ports may become public. Verify firewall, public origin bypass,
network/volume separation from Dev, SSH recovery access, time synchronization,
memory limits, disk/inodes and backup automation without broad host/network scans.

Rehearse forward and reverse restores with destination-created messages,
moderation/account/session changes, objects and external side effects. Include a
mid-backup disconnect, partial/checksum-bad transfer, restore timeout, failed
startup patch, wrong volume/alias, attempted second writer, stale deploy job,
Discord send/link ambiguity, delayed/failed queue work and failure after target
startup. Inject failures only in the isolated fixture environment. Every scenario
must recover without deleting accepted state or duplicating Discord effects.

Record elapsed drain, encryption/compression, transfer, hash verification,
extraction, startup and acceptance separately. Pre-stage images and verified
immutable downloads before the window. For mutable MinIO/Postgres/Redis data,
an online copy is only a seed; the backup must include a verified cold final copy
or a separately tested snapshot/base-backup/delta procedure accounting for
deletions, versions, WAL and interrupted retries. The default is a full cold copy.
Do not choose a faster path during the production outage.

Compute the latest safe rollback decision time before freezing: 30-minute budget
minus measured worst-case reverse restoration/restart/verification and reserve.
After target startup, that calculation includes a fresh reverse backup/transfer.
If forward plus required recovery reserve cannot fit, improve/rehearse the method
or obtain a different outage budget before scheduling. The timer starts when
accepted writes first stop and ends only after public functional acceptance.

## 7. Backup catalog and Redis policy

Use an operation ID, environment, exact source/target identities, UTC freeze
time, image digests/architecture, configuration version, store paths and a manifest
of encrypted archive sizes/SHA-256. Use relative unique paths; reject duplicate
names, missing files, unsafe extraction paths and unexpectedly empty manifests.
Verify every file after each transfer, decryptability, pipeline exit codes and
semantic restoration. Interrupted output uses a temporary name and becomes a
completed artifact only after verification. Encryption-key recovery must work
without Hostinger, Mothership or the laptop. Retain source and reverse archives
through acceptance and retirement.
Use a tested authenticated-encryption format and protect the manifest's integrity;
do not trust an archive and a replaceable neighboring checksum as proof of origin.

| State | Capture and acceptance |
| --- | --- |
| Timescale/Postgres | Full cleanly stopped cluster with WAL, configuration, roles and any external tablespaces/symlinks/mounts; matching PostgreSQL/Timescale image and ownership. Verify restore, extension/chunk inventories, counts and canonical sentinels. Generic SSH Manager logical restore is not the primary method. |
| Redis | Full stopped persistence directory, including Redis 7 multipart AOF manifest/base/increment files and any RDB. Restore matching config/version; verify session, queue and ephemeral-history behavior. |
| MinIO | All buckets/objects, versions/delete markers where enabled, internal metadata and bucket/access configuration; user avatars, wiki/camp, moderation evidence and integration assets. Check object size/content hashes with a version-aware inventory; ETag alone is not a universal content hash. |
| Downloads | Entire existing advertised download set, exact filenames, sizes/hashes and release metadata; installer scripts and any backend writable-layer files still used by the accepted revision. Do not rely on baked image seeds. |
| Configuration | Compose/Dokploy overrides, environment files/secret references, tunnel snapshot, release/CI flags, backup schedules and deployment provenance. Store secrets separately from the reviewable manifest. |

Cold filesystem backups require a stopped database and the complete cluster;
a logical dump may be a supplemental artifact. Follow
[the local physical-backup procedure](secret-rotation-runbook.md), correcting its
historical warning-only shutdown check to a hard stop for this operation.
[PostgreSQL filesystem backups](https://www.postgresql.org/docs/15/backup-file.html)
Never delete `postmaster.pid` to make a dirty copy appear clean. Validate target
`shared_buffers`, ownership, disk and permissions before startup; retain the
original config and use a recorded compatible resource override when necessary.

The selected readiness target is **session-preserving full Redis restore after
drain**, subject to successful rehearsal. Do not flush Redis or delete Bull keys.
Preserve expiry timestamps: elapsed downtime expires sessions, one-time OAuth
state/tickets/nonces and Server history naturally. New WebSocket connections and
fresh native room observations are required; restoring a key is not proof of live
authority. Do not extend TTLs or let heartbeats refresh stale roster evidence.
Compare logical surviving keys/TTLs at recorded timestamps, not raw counts that
naturally shrink with expiry. Queue recovery must not republish completed effects.
Redis's `appendfsync everysec` is not a zero-loss crash guarantee; a forced stop
requires recovery proof for accepted work.
[Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)

## 8. Authority checkpoints and production execution

Persist atomic, sanitized checkpoints on both hosts and independent operator
storage. Each contains operation ID, revision/manifest hashes, authority, dirty
state, completed phase, pending process/container IDs and last verified result.
Use a shared lock between deploy/cutover operations; do not steal an expired lock
until process/job state is reconciled. If the agent/SSH connection dies, reconnect
and inspect the existing named job/container and manifest before retrying. Never
launch a second restore into the same volume. Commands must have verified
postconditions and bounded timeouts; an SSH timeout is not evidence of failure.

| Checkpoint | Authority and permitted recovery |
| --- | --- |
| C0 — Hostinger accepted | Hostinger sole writer/connector. Target staged; all readiness gates G1–G10 passed. |
| C1 — producers frozen | Hostinger drains only already accepted work. Target backend/bot/worker/connector remain stopped. Failed drain cancels the transition and resumes source only after confirming target is stopped. |
| C2 — source cold | Both production writer/connector sets stopped; source stores cleanly stopped; final immutable recovery manifest complete. No authority promotion yet. |
| C3 — target storage verified | Source stays fenced; fresh Mothership storage restored/validated; target backend and connector still stopped. Source can resume without reverse transfer only if no target writer/patch has run. |
| C4 — target dirty | **Persist this checkpoint before starting any destination application or patch process.** Mothership owns all subsequent state, even without public ingress; Hostinger remains stopped. Rollback must account for final target state and external effects. |
| C5 — target public/accepted | One Mothership writer set and connector; public functional checks pass. Start the 48-hour hold; restore only the selected Mothership deployment trigger after acceptance. |
| C6 — retirement accepted | 48-hour gate and independent recovery/rollback checks passed; Hostinger FCM stays stopped and can be powered off. Do not cancel/delete its disks or recovery archives. |

Execute C0→C5 using the exact rehearsed commands and manifest. After C1 passes,
stop the source writer/connector set, then stores; verify clean stop, capture the
final backup and verify its immutable manifest before recording C2.
Transfer and restore into fresh target volumes, verify C3, record C4 and start
the sole target backend/bot/worker set. Require private functional acceptance
before starting the target connector and reopening producers. No production
backend may run privately alongside a source backend merely to test health.

Before and after edge startup require snapshot/verification through Cloudflare
MCP, unchanged intended DNS/ingress, one connector instance and successful origin
resolution. If an edge edit is necessary, use only the rehearsed exact-restore
procedure. Never fall back during this operation to direct-IP DNS or an untested
Traefik route. Reusing existing tunnel ingress still requires capability-tested
edge control and verification before the source is frozen.

Acceptance requires more than a 101 handshake:

- The running image matches the accepted artifact; clean startup logs, no OOM,
  unresolved schema/job failure or restart loop. Parse DB/Redis/Discord health
  fields and perform a real MinIO read/write round trip.
- Existing browser/overlay sessions remain valid until their original expiry;
  fresh Discord/Steam and applicable other login/link flows use correct callbacks,
  cookies/CORS and single-use state. Dev's production-role verification still works.
- Authenticate `/ws` and `/relay`; send bounded synthetic markers, receive echoes,
  read full authorized history and verify exactly one canonical row and expected
  Discord copy/link. Verify reconnect/resync and native ZFE/xScal HUD plus desktop
  export bridge traffic, room isolation and expired/stale authority rejection.
- Compare final source inventories/sentinels against restored storage before
  target writes; after C4 account explicitly for startup patches, expected expiry,
  reconciliation and test-created state. Exercise moderation/account changes and
  upload/download, then verify their persisted state.
- Verify every advertised release/download URL, existing client compatibility,
  public HTTP success and exact size/hash. Do not republish artifacts to repair
  missing files; restore the verified files to the correct volume.
- Complete bounded Discord outage reconciliation and due work, verify queue
  health and integration permissions, and confirm hosted Dev/other Mothership
  applications remain healthy. Freeze again on integrity or authority failure.

Require an external monitor independent of both hosts. Poll HTTP/dependency/
connector/restart/queue/resource status every 30 seconds during transition and
the first 30 minutes, then at least every five minutes during the 48-hour hold.
Integrity mismatch, unknown/duplicate authority, OOM or the rollback deadline
triggers immediate freeze and operator notification. Two consecutive failed
service/dependency checks or two unexpected backend restarts within five minutes
trigger the same response. Accepted queue work that exceeds the rehearsed drain
deadline or free disk below the recorded recovery reserve also fails acceptance.
Verify functional auth/history/upload and backup status throughout the hold; any
material incident requires correction and restarts the 48-hour stability clock.
Define actual alert delivery/ownership during preflight; do not assume the chat
session will remain open.

## 9. Recovery and retirement

Before C4, stop/verify all target processes and connector, confirm no target
writer/patch ran, and resume the unchanged Hostinger recovery point with its
original artifact/config/route. Reopen writes only after public acceptance.

At or after C4, never simply start Hostinger's stale database:

1. Freeze and drain Mothership using the same verified contract; stop its
   connector/writers and capture complete final state plus external-effect
   checkpoints. If the target is unreachable, fail closed until final state or
   an explicitly accepted data-loss recovery decision is available.
2. Restore that state onto fresh Hostinger volumes with the **same accepted
   application version** and current configuration. Keep original archives/volumes
   intact. Verify storage/private checks, fence Mothership and move the sole
   connector back through the snapshotted control plane.
3. Reconcile external effects once and perform public acceptance before reopening
   producers. Reverting to an older application/schema is a separate rehearsed
   downgrade, never an incidental image swap.

If target startup made only known schema/data repairs and no external/application
state, discarding it is allowed only with evidence of that bounded condition and
the approved recovery procedure. Unknown/partially restored/ambiguous states
require reconciliation; elapsed time is not permission to overwrite them.

After C5, enable only the Mothership deployment mechanism proven in G5. Confirm
its backup jobs, monitoring and bounded backend restart preserve state/aliases
and never deploy an untested revision. Keep Hostinger and laptop deployment flags
and local markers disabled; fence old stack restart policies/supervisors. Retain
the Hostinger disk and recovery data for at least the 48-hour hold.

Before C6, audit public routes, direct IPs, CI runners, SSH/deploy keys, backup
destinations, webhooks/OAuth URLs, scheduled tasks and other hosted applications
for Hostinger dependencies. Remove only the identified FCM runner/registration
and its host-specific credential authority; do not revoke shared application or
named-tunnel credentials still required on Mothership. Confirm independent backup
restoration and operational SSH access, obtain retirement acceptance, then power
off the exact Hostinger VPS. Provider cancellation, disk deletion and destruction
of recovery archives remain outside this plan.

## Review outcome

The plan now gives every identified failure path a gate, bounded recovery or
explicit stop condition. It does **not** establish zero-loss readiness yet:
G2/G3/G6/G8 and the unperformed restore/timing tests are known blockers. Record
the eventual command bundles, rehearsal results and discrepancy fixes here; do
not erase historical failures or mark a gate passed from intention alone.
