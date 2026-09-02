-- Relax the default flagged-words seed so untouched installs stop depending on
-- the PROFANITY preset for ordinary chat profanity.
-- Only update the stock rule when its metadata still matches the old seed
-- exactly; customized admin rules are left alone.
UPDATE "automod_rules"
SET "trigger_metadata" = '{"presets": ["SEXUAL_CONTENT", "SLURS"]}'::jsonb
WHERE "id" = 'a0000000-0000-0000-0000-000000000002'
  AND "trigger_type" = 'KEYWORD_PRESET'
  AND COALESCE("trigger_metadata", '{}'::jsonb) = '{"presets": ["PROFANITY", "SEXUAL_CONTENT", "SLURS"], "allow_list": ["ass", "damn", "fuck", "hell", "shit"]}'::jsonb;
