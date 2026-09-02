-- The normal chat policy allows ordinary cussing and only blocks these words
-- when the message is explicitly targeted. Remove only the exact legacy literal
-- catalog rows requested for this rollout; regex rules and other admin-authored
-- entries remain untouched. The marker prevents the post-push compatibility
-- patch from deleting a moderator's deliberate future override on every boot.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "moderation_settings"
     WHERE "key" = 'chat_profanity_literal_cleanup_v1'
  ) THEN
    DELETE FROM "word_filter"
     WHERE NOT "is_regex"
       AND lower("phrase") IN ('fuck', 'shit', 'bastard', 'assh');

    INSERT INTO "moderation_settings" ("key", "value", "updated_at")
    VALUES ('chat_profanity_literal_cleanup_v1', 'applied', NOW())
    ON CONFLICT ("key") DO NOTHING;
  END IF;
END $$;
