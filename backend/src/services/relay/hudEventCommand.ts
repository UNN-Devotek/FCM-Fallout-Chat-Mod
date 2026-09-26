import type { ChatCommand } from '../commandService';

/** Resolve HUD event shorthand against the enabled event catalog. */
export function hudEventCommand(body: string, commands: ChatCommand[]): string | null {
  const text = body.trim().replace(/^[/.]/, '');
  const match = /^(?:event\s+)?([a-z][a-z0-9]*)(?:\s+(.*))?$/i.exec(text);
  if (!match) return null;
  const trigger = `/${match[1].toLowerCase()}`;
  const command = commands.find((entry) => entry.actionType === 'announce'
    && (entry.trigger.toLowerCase() === trigger || entry.alias?.toLowerCase() === trigger));
  if (!command) return null;
  return `${trigger}${match[2] ? ` ${match[2].trim()}` : ''}`;
}
