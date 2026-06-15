-- MCP API Keys table — idempotent (IF NOT EXISTS + DO $$ constraint guard).
-- Stores SHA-256 hashes of personal access tokens for the MCP server auth model.
-- Plaintext tokens are never stored. env column enforces dev/prod firewall.

CREATE TABLE IF NOT EXISTS mcp_api_keys (
  id          TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  key_hash    TEXT        NOT NULL,
  label       TEXT,
  owner_id    TEXT        NOT NULL,
  env         TEXT        NOT NULL CHECK (env IN ('dev', 'prod')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,

  CONSTRAINT mcp_api_keys_pkey PRIMARY KEY (id),
  CONSTRAINT mcp_api_keys_key_hash_key UNIQUE (key_hash)
);

CREATE INDEX IF NOT EXISTS mcp_api_keys_owner_id_idx ON mcp_api_keys (owner_id);
CREATE INDEX IF NOT EXISTS mcp_api_keys_key_hash_idx ON mcp_api_keys (key_hash);
