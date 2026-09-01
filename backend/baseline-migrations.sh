#!/bin/sh
# Sync database schema on startup, then the CMD runs `node dist/server.js`.
#
# `prisma db push` is AUTHORITATIVE for the schema (it diffs schema.prisma
# against the live DB and applies the difference), so it alone guarantees the
# tables/columns the app needs exist. A schema-sync failure is fatal: the app
# must never boot against an unknown or partially-updated schema.
#
# NOTE: an earlier version invoked the prisma CLI ~2x per migration
# (`resolve --rolled-back` then `--applied` for every migration). With ~48
# migrations that's ~96 cold-start CLI calls (~150s), which pushed startup past
# the container healthcheck window — the orchestrator killed and restarted the
# container before `node` ever ran, an endless restart loop.
#
# A later version used `prisma migrate deploy`, but because db push already
# created every object, deploy tried to RE-APPLY them, failed with 42P07, and
# recorded a failed row -> P3009 ("failed migrations") noise on every boot.
#
# This version RECONCILES instead of applying: it records only the pending /
# previously-failed migrations as applied (history bookkeeping, no schema change,
# no re-run). Steady state = 0 pending, so it is a no-op on normal boots and
# never reintroduces the slow loop above. See src/scripts/reconcileMigrations.ts.

set -eu

echo "=== prisma db push (authoritative schema sync) ==="
if ! npx prisma db push --skip-generate; then
  echo "FATAL: prisma db push failed; refusing to boot" >&2
  exit 1
fi

echo "=== apply post-push compatibility patches (required) ==="
node dist/scripts/applyPostPushPatches.js

echo "=== reconcile migration history (record pending as applied; non-fatal) ==="
node dist/scripts/reconcileMigrations.js || true

echo "=== Database ready ==="
