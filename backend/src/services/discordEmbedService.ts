import { createRequiredAudit, isPrismaAtomicRefusal, runRequiredBundle, runRequiredMutation } from '../lib/requiredEffects';
import type { Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { postEmbed, type EmbedData } from './discordService';
import reactionRoleService, { ReactionRolePanelError, type ReactionRoleInput } from './reactionRoleService';

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const MAX_URL_LENGTH = 2_048;
const MAX_EMBED_TEXT_LENGTH = 6_000;

const TEXT_LIMITS = {
  title: 256,
  description: 4_096,
  authorName: 256,
  footerText: 2_048,
  content: 2_000,
} as const;

const URL_KEYS = ['url', 'authorIconUrl', 'authorUrl', 'thumbnailUrl', 'imageUrl', 'footerIconUrl'] as const;

export interface EmbedPreview {
  embed: EmbedData;
  warnings: string[];
}

export interface SendEmbedInput {
  channelId: string;
  embed: unknown;
  reactionRoles?: unknown;
  actorId?: string | null;
  /** MCP creates its own fail-closed audit intent before side effects. */
  suppressAudit?: boolean;
}

export interface SendEmbedResult {
  sent: true;
  messageId: string;
  reactionRoles: number;
}

export class PartialEmbedSendError extends Error {
  readonly code = 'embed_sent_panel_failed' as const;
  constructor(
    readonly messageId: string,
    readonly channelId: string,
    readonly causeClass: string,
  ) {
    super('Discord message was posted, but reaction-role panel setup failed');
    this.name = 'PartialEmbedSendError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateOptionalString(data: Record<string, unknown>, key: keyof typeof TEXT_LIMITS): string | null {
  const value = data[key];
  if (value === undefined) return null;
  if (typeof value !== 'string') return `${key} must be a string`;
  if (value.length > TEXT_LIMITS[key]) {
    const label = key === 'footerText' ? 'footer' : key === 'authorName' ? 'author name' : key;
    return `${label} must be ${TEXT_LIMITS[key]} characters or fewer`;
  }
  return null;
}

function validateOptionalUrl(data: Record<string, unknown>, key: typeof URL_KEYS[number]): string | null {
  const value = data[key];
  if (value === undefined) return null;
  if (typeof value !== 'string') return `${key} must be a string`;
  if (value === '') return null;
  if (value.length > MAX_URL_LENGTH) return `${key} must be ${MAX_URL_LENGTH} characters or fewer`;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `${key} must be an http or https URL`;
  } catch {
    return `${key} must be a valid http or https URL`;
  }
  return null;
}

/** Validate an embed using the same limits enforced by Discord. */
export function validateEmbed(data: unknown): string | null {
  if (!isRecord(data)) return 'embed payload is required';
  for (const key of Object.keys(TEXT_LIMITS) as Array<keyof typeof TEXT_LIMITS>) {
    const error = validateOptionalString(data, key);
    if (error) return error;
  }
  for (const key of URL_KEYS) {
    const error = validateOptionalUrl(data, key);
    if (error) return error;
  }
  if (data.timestamp !== undefined && typeof data.timestamp !== 'boolean') return 'timestamp must be a boolean';

  if (data.color !== undefined && data.color !== '') {
    if (typeof data.color === 'string') {
      if (!HEX_RE.test(data.color)) return 'color must be a 6-digit hex value (e.g. #18FF62)';
    } else if (typeof data.color !== 'number' || !Number.isInteger(data.color) || data.color < 0 || data.color > 0xFFFFFF) {
      return 'color must be a 6-digit hex value or an integer from 0 to 16777215';
    }
  }

  const fields = data.fields;
  if (fields !== undefined) {
    if (!Array.isArray(fields)) return 'fields must be an array';
    if (fields.length > 25) return 'an embed may have at most 25 fields';
    for (const field of fields) {
      if (!isRecord(field)) return 'each field must be an object';
      if (typeof field.name !== 'string' || typeof field.value !== 'string' || !field.name || !field.value) {
        return 'each field needs a string name and value';
      }
      if (field.inline !== undefined && typeof field.inline !== 'boolean') return 'field inline must be a boolean';
      if (field.name.length > 256) return 'field name must be 256 characters or fewer';
      if (field.value.length > 1024) return 'field value must be 1024 characters or fewer';
    }
  }

  const hasBody = Boolean(data.title || data.description || (Array.isArray(fields) && fields.length > 0) || data.imageUrl);
  if (!hasBody) return 'embed must have at least a title, description, image, or one field';

  const aggregateTextLength =
    ((data.title as string | undefined)?.length ?? 0)
    + ((data.description as string | undefined)?.length ?? 0)
    + ((data.authorName as string | undefined)?.length ?? 0)
    + ((data.footerText as string | undefined)?.length ?? 0)
    + (Array.isArray(fields)
      ? fields.reduce((total, field) => total + (field as { name: string; value: string }).name.length + (field as { name: string; value: string }).value.length, 0)
      : 0);
  if (aggregateTextLength > MAX_EMBED_TEXT_LENGTH) return 'embed text must total 6000 characters or fewer';
  return null;
}

/** Pure validation/normalization operation shared by REST and MCP callers. */
export function preview(data: unknown): EmbedPreview {
  const error = validateEmbed(data);
  if (error) throw new Error(error);
  const source = data as Record<string, unknown>;
  const embed: EmbedData = {};
  const stringKeys = [
    'title', 'description', 'url', 'authorName', 'authorIconUrl', 'authorUrl',
    'thumbnailUrl', 'imageUrl', 'footerText', 'footerIconUrl', 'content',
  ] as const;
  for (const key of stringKeys) {
    if (typeof source[key] === 'string') embed[key] = source[key];
  }
  if (typeof source.color === 'string' || typeof source.color === 'number') embed.color = source.color;
  if (typeof source.timestamp === 'boolean') embed.timestamp = source.timestamp;
  if (Array.isArray(source.fields)) {
    embed.fields = source.fields.map((field) => {
      const item = field as Record<string, unknown>;
      return { name: String(item.name), value: String(item.value), inline: item.inline === true };
    });
  }
  return { embed, warnings: [] };
}

export async function list() {
  return prisma.discordEmbed.findMany({ orderBy: { updatedAt: 'desc' } });
}

export async function get(id: number) {
  return prisma.discordEmbed.findUnique({ where: { id } });
}

export async function create(name: string, data: unknown) {
  return runRequiredBundle('domain', 'discordEmbedService:9eda60a743bf', async () => {
  const error = validateEmbed(data);
  if (error) throw new Error(error);
  return (<PreparedArgs extends Parameters<typeof prisma.discordEmbed.create>[0]>(preparedArgs: PreparedArgs) => runRequiredMutation('domain', '193342eb9ce2d1b613083352', { stage: 'primary-write-unconfirmed' }, () => prisma.discordEmbed.create(preparedArgs), isPrismaAtomicRefusal, undefined, undefined))({
    data: { name: name.trim().slice(0, 100), data: data as Prisma.InputJsonValue },
  });

  });
}

export async function update(id: number, name: string, data: unknown) {
  return runRequiredBundle('domain', 'discordEmbedService:154f493e34d3', async () => {
  const error = validateEmbed(data);
  if (error) throw new Error(error);
  return (<PreparedArgs extends Parameters<typeof prisma.discordEmbed.update>[0]>(preparedArgs: PreparedArgs) => runRequiredMutation('domain', 'e829b819d13ea51a9dd84ae4', { stage: 'primary-write-unconfirmed', rowId: id }, () => prisma.discordEmbed.update(preparedArgs), isPrismaAtomicRefusal, undefined, undefined))({
    where: { id },
    data: { name: name.trim().slice(0, 100), data: data as Prisma.InputJsonValue },
  });

  });
}

export async function remove(id: number): Promise<void> {
  return runRequiredBundle('domain', 'discordEmbedService:f0b2c8b876e6', async () => {
  await runRequiredMutation('domain', '8ea7591168eca57af0f6dd64', { stage: 'primary-write-unconfirmed', rowId: id }, () => prisma.discordEmbed.delete({ where: { id } }), isPrismaAtomicRefusal, undefined, undefined);

  });
}

export function validateReactionRoles(value: unknown): { error: string | null; mappings: ReactionRoleInput[] } {
  if (value === undefined) return { error: null, mappings: [] };
  if (!Array.isArray(value)) return { error: 'reactionRoles must be an array', mappings: [] };
  if (value.length > 20) return { error: 'at most 20 reaction roles per message', mappings: [] };
  const mappings: ReactionRoleInput[] = [];
  for (const mapping of value) {
    if (!isRecord(mapping)) return { error: 'each reaction role must be an object', mappings: [] };
    const hasUnicode = typeof mapping.emoji === 'string' && mapping.emoji.trim().length > 0;
    if (mapping.customEmojiId !== undefined && (typeof mapping.customEmojiId !== 'string' || !SNOWFLAKE_RE.test(mapping.customEmojiId))) {
      return { error: 'customEmojiId must be a valid Discord snowflake ID', mappings: [] };
    }
    const hasCustom = typeof mapping.customEmojiId === 'string' && SNOWFLAKE_RE.test(mapping.customEmojiId);
    if (!hasUnicode && !hasCustom) {
      return { error: 'each reaction role needs either a unicode emoji or a valid customEmojiId snowflake', mappings: [] };
    }
    if (typeof mapping.roleId !== 'string' || !SNOWFLAKE_RE.test(mapping.roleId)) {
      return { error: 'each reaction role needs a valid role ID', mappings: [] };
    }
    mappings.push({
      emoji: typeof mapping.emoji === 'string' ? mapping.emoji : '',
      roleId: mapping.roleId,
      ...(typeof mapping.customEmojiId === 'string' ? { customEmojiId: mapping.customEmojiId } : {}),
      ...(typeof mapping.animated === 'boolean' ? { animated: mapping.animated } : {}),
    });
  }
  return { error: null, mappings };
}

export async function send(input: SendEmbedInput): Promise<SendEmbedResult> {
  const normalized = preview(input.embed).embed;
  const validatedRoles = validateReactionRoles(input.reactionRoles);
  if (validatedRoles.error) throw new Error(validatedRoles.error);
  const message = await postEmbed(input.channelId, normalized);
  if (validatedRoles.mappings.length > 0 && message.guildId) {
    const mappings = reactionRoleService.buildMappings(message.client, message.guildId, validatedRoles.mappings);
    try {
      await reactionRoleService.createPanel(message, mappings);
    } catch (error) {
      const causeClass = error instanceof ReactionRolePanelError ? error.causeClass : (error instanceof Error ? error.constructor.name : 'UnknownError');
      throw new PartialEmbedSendError(message.id, input.channelId, causeClass);
    }
  }
  if (!input.suppressAudit) await createRequiredAudit(prisma.auditLog, {
    data: {
      actorId: input.actorId ?? null,
      action: 'send_discord_embed',
      targetType: 'discord_channel',
      reason: `Sent embed to channel ${input.channelId}${validatedRoles.mappings.length ? ` (+${validatedRoles.mappings.length} reaction roles)` : ''}`,
      metadata: { channelId: input.channelId, title: normalized.title ?? null, reactionRoles: validatedRoles.mappings.length },
    },
  }, { discordMessageId: message.id, channelId: input.channelId }).catch(() => {});
  return { sent: true, messageId: message.id, reactionRoles: validatedRoles.mappings.length };
}

export default { validateEmbed, preview, list, get, create, update, remove, validateReactionRoles, send };
