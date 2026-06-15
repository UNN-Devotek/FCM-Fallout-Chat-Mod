-- Add optional structured metadata to chat messages (e.g. party_invite embed). Idempotent.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
