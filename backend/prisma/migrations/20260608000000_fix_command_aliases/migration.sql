-- /r is a code-level built-in shortcut (→ Raids channel).
-- Any DB command that had /r as an alias would be silently shadowed by the built-in.
-- Remove the alias so the command only responds to its own trigger (e.g. /recent).
UPDATE chat_commands SET alias = NULL WHERE alias = '/r';
