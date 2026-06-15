-- Per-install ECDSA P-256 public keys for request signing (device keypair auth).
-- Idempotent (baseline-migrations.sh re-runs after db push).
CREATE TABLE IF NOT EXISTS "devices" (
  "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
  "install_token" TEXT NOT NULL,
  "public_key"    TEXT NOT NULL,
  "enrolled_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "last_seen_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "revoked_at"    TIMESTAMPTZ(6),
  CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "devices_install_token_key" ON "devices" ("install_token");
CREATE INDEX IF NOT EXISTS "devices_revoked_at_idx" ON "devices" ("revoked_at");
