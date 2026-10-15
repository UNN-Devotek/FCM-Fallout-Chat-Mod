# Return production from Hostinger to Mothership

**Version:** 1.0 — 2026-10-15 UTC

**Status:** Preparation and integration authorized; Task 1 runtime qualification passes at
`ab0bedcd`, and bounded Task 2A compatibility/attribution qualification passes at
`199e2464`. Remaining outage recovery, security review, final integrated
acceptance/promotion and timed rehearsal remain open. Hostinger remains authoritative.

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

The initial read-only checks on 2026-10-13 at approximately 13:20–13:24 UTC
established the following historical baseline. Later changes and verified
results are recorded in the execution ledger; baseline flags are not current state.

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
| Current HUD acceptance | 2.10.149 failed native stability; 2.10.150 has local automated gates and remains native-unverified. | The earlier 2.10.149 promotion assumption is superseded. The operator waived the manual native matrix on 2026-10-13; no native pass or new client publication is established. |
| Edge control at initial inventory | No callable Cloudflare MCP was present. | Capability testing was required; the execution ledger now records its successful reconnection and isolated control-plane test. |

The earlier inventory estimated about **15.7 GB** of live state. Remeasure after
promotion. Capacity must cover images, source recovery backup, fresh restored
volumes, a reverse-transfer backup, temporary extraction and growth on each host.
Do not delete the only recovery copy to make room.

**Explicit operator waiver — 2026-10-13:** the operator answered **“bypass”** to
the two-client native acceptance requirement. For this return operation, proceed
without the manual six-pairing game-client matrix. Record it as **waived/unverified**,
never passed. Preserve the historical 2.10.149 native failure and the exact
2.10.150 candidate hashes. All automated HUD/source/package/Ruffle checks remain
required, as do review/CI, storage integrity, single authority, drain/recovery,
rollback and timing. This waiver does not authorize a new client/HUD release.

## 2. Gaps found in the implementation

These findings began with the initial source review. Later resolutions and remaining
acceptance gaps are recorded in §5 and the execution ledger.

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
| A default Python health request receives Cloudflare error 1010; the same GET with `User-Agent: Mozilla/5.0` returns 200 and connected dependencies. | Record the tested user agent in scripted public health checks and distinguish edge denial from origin failure. Keep the edge settings unchanged; use private origin checks for rehearsal resource guards. |
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
| G3 — code acceptance | Required CI succeeds for the actual integration/promotion revision; Dev and automated compatibility acceptance pass. Manual two-client native acceptance is explicitly waived by the operator and remains unverified; diagnostic/DEV packages are not published as PROD. |
| G4 — Hostinger promotion | Verified pre-upgrade recovery backup, rehearsed schema rollback, exact accepted running image, full functional checks and 30 minutes stable operation. |
| G5 — target definition/config | Pinned image archives/digests; fresh explicit volumes; correct Dokploy source and overrides; secure runtime/edge settings; isolated networks and no direct data-store exposure; redeploy preserves the mappings. |
| G6 — freeze/drain/recovery | Tested §5 contract, queue accounting, clean shutdown and Discord outage reconciliation; all accepted sentinels survive both directions without duplicate side effects. |
| G7 — backup/restore | Encrypted complete state restored on fresh volumes, source/target checksums and semantic inventories match, encryption key recoverable independently of either host. |
| G8 — edge/transport | Cloudflare MCP capability-tested for read/snapshot/exact restore; source/target connector inventory; origin DNS reachable from connector network; authenticated `/ws` and `/relay`, automated provider transport probes and all discovered production hostnames pass. The manual game-client gate remains waived/unverified under G3. |
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
   **Operation exception:** the explicit operator waiver above skips this manual
   matrix for the return. Retain its failure/pending evidence and the automated
   gates; do not report native success or publish a new mod as a consequence.
7. Fence Hostinger's deployment flag and local marker **before merging Prod**;
   stop/drain any running deployment safely, cancel queued jobs and recheck just
   before the merge. Job-level flags may already have been evaluated. Marker
   removal alone cannot stop a deployment that already passed that check.
8. Respect the verified **linear-history requirement on both Dev and Prod**.
   Merge the reviewed integration through an allowed linear method. Create the
   promotion branch from refreshed Prod, apply the accepted Dev tree as reviewed
   linear commit(s), and prove its final tree equals the accepted Dev tree with
   every Prod-only fix retained. Keep original refs/recovery bundles; do not reset
   or force-push Prod. Use a Prod PR with code-owner approval and required checks
   on its resulting revision. A merge commit would violate current protection;
   do not bypass that rule or change branch protection for this operation.
9. Rehearse the new image's startup schema/data patches on isolated Dev fixtures.
   Capture a verified production recovery set under an approved write freeze
   before applying an incompatible upgrade. A live pre-upgrade copy is not a
   guaranteed cross-store rollback point. Validate on Hostinger first; either
   prove the old image can serve the changed schema or keep writes frozen until
   upgrade acceptance and full restoration are possible without discarding state.
10. Deploy the exact accepted artifact explicitly while other triggers stay
    fenced. Verify image identity, dependency fields, functional checks and 30
    minutes stable operation. Upgrade failures are resolved here, before migration.
    Hostinger's current backend mounts only downloads. Before installing the
    coordinator image, add and rehearse durable control-directory and release-file
    binds with its actual UID/GID and sufficient stop grace; preserve every store,
    connector, network alias and download volume. Verify the resulting container
    executes `runtime-start.sh`, and compare every effective raw runtime setting
    without printing credentials. A fence inside a replaceable image is insufficient.
    A newly built HUD/overlay does not automatically authorize publication: follow
    the separate release version/notes, native, smoke and VirusTotal rules.

## 5. Freeze, drain and external recovery contract

**Runtime qualification complete; recovery acceptance still blocked:** frozen v24
at `ab0bedcd` passes fresh independent specification and quality reviews across
all fourteen runtime requirements, all fourteen hosted CI jobs, and eight exact-image
application checks. The shared-helper correction retains required failures on both
initiating and remote relay-control delivery paths; v23's failed quality record remains
preserved. This accepts the Task 1 runtime checkpoint, not G6 or production readiness.
Task 2A separately qualifies source compatibility, audit attribution and a private
read-only retained-job classifier at `199e2464`; it grants no replay or repair.
Task 2 still needs verified legacy acceptance, expected external effects,
outage history/current-state and due-work recovery, and the complete forward/reverse
application rehearsal. Operator control remains private; use the
[documented local commands](../backend/runtime-maintenance.md), not a public
maintenance URL.

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
  The ordinary-relay journal at
  `<FCM_RUNTIME_CONTROL_DIR>/discord-relays.jsonl` must preserve the original
  message UUID/time, sole destination/config binding and payload digest, with
  intent before attempt, returned remote ID before linkage, and completion.
  Protected original input and the deterministic link prefix live in
  `<FCM_RUNTIME_CONTROL_DIR>/discord-relay-payloads/<operationId>.json` before
  mapping lookup or send. This also covers live-only REST messages without
  creating public history rows. Journal/operator output contains references
  and digests, not those private contents.
  If the first protected-input write fails, perform zero Discord creates and
  retain a failed drain. The existing live-only REST response policy can still
  return HTTP 201 after broadcast; a crash at this boundary may leave the original
  body unavailable. This remains an unresolved recovery failure, not accepted
  message loss. An absent payload cannot establish successful recovery or permit
  a clean cold-copy checkpoint. Changing the REST acceptance policy is outside
  this bounded Task 2B1 change.
  Required disconnected/skipped sends and unresolved journal entries fail drain.
  A known returned ID permits only separately verified local link repair;
  an unknown create is never automatically resent after restart. Any candidate
  search must prove stable identity and complete bounded coverage, not text/time
  similarity or a short nonce window. The private repair runner remains Task 2B2
  work; no manual journal clearing or new recovery command is authorized here.
  Send/link failure, permission errors or timeout fail the drain rather than
  disappear into a log.
- Close sockets, stop the Discord client and process only after the drain record
  passes. Test actual container PID/signal forwarding and a bounded shutdown
  timeout. Docker can force-kill after its grace period; an exit 137/forced kill
  is a discrepancy requiring accepted-ID and integrity recovery, not success.
  [Docker stop behavior](https://docs.docker.com/reference/cli/docker/container/stop/)
  A cold-copy boundary requires a persisted `closed` checkpoint with
  `ingressClosed: true`, empty active work and failures, matching inspection
  epochs, and cleared restart evidence, plus the actual stopped container state.
  A nonclosing `drained` response or a `closed` coordinator that never closed
  ingress cannot satisfy this boundary. Operator commands must exit nonzero if
  marker/checkpoint persistence or the requested shutdown remains unconfirmed.
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
Define race-free reconciliation with new live events. **The user approved retained
history and current state on 2026-10-14:** preserve every FCM-accepted operation,
retained accessible Discord messages and the latest observable roles, boosts,
events and related current state. Unobservable external transient events are
excluded, including independently created-and-deleted content and intermediate
changes that cannot be retrieved after downtime. This resolves the external-scope
choice; it does not excuse an unknown FCM-accepted effect, retained failed job or
legacy acceptance gap. Prove completeness within these approved bounds and
present any remaining concrete exception separately.
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
The staged [Mothership definition](../../deploy/return-mothership/README.md)
uses verified immutable local image IDs, dedicated networks, the exact tunnel
alias and four explicitly named external volumes. Its render/unit checks pass;
it is not yet installed or accepted. The complete frozen deploy/resume procedure
must pass an isolated redeploy rehearsal before G5 or trigger enablement.

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
Include the complete persistent runtime-control directory in both cold-state
catalogs: accepted-message receipts, failure journals, operator maintenance
marker, restart evidence, checkpoints and any accepted recovery journal or cursor.
This includes the complete `discord-relays.jsonl` ordinary-relay journal when
installing the Task 2B1 candidate. Preserve pending/attempted/known-result and
completed records with their original bindings; do not transfer only completed
entries or recreate the file empty. Its directory is 0700 and file is 0600.
Include the `discord-relay-payloads/` subdirectory (0700) and every unresolved
immutable payload file (0600) with exact bytes and reference digests. Only
accounted cleanup after verified completion may remove unneeded protected
input. Missing, orphaned or corrupt references, or failed cleanup, block
startup/drain; a digest cannot reconstruct the original input. Keep these
contents inside the encrypted application-state archive and out of agent output.
Final-state reverse restoration after C4 must carry the destination's final
journal together with its database/Redis/object/download/control state.
Restore its ownership and restrictive permissions with the data. Record explicit
operator disposition of stale restart evidence; never erase it to make startup
pass. A storage-only rehearsal does not prove preservation or recovery of this
application state.
The operator selected **this desktop (`Devotek-PC`)** for the protected recovery
key copy on 2026-10-13. Its `/home/devotek/.config/fcm-recovery/keys/` directory is
0700 and private key files are 0600. Desktop-only authenticated decryption and
manifest-signature verification pass for the provisional configuration archive;
repeat them for the final production and reverse-state archives. This key check
does not establish a complete production data backup.
Use a tested authenticated-encryption format and protect the manifest's integrity;
do not trust an archive and a replaceable neighboring checksum as proof of origin.

Binary archive helpers must use `--log-driver none`: Docker's default JSON log
driver can retain and expand attached binary stdout independently of the archive,
exhausting the backup reserve. Override unused image-declared anonymous volumes
with a bounded tmpfs, and record every helper container/process ID and its exact
owned mounts. A failed attached CLI or pipeline must explicitly stop and remove
only the verified operation-owned helper; do not assume loss of the CLI stopped
the container. Preserve the failed checkpoint and delete no source data volume.
Rehearse this disconnect/cleanup behavior before using the final backup commands.

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
  The operator's explicit waiver skips manual game-client probes; keep automated
  provider/transport fixtures and report the native result as unverified.
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

The plan gives the identified failure paths a gate, bounded recovery or explicit
stop condition. It does **not** establish zero-loss readiness yet: final code
acceptance, application drain/external recovery, target redeploy, complete
transport checks and representative timing remain open. Record
the eventual command bundles, rehearsal results and discrepancy fixes here; do
not erase historical failures or mark a gate passed from intention alone.

## Execution ledger — 2026-10-13

The operator authorized starting the cutover after plan review. Continue the
approved preparation and transfer sequence without asking for that authorization
again; readiness checks still control when source writers may stop. Hostinger
remains authoritative while these checks are open.

- Preserved and checksum-verified 44 changed/new files and a complete Git bundle
  in `/home/devotek/Documents/FCM-Recovery/return-mothership-20261013T133244Z/`.
  Refreshed `origin/dev` is `ddfa1fae`; `origin/prod` is `a6e8df12`. The integration
  runs in a separate worktree; the original checkout remains preserved.
- Disabled `HOSTINGER_PROD_AUTODEPLOY` and deactivated its local marker, retaining
  the marker in `checkpoints/HOSTINGER_AUTODEPLOY_ACTIVE.before-return-20261013`.
  No running/queued Hostinger deployment was found; source health remains good.
  Mothership Prod was subsequently fenced through the existing signed-in Chrome
  ChatGPT extension tab's Dokploy **Toggle autodeploy** control. Persisted
  `compose.one` readback confirms `autoDeploy=false`, `triggerType=tag`, status
  `idle`, with no pending deployment. `fcm-dev-stack` remains unchanged. Screenshot
  evidence and a sanitized checkpoint are retained in the operation's recovery
  record. Recheck all gates immediately before any production action.
- Current Hostinger files and container lacked `MINIO_BUCKET`; the real object
  store contains the `avatars` bucket. The newly integrated backend requires an
  explicit bucket. Added `MINIO_BUCKET=avatars` to source `.env` and
  `config/runtime.env`, with restricted originals preserved under
  `checkpoints/before-minio-bucket-20261013/`. Quiet Compose validation passed;
  no backend restart or image replacement occurred. The destination's persistent
  Dokploy environment must receive this setting too.
- Integrated source passes 31 pure Haxe suites, source/format/anchor checks and
  widget compiler diagnostics. Backend type-check/build, double-applied MCP
  migrations and MCP Inspector pass on synthetic isolated stores. Backend Jest:
  130 suites, 1,695 passing tests, nine existing skips. TS units: 445 passing,
  zero skips. Dashboard: 49 files/490 tests. Overlay: 59 files/1,307 tests.
  Dashboard/overlay type-checks pass; all three owned test containers were removed.
- Complete Ruffle passed all 93 scenarios in 7.7 minutes; the listener was removed.
  Rebuilt SWF/BA2 decoded-payload and source-manifest checks, widget packaging,
  seven bridge packaging cases and both compiler diagnostics passed. SWF SHA-256:
  `8a32f101a7b3237a01097d12a376c663cc219be86681973adeff2feea6de7de2`;
  BA2 SHA-256: `5c768944d2c9986c2a30d325bf7a5e193eb9561406c76149cce88ded4a0c3efe`.
  The integration combines the local nameplate work with newer remote Dev flood
  retry behavior. Historical 2.10.150 native observations cannot accept a different
  integration artifact merely because its displayed version is the same.
- Staged the exact source Postgres, Redis, MinIO and cloudflared image layers under
  `/home/devotek/fcm-return-mothership-20261013/` on Mothership. The 611,980,867-byte
  archive matched source/local/target SHA-256
  `68390c3d534a865ac8b078a5d8830bc15a4404dc5c6c434792de560bf35be965`.
  Source manifest IDs differed from the target Engine's imported config IDs;
  archive config hashes, architecture, creation time and every rootfs layer match.
  `runtime-images.json` records the verified mapping. No production containers
  were started.
- The Git merge-tree result for refreshed Dev/Prod equals the Dev tree exactly:
  the Prod-only input/install fixes and release notes are already present in
  current Dev content. Preserve the Prod ancestry in the integration merge; do
  not replay an older fix over the newer source.
- Cloudflare MCP OAuth now succeeds. Read/snapshot tests cover the zone's eight
  DNS records, production/Dev tunnel configuration versions and connector
  inventory. Isolated temporary TXT/tunnel fixtures passed create, mutate, exact
  restore, repeated restore and guarded cleanup. The complete live DNS/tunnel
  baseline was unchanged afterward; all fixture resources were removed. The
  production tunnel remains `6d9d808c-ec3c-4029-8cc5-c544dcd583ac`, configuration
  version 3, origin `http://chat-mod-fallout-chat-mod-dprwq2-backend-1:7676`, with
  one Hostinger connector instance. Restricted `cloudflare-control-plane/`
  snapshots, executable fixture and result record provide the evidence. This
  passes the G8 control-plane prerequisite, not full transport acceptance.
- A small isolated synthetic storage rehearsal passed cold forward and reverse
  restore, destination-created state, Redis expiry, versioned MinIO/delete
  markers and download hashes. It also rejected corrupt archives and unsafe
  extraction paths. Fixtures were removed. Its small timing result is not G9;
  a separate representative 15.7 GB random-data round trip subsequently passed
  storage integrity, with failed attempts retained. Its timing fails G9 below.
- Added the prepared pinned Mothership definition and required-backend-CI policy
  tests. Thirty-one tests pass, and real Docker Compose JSON rendering passes
  the validator without resolving secret files or starting containers. Protected
  configuration staging is recorded below; final configuration refresh, live
  image/mount checks, redeploy and runtime acceptance remain pending before G5.
- GitHub readback confirms Dev and Prod both require linear history, one approval,
  code-owner review and `CI Summary`. Corrected the earlier merge-commit promotion
  instruction to a reviewed linear promotion from Prod with the accepted Dev tree.
- The revised backend durable freeze/drain controller passes 94 runtime tests,
  the full backend build, 1,820 implemented Jest tests and 445 TS tests including
  the separately enabled real Redis suites. Nine old wiki live placeholders
  remain skipped. The exact Node 22 container image passes frozen non-writing
  health/downloads and HTTP/WebSocket refusals, one canonical admitted-message
  drain with one database row/frame/acknowledgment, ordinary SIGTERM closure and
  restart, persistent crash fencing, and operator-maintenance restart fencing.
  Closed checkpoints and actual stopped states agree. Real pg/Redis/Bull/S3
  lifetime regressions are covered without exempting pending application work.
  Fresh spec/quality review, final revision CI and Task 2 outage recovery remain
  open; this limited runtime proof does not pass all of G6.
  The old `a6e8df12` image has no such controller: its first promotion requires a
  separate proven bootstrap freeze/queue/external-effect recovery procedure.
  Installing a new signal handler does not retroactively drain that old image.
- Subsequent Task 1 corrections passed 1,877 Jest tests and 444 TypeScript tests;
  the separately enabled 17 real-Redis checks remain valid for their unchanged
  surfaces. The exact Node 22 v5 image passed eight real application/container
  cases, including a 3 MiB upload/readback and a complete SQL restore whose client
  disconnects while the write is blocked. These are scoped success-path proofs.
  Round 4 spec review failed 25 actual-source required-effect probes across
  audits/AutoMod evidence, authorization/session revocations, per-item producers,
  cursor startup and account/history cleanup. This evidence describes the earlier
  revision; subsequent corrections and their remaining findings are recorded below.
  Do not interpret the passing container cases as G6 acceptance. Signed evidence
  is retained in the operation's `runtime-rehearsal/v5-round3-fixed/` directory.
- Round 4 corrections passed 1,943 Jest tests and 444 TypeScript tests. The exact
  Node 22 v7 image passed eight application/container cases; the separate callback
  barrier experiment failed because the fixture blocked rate limiting before
  reaching the intended callback and is retained as unaccepted evidence.
  Fresh Round 5 review confirms the previous repairs but fails three remaining
  requirements: unknown primary DB/Redis/object outcomes can drain clean, the
  ban-evidence S3 client retains two SDK promises after a successful 3 MiB PUT,
  and several producer failure dispositions occur after their lease is released.
  The ordering probe did not reproduce a falsely closed checkpoint. The complete
  writer inventory includes manual tracing of dynamic delegates and pipelines;
  required mutations, covered transaction/domain boundaries and optional work
  must have an explicit classification before this batch can pass fresh review.
  Spec review, quality review, final revision CI and Task 2 remain open. The signed
  `runtime-rehearsal/v7-round4-fixed/` record is a scoped rehearsal, not G6 acceptance.
- Round 5's internal transaction-scope checkpoint passes 60 focused tests and
  nine actual PostgreSQL cases. Explicit ownership distinguishes a rolled-back
  transaction from an independent write that committed inside its callback.
  A lost COMMIT response remains unresolved even when an independent observer
  confirms the row exists. Zero-result operations require a per-writer no-op
  predicate; a zero-returning DDL statement still counts as a committed effect.
  These helper and inventory-policy checks do not accept the remaining writer
  changes. Authority/session, moderation, canonical publication and producer
  classifications still require the complete batch's fresh spec and quality review.
  The internal authority/identity/session/OAuth checkpoint adds 185 required
  writer classifications and eight verified merge-caller proofs, with 193 current
  AST validations, 165 authentication tests and 50 scope/policy/source checks.
  Six actual-source unknown/refusal/alias probes fail against the prior immutable
  v7 artifact and pass against these corrections. Moderation, publication and
  producer work remains open; these counts do not constitute final batch acceptance.
  The subsequent internal moderation/object checkpoint validates 410 classified
  AST rows and passes 16 actual SDK cases, 209 domain tests, 79 focused primary
  checks and 29 reconciled refusal/object tests. The old artifact stores a PUT,
  loses its reply, then receives a denial on retry and falsely drains clean.
  The correction retains that outcome; only a confirmed first-attempt refusal or
  an explicitly verified desired namespace state resolves it. Required audit
  refusals remain failures, and download counters remain optional. Publication,
  producers and the whole batch's independent review still remain open.
  The internal publication checkpoint validates 473 classified AST rows out of
  631 inventoried writers: 383 required, 23 delegated and 67 optional; 130 pending
  and 28 existing boundaries still need review. Five prior-source failure probes
  and a held-history case establish the corrected ownership boundary. The focused
  giveaway and publication suites pass 47 and 19 checks respectively. A history
  update admitted before freeze retains ownership until its effect disposition is
  recorded, even without an outer request lease. Signed checkpoint evidence is
  retained under `runtime-rehearsal/round5-chunk-d/`; source is still changing, so
  this does not accept the whole writer inventory or final application image.
- The next internal source checkpoint has 706 classified writers and passes the
  comparison for those recognized rows. The exact Node 22 v8 image passes eight
  application/container cases, nine compiled-helper PostgreSQL cases and fourteen
  installed S3 SDK cases, including independently confirmed COMMIT response loss
  and a successful PUT followed by response loss and a later denial. The signed
  845-file record is `runtime-rehearsal/v8-round5-final-scoped/`.
  **Fresh Round 6 review still fails acceptance.** Actual installed Discord login
  and successful REST sends retain unused SDK queue promises in drain accounting.
  Required Redis deletion and automatic browser-session save/touch paths lack
  complete failure ownership; the inventory also misses SDK writers. A required
  audit refusal after zero affected rows can drain clean. The TypeScript runner
  returns exit zero for an actual failing test on Node 22 and Node 26. Preserve
  these failures, correct the complete batch and rerun independent spec/quality
  and final gates. Passing scoped cases and a zero-pending recognized inventory
  cannot substitute for that acceptance.
- The interrupted Round 6 correction checkpoint passes 93 focused primary,
  required-audit and actual test-runner checks. It adds explicit Redis session
  cleanup ownership, retains required audit refusals after zero-row actions, and
  makes the programmatic TypeScript runner fail on failed, canceled or incomplete
  tests. The installed Discord and automatic session-store lifecycle corrections
  and complete SDK/alias inventory are still being verified. These are unfinished
  source changes, not a new accepted artifact, whole-batch PASS or G6 evidence.
  Preserve the signed six-finding review under
  `runtime-rehearsal/full-spec-round6/`; fresh spec and quality reviews follow the
  complete correction batch and exact Node 22 regression evidence.
- The next frozen v9 image passes all eight application/container cases and 32
  compiled primary-effect probes. Its actual Node 22 runner rejects assertion
  failures, canceled tests and incomplete child exits, and accepts a successful
  test with an open test-only timer. The complete SDK fixture executes 25 cases;
  two login closure cases still fail while the REST/session cases match their
  expected outcomes. A minimal Node 22 reproduction identifies reentry into
  `AsyncLocalStorage.exit()` as restoring the previous login owner to later SDK
  promises. The explicit empty-store correction requires a new artifact and
  fresh SDK/spec/quality evidence; v9 is a scoped proof, not acceptance.
- The corrected v10 Node 22 image passes all 25 installed SDK scenarios, 32
  compiled controller outcome checks and four actual runner checks. Its second
  application rehearsal passes all eight cases. The first attempt is retained
  as failed: a pre-existing Redis presence key expired between snapshots. The
  corrected evidence reader uses atomic read-only binary dumps and Redis time;
  it rejects added/changed keys and disappearance before the original expiry.
  **Fresh Round 7 review fails four requirements:** successful embed reads leave
  canceled timeout promises pending; canceled static downloads retain middleware
  leases; failed multipart cleanup can leave an installer while reporting clean
  closure; and the CLI reports success for failed freeze persistence or shutdown
  that joins a nonclosing drain. These are actual v10 Node 22 reproductions.
  The signed 1,290-file failure record is `runtime-rehearsal/v10-round7-failed/`,
  catalog SHA256 `05114786215c4efa983b10e59c6c275e57979f226464eaa328ec9a697f0e2a96`.
  All five reviewer containers were independently confirmed removed by exact ID.
  Correct the complete batch and rerun whole spec/quality and required gates.
  Neither v10's scoped passes nor the expanded inventory accepts Task 1, G6,
  quality review, Task 2 or production promotion.
- The v11 Node 22 image passes 54 installed file/control scenarios, 25 installed
  SDK scenarios, 32 compiled mutation checks, four actual runner checks and all
  eight application/container cases. Every application shutdown additionally
  requires `ingressClosed: true` and the actual stopped state. The implementer's
  subsequent self-audit identifies a pending multipart metadata callback that
  can lose ownership after request abort before any output stream exists. This
  draft remains unaccepted; preserve its scoped proofs and correct that callback
  before the next frozen artifact and fresh whole spec/quality review. The signed
  687-file record is `runtime-rehearsal/v11-scoped-draft/`, catalog SHA256
  `95378a5f077637a3ca255da80a40e1f1a847858a5226a927256f2c956a7d34fe`.
- The v12 artifact fixes the three pending upload-metadata cases in the actual
  Node 22/Multer 2.4 image. It also passes 25 SDK, 32 mutation, four runner, nine
  PostgreSQL, 14 S3 and eight application cases. Its 59-case file/control gate
  remains **failed**: two fixture expectations assume the host's older Multer
  finish-listener contract. Installed 2.4 uses `stream.pipeline` and completes
  canceled uploads through its result callback. Correct the supported-SDK
  fixtures and verify actual pending result ownership before final acceptance.
  The complete 539-file frozen source and failed proofs are preserved in the
  signed 1,321-file `runtime-rehearsal/v12-supported-sdk-pending/` record, catalog
  SHA256 `876e898a0f8205d7965e613dd2b9e823c55425f3c718921e0b73b4c1ad0f5ae3`.
- The v13 Node 22/Multer 2.4 artifact passes all 60 installed file/control
  scenarios, 25 SDK, 32 mutation, four runner, nine PostgreSQL, 14 S3 and eight
  application cases. **Fresh whole Round 8 review fails three requirements:** a
  real redirect response outlives a clean checkpoint; malformed GitHub deletion
  responses manufacture confirmation before ticket unlink/thread teardown; and
  seven current Discord `showModal` dispatches lack explicit inventory rows.
  Its corrected full backend attempt passes all 445 TypeScript tests, but Jest
  remains failed with 2,210 passed, two failed and nine skipped tests. The failures
  include the unsynchronized disconnect fixture and missing public HUD/deployment
  fixtures in the test snapshot. The original heap/OpenSSL/noexec preparation
  failure is preserved separately; correcting preparation does not accept v13.
  The 539 runtime source files, wider frozen inputs, complete review and both
  full-test attempts are preserved in signed 1,916-file
  `runtime-rehearsal/v13-round8-failed/`, catalog SHA256
  `219009440261eb282167e3ea4f9679d3b9017dc498a3c77e5309ab0ee05dd483`.
  Correct the findings and disconnect lifetime regression, rerun complete current
  supported-image gates, and obtain fresh whole spec then quality acceptance.
  Task 1, G6, Task 2 implementation and production promotion remain unaccepted.
  V4 transfer-helper work is paused at signed checkpoint 004; its eight drafts
  have no behavioral acceptance, remote staging or execution grant.
- The Round 8 correction's actual Node 22 native-fetch diagnosis also finds a
  legitimate GitHub success unable to drain within 120 seconds: the request,
  response and socket have all closed, but Undici's unused request-body clone
  retains an internal stream promise. The source-bound creation trace identifies
  `cloneRequest` and the internal byte-stream closed promise; this is a confirmed
  deadline failure, without a claim of a permanent leak. Preserve the earlier
  invalid missing-timeout attempt separately. Isolate only proven SDK initiation
  while retaining the actual request result, response body, parsing, required
  disposition and caller descendants. Check equivalent body-bearing OAuth and
  moderation calls with actual supported native requests before freezing the next
  artifact. No global fetch patch, arbitrary promise deletion or whole-handler
  bypass is accepted. Compiled-image regression and fresh full reviews remain
  required after this additional correction.
  Subsequent genuine loopback JSON and form-request cases reproduce the same
  retained clone after successful response parsing. The correction therefore
  covers the seven additional existing OAuth/moderation POST callers as well as
  GitHub, keeping arguments inside their owner and retaining response consumption
  before existing non-success refusals. The same correction also covers Steam's
  default OpenID verification and the optional GitHub release mirror's buffered
  create/update requests. Injected application fetch implementations retain their
  original scope; held response bodies, including mirror tag lookup failures,
  remain owned until consumed. Stream bodies and GET requests keep their original
  accounting. These are correction requirements, not final acceptance.
- The frozen v14 image repeats all 60 installed file/control cases and the
  25 SDK, 32 primary and four runner cases. Its 43 compiled response/native/TLS
  cases match the expected 29 closed and 14 failed outcomes with no active work.
  **Fresh whole Round 9 review still fails:** rejected MCP metadata responses
  can remain live after a closed checkpoint; required GitHub REST mutations can
  accept missing identities or malformed/mismatched confirmation; and the native
  helper loads the wrong coordinator in two source test fixtures. The supported
  full backend run passes 445 TypeScript tests but fails Jest with 2,204 passed,
  73 failed and nine skipped. Those 73 fixture failures require correct runtime
  binding; suppressing dotenv output or loosening JSON parsing is insufficient.
  Separate v14 compiled PostgreSQL/S3 and full-application proofs were not run
  after these blockers. Their earlier results remain historical only.
  The complete current source and failed evidence are preserved in signed
  3,422-file `runtime-rehearsal/v14-round9-failed/`, catalog SHA256
  `d7e271073b5f7d0b2bfa7a7e01c81c083647f7a1580573ce88be3e1ea53a0e5c`.
  The next artifact needs all current gates and fresh whole spec then quality
  review. V4 is paused at signed checkpoint 005, catalog
  `85c6e5366a385e8929d2b61dd93c53762d235a9e16c4bbf1dfb0ff0c06e2c035`.
  Its implementer observed 21 local lifecycle/diagnostic tests passing, with no
  raw passing output file; controller integration and the heavy-input
  prerequisite remain incomplete. Neither runtime nor transfer is accepted.
- The frozen v15 artifact passes the full supported backend gates: 2,324 Jest
  tests across 179 suites, zero failures and nine existing wiki placeholders,
  plus 445 TypeScript tests with no failures or skips. Current compiled proofs
  also pass 60 installed file/control cases, 25 SDK, 32 primary, four runner,
  43 response/native/TLS, 37 MCP/REST/helper-binding, nine PostgreSQL, 14 S3 and
  eight full-application cases. **Whole Round 10 still fails one P2 finding:**
  required GitHub label confirmation incorrectly rejects a returned name that
  differs only by case, retaining a false required failure. This exported helper
  has no identified current production caller. Correct the valid casefolding
  control without weakening missing/unknown-result retention, then repeat current
  gates and fresh whole spec followed by quality review. The complete signed
  evidence is `runtime-rehearsal/v15-round10-failed/`, catalog SHA256
  `d6ffc803d6570c24f61b14053d5b6b1d74bf26e41cc4e60e133f7ca710f565e0`.
  Task 1, G6 and Task 2 implementation remain unaccepted. V4 is paused at signed
  checkpoint 006, catalog SHA256
  `ce38fe031e927be03386452f78416dd0366998952e72c744fe8d5fe7c79002f1`.
  Its five local full-controller scenarios pass, but its 131-case Python attempt
  fails on a runner import; the corrected runner still needs a complete rerun.
  The heavy-input prerequisite, complete proposal and both reviews remain open.
  Neither a SMALL nor a full execution grant has been issued.
- The frozen v16 artifact passes the complete supported backend gates: 2,371
  Jest tests across 179 suites, zero failures and nine existing wiki placeholders,
  plus all 445 TypeScript tests. Current compiled PostgreSQL, S3, SDK, response,
  control and full-application proofs also pass. Whole Round 11 passes all fourteen
  runtime requirements, but **quality review fails one important P2 finding**:
  native cancellation removes a timer without unregistering its producer entry.
  A real compiled-runtime probe cancels 5,000 interval/timeout pairs and retains
  10,000 entries; shutdown closes but records those canceled schedules in a
  1,670,553-byte checkpoint. No outage, OOM or deadline breach was observed.
  The correction must unregister canceled timers exactly once while retaining
  any admitted callback until it settles. A minor transaction-fixture teardown
  issue must also preserve the original setup failure and close its allocated
  observer even if cleanup fails. The signed 12,100-file evidence is
  `runtime-rehearsal/v16-quality-failed/`, catalog SHA256
  `390e8baa1472f2a625b5160a477c2660011fda8e6e3df9844bdaa0e44dc72f8a`.
  V17 is being corrected and requires new current gates, whole spec review and
  quality review; Task 1, G6 and Task 2 implementation remain unaccepted.
  V4 is paused at signed checkpoint 007, catalog SHA256
  `bc6d7836b287c471c53d3a7ad40f5881b09eb1ca3becc012f2606cf1a949ce85`.
  Its recorded source generations pass 153 Python cases, five full-controller
  cases and nine SMALL-controller cases. Later signer metadata changes remain
  untested; the heavy remote prerequisite guard and both proposal reviews remain
  incomplete. No SMALL or full execution grant has been issued.
- The frozen v17 artifact passes all current parent test groups: 2,400 Jest
  tests across 181 suites with zero failures and nine existing wiki placeholders,
  445 TypeScript tests with no failures/cancellations/skips, eleven actual compiled
  timer cases and the current SDK, primary, file/control, response, MCP/REST,
  PostgreSQL, S3 and eight complete-application proofs. Whole Round 12 still
  **fails requirement 3**: a non-OK avatar CDN response returns without consuming
  or canceling its body. In the exact production image, a finite 100-byte refusal
  and physical socket closure leave two admitted native stream promises pending
  through the two-second retry. A successful response consumes its body, performs
  the actual signed S3 PUT and closes. The optional-avatar failure policy remains
  valid; its abandoned lifetime must be corrected and covered by native regression.
  `imageStorage` refusal/MIME early returns are a related source audit candidate,
  not another independently reproduced finding. The signed 16,566-file evidence
  is `runtime-rehearsal/v17-round12-failed/`, catalog SHA256
  `a822d79c837b4c993a40be1de18a83f7b348f97394219171fa42d45b6c09b7b1`.
  V18 is the sole runtime correction; its current gates and both fresh reviews
  remain required. V17 quality review was not started after the whole-spec failure.
  V18 freezes 559 runtime files and adds awaited cancellation of unused native
  response bodies without changing their status, authorization, retry or cache
  policies. The audit covers 44 native/default/aliased dispatches across 25 files;
  all 960 writer identities and dispositions, 167 prior source bindings and both
  shell bindings remain, with 181 current source bindings. Current focused checks
  pass 112 native/audit/inventory tests, 86 affected Jest regressions and four
  Steam TypeScript tests. Source and compiled caller fixtures pass 36 cases each;
  actual compiled TLS/S3 fixtures pass 13 image cases, retaining genuinely held
  bodies until completion. The initial exact-import assertion failure is retained
  separately from the corrected passing inventory run. These are implementation
  proofs; the new exact production image, full parent gates and both fresh reviews
  remain required before Task 1 acceptance.
  The frozen v18 production image subsequently passes all eight compiled/store/
  application groups, including the 49 native-body cases and real PostgreSQL/S3
  probes. Full TypeScript passes 445 tests, but full Jest has 2,427 passes,
  46 failures and nine unchanged wiki placeholders. All 46 failures share one
  required-effects fixture setup: its new native-helper import reaches an
  unintended fixture runtime/environment, and its stdout parser rejects ordinary
  dotenv logging. Whole Round 13 therefore fails requirement 14. Correct both the
  exact helper/coordinator binding and structured result transport; filtering
  diagnostics does not repair ownership. Signed evidence is
  `runtime-rehearsal/v18-round13-failed/`, catalog SHA256
  `ba4d7bbc425a6a701e3ced6ba57b81f96e3e2dd4e510bc60d6254d1421250e01`
  with 20,422 verified members. V19 is the sole fixture correction. The transfer
  correction is stopped at partial checkpoint 008, with 49 preserved source
  snapshots and unfinished, untested integrations. No quality or Task 1 acceptance
  has been granted.
  V4's separate code-only proposal is sealed at
  `full-preparation-v4-implementation/final-code-only-001`, catalog SHA256
  `0ec34fde53be9c738c4263d8f5d88bbc761832a64b56dc829838590ab9c23461`.
  Its exact source passes 163 Python regressions, five full-controller mock
  scenarios and nine SMALL mock scenarios, but **fresh whole proposal review
  fails nine source findings**: fabricated quarantine evidence for a missing
  result, admission after deadline, missed descendants, missing tunnel lifecycle
  acceptance gates, lease sequence replay, cleanup overruns, incomplete birth
  identity, uncovered CLI paths and uncertain Docker inspection treated as
  absence. The report and local counterexamples are preserved in signed
  `full-preparation-v4-implementation/review-round1-failed/`, catalog SHA256
  `6d8c69002bf9ee53919ebded0ef5c6006d415179af5c2816fa463c1c6ce7f182`.
  The original sealed proposal remains unchanged. Correct all findings after
  the runtime source freezes, then repeat whole spec and quality review.
  Full key/provenance and actual external tunnel closure remain prerequisites;
  no execution grant or production acceptance is implied by the local passes.
- V19 corrects both fixture helper bindings and explicit result transport while
  preserving the original 46 assertions. All current parent groups pass, including
  2,484 Jest tests, 445 TypeScript tests, actual PostgreSQL/S3 probes and eight
  application scenarios; nine existing wiki placeholders remain skipped.
  The first full run's two compiled-fixture failures remain preserved: the parent
  harness used a custom compiled-directory symlink. A fresh run with the exact
  compiled files in CI's regular-directory layout passes without changing source
  or assertions. Whole Round 14 passes all fourteen requirements, but the separate
  complete quality review fails an Important/P1 compound-outcome gap. An unchanged
  emitted-code synthetic contract confirms that a committed ban followed by Redis
  or session discovery failure can skip required cleanup and audit while persisting
  a clean runtime close. No actual-store incident is claimed. Nested unmute,
  party-leave and account-unlink paths require their own same-class confirmation.
  Signed failed evidence is `runtime-rehearsal/v19-quality-failed/`, catalog SHA256
  `ff60f14c00a5ed878616711125c258a5627b3d5de4ef9429515b87958ca5e3e4`,
  with 17,859 verified members. V20 began the next runtime correction; current full
  gates, fresh whole specification and separate quality review remained required.
  Transfer-helper work is stopped at immutable unsigned partial checkpoint 009,
  with 80 catalog members and 52 source snapshots. Twenty targeted controls pass;
  the broader 183-test regression has five failures and nine errors. The parent
  independently signed its readback outside that checkpoint; the child catalog
  remains unsigned and unaccepted. Historical warning-child wait/pidfd closure
  remains unproven. Actual MCP transport lifecycle and Full key/provenance remain
  unresolved. Task 1, G6, Task 2 source work and production promotion are unaccepted.
  Signed read-only guards at `2026-10-14T19:06Z` confirm all ten protected
  Hostinger production and Mothership dev container identities, images, starts,
  restarts and health remain unchanged. Hostinger's repository deployment flag
  and Mothership production Compose auto-deploy remain off; dev remains unchanged.
- V22 passes all eleven current local verification groups and the full fourteen-
  requirement specification review: 2,711 Jest tests, 445 TypeScript tests,
  nine real PostgreSQL cases, fourteen S3 SDK cases and eight application cases.
  Its separate quality review rejects four native publication funnels: layout,
  nameplates, existing-code link recovery and canonical receipt replay. Local
  delivery and later Redis acquisition can fail before the required publication
  boundary, then disappear through internal catches. The preserved source/emitted
  contracts establish this accounting defect without claiming a live incident.
  Signed failed custody is `runtime-rehearsal/v22-quality-failed/` and its separate
  `v22-quality-failed-adjacent/` addendum; neither is accepted for deployment.
- V23 adds explicit required publication prerequisites for both local delivery
  and client acquisition after input/reply selection. All 351 focused checks pass;
  the new 90-case source/emitted matrix reproduces 22 prior failures and preserves
  68 controls. Current full verification and fresh specification then quality
  review are pending. Task 1, Task 2, transfer timing and production promotion
  remain unaccepted; the old Hostinger stack remains authoritative.
- Exact legacy administrator-chat rehearsal exposed `source='web'` missing from
  the message source constraint. The current post-push patch has the same mismatch.
  A read-only production check at `2026-10-14T03:10:49.775Z` confirms 24 retained
  failed Bull jobs with original IDs/timestamps; 23 use `web` and report the source
  constraint failure. No jobs or schema were changed. The compatibility correction,
  actual admin durable delivery test and controlled retained-job recovery remain
  required before promotion. Preserve original IDs/times and check moderation and
  retention before repair; retained jobs do not establish absence of older deleted
  failures or pre-enqueue accepted effects. The protected aggregate inventory is
  signed in the operation's `legacy-retained-jobs/` directory.
  Follow-up SQL confirms those 24 exact rows are absent. Ten web jobs and the one
  other game-source job reference unavailable users; every referenced channel is
  present. Trace deletion/merge/moderation decisions before any replay and retain
  unresolved cases for specific disposition. Do not recreate deleted accounts.
  The signed deletion-audit aggregate identifies four distinct missing authors
  across those eleven jobs, with no matching deletion audit or durable legacy
  merge mapping. Their absence remains unknown; it does not establish an intended
  deletion or authorize replay through a guessed account. The thirteen jobs with
  existing authors still require per-ID moderation/retention/link checks and a
  proved persistence/publication disposition before controlled repair.
  The current retention setting is `0` (cleanup disabled); it supplies no age cutoff.
- A separate atomic Redis `EVAL_RO` at `2026-10-14T07:19:23.910712Z` preserves
  all 24 currently retained failed jobs, their raw hashes/logs, the failed set
  and absolute expiries. Only encrypted payload leaves Hostinger; the desktop
  authenticates decryption without writing plaintext and signs the nine-file
  catalog. It is retained under
  `legacy-retained-jobs/recovery-snapshot-20261014T071200Z/` with catalog SHA256
  `12081aefc0ff51e4e0b27e8be22a54ac90c5650291a409a00256ad04825b09fe`.
  No jobs were replayed or repaired and the source Redis process remained healthy
  and unchanged. This preservation does not prove complete historical capture,
  absence of older accepted effects or permission to recreate missing accounts.
  A further read-only audit check identifies four distinct unavailable authors
  across those eleven jobs and finds no matching `user_deleted` audit records.
  This establishes no deletion or merge decision. The exact legacy merge helper
  deletes the placeholder after repointing SQL rows but leaves no durable mapping
  for already queued payloads. Its deletion endpoint catches audit-write failures.
  Keep these jobs unresolved until a supported identity/deletion disposition is
  available; neither an absent author nor an absent audit authorizes replay.
  Static schema/auth inspection also finds direct audit calls using Discord
  snowflakes or `api-key` where `audit_logs.actor_id` requires a nullable internal
  user UUID. Validate actor mapping and actual audit rows on PostgreSQL for user,
  channel and message administration before promotion. Main moderation/AutoMod
  paths already resolve internal actors and need their own normal acceptance.
  This mismatch is a possible legacy audit-failure mechanism, not a proven cause
  of the unavailable authors or a production failure count.
- Completed an isolated full SQL/schema rehearsal with the exact PostgreSQL 15.17
  /TimescaleDB 2.26.2 image. All 16 compatibility patches applied repeatedly with
  identical rows/timestamps/constraints; `/sos` becomes Swarm of Suitors and
  `/sts` appears once. Custom commands and configured moderation defaults survive.
  The legacy patch runner preserves upgraded data, and a second full Prisma
  schema sync leaves the normalized complete catalog unchanged. Legacy/current
  Prisma schema files are identical. The owned fixture stopped cleanly and was
  removed. Restricted `schema-rehearsal/result.json` records this limited proof;
  full old/new application acceptance and verified state rollback remain open.
- Exported the exact running Hostinger backend image without changing its
  container, start time, restart count or health. The 179,442,176-byte archive
  matches SHA-256
  `a77fdc4c5789e5afedf5918ca01955dbebcba80a9cc7694b6175059324edc798`.
  Local import preserves its config/layers and verified image identity. On fresh
  private synthetic stores after the current schema/patch sync, the actual old
  image passes cookie-session authentication, download bytes, application upload
  and readback, authenticated WebSocket delivery, and one canonical message with
  one row/frame/acknowledgment/history entry. Its isolated SIGTERM probe did not
  stop within five seconds; forced fixture cleanup is retained as a discrepancy.
  This scoped compatibility proof does not account for the old production
  process's already accepted effects, prove external OAuth/Discord, or establish
  complete state rollback. The first-upgrade drain/recovery gate remains open.
  A separate synthetic probe adds one populated unknown SQL table: the old
  image's authoritative Prisma startup refuses to boot rather than drop it. Its
  row remains intact; `--accept-data-loss` was never used. Therefore populated
  additive recovery/outbox tables require exact schema/startup and full-state
  rollback rehearsal; current-schema compatibility cannot accept that future change.
- The exact legacy image's native HTTPS fetch and default Discord REST/Gateway
  handshake pass against private synthetic authorities on a dedicated internal
  Docker network. Missing CA and wrong-hostname negative controls also pass;
  ordinary TLS validation remains enabled. The actual legacy SDK and compiled
  service hashes are bound to signed evidence in `legacy-tls-preparation-v1/`.
  All seven existing fixture stores remain unchanged and the handshake resources
  were removed. The full backend default command, message/thread/issue creates
  and cutoff cases were not executed. A separate fixture preparation must prove
  accepted remote effects and missing local maps without SDK/source replacement;
  its diagnostic ledger cannot establish effects that old production never logged.
- Securely captured current source runtime/edge settings, effective container
  environments and release metadata, and staged six protected configuration files
  on Mothership. All 68 runtime settings preserve effective source credentials;
  URI identity is unchanged while private hosts normalize. Per-store credentials
  match the source; the connector file is separate. Compose `format: raw` and an
  isolated synthetic container verify literal dollar handling. Target byte checks
  pass without returning credential values or hashes. `runtime-control/` and the
  release metadata bind are owned by backend UID 0 with 0700/0600 modes; a harmless
  probe with all capabilities dropped passes. The target's maintenance marker
  exists before any application start. This is provisional configuration staging,
  not final recovery: refresh after Hostinger acceptance. Existing stacks and
  production authority are unchanged.
- **G9 fails for the baseline full-copy method.** A fresh representative capture
  takes 525.045 seconds for a 15,780,369,000-byte encrypted archive. Even its
  configured 30 MiB/s cap cannot fit forward/reverse streams and acceptance reserve
  in 30 minutes; observed forward relay throughput is slower, about 8 MB/s.
  The complete round trip passes all cold files/hashes/ownership, Redis
  sessions/expiry/queue acknowledgments, MinIO versions/delete markers and
  destination-created messages/downloads. Successful components plus the
  provisional 300-second application reserve take **85m 05.7s**; actual elapsed
  time including failures/gaps plus reserve is **112m 53.6s**. Reverse recovery
  alone plus reserve takes **36m 17.3s**, so no destination-writer boundary fits
  the 30-minute budget. Signed report, timings and 180-file evidence catalog are
  retained in the protected operation's `representative-rehearsal/` directory.
  Owned source/target fixtures and transport helpers were removed; independent
  encrypted archives remain on the desktop and Mothership. Do not schedule this
  method. A
  pre-stage optimization requires its own complete cold-state and reverse-state
  rehearsal before it can replace the failed baseline; no shortened verification
  or untested delta path is accepted.
- The proposed optimization passed small signed restore and refusal tests on
  both actual hosts, including an external SIGKILL after an applied file and
  rejection of incomplete/quarantined candidates. Exact ownership, nanosecond
  timestamps, deletions and hashes were checked. Full-workload timing remains
  untested. Parent review found that the start gate must also hash-bind its final
  manifest to the signed capsule after apply; revised small probes on both hosts
  pass the corresponding positive and altered-manifest refusal cases. Keep the original signed P0 evidence
  immutable. The complete runner must include the acknowledged live mutation
  journal, genuine absolute Redis expiries, independent trusted signing-key
  fingerprint, fresh Docker ownership/no-writer checks and the continuous
  forward/reverse clock plus application reserve. No integrity check may be
  omitted to meet the budget.
- The sealed complete optimization preparation verifies 192 catalog files,
  17 scripts and the helper's nine ordered layers, eight source modules and two
  age binaries. Independent review passes 68 small tests and the 40-operation
  orchestration dry-run, but fails three boundaries: SSH pipe transfers can block
  without a deadline or abort check; incoming archive ACL/xattr metadata can be
  discarded; Docker checks omit actual network identity and complete mount proofs.
  The unchanged v1 method and failed proofs are retained. A separate v2 correction
  requires fresh spec review, quality review and exact signed rehearsal approval
  before the full representative run. Production readiness remains false.
  Measure `forwardElapsed + reverseAfterAnyWriter + 300 <= 1800` from one unchanged
  operator boot and `CLOCK_BOOTTIME`; also retain the continuous total. Successful
  synthetic storage timing alone does not accept application or edge recovery.
- The operator selected **this desktop**, verified as `Devotek-PC`, for the
  protected independent production recovery-key copy. Its mode-0700 key directory
  and mode-0600 age/signing files passed ownership checks, configuration archive
  authentication/decryption and signature verification. Neither the MSI laptop
  nor Steam Deck is the selected second copy. No production private key was
  uploaded to either host. The recorded paths and verification procedure are in
  the protected operation's `desktop-key-recovery-record.json` and
  `verify-desktop-key.py`; do not commit the keys or configuration plaintext.
- A second source checkpoint preserved 98 changed/new source files, the tracked
  patch, refs and a verified Git bundle before another remote fetch. Its catalog
  signature verifies. Refreshed Dev remains `ddfa1fae286d8197da7abeb0b735f45f40538f27`
  and Prod remains `a6e8df12a730a421b7dea22c83c08726e4310b3f`; no new remote
  content was integrated at this checkpoint. Current runtime/definition changes
  are still uncommitted and require final review/CI on their eventual revision.
- The operator explicitly waived the two-client native acceptance matrix with
  “bypass”; its result remains unverified. The waiver is limited to that manual
  game-client gate and does not waive any automated or infrastructure acceptance.
  No final production data backup,
  writer shutdown, production target restore, edge handoff, Prod push or release
  publication has occurred at this checkpoint.
- **Recovered verification, 2026-10-15 UTC:** frozen v23 passes all eleven local
  verification groups: 2,803 Jest tests, 445 TypeScript tests, nine real PostgreSQL
  cases, fourteen S3 SDK cases and eight packaged application cases. Nine existing
  wiki placeholders remain skipped. The independent specification review passes
  all fourteen runtime requirements. The separate quality review fails one P1:
  five remote relay-control delivery helpers can swallow required acquisition or
  cursor failures. Its 64 source/emitted observations include sixteen false clean
  closes, four retained failures and 44 clean controls. Preserve that failure;
  the passing groups do not accept the candidate. Public source and review
  custody is retained in the protected operation's
  `runtime-rehearsal/v23-quality-failed/`. The bounded v24 shared-helper correction
  is in progress; production remains unchanged.
  The transfer harness's separate local generation 003 passes 193 Python tests,
  nine Full mock scenarios and thirteen SMALL mock scenarios, with zero skips.
  Its immutable `partial-checkpoint-001` preserves 53 source files and 96 catalog
  members. These are local tests: the final parent-death lifecycle correction,
  complete review, external MCP transport proof, Full key provenance and actual
  timed forward/reverse rehearsal remain open. No execution grant or cutover
  readiness follows from these results.
- **Task 1 qualified, 2026-10-15 UTC:** commit `ab0bedcd` corrects the five
  shared delivery helpers. Fresh independent specification and quality reviews
  pass all fourteen runtime requirements. The maintained receiver matrix retains
  32 required failures and 44 clean controls, with zero false clean closes or
  receiver republishing. All 960 writer identities/dispositions remain intact.
  Required [CI run 38679701888](https://github.com/UNN-Devotek/FCM-Fallout-Chat-Mod/actions/runs/38679701888)
  passes all fourteen jobs, including CI Summary and the complete Ruffle harness:
  189 Jest suites / 2,879 passes / nine existing wiki placeholders, and 445
  TypeScript passes with zero failed, cancelled or skipped tests. The tested
  merge and reviewed head have the identical complete Git tree. The exact image
  passes eight application checks; six final backends are independently stopped
  and removed. Public source and synthetic evidence are preserved in
  `runtime-rehearsal/v24-task1-qualified/`, unsigned catalog SHA256
  `1b60a237ac410d88fbded33a56949e7a51ec84dc0e5600da197c1b718844f360`.
  This supersedes the earlier pending Task 1 status, while preserving its failed
  versions. It does not accept Task 2, promotion, G6, timing or the live boundary.
- Transfer generation 004 is frozen at `public-checkpoint-001`: 54 source files,
  116 verified catalog members, 199 Python tests with zero skips, nine Full mock
  scenarios retaining all forty operations, and thirteen SMALL mock scenarios.
  Catalog SHA256 is
  `8d7bb428d5f97b4fcbf762af5cdd4532a5700584ad699c29b26cad1a540aa61f`.
  Preauthority verifier custody and a nested budget watcher remain confirmed
  blocking code gaps. The actual owned MCP controller-loss/tunnel/both-port
  proof and private authority provenance also remain unresolved. Current test
  inputs are complete; five earlier test-file revisions retain their captured
  hashes and raw results without recoverable historical bytes. No real transfer
  or new execution grant is accepted from this checkpoint.
- **Task 2A qualified, 2026-10-15 UTC:** commit `199e2464` passes fresh
  specification and quality reviews for `web` compatibility, FK-safe audit
  attribution/canonical self-deletion and private retained-job classification.
  The real fixtures own their Bull prefixes and PostgreSQL sequences. All 851
  frozen files and 960 prior writer identities/dispositions match their bindings.
  Required [CI run 38725875287](https://github.com/UNN-Devotek/FCM-Fallout-Chat-Mod/actions/runs/38725875287)
  passes all fourteen workflow jobs: 193 Jest suites / 2,956 tests, 476 TypeScript
  tests and 93 Ruffle scenarios; nine unchanged wiki placeholders remain skipped.
  Independent proof passes 65 real-store tests and 110 source/emitted cases.
  An optional inventory run hit its reviewer watchdog and remains incomplete;
  the separate direct inventory/mutation check passed. All 656 production build
  inputs are unchanged, so the same immutable image's prior nine application
  cases and six natural terminal closures are explicitly reused. Public source
  and synthetic evidence are sealed in `runtime-rehearsal/v27-task2a-qualified/`,
  unsigned catalog SHA256
  `949d519efe1d68e30c2d1fb4d25f5c4b09311c88b1ec6d02c0a7f8516d6ddb1e`.
  Earlier v25/v26 failures remain preserved. The separate CodeQL check
  `116390777156` fails six alerts and is outside that fourteen-job count;
  production CSRF review remains open, with no security-readiness claim.
  All 24 retained jobs remain protected: thirteen existing-author candidates
  and eleven missing-author blocks pending provenance or explicit disposition.
  Task 2B1 ordinary relay/journal/SDK work is released locally, while its review,
  Task 2B2 private repair runner, broader recovery, promotion and timing remain
  open. Hostinger and hosted Dev authority are unchanged; no production repair
  or operation is authorized by this source checkpoint.
- **Task 2B1 v28 failed, 2026-10-15 UTC:** commit `1406f01f` passes the
  bounded specification review, 39 direct-image and 58 emitted caller/relay
  checks, and nine new-image application cases. Required CI fails five tests
  in two startup fixtures: the compiled journal dependency and explicit 0700
  fixture controls were missing. Quality review also measures 1.17 seconds of
  synchronous journal work at 10,000 completed operations, below the file cap.
  Both defects require correction while preserving private permissions,
  complete journal integrity and failure fencing. The failed source, image
  bindings, reviews, CI log and reproductions are preserved in the 34-member
  `runtime-rehearsal/v28-task2b1-ci-failed/` catalog, SHA256
  `c1b0c11335b13096b894565f018b1cb8c368c6abfedd36f16936dcf0333b9120`.
  Fresh reviews, a new exact image/application run and current CI remain
  required after the source correction. This is not Task 2B1 qualification.
- **Task 2B1 v29 reviewed, not accepted, 2026-10-15 UTC:** commit
  `258e79b1` resolves the v28 scaling and startup-fixture defects. Fresh
  specification review, all fourteen required CI jobs, nine new-image
  application cases and the unchanged growth probe pass. CI includes 2,999
  Jest passes, 515 TypeScript passes and all 93 Ruffle scenarios. Quality
  review finds one Minor cleanup defect: a file-close error can skip an owned
  directory close. The persistence failure remains fenced; the omitted close
  must still be corrected and regression-tested before acceptance. The
  41-member `runtime-rehearsal/v29-task2b1-reviewed-not-accepted/` catalog,
  SHA256 `9c4fc636e3cfe232a707ea4e0e02484e91dfbe1c7022970c88968d315bf6b1ed`,
  preserves exact source, emitted files, both reviews, CI and the ownership
  probe. The next local correction is limited to independent cleanup attempts
  and their tests/documentation. A new image/application run, fresh reviews
  and current CI remain required. B2 recovery, security, promotion and the
  production cutover remain open; this checkpoint grants no operation.
