# Production Secret Rotation + Git History Scrub Runbook

> **NEVER commit real secret values into this file.** The `replacements.txt` built in Phase 5
> holds the real leaked password — keep it only on the local machine and `shred -u` it after.

Rotates the leaked production Postgres password with a consistent backup and minimal
downtime, then scrubs the leaked values from git history. Reviewed adversarially (correctness,
Dokploy docs, PostgreSQL/TimescaleDB); all known blockers folded in.

## Ownership / who runs what

| Role | Pane / actor | Owns |
| ---- | ------------ | ---- |
| **Server agent** | tmux `%5` (`Claude Code · Server`), using **Sonnet sub-agents** | All **VPS/DB** work: Phases 0–3 (backup, `ALTER USER`, write `.env` on disk, recreate backend, verify) |
| **Orchestrator** | tmux `%2` (`Fallout Chat Mod`) — **this agent** | Sends `GO-EXECUTE` with exact commands; runs **Phase 4 + Phase 5 git-history force-push locally**; Phase 6 |
| **Operator (you)** | Windows host | Approvals, the Phase 5 decision gate, GitHub Support ticket |

Comms: Server agent replies with `tmux send-keys -t %2 'AGENT_SIGNAL::SERVER::<msg>' Enter`.
**Nothing runs on prod until the orchestrator sends a message starting `GO-EXECUTE`.**

## Exposure scan result (verified)

| Secret | In git history? | Action |
| ------ | --------------- | ------ |
| Prod Postgres DSN — password + host `<PROD_HOST>:<PORT>` (`backend/prisma/.env.example` @ `d84824e`, `e27e14e`) | **YES** | Rotate (Phase 2) + scrub (Phase 5) |
| MinIO defaults `<MINIO_DEFAULT_USER>` / `<MINIO_DEFAULT_SECRET>` (@ `17f8727`) | YES (now only guard strings) | Scrub optional; rotate if ever deployed |
| Dev creds `<DEV_MINIO_PASS>` / `<DEV_REDIS_PASS>` (root `.env.example` @ `e361297d`) | YES — still in working tree | Phase 4 fix + scrub |
| **Discord bot token / webhooks** | **NO** (only empty `=` assignments) | None — verified clean |
| **Cloudflare tunnel token** | **NO** (only a docs reference to `~/.config/fcm/cf.env`) | None — verified clean |

Branches containing `d84824e` to rewrite: `prod`, `dev`, `ci/windows-build-and-e2e`.

---

## Quick checklist

### Phase 0 — Pre-flight (Server agent)
- [ ] Prerequisites confirmed (see below)
- [ ] Dokploy auto-deploy disabled (prevents a concurrent push triggering a full redeploy)
- [ ] `<appName>` / compose project resolved via the Docker label (not name-parsing)
- [ ] Compose dir + `.env` path located and confirmed
- [ ] `OLD_PW` captured from running container (non-empty)
- [ ] `NEW_PW` generated and recorded securely
- [ ] `pg_hba.conf` audited (know whether loopback is `trust`)
- [ ] Maintenance notice posted; downtime window communicated

### Phase 1 — Backup (Server agent — downtime begins)
- [ ] Connections drained, backend stopped
- [ ] Logical dump created, verified (`--list` + size vs `pg_database_size`)
- [ ] Globals dump created and non-empty
- [ ] Cold volume tar (graceful stop, `sudo`, `--numeric-owner`)
- [ ] Postgres healthy again

### Phase 2 — Rotate (Server agent)
- [ ] `ALTER USER` done; SCRAM hash confirmed
- [ ] `.env` on disk manually rewritten with `NEW_PW` (UI save alone does NOT apply)
- [ ] Standby app env updated if deployed
- [ ] Backend recreated and healthy

### Phase 3 — Verify (Server agent — STOP & roll back if any fail)
- [ ] `/api/health` 200
- [ ] Real login flow works
- [ ] Old password reliably rejected (via host port, not trusted loopback)
- [ ] Logs clean; Dokploy auto-deploy re-enabled
- [ ] **Server agent signals `AGENT_SIGNAL::SERVER::PHASE3_GREEN` to `%2`**

### Phase 4 — Working-tree creds (Orchestrator, local)
- [ ] Root `.env.example` dev placeholders replaced, committed, pushed to `prod`
- [ ] Dokploy deployed cleanly

### Phase 5 — Git history scrub (Orchestrator, local — POINT OF NO RETURN at force-push)
- [ ] Phase 4 commit confirmed on origin
- [ ] Safety mirror + working clone created
- [ ] `replacements.txt` filled with REAL values
- [ ] Rewrite run; secret confirmed absent from all branches
- [ ] **DECISION GATE — operator approves force-push**
- [ ] All branches + tags force-pushed; verified clean

### Phase 6 — Post-rewrite (Orchestrator + operator)
- [ ] Collaborators told to re-clone; local branches rescued
- [ ] GitHub deploy keys rotated; Support ticket filed; repo kept PRIVATE until purge
- [ ] Dokploy manual Redeploy to resync git SHA
- [ ] Secrets shredded; mirror retained 30 days then deleted
- [ ] Success criteria met (below)

---

## Prerequisites

- **VPS (Server agent):** `docker`, `sudo`, `openssl`, `shred` (`which shred` — else use `rm -P`/`wipe`), `psql` client on host or via `docker exec`, SSH access, **Dokploy admin**.
- **Local (Orchestrator):** `git`, `git-filter-repo` (`pip3 install git-filter-repo` — confirm `pip3` exists), GitHub **repo admin** (force-push rights).
- Stack: `timescale/timescaledb:latest-pg15`, user `fo76_user`, db `fo76_chat`, volume `postgres_data`, deployed via Dokploy behind Cloudflare Tunnel.

---

## Phase 0 — Pre-flight (Server agent)

```bash
# 1. Dokploy UI: disable auto-deploy for this app (stops a concurrent git push from
#    triggering a full redeploy mid-rotation). NOTE: this does NOT govern container
#    restart — `restart: unless-stopped` already means `docker compose stop` stays stopped.

# 2. Resolve the compose project name from the Docker label (authoritative; do NOT parse names)
PROJ=$(docker inspect $(docker ps -q --filter "name=postgres") \
  --format '{{index .Config.Labels "com.docker.compose.project"}}' | head -1)
PGCONT=$(docker ps --format '{{.Names}}' | grep -m1 "${PROJ}.*postgres")
echo "project=$PROJ  postgres=$PGCONT"

# 3. Locate the compose dir + .env (Dokploy writes .env only at deploy time; verify path —
#    known bug puts it in the parent dir for raw-mode apps)
COMPOSE_DIR=$(docker inspect $PGCONT \
  --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')
echo "compose dir=$COMPOSE_DIR"; ls -la "$COMPOSE_DIR"/.env "$COMPOSE_DIR"/../.env 2>/dev/null

# 4. Capture current password from the RUNNING container (not your shell)
OLD_PW=$(docker exec $PGCONT printenv POSTGRES_PASSWORD); echo "OLD_PW len: ${#OLD_PW}"

# 5. Generate new password (extra entropy so the alnum filter still yields 40 chars)
NEW_PW=$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 40); echo "$NEW_PW"

# 6. Audit pg_hba — decides whether the Phase 3 negative test is meaningful
docker exec $PGCONT sh -c 'cat "$PGDATA"/pg_hba.conf' | grep -E '^host|^local'
#    If 127.0.0.1 is `trust`, the in-container old-pw test is worthless — use the host port test.
```

## Phase 1 — Consistent backup (Server agent — downtime begins)

```bash
# NO HOST ROOT/SUDO required. The operator has Docker access but not sudo. Every root-needing file
# op is routed through an ephemeral container (root inside the container). Backups land in
# $HOME/fcm-backups (BK), not /root.
BK=$HOME/fcm-backups; mkdir -p "$BK"

# 7. Drain connections, then stop backend
docker exec $PGCONT psql -U fo76_user fo76_chat -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname='fo76_chat' AND pid<>pg_backend_pid();"
docker compose -p "$PROJ" stop backend     # confirm in Dokploy it does NOT auto-restart

# 8. Logical dump (password from container env), then verify TOC + size
docker exec -e PGPASSWORD="$OLD_PW" $PGCONT \
  pg_dump -U fo76_user -d fo76_chat --format=custom --compress=9 --no-owner --no-acl \
  > "$BK/fo76_backup_$(date +%Y%m%d_%H%M%S).dump"
DUMP=$(ls -t "$BK"/fo76_backup_*.dump | head -1)
docker run --rm -v "$BK":/bk postgres:15 pg_restore --list "/bk/$(basename "$DUMP")" | head -30
ls -lh "$DUMP"
docker exec $PGCONT psql -U fo76_user -tAc \
  "SELECT pg_size_pretty(pg_database_size('fo76_chat'));"   # sanity-compare

# 9. Globals (superuser via local trust socket); fail loudly if empty.
#    NOTE: the superuser here is fo76_user (POSTGRES_USER), NOT postgres — there is no `postgres` role.
docker exec $PGCONT pg_dumpall -U fo76_user --globals-only > "$BK/globals_$(date +%Y%m%d).sql"
[ -s "$BK"/globals_*.sql ] && echo "globals OK" || { echo "GLOBALS EMPTY — abort"; }

# 10. Cold volume tar = PRIMARY backup. No host sudo: tar from a container mounting the volume.
docker compose -p "$PROJ" stop --timeout 60 postgres
docker run --rm -v ${PROJ}_postgres_data:/data:ro -v "$BK":/bk alpine sh -c \
  "test ! -f /data/postmaster.pid && echo 'clean shutdown' || echo 'WARN: dirty shutdown'; \
   tar -czf /bk/postgres_data_$(date +%Y%m%d_%H%M%S).tar.gz --numeric-owner -C /data ."
docker compose -p "$PROJ" start postgres
until docker inspect --format='{{.State.Health.Status}}' $PGCONT | grep -q healthy; do sleep 2; done
```

> Why cold tar is primary: a plain `pg_restore` of a TimescaleDB logical dump mangles hypertable
> chunks without `timescaledb_pre_restore()`. The physical tar restores cleanly. The dump is the
> secondary, finer-grained option.

## Phase 2 — Rotate (Server agent)

```bash
# 11. Change the password IN the database (backend down -> no live pool)
docker exec -i $PGCONT psql -U fo76_user fo76_chat -c "ALTER USER fo76_user PASSWORD '$NEW_PW';"
# confirm SCRAM (PG15 default), not md5:
docker exec $PGCONT psql -U fo76_user -tAc \
  "SELECT left(passwd,13) FROM pg_shadow WHERE usename='fo76_user';"   # expect SCRAM-SHA-256

# 12a. OPERATOR (you) — update the Dokploy ENV STORE (UI/API) for DB_PASSWORD + DATABASE_URL.
#      REQUIRED for persistence: Dokploy regenerates .env from its store on EVERY redeploy, so if the
#      store still holds the old value the backend breaks on the next deploy. POSTGRES_PASSWORD is
#      derived from DB_PASSWORD via compose interpolation and is HARMLESS if stale — it is IGNORED on
#      an already-initialized volume; the live password is whatever ALTER USER set in step 11.
# 12b. Server agent — write the on-disk .env so the immediate recreate uses NEW_PW (UI save alone does
#      NOT rewrite the on-disk .env). sudo is available; container-route also works and preserves
#      root:root ownership either way:
sudo sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=${NEW_PW}|" "$COMPOSE_DIR/.env"
sudo sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://fo76_user:${NEW_PW}@postgres:5432/fo76_chat|" "$COMPOSE_DIR/.env"
grep -E '^DB_PASSWORD|^DATABASE_URL' "$COMPOSE_DIR/.env"   # verify

# 13. No standby deployed (confirmed in recon). If one ever is, repeat 12a/12b for its app + .env.
docker ps | grep -i standby || echo "no standby deployed"

# 14. Recreate backend only (postgres untouched; avoids a Dokploy git pull)
docker compose -p "$PROJ" up -d --no-deps --force-recreate backend
until docker inspect --format='{{.State.Health.Status}}' ${PROJ}*backend* 2>/dev/null \
  | grep -q healthy; do sleep 3; done
```

## Phase 3 — Verify (Server agent)

```bash
# 15. health
curl -sf https://falloutchatmod.com/api/health && echo OK
# 16. Auth is Discord-OAuth — there is NO username/password login endpoint (/api/auth/login = 404).
#     Verify the DB path instead: /api/health must report database:connected (+ redis/discord), and
#     confirm a live DB-backed read works (e.g. WS users connected / a real authenticated fetch).
curl -sf https://falloutchatmod.com/api/health | grep -o 'database":"[a-z]*"'   # expect connected
# 17. Old password reliably rejected. NOTE (confirmed on this stack): loopback is TRUST and NO host
#     port is published for 5432, so an in-container 127.0.0.1 test is meaningless. Test from a
#     SEPARATE container over the project's default network — a non-loopback source IP hits the
#     `host all all all scram-sha-256` rule and enforces the password:
DEFNET="${PROJ}_default"
docker run --rm --network "$DEFNET" postgres:15 \
  sh -c "PGPASSWORD='$OLD_PW' psql -h postgres -U fo76_user -d fo76_chat -c 'SELECT 1;'" 2>&1
#     expect: FATAL: password authentication failed for user "fo76_user"
docker run --rm --network "$DEFNET" postgres:15 \
  sh -c "PGPASSWORD='$NEW_PW' psql -h postgres -U fo76_user -d fo76_chat -c 'SELECT 1;'" 2>&1
#     expect: a 1-row result (new password works)
# 18. logs clean
docker logs --since 3m ${PROJ}*backend* 2>&1 | grep -iE "error|fatal|ECONNREFUSED"
# 19. Re-enable Dokploy auto-deploy.
# 20. SIGNAL the orchestrator:  tmux send-keys -t %2 'AGENT_SIGNAL::SERVER::PHASE3_GREEN' Enter
```

**If any check fails → Rollback (below). Do not proceed to Phase 4/5.**

---

## Phase 4 — Fix live working-tree creds (Orchestrator, local)

```bash
# 21. replace dev placeholders in root .env.example with obvious non-functional values
#     (the dev MinIO/Redis defaults -> change-me-strong-password)
git add .env.example
git commit -m "chore(security): replace dev placeholder creds in root .env.example"
git push origin prod
# confirm Dokploy deploys cleanly (env already set; this just ships code)
```

## Phase 5 — Git history scrub (Orchestrator, local — force-push)

```bash
# 22. CONFIRM the Phase 4 commit is on origin BEFORE mirroring (else the rewrite drops it)
git fetch origin && git log origin/prod --oneline | grep -q "replace dev placeholder" \
  && echo "Phase4 present" || { echo "Phase4 MISSING — push it first"; }

# 23. safety mirror (NEVER push from this) + working clone
git clone --mirror https://github.com/UNN-Devotek/FCM-Fallout-Chat-Mod.git $HOME/fcm-history-backup.git
git clone $HOME/fcm-history-backup.git $HOME/fcm-filter-work.git

# 24. replacements file — FILL IN the real leaked password. `literal:` prefix is REQUIRED.
cat > $HOME/replacements.txt <<'EOF'
literal:<REAL_LEAKED_DB_PASSWORD>==>REDACTED_DB_PASSWORD
literal:<PROD_HOST_IP>==>REDACTED_HOST
literal:<MINIO_DEFAULT_SECRET>==>REDACTED
literal:<DEV_MINIO_PASS>==>REDACTED
literal:<DEV_REDIS_PASS>==>REDACTED
EOF
#    ^ replace <REAL_LEAKED_DB_PASSWORD> with the actual value — do NOT push the literal placeholder.

# 25. rewrite (filter-repo refuses to run while a remote exists)
cd $HOME/fcm-filter-work.git
git remote remove origin
pip3 install git-filter-repo
git filter-repo --replace-text $HOME/replacements.txt

# 26. confirm the secret is gone everywhere
git log --all -p | grep -F "<REAL_LEAKED_DB_PASSWORD>" && echo "STILL PRESENT — ABORT" || echo clean
git log --all -p | grep "67\.222" && echo "STILL PRESENT — ABORT" || echo clean

# ===== DECISION GATE — operator must approve before the next command. POINT OF NO RETURN. =====
# Confirm: (a) $HOME/fcm-history-backup.git intact, (b) Phase 4 commit in rewritten history,
# (c) all collaborators warned. Only then:

# 27. force-push all branches AND tags
git remote add origin https://github.com/UNN-Devotek/FCM-Fallout-Chat-Mod.git
git push --force --all
git push --force --tags

# 28. verify each branch is clean
git fetch origin
for b in prod dev ci/windows-build-and-e2e; do
  git log --oneline origin/$b 2>/dev/null | grep -q d84824e \
    && echo "STILL PRESENT in $b — ABORT" || echo "$b clean"
done
```

## Phase 6 — Post-rewrite cleanup

```bash
# 29. Tell every collaborator to re-clone (old SHAs are gone). Then rescue any unpushed
#     local branch from an old checkout:
git format-patch origin/prod..feat/implementation-gap-review -o /tmp/gap-patches/  # in OLD clone
#   in a FRESH clone:  git checkout -b feat/implementation-gap-review && git am /tmp/gap-patches/*.patch

# 30. Rotate GitHub deploy keys (Settings > Deploy keys) / any PATs.
# 31. Open a GitHub Support request to purge cached commit objects for the old SHAs.
#     KEEP THE REPO PRIVATE until GitHub confirms purge (can take weeks).
# 32. Dokploy UI: manual Redeploy (fresh git clone) to resync its deployed SHA.
# 33. Securely delete plaintext secrets — TWO machines:
#   (a) ON THE VPS (Server agent) — the dumps/globals/tar live in $HOME/fcm-backups:
#       shred -u $HOME/fcm-backups/fo76_backup_*.dump $HOME/fcm-backups/globals_*.sql 2>/dev/null \
#         || rm -f $HOME/fcm-backups/fo76_backup_*.dump $HOME/fcm-backups/globals_*.sql
#       # tar is root-owned (written by container); remove via container or sudo. Keep ~30 days first.
#       # ALSO shred the OLD-password rollback file (root-owned) once rollback is no longer needed:
#       sudo shred -u /etc/dokploy/compose/<backend-compose-dir>/code/.env.rotbak_*
#   (b) LOCALLY (Orchestrator) — the scrub artifacts:
shred -u $HOME/replacements.txt 2>/dev/null || rm -P $HOME/replacements.txt
rm -rf $HOME/fcm-filter-work.git
# keep $HOME/fcm-history-backup.git ~30 days, then delete.
```

---

## Rollback

**Phase 2/3 failure (before force-push):**
```bash
docker exec -i $PGCONT psql -U fo76_user fo76_chat -c "ALTER USER fo76_user PASSWORD '$OLD_PW';"
sudo sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=${OLD_PW}|" "$COMPOSE_DIR/.env"
sudo sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://fo76_user:${OLD_PW}@postgres:5432/fo76_chat|" "$COMPOSE_DIR/.env"
docker compose -p "$PROJ" up -d --no-deps --force-recreate backend
# data corruption: restore cold tar (sudo tar -xzf ... --numeric-owner -C "$MOUNT"), or the dump via
# the timescaledb image: CREATE EXTENSION timescaledb; timescaledb_pre_restore(); pg_restore
#   --no-owner --no-acl --single-transaction (NO --jobs); timescaledb_post_restore();
```

**Phase 5 partial force-push (some branches pushed, some not):** restore ALL branches at once from
the untouched mirror:
```bash
cd $HOME/fcm-history-backup.git && git push --force --all && git push --force --tags
```

## Success criteria

- `/api/health` 200 and a real login works; no auth errors in backend logs for 30 min.
- Old password rejected via an auth-enforcing path; new password works.
- `git log --all -p | grep` for each leaked value returns nothing on origin.
- Dokploy redeploy from rewritten history succeeds; repo kept private until GitHub purge confirmed.
- Plaintext backups shredded; safety mirror retained for 30 days.
