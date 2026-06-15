-- v1.3.33: the "[Server Count]" token now always resolves to 0 (automatic
-- world detection was retired in v1.3.30). Strip the ", player count
-- [Server Count]/24" suffix from every event announce response so they no
-- longer print a meaningless "0/24". Idempotent: REPLACE is a no-op once the
-- pattern is gone.
UPDATE chat_commands
SET response = REPLACE(response, ', player count [Server Count]/24.', '.')
WHERE action_type = 'announce'
  AND response LIKE '%player count [Server Count]/24%';
