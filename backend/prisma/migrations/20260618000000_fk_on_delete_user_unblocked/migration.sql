-- Fix FK onDelete policies that blocked user deletion.
-- Idempotent (DO $$ ... END $$ guards) — safe under baseline-migrations.sh.
--
-- Changes:
--   messages.user_id          Restrict → Cascade  (admin deleteUser already deleted them manually; now DB handles it)
--   party_messages.user_id    Restrict → Cascade  (was missing from manual cleanup; Cascade closes the gap)
--   bans.banned_by_id         Restrict → SetNull  (mod who issued a ban may be deleted; audit row must survive)
--   bans.banned_by_id         NOT NULL → NULL      (required for SetNull)
--   parties.owner_id          Restrict → Cascade  (deleting a user deletes their owned parties, cascading to members/invites/messages)

DO $$
BEGIN
  -- messages.user_id: Restrict → Cascade
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'messages_user_id_fkey'
      AND table_name = 'messages'
  ) THEN
    ALTER TABLE messages DROP CONSTRAINT messages_user_id_fkey;
  END IF;
  ALTER TABLE messages
    ADD CONSTRAINT messages_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE;

  -- party_messages.user_id: Restrict → Cascade
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'party_messages_user_id_fkey'
      AND table_name = 'party_messages'
  ) THEN
    ALTER TABLE party_messages DROP CONSTRAINT party_messages_user_id_fkey;
  END IF;
  ALTER TABLE party_messages
    ADD CONSTRAINT party_messages_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE;

  -- bans.banned_by_id: Restrict → SetNull, allow NULL
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'bans_banned_by_id_fkey'
      AND table_name = 'bans'
  ) THEN
    ALTER TABLE bans DROP CONSTRAINT bans_banned_by_id_fkey;
  END IF;
  ALTER TABLE bans ALTER COLUMN banned_by_id DROP NOT NULL;
  ALTER TABLE bans
    ADD CONSTRAINT bans_banned_by_id_fkey
    FOREIGN KEY (banned_by_id)
    REFERENCES users(id)
    ON DELETE SET NULL;

  -- parties.owner_id: Restrict → Cascade
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'parties_owner_id_fkey'
      AND table_name = 'parties'
  ) THEN
    ALTER TABLE parties DROP CONSTRAINT parties_owner_id_fkey;
  END IF;
  ALTER TABLE parties
    ADD CONSTRAINT parties_owner_id_fkey
    FOREIGN KEY (owner_id)
    REFERENCES users(id)
    ON DELETE CASCADE;
END $$;
