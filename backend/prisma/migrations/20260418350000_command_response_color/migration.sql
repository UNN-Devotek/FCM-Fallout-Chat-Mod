-- Add configurable response text color to chat commands
ALTER TABLE chat_commands ADD COLUMN IF NOT EXISTS response_color VARCHAR(20);

-- Events default to 'channel' (render in the channel tag color)
UPDATE chat_commands
SET response_color = 'channel'
WHERE action_type = 'announce';
