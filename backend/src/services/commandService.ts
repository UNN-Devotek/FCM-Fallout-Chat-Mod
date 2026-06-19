import prisma from '../config/prisma';
import logger from '../config/logger';
import { getServerStatus } from './serverStatusService';
import { getNukeCodes } from './nukeCodesService';
import { getCampItem } from './campService';
import * as giveawayService from './giveawayService';
import { GiveawayError } from './giveawayService';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatCommand {
  id: number;
  trigger: string;
  alias?: string | null;
  description: string;
  response: string;
  actionType: string;
  targetChannelId: string | null;
  allowedChannelId: string | null;
  cooldownSec: number;
  enabled: boolean;
  requiresArgs: boolean;
  responseColor: string | null;
  relayToDiscord: boolean;
}

export type CommandResult =
  | { handled: false }
  | { handled: true; actionType: 'message'; botMessage: string; targetChannelId: string; metadata?: Record<string, unknown> | null; privateNotice?: string }
  | { handled: true; actionType: 'relay'; relayContent: string; targetChannelId: string; responseColor?: string | null; privateNotice?: string; relayToDiscord: boolean }
  | { handled: true; actionType: 'private'; botMessage: string; targetChannelId: string; metadata?: Record<string, unknown> | null }
  | { handled: true; actionType: 'report'; reportContent: string; reportType: 'bug' | 'player'; targetChannelId: string }
  ;

// ── Command Cache (60s TTL) ───────────────────────────────────────────────────

let cachedCommands: ChatCommand[] = [];
let commandLastLoaded = 0;
let commandLoadPromise: Promise<ChatCommand[]> | null = null;
const COMMAND_CACHE_TTL_MS = 60_000;

async function loadCommands(): Promise<ChatCommand[]> {
  const rows = await prisma.chatCommand.findMany({ where: { enabled: true } });
  return rows.map(r => ({ ...r, relayToDiscord: (r as any).relayToDiscord ?? false, responseColor: (r as any).responseColor ?? null })) as unknown as ChatCommand[];
}

export async function getCommands(): Promise<ChatCommand[]> {
  const now = Date.now();
  if (cachedCommands.length > 0 && now - commandLastLoaded < COMMAND_CACHE_TTL_MS) {
    return cachedCommands;
  }
  if (!commandLoadPromise) {
    commandLoadPromise = loadCommands()
      .then(cmds => {
        cachedCommands = cmds;
        commandLastLoaded = Date.now();
        commandLoadPromise = null;
        return cmds;
      })
      .catch(err => {
        commandLoadPromise = null;
        logger.warn({ err }, 'Failed to load chat commands from DB — serving stale cache');
        return cachedCommands;
      });
  }
  return commandLoadPromise;
}

export function bustCommandCache(): void {
  cachedCommands = [];
  commandLastLoaded = 0;
}

// ── Per-User Cooldown (in-memory) ─────────────────────────────────────────────

const cooldownMap = new Map<string, number>();

function isCoolingDown(commandId: number, userId: string): boolean {
  const key = `${commandId}:${userId}`;
  const expiresAt = cooldownMap.get(key);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) { cooldownMap.delete(key); return false; }
  return true;
}

function setCooldown(commandId: number, userId: string, cooldownSec: number): void {
  if (cooldownSec <= 0) return;
  cooldownMap.set(`${commandId}:${userId}`, Date.now() + cooldownSec * 1000);
}

// Prune expired entries every 5 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, exp] of cooldownMap.entries()) {
    if (now >= exp) cooldownMap.delete(key);
  }
}, 5 * 60 * 1000);

// ── Template Substitution ─────────────────────────────────────────────────────

function substituteTemplate(
  template: string,
  vars: { user: string; args: string; channel: string },
): string {
  return template
    .replace(/\{user\}/g, vars.user)
    .replace(/\{args\}/g, vars.args)
    .replace(/\{channel\}/g, vars.channel);
}


// ── /help Response Builder ────────────────────────────────────────────────────

function buildHelpResponse(commands: ChatCommand[]): string {
  const lines: string[] = ['◈ VAULT-TEC COMMAND REFERENCE'];

  lines.push('', '— CHANNEL RELAY —');
  lines.push('/g <message> — Send to General');
  lines.push('/t <message> — Send to Trading');
  lines.push('/e <message> — Send to Events');
  lines.push('/r <message> — Send to Raids');
  lines.push('/i <message> — Send to Infests');

  lines.push('', '— MODERATION —');
  lines.push('/report bug <description> — Report a bug to the team');
  lines.push('/report player <name + reason> — Report a player to moderators');
  lines.push('/apply — Open the staff application form');

  lines.push('', '— FALLOUT 76 —');
  lines.push('/serverstatus — Show Fallout 76 server status (up/down)');
  lines.push('/nukecodes — Show this week\'s nuke launch codes (Alpha/Bravo/Charlie)');
  lines.push('/wiki <name> — Look up a Fallout 76 item, weapon, creature, perk, or location');
  lines.push('/camp <item name> — Look up a CAMP item (budget cost, required plan, category)');

  lines.push('', '— GIVEAWAYS —');
  lines.push('/giveaway start <item> [<minutes>] - Start a giveaway (1-60 min, default 5)');
  lines.push('/giveaway list - Show all active giveaways');
  lines.push('/giveaway last [<number>] - Show results of last 1-10 giveaways (default 5)');
  lines.push('/giveaway join <id> - Enter a giveaway');
  lines.push('/giveaway leave <id> - Leave a giveaway you entered');
  lines.push('/giveaway stop <id> - Cancel your giveaway (creator or mod only)');

  const relayCommands   = commands.filter(c => c.actionType === 'relay');
  const eventCommands   = commands.filter(c => c.actionType === 'announce');
  const msgCommands     = commands.filter(c => c.actionType === 'message');
  const privateCommands = commands.filter(c => c.actionType === 'private');

  function fmtTrigger(c: ChatCommand): string {
    return c.alias ? `${c.trigger} (${c.alias})` : c.trigger;
  }

  for (const c of relayCommands) {
    lines.push(`${fmtTrigger(c)} <message> — ${c.description}`);
  }

  if (eventCommands.length > 0) {
    lines.push('', '— EVENTS (announces to Events channel) —');
    for (const c of eventCommands) {
      lines.push(`${fmtTrigger(c)} — ${c.description}`);
    }
  }

  if (msgCommands.length > 0 || privateCommands.length > 0) {
    lines.push('', '— COMMANDS —');
    for (const c of [...msgCommands, ...privateCommands]) {
      lines.push(`${fmtTrigger(c)}${c.requiresArgs ? ' <args>' : ''} — ${c.description}`);
    }
  }

  lines.push('', '— DYNAMIC VARIABLES (use in response templates) —');
  lines.push('{user} · {args} · {channel}');

  return lines.join('\n');
}

// ── /serverstatus Response Builder ────────────────────────────────────────────

async function buildServerStatusResponse(): Promise<{ text: string; metadata: Record<string, unknown> | null }> {
  const data = await getServerStatus();
  if (!data) {
    return { text: '◈ FALLOUT 76 SERVER STATUS\n\nStatus unavailable right now. Try again in a moment.', metadata: null };
  }
  const glyph =
    data.status === 'UP' ? '🟢' :
    data.status === 'DOWN' ? '🔴' :
    data.status === 'UNKNOWN' ? '⚪' : '🟡';
  const label =
    data.status === 'UP' ? 'Operational' :
    data.status === 'DOWN' ? 'Down' :
    data.status === 'UNKNOWN' ? 'Unknown' : data.status;
  return {
    text: `◈ FALLOUT 76 SERVER STATUS\n\n${glyph} ${label} (${data.status})\n\nSource: Bethesda · checked ${new Date(data.checkedAt).toUTCString()}`,
    metadata: { type: 'server_status', status: data.status, label, checkedAt: data.checkedAt },
  };
}

// ── /nukecodes Response Builder ───────────────────────────────────────────────

async function buildNukeCodesResponse(): Promise<{ text: string; metadata: Record<string, unknown> | null }> {
  const data = await getNukeCodes();
  if (!data) {
    return { text: '◈ NUKE CODES\n\nCodes unavailable right now. Try again in a moment.', metadata: null };
  }
  const lines = [
    '◈ FALLOUT 76 NUKE CODES',
    '',
    `ALPHA   — ${data.alpha}`,
    `BRAVO   — ${data.bravo}`,
    `CHARLIE — ${data.charlie}`,
  ];
  if (data.validUntil != null) {
    lines.push('', `Valid until ${new Date(data.validUntil * 1000).toUTCString()}`);
  }
  lines.push('', 'Codes via NukaCrypt');
  return {
    text: lines.join('\n'),
    metadata: {
      type: 'nuke_codes',
      alpha: data.alpha,
      bravo: data.bravo,
      charlie: data.charlie,
      validUntil: data.validUntil != null ? new Date(data.validUntil * 1000).toISOString() : null,
    },
  };
}

// ── /giveaway Sub-Command Handler ────────────────────────────────────────────

async function handleGiveawayCommand(
  args: string,
  userId: string,
  username: string,
  channelId: string,
): Promise<CommandResult> {
  // All giveaway activity is routed through Events regardless of the channel the user typed from.
  const EVENTS_CHANNEL_ID = '00000000-0000-0000-0000-000000000003';
  const replyChannelId = channelId; // private replies go back to wherever the user is
  const giveawayChannelId = EVENTS_CHANNEL_ID;

  const spaceIdx = args.indexOf(' ');
  const subCmd = (spaceIdx < 0 ? args : args.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx < 0 ? '' : args.slice(spaceIdx + 1).trim();

  const USAGE = [
    '◈ GIVEAWAY COMMANDS',
    '',
    '/giveaway start <item> [<minutes>]',
    '  Start a raffle (1-60 min, default 5)',
    '/giveaway list',
    '  Show all active giveaways',
    '/giveaway last [<number>]',
    '  Show results of last 1-10 giveaways (default 5)',
    '/giveaway join <id>',
    '  Enter a giveaway by its short ID',
    '/giveaway leave <id>',
    '  Remove yourself from a giveaway',
    '/giveaway stop <id>',
    '  Cancel your giveaway (creator or mod only)',
  ].join('\n');

  if (!subCmd || subCmd === 'help') {
    return { handled: true, actionType: 'private', botMessage: USAGE, targetChannelId: replyChannelId };
  }

  if (subCmd === 'start') {
    if (!rest) {
      return { handled: true, actionType: 'private', botMessage: 'Usage: /giveaway start <item name> [<minutes>]', targetChannelId: replyChannelId };
    }
    // Parse optional trailing integer as duration: "/giveaway start Ultracite Flux 10"
    // Only treat the last token as duration when:
    //   1. It is a bare integer (no letters)
    //   2. The token immediately before it is NOT 'x' or 'X' (guards "Flux x 10")
    //   3. At least one token remains as the item name after removing it
    const parts = rest.split(' ');
    const lastPart = parts[parts.length - 1];
    const secondLast = parts.length >= 2 ? parts[parts.length - 2] : '';
    const isDurationToken = /^\d+$/.test(lastPart) && !/^x$/i.test(secondLast) && parts.length >= 2;
    const trailingNum = isDurationToken ? parseInt(lastPart, 10) : null;
    const itemName = trailingNum !== null ? parts.slice(0, -1).join(' ').trim() : rest;
    const durationMin = trailingNum ?? 5;

    if (!itemName) {
      return { handled: true, actionType: 'private', botMessage: 'Usage: /giveaway start <item name> [<minutes>]', targetChannelId: replyChannelId };
    }

    try {
      await giveawayService.createGiveaway(userId, username, giveawayChannelId, itemName, durationMin);
      return {
        handled: true,
        actionType: 'private',
        botMessage: `🎁 Giveaway started! Prize: ${itemName} - Duration: ${Math.min(60, Math.max(1, durationMin))} min. Winner will be drawn automatically.`,
        targetChannelId: replyChannelId,
      };
    } catch (err) {
      const msg = err instanceof GiveawayError ? err.message : 'Failed to start giveaway. Try again.';
      return { handled: true, actionType: 'private', botMessage: msg, targetChannelId: replyChannelId };
    }
  }

  if (subCmd === 'list') {
    try {
      const active = await giveawayService.listActive();
      return {
        handled: true,
        actionType: 'private',
        botMessage: active.length === 0 ? 'No active giveaways right now.' : `${active.length} active giveaway${active.length === 1 ? '' : 's'}`,
        targetChannelId: replyChannelId,
        metadata: {
          type: 'giveaway_list',
          giveaways: active.map(g => ({
            giveawayId: g.id,
            shortId: g.shortId,
            itemName: g.itemName,
            creatorName: g.creatorName,
            createdByUserId: g.createdByUserId,
            endsAt: new Date(g.endsAt).toISOString(),
            entryCount: g.entryCount,
            status: g.status,
          })),
        },
      };
    } catch {
      return { handled: true, actionType: 'private', botMessage: 'Failed to list giveaways.', targetChannelId: replyChannelId };
    }
  }

  if (subCmd === 'join') {
    const shortId = rest.toUpperCase();
    if (!shortId) {
      return { handled: true, actionType: 'private', botMessage: 'Usage: /giveaway join <id>', targetChannelId: replyChannelId };
    }
    try {
      const { entryCount } = await giveawayService.joinGiveaway(shortId, userId, username);
      return {
        handled: true,
        actionType: 'private',
        botMessage: `✅ You've entered giveaway [${shortId}]! Total entries: ${entryCount}.`,
        targetChannelId: replyChannelId,
      };
    } catch (err) {
      const msg = err instanceof GiveawayError ? err.message : 'Failed to join giveaway.';
      return { handled: true, actionType: 'private', botMessage: msg, targetChannelId: replyChannelId };
    }
  }

  if (subCmd === 'leave') {
    const shortId = rest.toUpperCase();
    if (!shortId) {
      return { handled: true, actionType: 'private', botMessage: 'Usage: /giveaway leave <id>', targetChannelId: replyChannelId };
    }
    try {
      const { entryCount } = await giveawayService.leaveGiveaway(shortId, userId);
      return {
        handled: true,
        actionType: 'private',
        botMessage: `You've left giveaway [${shortId}]. Remaining entries: ${entryCount}.`,
        targetChannelId: replyChannelId,
      };
    } catch (err) {
      const msg = err instanceof GiveawayError ? err.message : 'Failed to leave giveaway.';
      return { handled: true, actionType: 'private', botMessage: msg, targetChannelId: replyChannelId };
    }
  }

  if (subCmd === 'stop') {
    const shortId = rest.toUpperCase();
    if (!shortId) {
      return { handled: true, actionType: 'private', botMessage: 'Usage: /giveaway stop <id>', targetChannelId: replyChannelId };
    }
    try {
      await giveawayService.cancelGiveaway(shortId, userId, false);
      return {
        handled: true,
        actionType: 'private',
        botMessage: `❌ Giveaway [${shortId}] cancelled.`,
        targetChannelId: replyChannelId,
      };
    } catch (err) {
      const msg = err instanceof GiveawayError ? err.message : 'Failed to cancel giveaway.';
      return { handled: true, actionType: 'private', botMessage: msg, targetChannelId: replyChannelId };
    }
  }

  if (subCmd === 'last') {
    const n = parseInt(rest, 10);
    const count = !rest ? 5 : (isNaN(n) ? null : Math.min(10, Math.max(1, n)));
    if (count === null) {
      return { handled: true, actionType: 'private', botMessage: 'Usage: /giveaway last [<number>] - show last 1-10 completed giveaways (default 5)', targetChannelId: replyChannelId };
    }
    try {
      const recent = await giveawayService.listRecent(count);
      return {
        handled: true,
        actionType: 'private',
        botMessage: recent.length === 0 ? 'No completed giveaways yet.' : `Last ${recent.length} giveaway${recent.length === 1 ? '' : 's'}`,
        targetChannelId: replyChannelId,
        metadata: {
          type: 'giveaway_history',
          giveaways: recent.map(g => ({
            giveawayId: g.id,
            shortId: g.shortId,
            itemName: g.itemName,
            creatorName: g.creatorName,
            winnerName: g.winnerName,
            entryCount: g.entryCount,
            status: g.status,
            createdAt: new Date(g.createdAt).toISOString(),
          })),
        },
      };
    } catch {
      return { handled: true, actionType: 'private', botMessage: 'Failed to fetch recent giveaways.', targetChannelId: replyChannelId };
    }
  }

  return { handled: true, actionType: 'private', botMessage: USAGE, targetChannelId: replyChannelId };
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

/**
 * Attempt to handle a chat message as a slash command.
 *
 * @param content          Raw trimmed message text
 * @param userId           Triggering user UUID
 * @param username         Triggering user display name
 * @param channelId        Channel the message was sent in (UUID)
 * @param channelName      Human-readable channel name
 * @param serverEndpoint   Unused — retained for call-site compatibility
 * @param playerCount      Unused — retained for call-site compatibility
 * @param parentChannelId  Parent channel UUID (for allowedChannelId check on sub-channels)
 */
export async function tryHandleCommand(
  content: string,
  userId: string,
  username: string,
  channelId: string,
  channelName: string,
  serverEndpoint?: string | null,
  playerCount = 0,
  parentChannelId?: string | null,
): Promise<CommandResult> {
  if (!content.startsWith('/')) return { handled: false };

  const spaceIdx = content.indexOf(' ');
  const trigger  = (spaceIdx === -1 ? content : content.slice(0, spaceIdx)).toLowerCase();
  const args     = spaceIdx === -1 ? '' : content.slice(spaceIdx + 1).trim();

  // Built-in /help — always-on, not in DB
  if (trigger === '/help') {
    const commands = await getCommands();
    return {
      handled: true,
      actionType: 'private',
      botMessage: buildHelpResponse(commands),
      targetChannelId: channelId,
    };
  }

  // Built-in /s — DISABLED. Server chat is not available (same-world detection
  // retired per EULA §4(F)). The command stays handled so it returns a clear
  // notice instead of being relayed as a normal message.
  if (trigger === '/s') {
    return {
      handled: true,
      actionType: 'private',
      botMessage: 'Server chat is currently disabled.',
      targetChannelId: channelId,
    };
  }

  // Built-in channel relay shortcuts — first letter of each seeded sub/main channel
  const CHANNEL_SHORTCUTS: Record<string, { id: string; name: string }> = {
    '/g': { id: '00000000-0000-0000-0000-000000000005', name: 'General' },
    '/t': { id: '00000000-0000-0000-0000-000000000002', name: 'Trading' },
    '/e': { id: '00000000-0000-0000-0000-000000000003', name: 'Events' },
    '/r': { id: '00000000-0000-0000-0000-000000000004', name: 'Raids' },
    '/i': { id: '983995c1-f9ab-44c0-9b78-8b4cbf497273', name: 'Infests' },
  };
  if (trigger in CHANNEL_SHORTCUTS) {
    const ch = CHANNEL_SHORTCUTS[trigger];
    if (!args) {
      return {
        handled: true,
        actionType: 'private',
        botMessage: `Usage: ${trigger} <message> — Send to ${ch.name}`,
        targetChannelId: channelId,
      };
    }
    return { handled: true, actionType: 'relay', relayContent: args, targetChannelId: ch.id, relayToDiscord: true };
  }

  // Built-in /report bug <content> | /report player <content>
  if (trigger === '/report') {
    const spaceIdx  = args.indexOf(' ');
    const subCmd    = (spaceIdx < 0 ? args : args.slice(0, spaceIdx)).toLowerCase();
    const content   = spaceIdx < 0 ? '' : args.slice(spaceIdx + 1).trim();
    const reportType: 'bug' | 'player' = subCmd === 'bug' ? 'bug' : 'player';

    if (subCmd !== 'bug' && subCmd !== 'player') {
      return {
        handled: true,
        actionType: 'private',
        botMessage: 'Usage:\n  /report bug <description> — report a bug\n  /report player <player name + description> — report a player',
        targetChannelId: channelId,
      };
    }
    if (!content) {
      return {
        handled: true,
        actionType: 'private',
        botMessage: subCmd === 'bug'
          ? 'Usage: /report bug <title, description, steps to reproduce, expected vs actual>'
          : 'Usage: /report player <player name, reason, description>',
        targetChannelId: channelId,
      };
    }
    return { handled: true, actionType: 'report', reportContent: content, reportType, targetChannelId: channelId };
  }

  // Built-in /apply — private link to staff application page
  if (trigger === '/apply') {
    return {
      handled: true,
      actionType: 'private',
      botMessage: '◈ STAFF APPLICATION\n\nInterested in joining the Fallout Chat Mod team?\n\nVisit: https://falloutchatmod.com/apply\n\nApplications are reviewed by the moderation team. Requirements: active community member, no recent bans, 18+.',
      targetChannelId: channelId,
    };
  }

  // Built-in /serverstatus — FO76 server up/down via Bethesda's status endpoint
  if (trigger === '/serverstatus' || trigger === '/server-status') {
    const r = await buildServerStatusResponse();
    return {
      handled: true,
      actionType: 'private',
      botMessage: r.text,
      metadata: r.metadata,
      targetChannelId: channelId,
    };
  }

  // Built-in /nukecodes — current week's Alpha/Bravo/Charlie silo codes via NukaCrypt
  if (trigger === '/nukecodes' || trigger === '/codes') {
    const r = await buildNukeCodesResponse();
    return {
      handled: true,
      actionType: 'private',
      botMessage: r.text,
      metadata: r.metadata,
      targetChannelId: channelId,
    };
  }

  // Built-in /camp — CAMP item lookup from 76-CAMPDatabase
  if (trigger === '/camp') {
    if (!args) {
      return {
        handled: true,
        actionType: 'private',
        botMessage: 'Usage: /camp <item name> — Look up a CAMP item\'s budget cost, required plan, and category.',
        targetChannelId: channelId,
      };
    }
    const item = await getCampItem(args);
    if (!item) {
      return {
        handled: true,
        actionType: 'private',
        botMessage: `No CAMP item found for "${args}".`,
        targetChannelId: channelId,
        metadata: null,
      };
    }
    const planLine   = item.plan ? `Plan: ${item.plan}` : 'No plan required';
    const budgetLine = item.budgetCost != null ? `Budget: ${item.budgetCost}` : 'Budget: unknown';
    const sourceLine = item.sourceLabel ? `Source: ${item.sourceLabel}` : '';
    const atomLine   = item.atomPrice != null
      ? `Atomic Shop: ${item.atomPrice} Atoms${item.atomBundle ? ` (${item.atomBundle})` : ''}`
      : '';
    const text = [
      `◈ CAMP ITEM — ${item.name}`,
      '',
      `Category: ${item.category} › ${item.subCategory}`,
      budgetLine,
      planLine,
      ...(sourceLine ? [sourceLine] : []),
      ...(atomLine ? [atomLine] : []),
      '',
      'Data: 76 CAMP Database + Fallout Wiki',
    ].join('\n');
    return {
      handled: true,
      actionType: 'private',
      botMessage: text,
      targetChannelId: channelId,
      metadata: {
        type:        'camp_item',
        name:        item.name,
        category:    item.category,
        subCategory: item.subCategory,
        budgetCost:  item.budgetCost,
        plan:        item.plan,
        imageUrl:    item.imageUrl,
        sourceType:  item.sourceType,
        sourceLabel: item.sourceLabel,
        atomPrice:   item.atomPrice,
        atomBundle:  item.atomBundle,
        source:      '76 CAMP Database + Fallout Wiki',
        sourceUrl:   'https://mrsblobby.github.io/76-CAMPDatabase/Live/',
      },
    };
  }

  const commands = await getCommands();
  const cmd = commands.find(c => c.trigger === trigger || (c.alias != null && c.alias === trigger));

  // Built-in /giveaway — start | list | join | leave | stop
  if (trigger === '/giveaway') {
    return handleGiveawayCommand(args, userId, username, channelId);
  }

  if (!cmd) return { handled: false }; // unknown command — fall through to normal message

  // Channel restriction: if allowedChannelId is set, command only works in that channel or its subs
  if (cmd.allowedChannelId) {
    const allowed = channelId === cmd.allowedChannelId || parentChannelId === cmd.allowedChannelId;
    if (!allowed) {
      return {
        handled: true,
        actionType: 'private',
        botMessage: `${cmd.trigger} can only be used in the designated channel.`,
        targetChannelId: channelId,
      };
    }
  }

  // requiresArgs guard
  if (cmd.requiresArgs && args.length === 0) {
    return {
      handled: true,
      actionType: 'private',
      botMessage: `Usage: ${cmd.trigger} <message>`,
      targetChannelId: channelId,
    };
  }

  // Cooldown check
  if (isCoolingDown(cmd.id, userId)) {
    return {
      handled: true,
      actionType: 'private',
      botMessage: `Please wait before using ${cmd.trigger} again.`,
      targetChannelId: channelId,
    };
  }
  setCooldown(cmd.id, userId, cmd.cooldownSec);

  const resolvedChannelId = cmd.targetChannelId ?? channelId;

  // Relay action — send user's args as their own message to target channel
  if (cmd.actionType === 'relay') {
    const relayContent = args.length > 0 ? args : '(empty)';
    return { handled: true, actionType: 'relay', relayContent, targetChannelId: resolvedChannelId, responseColor: cmd.responseColor, relayToDiscord: cmd.relayToDiscord };
  }

  // Announce action — resolves template but posts as the triggering user (not bot)
  if (cmd.actionType === 'announce') {
    const relayContent = substituteTemplate(cmd.response, { user: username, args, channel: channelName });
    return {
      handled: true, actionType: 'relay', relayContent, targetChannelId: resolvedChannelId, responseColor: cmd.responseColor, relayToDiscord: cmd.relayToDiscord,
    };
  }

  // Message/private action — bot sends response; 'private' goes only to sender, 'message' broadcasts
  const botMessage = substituteTemplate(cmd.response, { user: username, args, channel: channelName });
  const replyType = cmd.actionType === 'private' ? 'private' : 'message';

  return {
    handled: true, actionType: replyType, botMessage, targetChannelId: resolvedChannelId,
  };
}
