-- Multi-endpoint same-server matching (v1.0.35)
-- FO76 caches multiple IP:port strings in memory (regional ingress + world
-- server). Different clients on the same world see different subsets. We now
-- persist every candidate the memory scanner found so the backend can match
-- users via endpoint set-intersection instead of string equality.
--
-- Idempotent per CLAUDE.md rule: baseline-migrations.sh runs `prisma db push`
-- before `migrate deploy`, so this DDL must tolerate a pre-existing column.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "alternate_endpoints" TEXT[] NOT NULL DEFAULT '{}';
