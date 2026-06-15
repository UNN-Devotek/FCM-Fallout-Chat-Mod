-- Event announcement commands (action_type = 'announce') should relay to Discord
-- so players on Discord see the event callouts. These were seeded before the
-- relay_to_discord column existed and defaulted to false.
UPDATE chat_commands SET relay_to_discord = true WHERE action_type = 'announce';
