-- banned_identities: provider-level deny-list (#297)
-- Checked at OAuth callback and device-code redemption
-- A banned provider identity cannot link to ANY FCM account, even fresh ones
CREATE TABLE IF NOT EXISTS banned_identities (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT        NOT NULL,
  provider_uid TEXT        NOT NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'banned_identities_provider_provider_uid_key') THEN
    ALTER TABLE banned_identities ADD CONSTRAINT banned_identities_provider_provider_uid_key UNIQUE (provider, provider_uid);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS banned_identities_provider_uid_idx ON banned_identities (provider, provider_uid);
