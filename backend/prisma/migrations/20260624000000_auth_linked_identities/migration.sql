-- linked_identities: per-user provider links (non-Discord providers)
-- Discord identity stays inline on users (it's load-bearing for session auth)
CREATE TABLE IF NOT EXISTS linked_identities (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT        NOT NULL,
  provider_uid  TEXT        NOT NULL,
  username      TEXT,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified TIMESTAMPTZ
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linked_identities_provider_provider_uid_key') THEN
    ALTER TABLE linked_identities ADD CONSTRAINT linked_identities_provider_provider_uid_key UNIQUE (provider, provider_uid);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'linked_identities_user_id_provider_key') THEN
    ALTER TABLE linked_identities ADD CONSTRAINT linked_identities_user_id_provider_key UNIQUE (user_id, provider);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS linked_identities_user_id_idx ON linked_identities (user_id);
