# Backend maintenance and accepted-work drain

The backend has a local operator control socket and durable startup fences. This is the
application drain mechanism for the [return-to-Mothership procedure](../deployment/return-production-to-mothership.md).
It adds no HTTP maintenance endpoint, client release, authentication bypass, or transport.

## Control directory and startup

| Setting | Default | Meaning |
| --- | --- | --- |
| `FCM_RUNTIME_CONTROL_DIR` | `/app/runtime-control` in production; `backend/.fcm-runtime` during local development | A writable, persistent, host-managed directory. Bind-mount it independently of the application image. Directory mode is `0700`; control socket and journals use `0600`. |
| `FCM_DRAIN_TIMEOUT_MS` | `120000` | Total drain and close budget. Valid range is 100–1800000 ms. Container stop grace must exceed it; the return deployment uses 180 seconds. |

`src/runtime/index.ts` is the first server import and reads the fence before route, queue,
Discord, or timer modules load. `runtime-start.sh` checks the same directory and atomically
claims a process fence before schema baseline/synchronization, then `exec`s Node. Node receives
container signals directly and inherits only that claim's fresh nonce and unchanged shell PID.
Direct Node/development startup claims the same fence before importing producer modules.

| File | Behavior |
| --- | --- |
| `maintenance.json` | Durable operator maintenance. Any file with this name freezes startup, including an empty file, unknown content, or a dangling symlink. The backend never automatically removes it. |
| `restart-active.json` | An exclusive process claim created before baseline migrations or module producers. It remains throughout the active process lifetime, including an unsignalled crash or failed/killed baseline. Only the process owning the exact unchanged claim may clear it after a verified closed drain and no operator request. Any other/unknown `restart-*.json` also fences startup. |
| `control.sock` | Local Unix socket. A live or unknown existing socket prevents takeover; only a verified refused connection permits stale-inode removal. |
| `checkpoint.json` | Atomic structured snapshot with phase, process ID, fences, `operatorMarkerPersisted`, `ingressClosed`, active work, accounting/inspection epochs, closed participants, stopped producer schedules, failures, and queue/Discord inspections. |
| `failures.jsonl` | Append-only required-effect failures, including ambiguous external sends. Unresolved records fence a new process and prevent a clean drain. |
| `messages.jsonl` | Accepted canonical message IDs, timestamps, content digests, and initial committed-row proofs. Contains no message bodies or tokens. |
| `discord-relays.jsonl` | Ordinary-message relay intent, attempt, known returned Discord ID, and verified completion. Immutable canonical UUID/time, destination, configuration and protected-input digest; no message bodies or tokens. |
| `discord-relay-payloads/<operationId>.json` | Private original relay arguments and exact link prefix for unresolved ordinary messages, including live-only REST. Directory `0700`, files `0600`; never print these contents. Verified completion durably removes the protected input; failed cleanup remains unresolved. |

A frozen boot skips baseline migrations, startup compatibility patches/seeds, Bull consumption,
Discord login, scheduled jobs and producer timers, rate-limit Redis script initialization, and
installer-script copies. Frozen HTTP reads are limited to existing health, installer scripts,
and static `/downloads/` artifacts; these bypass session refresh and download counters. Health
reports `status: "maintenance"` and can perform read-only store probes. All other HTTP requests
return RFC 7807 HTTP 503 with `Retry-After: 30`, including GET routes that can refresh sessions
or account state. Both WebSocket upgrade paths return 503; existing sessions get an existing
error frame with `code: "maintenance"` and `retryAfterMs: 30000`, without a success acknowledgement.

Removing a file never resumes a running frozen process. Activation requires a new process.

## Local commands

Run status/freeze/drain inside the exact backend container, using its configured control directory:

```sh
node dist/runtime/cli.js status
node dist/runtime/cli.js freeze
node dist/runtime/cli.js drain
```

For shutdown, run the CLI in an independent container using the exact tested backend image
and the exact control-directory host mount. It needs no network, credentials, other volumes
or Linux capabilities. This keeps the CLI alive when backend PID 1 exits:

```sh
: "${fcm_backend_image:?Set the exact tested backend image reference}"
: "${fcm_control_host_dir:?Set the exact backend control-directory host path}"
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=${fcm_control_host_dir},dst=/app/runtime-control" \
  --env FCM_RUNTIME_CONTROL_DIR=/app/runtime-control \
  --entrypoint node "$fcm_backend_image" dist/runtime/cli.js shutdown
```

`freeze` persists operator maintenance and stops new producer ticks. `drain` waits for accepted
work and records a checkpoint while keeping ingress/dependencies available for recovery.
`shutdown` additionally closes ingress, waits for close-handler effects, closes consumers and
dependencies, records `phase: "closed"`, and exits successfully. Both operator commands leave
`maintenance.json` in place. A command failure exits the CLI nonzero; the backend stays frozen.
Freeze success requires the durable, directory-synced operator marker. An in-memory freeze or
remaining process claim still fences work when marker/journal persistence fails, but the CLI
reports failure. Shutdown success requires `closed`, confirmed ingress closure and no retained
failures; `drained` alone returns nonzero for shutdown. Status remains a read-only report.
Concurrent shutdown/signal requests strengthen an active nonclosing drain and share its
original absolute deadline. They wait for real ingress callbacks, reinspect after them, and
close the remaining dependencies. A joining request never resets or extends the total budget.
An incomplete or failed close retains the process claim and any operator marker.
There is no `resume` command. Docker may terminate an `exec`-launched shutdown CLI as soon
as backend PID 1 exits, even after it emitted a complete `closed` result. Its exit status
alone is not application acceptance or failure evidence. Verify the retained final checkpoint
(`closed`, `ingressClosed: true`, matching accounting/inspection epochs, no active/pending work or failures) and
actual stopped backend/container state. A separately controlled `freeze` followed by signal
shutdown can use the same checkpoint/stopped-state proof; the operator marker stays durable.

`SIGTERM`/`SIGINT` use the same drain and close ordering while retaining the private process
fence created at bootstrap. An ordinary reviewed deployment can restart normally only after a successful closed
drain clears that process's own exact fence. A concurrent operator freeze/drain, another fence,
failed effect, timeout, interrupted close, crash or forced kill prevents automatic activation.
An operator request arriving after close still creates durable maintenance for the next process.
Marker age is never an activation decision.

`FCM_RUNTIME_BOOT_NONCE` is an internal entrypoint handshake, not an operator setting. The
entrypoint discards any configured value, generates a fresh claim, and passes it only to its
exec'd Node process. A mismatched nonce/PID, changed claim, leftover claim from another process,
or unresolved failure journal keeps producers frozen. Do not configure or reuse this value.

Use operator `freeze`/`shutdown` for cutover. A signal-only shutdown is the ordinary restart
path and does not establish an indefinite maintenance window.

## Accepted-work accounting and close ordering

Ingress callbacks have scoped work leases. The coordinator counts returned and detached
descendant promises, middleware/upload callbacks, moderation continuations, and queued external
effects. Finishing a response, disconnecting a client, returning `void`, or shifting a send from
an array does not prove completion. Unknown callback completion or an unresolved promise causes
a bounded failed drain rather than guessed success.

Required-effect disposition is recorded inside the retained lease, before it releases. The
explicit audit funnel covers moderation/configuration changes, AutoMod evidence, chat names,
cosmetics, device/admin changes, Discord embeds and native reports. Audit failures can preserve
the existing availability response while preventing a clean drain. MCP finalization retains its
existing two attempts and partial-effect warning; only an unconfirmed final disposition becomes
a required failure. Browser session save/destroy callbacks remain accepted until the callback
settles, independently of response close. The per-instance `createRuntimeSessionStore` adapter
also covers actual connect-redis automatic SET and TTL touch, destroy and clear commands.
It retains their required result before SDK callback error forwarding, owns returned and
detached callback work, and reports unknown accepted clear discovery without publishing raw
session keys. Read failures, pre-write serialization refusal and disabled TTL touch preserve
normal middleware behavior. A new write after freeze receives its ordinary maintenance
callback error before any SDK command. Repeated callbacks cannot release work twice.

Remote embed-image DNS deadlines use one settled result rather than leaving a canceled
`Promise.race` timeout unresolved. A timed-out underlying lookup and an in-flight request or
response callback remain accepted until their actual work settles. HTTPS, public-address DNS
validation/pinning, rebound checks, redirect, size and total-time rules remain enforced.
Each remote-image step retains its result through the actual ClientRequest close and response
end, or actual cancellation close. Redirect headers and `resume()` cannot release an open
redirect body or clear its deadline; rejection, size limits, rebound failures and aborts wait
for concrete teardown too. A following redirect starts after the preceding read completes.
The separate MCP metadata reader likewise owns actual request close plus response end or
cancellation close. Redirect/status/media refusal cancels the concrete read and waits for
teardown; error, size, peer-abort and timeout paths have the same terminal accounting. Its
public-address DNS pinning, credential-free HTTPS/default-port, no-redirect, 64 KiB, cache and
five-second socket-timeout policies remain in force. This read-only rejection does not
manufacture a required durable-write failure.

Static downloads, dashboard files and installer reads have explicit file-read ownership.
Installed serve-static/send streams release only after actual `fs.ReadStream.close`, including
held destruction after a client abort. HEAD/304 responses use the SDK's completed metadata and
response-end signal even when a closed response cannot emit finish. Installer/SPA transfers use
the same send dependency installed for Express, with per-transfer metadata/error/stream events;
an abort callback alone cannot release pending stat/read work. Frozen exemptions return these
completion promises. Arbitrary HTTP callbacks and accepted uploads/restores are never released
solely because a client disconnects.

Release uploads use a per-instance installed Multer/diskStorage adapter. It owns real input and
output closure, SDK callbacks and filesystem unlink outcomes, including partial writes and
cleanup after rejected multipart fields or size limits. Input abort cannot complete requested
destination, filename or pre-write `lstat` callbacks. Confirmed unlink cannot complete a result
callback still pending before the adapter. Installed Multer diskStorage uses Node's pipeline
callback for successful and aborted/error output; canceled output still delivers its result.
Both concrete stream closure and that actual result are required through cleanup.
A destination path is serialized across
accepted uploads until its write/cleanup finishes, and pre-write discovery distinguishes a new
file from replacement of an existing installer. Confirmed pre-write validation/permission
refusal or successful removal of a newly created partial file has no remaining write effect.
Existing symlink targets are refused before opening the upload destination.
Failed or unknown cleanup prevents clean drain. Removing an overwritten existing installer
does not restore its prior bytes and retains `prior-artifact-overwritten` failure evidence.
The post-upload path-validation cleanup is required too. Failure evidence carries operation IDs,
an opaque path-derived artifact ID and fixed stages, never installer bytes or raw filesystem
paths. Filename validation, authentication, upload limit, download URLs and release publication
remain separate from this accounting.

Accepted account wipe/deletion and full-user cleanup require session client/key/owner/row
discovery as well as deletion. Unknown discovery or UNLINK completion prevents a clean drain,
including when earlier SQL statements changed zero rows. Read success creates no committed
mutation stage, and known no-op deletion remains successful. Accepted required audits retain
refused outcomes independently of the primary row count; verified whole-transaction rollback
contracts remain separate.

Audited user/channel/message/moderation controllers resolve the authenticated actor before
their primary mutation. Existing internal users and linked Discord accounts supply a verified
UUID; API-key and confirmed unlinked Discord actors supply null. Wrong identity types,
nonexistent internal UUIDs and lookup outages are separate attribution errors, not anonymous
success. Self-deletion explicitly uses a null audit FK and retains the verified deleted actor
UUID in metadata. Required audit failure accounting and existing response catches remain in
place after primary commits, including zero-row writes. See [authentication](auth.md).

Private operator output contains fixed failure descriptions, allowlisted error classes/codes,
trusted IDs and fixed stages. SDK messages, SQL, chat content, bearer tokens, session keys and
URLs are excluded. Discord interaction/webhook routes retain a template and numeric IDs; the
bearer segment becomes `:token`. Bull failed jobs retain their original private Redis recovery
state while checkpoints expose only IDs and a fixed failure classification. Legacy journal
records are sanitized when loaded into status/checkpoints; their retained on-disk archives are
not rewritten or silently resolved. Original errors still reach domain callers/logs.

Migration database restore holds an explicit work scope through the `psql` child's
`close` event and verified stdin completion. A completed SQL input continues after
the response client disconnects. Spawn/stdio errors, incomplete request input,
nonzero or signalled closure and unknown child state retain operation/PID/stage
evidence and prevent a clean drain; `error`, `exit` or a requested termination does
not prove the child stopped. Storage restore awaits archive/entry iteration and
every object PUT. Failed or ambiguous PUTs retain the allowlisted object key; a
truncated request/archive/entry also enters the failure journal, including when a
previous object was stored successfully. Ordinary rejected keys stay distinct
from required-effect failures. Existing restore response formats are unchanged.

Database/storage dumps, avatars, party images, moderation evidence and embed-asset delivery are read-only work. Output
disconnect cancels their child/body reads, while the handler awaits actual child
closure or stream teardown. A canceled read creates no required-write failure;
unknown or still-pending read completion remains outstanding work.

Drain inspection uses a monotonic accounting epoch. If admitted work starts/finishes while
an inspector awaits I/O, its sample is discarded and repeated before recording a verified
zero queue. The same rule applies after ingress cleanup and each consumer's close callbacks;
remaining open participants are reinspected before closing the next dependency. Checkpoints
retain the last zero inspection for closed participants and list which participants closed.
`inspectionEpoch` must equal `accountingEpoch` in the final verified checkpoint.

SDK connection lifetimes are not application work: pg-protocol's parser awaits socket end,
and node-redis retains losing handshake race promises after successful connection. Connection
initiation (`pgPool.connect`, Redis connects and blacklist duplication/connect)
runs outside the admitted AsyncLocalStorage scope. The caller still awaits connection and
each SQL/Redis operation inside its work scope, and registered participants close the stores.
No unresolved application promise is deleted, guessed complete, or exempted from drain.
Subscription/gateway deliveries always enter their explicit admission boundary.

Native Node fetch with serialized JSON/string/form bodies clones an internal request-body
byte stream. On the supported Node 22 runtime, its unused branch can retain a promise after
the real request, response and transport finish, including beyond the normal 120-second drain
budget. The shared `beginRuntimeFetch` prepares application headers, URL and form values inside
the admitted owner, then isolates only this native SDK initiation for buffered request bodies.
Actual OAuth, GitHub, AI and Steam assertion callers still await the request result and real
response body in their owner; non-OK OAuth/moderation/provider responses are consumed before
their existing refusal. The optional GitHub release mirror consumes lookup, 404, mutation
and other non-OK bodies before continuing or retrying. Injected `fetchImpl` callbacks keep
the original application scope. Provider, mirror and release policies are unchanged.
GET requests and application stream bodies keep the original scope. Body parsing, required
mutation disposition and returned/detached application callback work are never exempted.
No global fetch/SDK method is replaced and no promise ID is deleted.

Every native fetch response also needs an explicit body disposition. Unused non-OK,
media-refused and status-only success bodies use `discardRuntimeResponse`, which awaits
the actual Web stream cancellation in the admitted caller without buffering that body.
Peer EOF/TCP close alone does not settle an unread native Web stream's completion promises.
Consumed JSON/text/image bodies retain their existing reads, validation and error policies;
HEAD responses have no response body. Avatar/image caching, provider reads, role checks,
proxy retries, attachment refusal and OAuth membership/identity exits keep their original
optional fallback, authorization, retry and required-effect rules. Public Discord sign-in
disposes the successful membership body before proceeding with its status-only decision.
Cancellation and any application callback descendants remain owned through freeze, and
an unresolved cancellation cannot establish a clean drain. This body operation never uses
SDK initiation isolation.

Discord's per-instance `createRuntimeDiscordClient` initiates Client/login and concrete REST
requests outside application ALS because the installed SDK queue/throttler retains unused
internal head promises. The caller still awaits startup, each REST result and actual destroy
inside an admitted scope. REST mutations retain their own required disposition, including an
unknown response swallowed by a feature catch. Feature gateway deliveries and REST response,
debug and rate-limit callbacks enter independent scopes before application listeners run, so
returned or detached callbacks and accepted responses arriving after freeze stay outstanding.
No SDK prototype or queue is patched and no unresolved application promise is removed.
The isolated scope uses an explicit empty ALS store. On Node 22, `exit()` disables the storage
globally and a scoped SDK callback can re-enable the old login owner; an empty store preserves
isolation across that callback reentry while still owning the application callback.
The registered Discord participant destroys this exact client after accepted work finishes.
Its installed REST 2.6.3 client is constructed with `retries: 0` and a rejecting
`rejectOnRateLimit` policy. Network/5xx retries and the separate 429 retry loop are disabled
for every request, including reads and desired-state operations. No per-request shared-option
mutation or implicit desired-state retry remains. The existing REST timeout (normally 15000 ms)
also supplies a whole-request abort signal, combined with any caller signal, covering SDK
queue/bucket waits and response bodies. The adapter awaits actual SDK settlement and accounts
application response callbacks independently; expiry never substitutes a losing promise race
for completion. An already-aborted SDK queue entry can remain owned until its head completes;
its aborted transport cannot dispatch a later create. Unknown effects still require private
verification; these settings provide no long-gap replay permission or nonce guarantee.

Bull's local pause is initialized/awaited outside the application scope before normal scoped
`close()`: its unresolved SDK resume gate is not unfinished work, while disconnect and async
application close callbacks still must complete. Pause errors propagate instead of relying on
Bull close's swallowed pause catch. No queue is resumed, force-closed, or flushed.

S3 uses ordinary signed requests with `expectContinueHeader: false`. Smithy's default large-upload
`100-continue` optimization cancels a losing timer without resolving its promise, retaining an
otherwise completed work scope. Disabling that optimization preserves object bytes, signatures
and the awaited response; a pending upload still blocks drain. No storage operation is exempted
from accounting.

1. Freeze new HTTP, WS/relay, Discord, pub/sub and scheduled producers, preserving dependencies.
2. Finish accepted handlers, ingestion, object processing, moderation, direct persistence,
   Bull consumption and queued/in-flight Discord sends.
3. Inspect all Bull states, stalled IDs, canonical receipts, queued and in-flight Discord sends,
   and required-effect failures. Failed jobs are retained and require explicit operator disposition.
4. Close HTTP and both socket transports. Account for room/bridge/presence writes initiated by
   asynchronous close handlers and inspect accepted queues again.
5. Close each consumer/dependency, accounting for its detached cleanup before closing the next.
   This includes Bull, Discord, Prisma/pg, common Redis, and the blacklist subscriber.
6. Record a final `closed` checkpoint. For an ordinary restart only, clear its exact private
   fence when no operator or other fence exists. Exit zero only after successful closure.

`drained` and `closing` are intermediate states, not permission to take a cold backup. For
cutover require `closed`, `ingressClosed: true`, empty active work/failures, zero pending queue/send inspections,
canonical receipt proofs, and independently verified stopped writer containers. Docker's eventual
forced kill after its stop grace is never clean-drain evidence. Use the retained checkpoint and
actual container state; do not infer success from an empty job array or an exited process.

## Producer inventory

| Surface | Frozen boundary / stop |
| --- | --- |
| REST, admin, uploads, OAuth and both MCP surfaces | Before body/session/auth/rate-limit middleware; all methods and paths are gated. Accepted async handlers and upload callbacks remain accounted for after response/disconnect. |
| `/ws`, `/relay`, bridge/native observations | Upgrade and every incoming frame; accepted setup/frame handlers and asynchronous socket cleanup are accounted for. |
| Redis pub/sub and blacklist refresh | Delivery callback admission; subscriber connections close after accepted work. |
| Discord messages/edits, commands/interactions, reactions, members/boost roles, tickets and voice | One shared client event boundary; fresh interactions receive an ephemeral retry refusal. Accepted handler descendants and every Discord REST mutation remain accounted for. |
| Retention purge, moderation sweep, session cleanup, online snapshots and purge | Registered cron/interval callbacks stop on freeze; in-flight passes finish with stores available. |
| Wiki full/incremental ingestion and CAMP startup/periodic ingestion | Registered startup and scheduled callbacks; detached admin ingestion stays accounted for after HTTP 202. |
| Party reap and invite expiry | Registered startup reconcile/interval; direct party-message persistence errors remain visible to the drain. |
| Giveaways | Draw/reminder/reconcile timers stop; due giveaway rows remain in the database. Draw/publication failures are journaled. |
| Scheduled Discord events | Reconcile timer stops; accepted event/subscriber/deletion projections and failed effects remain accounted for. |
| Supporter and admin-role reconciliation | First-run and recurring timers stop; accepted membership/entitlement work completes or records failure. |
| Temporary voice channels | Sweep/lobby timers stop; accepted Discord operations and ownership-link writes complete or record failure. |
| Presence, WS heartbeat/access checks, local-export expiry and native bridge polling | Producer timers stop. Accepted moderation disconnect delays and socket-close cleanup finish before pools close. |
| Dev/MCP simulated streams and in-memory cooldown/metric maintenance | Registered timers stop and cannot create more messages after freeze. |

Producer timer handles remain native, including `ref`/`unref`. Application teardown and
replacement use `cancelProducerTimer(handle)` to clear future execution and unregister that
timer exactly once. Natural timeout completion also unregisters it. Cancellation does not
release callback work already admitted, including detached promise descendants. Direct native
clears are reserved for ordinary deadlines/consumers, not registered producer handles.
Canceled-before-freeze timers are absent from producer/due evidence; freeze still records
actually live timer/cron schedules before stopping them. Repeated cancellation/freeze does not
duplicate those records. Accepted continuation timers and cron policy retain their existing
contracts. Stopping a timer does
not replay work that becomes due during downtime. Outage reconciliation for giveaways, scheduled
events, wiki/CAMP, roles/boosts, reaction roles, voice and missed Discord messages is a separate
recovery gate; the drain cannot substitute for it.

## Queue and external-effect evidence

Bull retries use one stable acceptance timestamp even if a producer omitted it. `removeOnFail`
is forced false for new acceptance and for legacy jobs when the new worker consumes them.
Waiting, active, delayed, paused, failed and stalled work cannot be treated as a zero queue.
No flush, automatic failure deletion, blind retry, or restoring pending jobs as a shortcut is
provided. A legacy accepted job without a stable timestamp is an explicit recovery error.

Before the worker completes, the ledger verifies one committed canonical row with the expected
timestamp and digest. Its proof survives restart and subsequent authorized edits/deletes; those
operations must not resurrect original chat content. A zero queue with an unproved acknowledged
canonical ID still fails drain. Historical failures already deleted by the legacy image cannot
be reconstructed by this mechanism.

Ordinary Discord relay expectations are established before connection/channel skips. An explicit
mapping selects the sole target; missing/non-text/refused mapped targets cannot fall back to
the default. The default is eligible only without an explicit mapping. Missing destination,
failed lookup, disconnection or failure to enqueue retains required failure evidence and blocks
clean drain. An empty `DISCORD_TOKEN` intentionally disables this integration; explicit
`[TEST-ROUNDTRIP…]`/`TestBot<digits>` synthetic probes remain excluded. These exclusions do not
waive admission freeze. Existing cards, supporter cosmetics, mentions, public responses and
native ACK timing remain unchanged. Ingest/finalize, admin WS, command WS and live-only REST
carry their original generated UUID and timestamp; REST still creates no canonical history row.

`DiscordRelayJournal` durably retains the protected original arguments and exact link prefix
before mapping lookup, then appends immutable intent before attempt, attempt before SDK send,
returned Discord snowflake before local linkage, and completion after link readback. Each write
flushes its file and directory. The operation key depends on the canonical UUID, so changing
timestamp, payload, destination or configuration cannot create a fresh retry identity. An existing
legacy link requires private verification before any new create. A known returned ID with failed
linkage, an unknown result, held callback, interrupted write, missing protected input, orphan,
corrupt/partial/unknown record, or failed cleanup remains fenced. Original failures stay retained.
Ordinary calls cannot resume an incomplete key; identical completed calls make no second create.
Clearing/truncating evidence cannot manufacture a clean inspection in its owning process.

The journal is bounded to 64 MiB and 2048 bytes per record. Each protected input is bounded to
64 KiB, with at most 4096 retained files and 64 MiB total. Exhaustion refuses further work;
there is no automatic journal truncation or rotation. Protected inputs contain only selected
relay arguments/prefix, never OAuth/interaction bearer tokens or SDK request options. Their
contents remain private until verified completion permits durable cleanup. Journal/checkpoint
reports expose safe identifiers, digests and counts; relay rejection and outer logging use fixed
diagnostics. Preserve the whole control directory, including unresolved protected inputs, in
encrypted forward/reverse handoff state. Do not delete it to obtain readiness.

Startup completely parses the bounded journal once. The owning instance then retains an
immutable semantic index and compares every historical byte before each transition, together
with file identity, size, private mode and ownership checks. Unchanged timestamps never bypass
that comparison. Unexpected append, replacement, truncation or same-size prefix edits refuse
further work; a new instance must validate the whole file. Only successful file and directory
syncs advance the cached append/index. A failed append or protected-input cleanup leaves a
sticky unresolved inspection and refuses later relay transitions, including a repeated call
after failed cleanup. This cache creates no additional persistent path or repair capability.

If the initial protected-input write itself fails, no Discord create is attempted and the
failure/restart fence prevents a clean boundary. The existing live-only REST broadcast/HTTP 201
policy is preserved, so its original body may be unavailable after a crash in that failed-write
case. This is unresolved accepted work, never clean/recovered success or an approved loss
exception. An absent payload grants no cold-copy, retry or recovery permission; future repair
must retain that uncertainty or obtain a specific evidence-linked disposition.

The RAM queue remains accounted through send, durable returned-ID recording, linkage and
verification. Private plan/status/apply/verify/disposition commands and known-ID link-only repair
are deferred Task2B2 work; this journal grants no recovery permit, retry, replay or disposition.
Ticket/voice ownership-link failures remain retained under their existing accounting. Whole
Task2B and outage/cutover acceptance remain separate, unaccepted gates.

Inbound Discord edit writes retain the canonical ID, observed Discord message/channel IDs,
and `discord-edit-observed-local-update-unconfirmed` stage on failure. Report/thread binding,
report close/delete, attachment links, ticket issue/thread mapping, and external teardown
failures also retain their known report/issue/thread/object IDs and effect stage. Required
write failures propagate before a success acknowledgement or further destructive teardown.
A created thread/issue or uploaded object is retained for exact inspection/repair; ambiguous
creation failures direct the user to a moderator before submitting again. An unconfirmed
issue delete/close retains its mapping. No automatic duplicate creation is provided.
GitHub issue deletion requires a valid GraphQL mutation payload with the selected nullable
`clientMutationId` field present. Malformed JSON, absent/invalid payloads, partial errors and
unknown transport results remain unconfirmed required operations: ticket confirmation stops
before close fallback, mapping unlink and Discord thread deletion. Only an explicit targeted
GraphQL permission refusal permits the existing close fallback. It cannot erase retained
required-failure evidence. GitHub helper errors use fixed descriptions/statuses, excluding
response bodies and tokens.
The close fallback also requires the returned issue number and `state: "closed"`;
an invalid or missing closure result preserves the mapping/thread and its failure stage.
Required REST mutations also validate endpoint confirmation before resolving: issue/comment
creation requires the expected created status and usable returned identity, added labels need
a valid returned label array containing every requested label, with names compared using Unicode
simple case folding (for example, requested `bug` matches returned `Bug`). Distinct names,
whitespace, accents and Unicode normalization remain significant; malformed label identities
cannot confirm membership. This follows
[GitHub CLI label matching](https://github.com/cli/cli/blob/trunk/api/queries_repo.go).
Milestone updates require
the exact issue and requested set/clear outcome. A successful status with an unchanged or
malformed result cannot acknowledge the requested change. Creation labels remain best effort;
empty add-label requests and optional milestone listing/release mirroring retain their policy.

Authoritative admin role changes retain failed DB updates/deletes, session enumeration/deletion,
role-cache mutation and revocation-audit effects. Transient member-fetch or optional role-cache
reads remain ordinary fallbacks; malformed unrelated session JSON is skipped. Session keys and
contents are not journal evidence. Live supporter refreshes, definitive member removal and
reconcile writes retain trusted account/Discord IDs and entitlement/cache/presentation stages.
Tier/cosmetics invalidation, detached entitlement audits and live identity broadcast failures
remain required effects despite their availability-preserving outer catches. Supporter
enablement, optional lookup/cooldown behavior and expected presentation no-ops are unchanged.

Scheduled-event description-link repair journals external-edit and local generated-link
persistence failures separately. Subscriber transaction, mirror and presentation writes retain
event/mirror IDs and their stages even when the outer reconciliation keeps a fallback count.
A subscriber read that fails before applying state retains the documented read fallback.
These failure journals contain fixed descriptions and trusted identifiers/stages, rather than
SQL errors, message bodies, credentials or user presentation payloads.

Full/targeted admin wiki ingestion remains accounted for after HTTP 202; real rejection
enters the journal with an operation ID, mode and target count. The exact competing Redis
lock-held skip is expected and does not fail drain. CAMP admin sync failures and acknowledged
migration image-backfill query/per-object failures also retain operation IDs and object keys.
Each backfill worker advances past per-row existing-object/allowlist skips and failures;
remaining rows are processed even when the input exceeds worker concurrency. Real failures
still block drain, while expected allowlist skips remain separate.
Existing registration/QA/DEV-persona session persistence remains non-blocking for login, but
a failed background DB write is journaled with user/source evidence and blocks clean drain;
tokens are not included in that evidence. Optional absent lookups, pre-write upload/content
validation refusals and existing read/cache fallbacks remain distinct from required effects.

Required primary mutations use explicit business boundaries. An unknown result is recorded
inside its retained lease before ordinary HTTP error handling or an availability fallback
can finish. Compound callers retain confirmed required stages; a later known refusal or
separate rollback cannot erase earlier commits. Traced no-change contracts can exclude
confirmed false/null/zero/count-zero or empty transaction results. Fulfilled required writes
default to committed progress: DDL/TRUNCATE may change state while returning zero.
Nested compound callers retain completion failures before a caller can catch them.
After a confirmed commit, discovery needed for session revocation, party ownership,
account-name propagation or required publication uses `runRequiredLookup`. A failed
lookup records `required-discovery-unconfirmed` before HTTP or logging error handling
continues. Reads add no committed stages; optional reads, pre-write validation and
confirmed rollbacks keep their existing behavior. This also preserves account-unlink
responses while preventing unfinished cleanup from passing the maintenance gate.
Required publication uses the helper's `required` retention mode across Redis-client
acquisition, including canonical messages whose receipt is owned by the message ledger
without a compound scope. Optional scheduled-event subscriber snapshot reads precede
their inner required reconciliation boundary, so a transient fetch can retain the last
known count; accepted subscriber writes and later projections still retain failures.
Party send/edit member discovery also uses required retention: accepted detached writes
can commit after a discovery failure. History resync, blacklist publication and bridge
rebind keep their required publication contract across sibling runtime scopes.
Native layout/nameplate replies, link-code recovery and HUD receipt replay use
`runRequiredPublicationPrerequisite` after selecting the validated identity and
reply. All five shared local helpers, including link completion, own required
delivery completion for both initiating calls and accepted Redis receivers.
Client acquisition, pairing discovery, cursor allocation and later delivery
failures are retained before the subscription callback's logging catch. The two
existing no-target returns still precede required preparation; other no-target
behavior is unchanged. Cross-instance client acquisition and publication remain
owned by the initiating caller; receivers never republish control messages. This
also covers layout GET, existing link codes and canonical receipt replays with
no new write. Successful preparation adds no synthetic committed stage; nested
required mutations retain their own stages. Validation, rate refusal and optional
reply preparation stay outside this publication boundary.
Operator evidence includes only fixed
business stage descriptions and validated writer hashes, never mutation arguments or SQL.

Transaction ownership is explicit: bind the actual callback client supplied by the awaited
Prisma transaction and pass that client to its required statement/audit boundaries. Async
context nesting alone does not prove SQL ownership. Global-client writes and independently
started transactions may commit during an outer callback and retain their own disposition.
Statements using the bound client become committed progress only after their owning SQL
transaction succeeds. Proven atomic rollback clears its in-transaction statement failures;
unknown COMMIT completion remains unresolved. Lazy Prisma transaction arrays stay lazy and
are accounted for at their awaited owning boundary. Optional cache/telemetry writes are not
converted into required mutations by these helpers.

The ledger and failure journal are intentionally retained without a live rotation command.
Memory/disk usage grows with receipts/failures. Only pending IDs are queried on the worker path,
but confirmed receipts remain indexed for duplicate/conflict evidence. Monitor the control
directory and process memory. Rotation requires a verified closed checkpoint, stopped backend,
independent retained archive of the full control directory and matching storage/version state,
and explicit disposition of every unresolved receipt/failure. Never truncate a live journal or
erase it to make a drain pass. The full application rehearsal must measure this overhead and
the configured drain budget with representative fixtures.

## Controlled destination recovery and acceptance

Create the destination operator marker before container startup. Restore and privately validate
storage while its worker/bot remains frozen and the public connector is stopped. Keep the source
writers and connector stopped and verify there is exactly one prospective authority. Complete
the separate outage/reverse-restore gates before activation.

After retaining/dispositioning the exact control evidence, an operator may remove the identified
maintenance/recovery fences and restart the destination with public ingress still closed.
Run ordinary authenticated private-origin acceptance probes; all existing governance, scopes,
role checks and session rules continue to apply. The runbook owns bounded probe identities,
cleanup, write accounting, rollback transfer and final public-connector authorization. No
unauthenticated maintenance bypass is available.

The legacy Hostinger image at `a6e8df12` has no coordinator. New-code tests do not prove that
process can drain. Its upgrade to a drain-capable image requires the separately rehearsed legacy
promotion/recovery procedure before this mechanism can serve as source-cutover evidence.

## CI evidence

Backend Jest covers admission/restart inheritance, early HTTP response/client-close and upload
uncertainty, detached callback work, both socket transports and close effects, Discord queued/
in-flight and ambiguous failures, every Bull state and canonical proof, local socket ownership,
signal/operator races, bounded failure and close ordering.
`runtimeDiscordDrain.test.js` and `discordRelayCallers.test.js` add ordinary relay routing,
protected live-only REST input, actual WS/REST caller identity, persistence/cleanup refusal,
known/unknown result and freeze regressions. `src/runtime/__tests__/discordRelayJournal.test.ts`
and `discordTransport.test.ts` run through the required recursive TS-unit discovery. The latter
uses actual installed SDK HTTP transport against a loopback fake provider for lost responses,
5xx, 429 success/error alternatives, queue/bucket waits, held headers/body/callbacks and caller
budgets. Focused tests also run with natural process exit; inherited Jest/test-runner force-exit
settings are not drain or resource-lifetime evidence.
`discordRelayJournalCache.test.js` runs in the same required Jest discovery. Accumulated real
records must require constant new semantic parse/hash work; exact prefix mutation with restored
mtime, inode replacement, truncation, permissions, unknown/torn tails, caller mutation and
failed append/sync/cleanup must stay fenced. Local source growth measurements are separate
from the parent-owned frozen production-image probe and full CI acceptance.
`runtimeRelayControlReceivers.test.js` executes the actual whole Redis subscription
adapter, registered control callback and five shared local helpers in source and
compiled form. Synthetic stores and socket sinks exercise successful delivery,
client acquisition failure, applied INCR with a lost response, later delivery
failure, pairing lookup failure, frozen/self-origin suppression and existing
no-target behavior. Failure cases require a retained journal, failed checkpoint
and uncleared restart fence; every received case also checks that no publication
occurs. The suite runs in the existing required backend Jest job.
Migration restore regressions exercise actual HTTP disconnects with held child/PUT effects,
incomplete input, stream errors and unknown child completion. Read-export and embed-asset
regressions hold asynchronous body teardown after disconnect, preserving accounting until close.
An actual compiled frozen backend is started against isolated dummy stores to verify no
import/startup store connection or installer
copy. Shell/child-process tests verify baseline suppression and signals reaching the final Node
PID. Real pg/Redis clients against bounded wire-protocol fixtures reproduce the SDK lifetime
issue and prove awaited SQL/PING still precede store closure. Adversarial tests also exercise
the real Bull pause/close implementation with delayed disconnect and application cleanup,
and the real S3 large-upload handshake with a held response. They also exercise
queue mutation during initial/ingress/consumer inspection, edit/report/ticket failures with
known external IDs, and failure after HTTP 202 or acknowledged session creation. These run in
the existing required `backend-jest` job; TypeScript builds remain covered by
`lint-typecheck`. Live application/Discord outage, storage transfer and rollback rehearsals are
separate prerequisites, not established by these tests.

The real transaction suite requires `FCM_RUNTIME_TRANSACTION_TEST_DATABASE_URL` explicitly.
It never reads the default application database URL or local `.env`. The allowed targets are
loopback/CI `docker` hosts with database `fcm_test` or `fcm_runtime_transaction_test`; tests use
and remove one randomly named fixture table. The required backend CI supplies its synthetic
PostgreSQL service URL. Coverage includes actual atomic rollback, independent commits during
outer rollback, tx-owned audits, parallel ownership isolation, and COMMIT response loss. A
transparent wire proxy confirms that last case through a separate database connection before
dropping the response. Local runs without this explicit fixture skip the real suite.

Writer inventory review uses stable AST owner/callee identities, argument/binding fingerprints
and owning-function/catch fingerprints. Source line shifts are evidence-only changes. Changing
an optional last-used update or cache key into authority state, adding a swallowing catch, or
removing a required owner forces classification review. Inventory rows supplement behavioral
failure/refusal tests; they do not establish a required boundary or production readiness alone.

Managed party, embed and moderation-evidence writes retain their own completion and safe disposition evidence. A confirmed first-attempt object-store permission refusal proves that attempt did not write; a final denial after an earlier retry does not prove whether the earlier PUT committed. Object evidence records a fixed stage, object key and expected SHA-256, never uploaded bytes or SDK error messages. Existing SDK retries are unchanged. Read caches, avatar mirroring and download counters keep their optional fallback behavior. Accepted moderation audits remain required even when their write is definitively refused; this is distinct from an atomic business transaction that intentionally rolls back on a known capacity or constraint refusal.

Canonical room/roster and bridge bindings, room history and publications retain their mutation leases through completion and safe disposition, including accepted work finishing after freeze. Coordination locks, diagnostics, rate-limit counters, optional capability cache and the ordinary best-effort relay cursor remain separate from those accepted writes. Direct message fallback owns its SQL outcome; the existing durable queue retains retry attempts, failed jobs and canonical-row verification before a clean drain.

The durable inventory is [`backend/runtime-writer-classification.json`](../../backend/runtime-writer-classification.json). The required backend Jest job compares the current application and startup/script AST against every row, including SDK/HTTP, SQL, Redis pipeline/receipt, filesystem and callback aliases. It also binds the implementations of shared required-effect, queue, REST, SQL, file-read/upload helpers and the startup shell commands. Adding a writer, changing an optional field/key/SQL command, removing a current owner, changing an intervening catch, or swallowing a required startup failure requires explicit reclassification and behavioral evidence. Position and comment changes alone do not change the AST policy. The ledger is reviewed evidence; passing its comparison does not establish production readiness.

Detection follows imported types, lexical receiver aliases, destructured/bound operations,
nested cosmetic role callers, interaction/message responses and reaction cleanup. Every installed
Discord modal interaction dispatch is explicit too: three voice, one cosmetics, one chat-name
and two ticket `showModal` calls use the bound per-instance REST required funnel. Local modal
builders and local helper calls remain separate from actual SDK dispatches. Every installed
Redis command is a candidate, including read-looking TTL mutations and dynamic sendCommand;
the ledger classifies concrete reads, pipeline construction and rate-limit dispatch explicitly.
Each delegated entry binds the current required owner and caller module. Discord entries also
bind the sole client initializer, accessor and per-instance REST funnel. Semantic changes to an
omitted-at-review cosmetic caller, the funnel or required test runner now fail the repository
policy. The policy still requires review when adding another provider or dispatch mechanism.
Filesystem entries explicitly classify installed fs API candidates, actual disk-storage
configuration/dispatch and release middleware. Their required provenance binds the current
per-instance callback/stream/cleanup disposition and the actual server caller; the server module
hash alone is insufficient. Private claim/marker/checkpoint/journal writers and canonical receipt
files have their own fatal or retained-failure contracts. Concrete filesystem reads, memory-only
multipart buffers and the existing best-effort startup installer-template copies are classified
separately; changing their operation or arguments forces review.

`runtimeSdkCallbacks.test.js` launches the installed discord.js, express-session and connect-redis
modules in an isolated subprocess using only loopback gateway/REST/HTTP and synthetic command
inputs. It covers real ready login, held and successful REST, unknown/retried replies, callback
descendants through freeze and actual close; automatic session SET/EXPIRE and destroy/clear cover
held, successful and unknown results, clear discovery, ordinary pre-write refusal and maintenance
admission. Jest module stubs cannot stand in for those SDK tests. These tests run normally in the
required Node 22 backend CI job.

`runtimeRound8Responses.test.js` uses genuine loopback ClientRequest/IncomingMessage instances,
held redirect/success bodies and held concrete cancellation callbacks for status/encoding/size,
peer abort, rebound failure and total deadlines. The fixture also runs actual compiled source
in the supported image. `runtimeRound8GitHub.test.js` exercises actual JSON parsing, deletion
payload checks and the registered ticket follow-on path; separate native-fetch TLS probes
retain their bounded SDK lifetime observations. `runtimeDrain.test.js` waits for actual
server-side response/socket close, proves accepted middleware remains held before `next()`,
and distinguishes a completed returned callback from concrete terminal asynchronous work.
These suites run normally in required backend Jest CI; passing them does not replace the
fresh whole-spec, complete supported backend gates or cutover prerequisites.

`runtimeRound8NativeFetch.test.js` uses the actual Node 22 native fetch over loopback with
JSON/form bodies, held headers/body reads, abort/error responses and held application/header
preparation work. A held GET body verifies the original read scope. The actual twelve POST
callers, helper dispatch and their source bindings are checked by the durable inventory;
a semantic helper result-suppression mutation fails that policy. Separate native TLS probes
of the actual GitHub service retain both the 120-second RED and corrected bounded outcomes.
`runtimeRound9Responses.test.js` uses actual request/response/socket completion for MCP reads,
including held destruction callbacks. `runtimeRound9GitHubRest.test.js` covers required REST
identities, label and milestone results, optional/noop controls and registered ticket follow-on.
Native TLS probes exercise the actual default REST transport with endpoint-specific statuses.
`runtimeNativeFixtureBinding.test.js` binds the exact native helper to each current coordinator
in both source-effect fixtures, rejects unintended runtime/config singleton loading, and
retains real body reads and detached application callbacks through freeze. The fixtures keep
whole-stdout JSON checks; informational logging is not suppressed to conceal incorrect binding.
`runtimeRound8NativeCallers.test.js` exercises actual Steam/mirror callers with injected
callback descendants and realistic held `Response` bodies, including lookup 404, lookup
refusal and POST/PATCH refusal before further work. Native TLS fixtures cover both callers
using their default transport; no real provider or release is contacted.

The required-effects integration fixture binds the exact native helper's `../runtime`
dependency to its current scenario coordinator through both the normal and VM loaders.
Its guarded getter refuses access before a coordinator exists. Source and compiled native
POST controls verify the actual initializer, completed/held body reads, detached callbacks,
real socket closure and stable final epochs without loading another runtime or environment.
Removing that binding is a failing ownership control even when a result file is present.
The original required-effect, audit, no-change/fallback and privacy assertions remain intact.
Results travel through an explicit artifact in an owned temporary directory; raw ordinary
stdout/stderr stay visible and are never parsed as the result. Nonzero child exit or missing,
malformed, duplicated, unexpected or incomplete scenario artifacts fail required CI. The VM
callback source seam retains the exact frozen TypeScript callbacks when testing compiled
modules; this remains fixture evidence, not complete application acceptance.

`runtimeNativeResponseDisposal.test.js` runs the actual native response branches over owned
loopback transport and checks their status, fallback and retry outcomes. It retains genuine
held 200 image bodies, pending Web cancellation and detached cancellation callbacks through
freeze, and verifies required cancellation-failure retention. The source/compiled function
fixture supplies explicit synthetic non-fetch dependencies; it does not establish complete
application or database acceptance. `runtimeNativeFetchAudit.test.js` binds every actual
global/imported/default-aliased native call and rejects removed cancellation or escaped body
ownership, separately from Discord SDK fetches. Both suites run under the required backend
Jest job. The separate compiled `runtime-native-image-responses.cjs` probe uses real owned TLS
CDN responses and installed signed S3 HEAD/PUT, including finite refusals, canceled unfinished
refusals, valid images and held image reads. Its peer/response facts precede cleanup of any
idle replacement native-pool socket; it makes no claim about a full application shutdown.

`runtimeRound7Callbacks.test.js` executes actual embed helpers, installed static/send and
Multer/diskStorage, the extracted unchanged server upload/frozen-read/validation handlers and
actual private CLI subprocesses. It covers success, held lookup/write/close/unlink/callback work,
deadlines, partial writes, confirmed new-file rollback, real EACCES cleanup, replacement loss,
metadata callbacks pending after input abort, aborted pipeline results, successful output and
confirmed cleanup with a real SDK result held before adapter completion, no-stream HEAD/304
cancellation and durable operator-command failures. Its fixture supports
both CI TypeScript source and the supported image's actual compiled modules; the latter consumes
the exact captured server source through `RUNTIME_FIXTURE_SERVER_SOURCE`. Output records actual
installed package versions and implementation hashes, including Express's own send resolution
and the Multer diskStorage/middleware files. Required CI rejects a Multer version differing from
the lockfile; a stale host installation cannot substitute for installed SDK results. The internal
storage-instance test seam supplies a real per-instance diskStorage callback hold without changing
the production constructor or replacing global SDK/filesystem functions. No real credentials or
stores are used. `runtimeConcurrentShutdown.test.js` covers joins during final inspection,
ingress and consumer close, the original total deadline, signal/operator races and retained
marker/journal/checkpoint failure. These run in the required backend Jest job; current revision
acceptance also requires fresh supported-image and whole-spec/quality review evidence.

The required `npm run test:unit` runner uses structured Node test events for failure status.
Failed/cancelled tests, a child exiting before its terminal summary, missing final summary or an
empty discovery return nonzero. Completed test-only handles still use bounded child cleanup.
`runtimeTestRunnerGate.test.js` verifies actual runner subprocess failure, cancellation,
premature child exit and successful open-timer fixtures; the runner is also a shared CI source proof.

Owner-submitted arbitrary migration SQL has a required outcome boundary because that surface accepts schema and data mutations. Session callbacks and authenticated bridge connection/state writes retain their own completion after disconnect or freeze. Typed GitHub ticket mutation exports retain request and response interpretation; their pre-request configuration/input refusals preserve the existing behavior. The documented GitHub release mirror remains best effort.

Standalone script scope is explicit: required compatibility patches are awaited under the live startup owner, while the separate CLI propagates failure to a nonzero exit under the pre-baseline fence and fatal shell execution. Migration-history reconciliation remains documented nonfatal bookkeeping after authoritative schema synchronization. Wiki image backfill remains a resumable source-image cache; canonical alias regeneration and wiki/CAMP ingestion retain required mutation owners. These scripts are not outage, data-transfer or missed-event recovery acceptance.
