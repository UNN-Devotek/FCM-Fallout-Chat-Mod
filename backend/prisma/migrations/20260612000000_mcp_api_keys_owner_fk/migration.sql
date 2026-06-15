-- M-3: Add FK from mcp_api_keys.owner_id → users.id with ON DELETE CASCADE.
-- Idempotent: column-type alter guards against double-run via check on data_type,
-- and ADD CONSTRAINT IF NOT EXISTS prevents duplicate constraint errors.
-- owner_id was TEXT but stores users.id (UUID) values — cast the column to UUID first.

DO $$
BEGIN
  -- Step 1: alter column type TEXT → UUID (safe: all existing values are valid UUIDs)
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'mcp_api_keys' AND column_name = 'owner_id') = 'text' THEN
    ALTER TABLE mcp_api_keys ALTER COLUMN owner_id TYPE UUID USING owner_id::uuid;
  END IF;

  -- Step 2: add FK constraint if it does not already exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'mcp_api_keys_owner_id_fkey'
      AND table_name = 'mcp_api_keys'
  ) THEN
    ALTER TABLE mcp_api_keys
      ADD CONSTRAINT mcp_api_keys_owner_id_fkey
      FOREIGN KEY (owner_id)
      REFERENCES users(id)
      ON DELETE CASCADE;
  END IF;
END $$;
