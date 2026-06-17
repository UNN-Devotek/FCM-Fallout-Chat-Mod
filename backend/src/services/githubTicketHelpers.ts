/**
 * Pure helpers for the Discord <-> GitHub ticketing feature.
 *
 * Deliberately free of discord.js / prisma / network imports so they can be
 * unit-tested in isolation (Jest, tests/githubTicketHelpers.test.js) and reused
 * by both the Discord wiring (ticketService) and the webhook handler.
 */

/** customId namespace for all ticket interaction components. */
export const TICKET_NS = 'ght';

/** Ticket kinds. 'support' is the hidden/private staff flow (added in increment 2). */
export type TicketType = 'bug' | 'suggestion' | 'support';

export const TICKET_TYPES: readonly TicketType[] = ['bug', 'suggestion', 'support'] as const;

export function isTicketType(v: string): v is TicketType {
  return (TICKET_TYPES as readonly string[]).includes(v);
}

/** Build a component customId: buildCustomId('open', 'bug') => "ght:open:bug". */
export function buildCustomId(action: string, arg?: string): string {
  return arg !== undefined && arg !== '' ? `${TICKET_NS}:${action}:${arg}` : `${TICKET_NS}:${action}`;
}

export interface ParsedCustomId {
  isOurs: boolean;
  action: string;
  arg: string;
}

/** Parse a component customId. Returns isOurs=false for anything not in our namespace. */
export function parseCustomId(customId: string | undefined | null): ParsedCustomId {
  if (!customId || typeof customId !== 'string') return { isOurs: false, action: '', arg: '' };
  const parts = customId.split(':');
  if (parts[0] !== TICKET_NS) return { isOurs: false, action: '', arg: '' };
  return { isOurs: true, action: parts[1] || '', arg: parts.slice(2).join(':') };
}

/** Discord's hard limit on thread names. */
export const THREAD_NAME_MAX = 100;

/**
 * Thread name as "#<issueNumber> · <title>", truncated to Discord's 100-char
 * limit. The issue-key prefix is always preserved; only the title is trimmed.
 */
export function buildThreadName(issueNumber: number, title: string): string {
  const prefix = `#${issueNumber} · `;
  const cleanTitle = (title || '').replace(/\s+/g, ' ').trim();
  const room = THREAD_NAME_MAX - prefix.length;
  if (cleanTitle.length <= room) return `${prefix}${cleanTitle}`;
  if (room <= 1) return prefix.slice(0, THREAD_NAME_MAX);
  return `${prefix}${cleanTitle.slice(0, room - 1)}…`;
}

/** GitHub label applied to issues of each type. */
export function labelForType(type: TicketType): string {
  switch (type) {
    case 'bug':
      return 'bug';
    case 'suggestion':
      return 'suggestion';
    case 'support':
      return 'support';
  }
}

/** Embed accent color per ticket type (Fallout-green family, distinct hues). */
export function colorForType(type: TicketType): number {
  switch (type) {
    case 'bug':
      return 0xff5555; // red
    case 'suggestion':
      return 0xffd43b; // amber
    case 'support':
      return 0x4dabf7; // blue
  }
}

/** Human label for a type, used in embeds/messages. */
export function displayForType(type: TicketType): string {
  switch (type) {
    case 'bug':
      return 'Bug Report';
    case 'suggestion':
      return 'Suggestion';
    case 'support':
      return 'Private Bug';
  }
}

export interface IssueBodyInput {
  type: TicketType;
  description: string;
  steps?: string;
  reporterTag: string; // e.g. "dweller#0001" or "@dweller"
  reporterId: string; // Discord user id
}

/**
 * Build the GitHub issue body (markdown) from the modal fields. No attachments —
 * files live in the Discord thread (text-only issues by design).
 */
export function buildIssueBody(input: IssueBodyInput): string {
  const lines: string[] = [];
  lines.push(`**Reported by:** ${input.reporterTag} (Discord \`${input.reporterId}\`)`);
  lines.push('');
  lines.push('## Description');
  lines.push((input.description || '').trim() || '_No description provided._');
  if (input.type === 'bug') {
    lines.push('');
    lines.push('## Steps to reproduce');
    lines.push((input.steps || '').trim() || '_Not provided._');
  }
  lines.push('');
  lines.push('---');
  lines.push('_Filed from Discord. Screenshots and discussion live in the linked thread._');
  return lines.join('\n');
}

export interface StaffRoleIds {
  ownerRoleId?: string;
  adminRoleId?: string;
  moderatorRoleId?: string;
  developerRoleId?: string;
}

/** True if the member holds any configured staff role. Empty config ids are ignored. */
export function isStaff(memberRoleIds: string[] | undefined | null, staff: StaffRoleIds): boolean {
  if (!Array.isArray(memberRoleIds) || memberRoleIds.length === 0) return false;
  const staffIds = [staff.ownerRoleId, staff.adminRoleId, staff.moderatorRoleId, staff.developerRoleId].filter(
    (x): x is string => !!x,
  );
  if (staffIds.length === 0) return false;
  const set = new Set(memberRoleIds);
  return staffIds.some((id) => set.has(id));
}

/**
 * Format a Discord thread message as a GitHub issue comment (text-only). When the
 * source message had attachments we note the count so GitHub readers know to look
 * in Discord, without uploading the files.
 */
export function formatDiscordMessageForGitHub(opts: {
  authorName: string;
  content: string;
  attachmentCount?: number;
}): string {
  const parts: string[] = [];
  parts.push(`**${opts.authorName}** (Discord):`);
  const content = (opts.content || '').trim();
  if (content) parts.push(content);
  const n = opts.attachmentCount || 0;
  if (n > 0) parts.push(`_(${n} attachment${n === 1 ? '' : 's'} shared in the Discord thread)_`);
  return parts.join('\n');
}

module.exports = {
  TICKET_NS,
  TICKET_TYPES,
  isTicketType,
  buildCustomId,
  parseCustomId,
  THREAD_NAME_MAX,
  buildThreadName,
  labelForType,
  colorForType,
  displayForType,
  buildIssueBody,
  isStaff,
  formatDiscordMessageForGitHub,
};
