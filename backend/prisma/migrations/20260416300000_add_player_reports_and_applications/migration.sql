-- Player reports (submitted via /report in-game)
CREATE TABLE IF NOT EXISTS "player_reports" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID         NOT NULL,
  "content"    TEXT         NOT NULL,
  "status"     TEXT         NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT "player_reports_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_reports_user_id_fkey') THEN
    ALTER TABLE "player_reports"
      ADD CONSTRAINT "player_reports_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "player_reports_status_created_at_idx"
  ON "player_reports"("status", "created_at" DESC);

-- Staff applications (submitted via public /apply page)
CREATE TABLE IF NOT EXISTS "staff_applications" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "in_game_name" TEXT         NOT NULL,
  "discord_tag"  TEXT         NOT NULL,
  "age"          TEXT         NOT NULL,
  "timezone"     TEXT         NOT NULL,
  "experience"   TEXT         NOT NULL,
  "motivation"   TEXT         NOT NULL,
  "availability" TEXT         NOT NULL,
  "status"       TEXT         NOT NULL DEFAULT 'pending',
  "admin_notes"  TEXT,
  "created_at"   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT "staff_applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "staff_applications_status_created_at_idx"
  ON "staff_applications"("status", "created_at" DESC);
