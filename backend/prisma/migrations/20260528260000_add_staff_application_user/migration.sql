-- Add nullable user_id to staff_applications so a logged-in user can review their
-- own application from the dashboard self-service view. Idempotent per CLAUDE.md.

ALTER TABLE "staff_applications" ADD COLUMN IF NOT EXISTS "user_id" UUID;

CREATE INDEX IF NOT EXISTS "staff_applications_user_id_created_at_idx"
  ON "staff_applications" ("user_id", "created_at" DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_applications_user_id_fkey') THEN
    ALTER TABLE "staff_applications"
      ADD CONSTRAINT "staff_applications_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
