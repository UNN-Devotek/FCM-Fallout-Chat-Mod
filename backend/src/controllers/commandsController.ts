import { Request, Response, NextFunction } from 'express';
import { paramStr } from '../utils/reqParams';
import prisma from '../config/prisma';
import { bustCommandCache } from '../services/commandService';

async function pushCommandsToClients(): Promise<void> {
  const commands = await prisma.chatCommand.findMany({ orderBy: { trigger: 'asc' } });
  const fn = (global as any).broadcastCommandsUpdate as ((cmds: any[]) => void) | undefined;
  fn?.(commands);
}

const SYSTEM_TRIGGERS = new Set(['/apply', '/report']);
// Hard-coded built-ins resolved in commandService before any DB lookup — a DB row with
// one of these triggers would be silently ignored, so reject creation upfront.
const RESERVED_BUILTINS = new Set([
  '/help', '/s', '/g', '/t', '/e', '/r', '/i', '/raid',
  '/serverstatus', '/server-status', '/nukecodes', '/codes',
  '/wiki', '/camp',
]);

function validId(id: string): boolean {
  return /^\d+$/.test(id) && parseInt(id, 10) > 0;
}

export async function listCommands(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const commands = await prisma.chatCommand.findMany({ orderBy: { trigger: 'asc' } });
    res.json({ data: commands });
  } catch (err) { next(err); }
}

export async function createCommand(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { trigger, alias, description, response, actionType, targetChannelId, allowedChannelId, responseColor, cooldownSec, enabled, requiresArgs, relayToDiscord } = req.body;
  const normalized = String(trigger ?? '').toLowerCase().trim();

  if (RESERVED_BUILTINS.has(normalized) || SYSTEM_TRIGGERS.has(normalized)) {
    res.status(422).json({ title: 'Reserved', detail: `${normalized} is a built-in command and cannot be overridden.` });
    return;
  }
  if (req.body.actionType === 'form') {
    res.status(422).json({ title: 'Reserved', detail: 'Form commands are system-managed and cannot be created manually.' });
    return;
  }
  if (!/^\/[a-z0-9_-]+$/.test(normalized)) {
    res.status(422).json({ title: 'Invalid trigger', detail: 'Trigger must start with / and contain only letters, numbers, underscores, or hyphens.' });
    return;
  }

  const rawAlias = String(alias ?? '').toLowerCase().trim();
  const normalizedAlias = rawAlias || null;
  if (normalizedAlias) {
    if (!/^\/[a-z0-9_-]+$/.test(normalizedAlias)) {
      res.status(422).json({ title: 'Invalid alias', detail: 'Alias must start with / and contain only letters, numbers, underscores, or hyphens.' });
      return;
    }
    if (normalizedAlias === '/help' || SYSTEM_TRIGGERS.has(normalizedAlias) || RESERVED_BUILTINS.has(normalizedAlias)) {
      res.status(422).json({ title: 'Reserved', detail: `${normalizedAlias} is a built-in command and cannot be used as an alias.` });
      return;
    }
  }

  try {
    const command = await prisma.chatCommand.create({
      data: {
        trigger: normalized,
        alias: normalizedAlias,
        description: String(description ?? ''),
        response: String(response ?? ''),
        actionType: String(actionType ?? 'message'),
        targetChannelId: targetChannelId || null,
        allowedChannelId: allowedChannelId || null,
        responseColor: responseColor || null,
        cooldownSec: Number(cooldownSec ?? 0),
        enabled: Boolean(enabled ?? true),
        requiresArgs: Boolean(requiresArgs ?? false),
        relayToDiscord: Boolean(relayToDiscord ?? false),
      },
    });
    bustCommandCache();
    pushCommandsToClients().catch(() => {});
    res.status(201).json({ data: command });
  } catch (err: any) {
    if (err.code === 'P2002') {
      res.status(409).json({ title: 'Conflict', detail: `A command with trigger '${normalized}' already exists.` });
      return;
    }
    next(err);
  }
}

export async function updateCommand(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validId(paramStr(req, 'id'))) { res.status(400).json({ title: 'Bad Request', detail: 'Invalid ID.' }); return; }
  const id = parseInt(paramStr(req, 'id'), 10);

  try {
    const existing = await prisma.chatCommand.findUnique({ where: { id } });
    if (!existing) { res.status(404).json({ title: 'Not Found', detail: 'Command not found.' }); return; }

    const data: Record<string, unknown> = {};
    // System commands: only description and formFields may be edited.
    if (SYSTEM_TRIGGERS.has(existing.trigger)) {
      if (req.body.description !== undefined) data.description = req.body.description;
      if (req.body.formFields  !== undefined) data.formFields  = req.body.formFields;
      if (req.body.alias) {
        res.status(422).json({ title: 'Protected', detail: 'System commands cannot have aliases.' });
        return;
      }
    } else {
      if (req.body.trigger          !== undefined) data.trigger          = String(req.body.trigger).toLowerCase().trim();
      if (req.body.description      !== undefined) data.description      = req.body.description;
      if (req.body.response         !== undefined) data.response         = req.body.response;
      if (req.body.actionType       !== undefined) data.actionType       = req.body.actionType;
      if (req.body.cooldownSec      !== undefined) data.cooldownSec      = Number(req.body.cooldownSec);
      if (req.body.enabled          !== undefined) data.enabled          = Boolean(req.body.enabled);
      if (req.body.requiresArgs     !== undefined) data.requiresArgs     = Boolean(req.body.requiresArgs);
      if (req.body.relayToDiscord   !== undefined) data.relayToDiscord   = Boolean(req.body.relayToDiscord);
      if ('targetChannelId'  in req.body) data.targetChannelId  = req.body.targetChannelId  || null;
      if ('allowedChannelId' in req.body) data.allowedChannelId = req.body.allowedChannelId || null;
      if ('responseColor'    in req.body) data.responseColor    = req.body.responseColor    || null;
      if ('alias' in req.body) {
        const newAlias = req.body.alias ? String(req.body.alias).toLowerCase().trim() : null;
        if (newAlias && (newAlias === '/help' || SYSTEM_TRIGGERS.has(newAlias) || RESERVED_BUILTINS.has(newAlias))) {
          res.status(422).json({ title: 'Reserved', detail: `${newAlias} is a built-in command and cannot be used as an alias.` });
          return;
        }
        data.alias = newAlias;
      }
    }

    const updated = await prisma.chatCommand.update({ where: { id }, data });
    bustCommandCache();
    pushCommandsToClients().catch(() => {});
    res.json({ data: updated });
  } catch (err: any) {
    if (err.code === 'P2002') { res.status(409).json({ title: 'Conflict', detail: 'Trigger already exists.' }); return; }
    next(err);
  }
}

export async function deleteCommand(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!validId(paramStr(req, 'id'))) { res.status(400).json({ title: 'Bad Request', detail: 'Invalid ID.' }); return; }
  const id = parseInt(paramStr(req, 'id'), 10);

  try {
    const existing = await prisma.chatCommand.findUnique({ where: { id } });
    if (!existing) { res.status(404).json({ title: 'Not Found', detail: 'Command not found.' }); return; }
    if (SYSTEM_TRIGGERS.has(existing.trigger)) {
      res.status(422).json({ title: 'Protected', detail: `${existing.trigger} is a system command and cannot be deleted.` });
      return;
    }
    await prisma.chatCommand.delete({ where: { id } });
    bustCommandCache();
    pushCommandsToClients().catch(() => {});
    res.json({ data: { deleted: true } });
  } catch (err) { next(err); }
}
