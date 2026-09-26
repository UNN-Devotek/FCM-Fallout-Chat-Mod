import type { CommandResult } from '../commandService';

const GIVEAWAY_COMMAND = /^\/?giveaway(?:\s+(.*))?$/i;

/** Only the giveaway command is allowed through the HUD chat.v1 command boundary. */
export function hudGiveawayCommand(body: string): string | null {
  const match = GIVEAWAY_COMMAND.exec(body.trim());
  if (!match) return null;
  return `/giveaway${match[1] ? ` ${match[1].trim()}` : ''}`;
}

export function hudGiveawayFeedback(result: CommandResult): string {
  if (!result.handled || (result.actionType !== 'private' && result.actionType !== 'message')) {
    return 'Giveaway command failed.';
  }
  const metadata = result.metadata;
  const rows = metadata?.type === 'giveaway_list' || metadata?.type === 'giveaway_history'
    ? metadata.giveaways : null;
  if (!Array.isArray(rows) || rows.length === 0) return result.botMessage.slice(0, 180);
  const summary = rows.slice(0, 3).map((row: Record<string, unknown>) =>
    `${String(row.shortId ?? '')} ${String(row.itemName ?? '')}`).join(' | ');
  return `${result.botMessage}: ${summary}`.slice(0, 180);
}
