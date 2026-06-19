/**
 * Giveaway service.
 *
 * Manages in-process draw timers and delegates persistence to Prisma.
 * Injected deps (broadcast, prisma) keep this testable without the real WS server.
 *
 * Design notes:
 *  - Any authenticated chat user may create a giveaway (no role gate); the
 *    1-active-per-user cap plus the per-user create cooldown prevent spam.
 *  - All broadcasts go to the Events channel (caller passes the fixed UUID).
 *  - reconcileActive() runs at startup and on a 5-minute periodic sweep so a
 *    giveaway orphaned by a DB blip is retried, not silently abandoned.
 */

import { v4 as uuidv4 } from 'uuid';
import type { PrismaClient } from '@prisma/client';
import { findProhibitedPhrase } from './autoModService';
import logger from '../config/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GiveawayDeps {
  prisma: PrismaClient;
  broadcast: (payload: object) => void;
}

export interface GiveawayRow {
  id: string;
  shortId: string;
  createdByUserId: string;
  creatorName: string;
  channelId: string;
  itemName: string;
  durationMin: number;
  endsAt: Date;
  status: string;
  winnerId: string | null;
  winnerName: string | null;
  createdAt: Date;
}

export interface GiveawayWithCount extends GiveawayRow {
  entryCount: number;
}

export class GiveawayError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'ALREADY_ENTERED' | 'NOT_ACTIVE' | 'OWN_GIVEAWAY' | 'CAP_REACHED' | 'INVALID_ARGS' | 'RATE_LIMITED',
  ) {
    super(message);
    this.name = 'GiveawayError';
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SHORT_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
const SHORT_ID_LEN = 6;
const DEFAULT_DURATION_MIN = 5;
const MIN_DURATION_MIN = 1;
const MAX_DURATION_MIN = 60;
const MAX_ITEM_NAME_LEN = 100;
const MAX_ACTIVE_PER_USER = 1;
const JOIN_LEAVE_COOLDOWN_MS = 2_000;
/** After a giveaway ends or is cancelled, the creator must wait this long before starting another. */
const CREATE_COOLDOWN_MS = 30_000;
const REMINDER_THRESHOLD_MIN = 10;
const RECONCILE_INTERVAL_MS = 5 * 60_000;

// ── Module state ──────────────────────────────────────────────────────────────

let deps: GiveawayDeps | null = null;
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeReminderTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** join/leave cooldown: `${giveawayId}:${userId}` → expiry ms */
const joinLeaveCooldown = new Map<string, number>();
/** create cooldown: `userId` → expiry ms */
const createCooldown = new Map<string, number>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateShortId(): string {
  let id = '';
  for (let i = 0; i < SHORT_ID_LEN; i++) {
    id += SHORT_ID_CHARS[Math.floor(Math.random() * SHORT_ID_CHARS.length)];
  }
  return id;
}

async function uniqueShortId(prisma: PrismaClient): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = generateShortId();
    const existing = await prisma.giveaway.findUnique({ where: { shortId: candidate } });
    if (!existing) return candidate;
  }
  return uuidv4().replace(/-/g, '').slice(0, SHORT_ID_LEN).toUpperCase();
}

function safeBroadcast(payload: object): void {
  try {
    deps?.broadcast(payload);
  } catch (err) {
    logger.error({ err }, 'giveawayService: broadcast failed (non-fatal)');
  }
}

function broadcastGiveawayUpdate(giveawayId: string, shortId: string, entryCount: number, status: string): void {
  safeBroadcast({ type: 'giveaway:update', payload: { giveawayId, shortId, entryCount, status } });
}

function isJoinLeaveCoolingDown(giveawayId: string, userId: string): boolean {
  const key = `${giveawayId}:${userId}`;
  const exp = joinLeaveCooldown.get(key);
  if (!exp) return false;
  if (Date.now() >= exp) { joinLeaveCooldown.delete(key); return false; }
  return true;
}

function setJoinLeaveCooldown(giveawayId: string, userId: string): void {
  joinLeaveCooldown.set(`${giveawayId}:${userId}`, Date.now() + JOIN_LEAVE_COOLDOWN_MS);
}

function isCreateCoolingDown(userId: string): boolean {
  const exp = createCooldown.get(userId);
  if (!exp) return false;
  if (Date.now() >= exp) { createCooldown.delete(userId); return false; }
  return true;
}

function setCreateCooldown(userId: string): void {
  createCooldown.set(userId, Date.now() + CREATE_COOLDOWN_MS);
}

// Prune expired cooldown entries every 5 minutes.
const _cooldownPruneInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of joinLeaveCooldown.entries()) if (now >= exp) joinLeaveCooldown.delete(k);
  for (const [k, exp] of createCooldown.entries()) if (now >= exp) createCooldown.delete(k);
}, 5 * 60_000);
if (typeof _cooldownPruneInterval.unref === 'function') _cooldownPruneInterval.unref();

// ── Bot message builder ───────────────────────────────────────────────────────

function makeBotMessage(
  content: string,
  channelId: string,
  metadata: Record<string, unknown>,
): object {
  return {
    type: 'chat:message',
    payload: {
      id: uuidv4(),
      content,
      username: '[Vault-Tec]',
      userId: 'system',
      channelId,
      source: 'bot',
      timestamp: new Date().toISOString(),
      metadata,
    },
  };
}

// ── Draw ──────────────────────────────────────────────────────────────────────

async function drawWinner(giveawayId: string): Promise<void> {
  if (!deps) return;
  activeTimers.delete(giveawayId);
  const reminderTimer = activeReminderTimers.get(giveawayId);
  if (reminderTimer) { clearTimeout(reminderTimer); activeReminderTimers.delete(giveawayId); }

  const { prisma } = deps;

  try {
    const giveaway = await prisma.giveaway.findUnique({
      where: { id: giveawayId },
      include: { entries: true },
    });

    if (!giveaway || giveaway.status !== 'active') return;

    const entries = giveaway.entries;
    const winner = entries.length > 0
      ? entries[Math.floor(Math.random() * entries.length)]
      : null;

    // Atomic update — P2025 if cancelled concurrently.
    await prisma.giveaway.update({
      where: { id: giveawayId, status: 'active' },
      data: {
        status: 'completed',
        ...(winner ? { winnerId: winner.userId, winnerName: winner.username } : {}),
      },
    });

    // Set create cooldown so the creator can't immediately spam a new giveaway.
    setCreateCooldown(giveaway.createdByUserId);

    const sharedMeta: Record<string, unknown> = {
      type: 'giveaway_winner',
      giveawayId,
      shortId: giveaway.shortId,
      itemName: giveaway.itemName,
      createdByUserId: giveaway.createdByUserId,
      creatorName: giveaway.creatorName,
      winnerName: winner?.username ?? null,
      entryCount: entries.length,
    };

    const content = winner
      ? `🎉 Giveaway winner: ${winner.username}! Prize: ${giveaway.itemName} (started by ${giveaway.creatorName}) [${giveaway.shortId}]`
      : `🎁 Giveaway ended - no entries. [${giveaway.shortId}] ${giveaway.itemName}`;

    safeBroadcast(makeBotMessage(content, giveaway.channelId, sharedMeta));
    broadcastGiveawayUpdate(giveawayId, giveaway.shortId, entries.length, 'completed');

    logger.info(
      { giveawayId, shortId: giveaway.shortId, winner: winner?.username ?? null },
      winner ? 'Giveaway drawn' : 'Giveaway drawn - no entries',
    );
  } catch (err: any) {
    if (err?.code === 'P2025') {
      logger.info({ giveawayId }, 'drawWinner: giveaway already cancelled before draw (race avoided)');
      return;
    }
    // Non-P2025 DB error: giveaway stays active. The periodic reconcileActive sweep
    // will re-schedule the draw on the next tick.
    logger.error({ err, giveawayId }, 'drawWinner: DB error — giveaway remains active and will be retried by reconcileActive');
  }
}

function scheduleReminder(giveaway: { id: string; shortId: string; itemName: string; channelId: string; durationMin: number; endsAt: Date }): void {
  if (giveaway.durationMin <= REMINDER_THRESHOLD_MIN) return;
  const halfwayMs = Math.max(0, giveaway.endsAt.getTime() - Date.now() - (giveaway.durationMin * 60 * 1000 / 2));
  const timer = setTimeout(() => {
    activeReminderTimers.delete(giveaway.id);
    if (!deps) return;
    const secsLeft = Math.max(0, Math.round((giveaway.endsAt.getTime() - Date.now()) / 1000));
    const minsLeft = secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)} min` : `${secsLeft}s`;
    safeBroadcast(makeBotMessage(
      `⏰ Reminder: giveaway still open! Prize: ${giveaway.itemName} - ${minsLeft} left to enter. /giveaway join ${giveaway.shortId}`,
      giveaway.channelId,
      {},
    ));
  }, halfwayMs);
  activeReminderTimers.set(giveaway.id, timer);
}

function scheduleTimer(giveawayId: string, endsAt: Date): void {
  const delayMs = Math.max(0, endsAt.getTime() - Date.now());
  const timer = setTimeout(() => { void drawWinner(giveawayId); }, delayMs);
  activeTimers.set(giveawayId, timer);
}

// ── Init & Reconcile ──────────────────────────────────────────────────────────

export async function init(injectedDeps: GiveawayDeps): Promise<void> {
  deps = injectedDeps;
  try {
    await reconcileActive();
  } catch (err) {
    logger.warn({ err }, 'giveawayService.reconcileActive failed at init (non-fatal - may be pending migration)');
  }

  // Periodic sweep: re-schedule any giveaway whose draw timer was lost (e.g. non-P2025 DB error).
  const _reconcileInterval = setInterval(() => { void reconcileActive(); }, RECONCILE_INTERVAL_MS);
  if (typeof _reconcileInterval.unref === 'function') _reconcileInterval.unref();
}

export async function reconcileActive(): Promise<void> {
  if (!deps) return;
  const { prisma } = deps;
  const now = new Date();

  const active = await prisma.giveaway.findMany({ where: { status: 'active' } });

  for (const g of active) {
    if (activeTimers.has(g.id)) continue;
    if (g.endsAt <= now) {
      void drawWinner(g.id);
    } else {
      scheduleTimer(g.id, g.endsAt);
      const halfwayAt = new Date(g.endsAt.getTime() - (g.durationMin * 60 * 1000 / 2));
      if (halfwayAt > now) {
        scheduleReminder({ id: g.id, shortId: g.shortId, itemName: g.itemName, channelId: g.channelId, durationMin: g.durationMin, endsAt: g.endsAt });
      }
    }
  }

  if (active.length > 0) {
    logger.info({ count: active.length }, 'Giveaway reconcile: timers restored');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createGiveaway(
  userId: string,
  username: string,
  channelId: string,
  itemName: string,
  durationMin: number,
): Promise<GiveawayRow> {
  if (!deps) throw new Error('giveawayService not initialised');
  const { prisma } = deps;

  const trimmed = itemName.trim();
  if (!trimmed || trimmed.length > MAX_ITEM_NAME_LEN) {
    throw new GiveawayError(`Item name must be 1-${MAX_ITEM_NAME_LEN} characters.`, 'INVALID_ARGS');
  }

  const sanitized = trimmed.replace(/[​-‏‪-‮⁠-⁤﻿]/g, '').trim();
  if (!sanitized) {
    throw new GiveawayError('Item name contains only invisible characters.', 'INVALID_ARGS');
  }

  const clampedDuration = Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, durationMin || DEFAULT_DURATION_MIN));

  const badPhrase = await findProhibitedPhrase(sanitized);
  if (badPhrase) {
    throw new GiveawayError('Item name contains a prohibited phrase.', 'INVALID_ARGS');
  }

  // Verify the channel exists (typed correctly — no 'as any' needed).
  const channel = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!channel) {
    throw new GiveawayError('Channel not found.', 'INVALID_ARGS');
  }

  if (isCreateCoolingDown(userId)) {
    throw new GiveawayError(`Please wait a moment before starting another giveaway.`, 'RATE_LIMITED');
  }

  const existing = await prisma.giveaway.count({
    where: { createdByUserId: userId, status: 'active' },
  });
  if (existing >= MAX_ACTIVE_PER_USER) {
    throw new GiveawayError('You already have an active giveaway. Stop it first.', 'CAP_REACHED');
  }

  const shortId = await uniqueShortId(prisma);
  const endsAt = new Date(Date.now() + clampedDuration * 60 * 1000);

  const giveaway = await prisma.giveaway.create({
    data: {
      shortId,
      createdByUserId: userId,
      creatorName: username,
      channelId,
      itemName: sanitized,
      durationMin: clampedDuration,
      endsAt,
      status: 'active',
    },
  });

  scheduleTimer(giveaway.id, endsAt);
  scheduleReminder({ id: giveaway.id, shortId, itemName: sanitized, channelId, durationMin: clampedDuration, endsAt });

  safeBroadcast(makeBotMessage(
    `🎁 ${username} started a giveaway! Prize: ${sanitized}. Type /giveaway join ${shortId} or click Join - ends in ${clampedDuration} min.`,
    channelId,
    {
      type: 'giveaway',
      giveawayId: giveaway.id,
      shortId,
      itemName: sanitized,
      creatorName: username,
      createdByUserId: userId,
      endsAt: endsAt.toISOString(),
      durationMin: clampedDuration,
      entryCount: 0,
    },
  ));

  logger.info({ giveawayId: giveaway.id, shortId, userId, itemName: sanitized, durationMin: clampedDuration }, 'Giveaway created');
  return giveaway as unknown as GiveawayRow;
}

export async function joinGiveaway(
  shortId: string,
  userId: string,
  username: string,
): Promise<{ entryCount: number }> {
  if (!deps) throw new Error('giveawayService not initialised');
  const { prisma } = deps;

  const giveaway = await prisma.giveaway.findUnique({ where: { shortId } });
  if (!giveaway) throw new GiveawayError(`No active giveaway with ID ${shortId}.`, 'NOT_FOUND');
  if (giveaway.status !== 'active') throw new GiveawayError(`Giveaway ${shortId} is no longer active.`, 'NOT_ACTIVE');
  if (giveaway.createdByUserId === userId) throw new GiveawayError(`You can't enter your own giveaway.`, 'OWN_GIVEAWAY');

  // Check if already entered BEFORE setting the cooldown — re-clicking Join
  // on an existing entry should not block the user from immediately Leaving.
  const existing = await prisma.giveawayEntry.findUnique({
    where: { giveawayId_userId: { giveawayId: giveaway.id, userId } },
  });

  if (!existing && isJoinLeaveCoolingDown(giveaway.id, userId)) {
    throw new GiveawayError('Please wait a moment before joining again.', 'RATE_LIMITED');
  }
  if (!existing) setJoinLeaveCooldown(giveaway.id, userId);

  await prisma.giveawayEntry.upsert({
    where: { giveawayId_userId: { giveawayId: giveaway.id, userId } },
    create: { giveawayId: giveaway.id, userId, username },
    update: {},
  });

  const entryCount = await prisma.giveawayEntry.count({ where: { giveawayId: giveaway.id } });

  if (!existing) {
    broadcastGiveawayUpdate(giveaway.id, shortId, entryCount, 'active');
  }

  return { entryCount };
}

export async function leaveGiveaway(
  shortId: string,
  userId: string,
): Promise<{ entryCount: number }> {
  if (!deps) throw new Error('giveawayService not initialised');
  const { prisma } = deps;

  const giveaway = await prisma.giveaway.findUnique({ where: { shortId } });
  if (!giveaway) throw new GiveawayError(`No active giveaway with ID ${shortId}.`, 'NOT_FOUND');
  if (giveaway.status !== 'active') throw new GiveawayError(`Giveaway ${shortId} is no longer active.`, 'NOT_ACTIVE');

  if (isJoinLeaveCoolingDown(giveaway.id, userId)) {
    throw new GiveawayError('Please wait a moment before leaving again.', 'RATE_LIMITED');
  }
  setJoinLeaveCooldown(giveaway.id, userId);

  const deleted = await prisma.giveawayEntry.deleteMany({
    where: { giveawayId: giveaway.id, userId },
  });

  const entryCount = await prisma.giveawayEntry.count({ where: { giveawayId: giveaway.id } });

  if (deleted.count > 0) {
    broadcastGiveawayUpdate(giveaway.id, shortId, entryCount, 'active');
  }

  return { entryCount };
}

export async function cancelGiveaway(
  shortId: string,
  userId: string,
  isMod: boolean,
): Promise<void> {
  if (!deps) throw new Error('giveawayService not initialised');
  const { prisma } = deps;

  const giveaway = await prisma.giveaway.findUnique({ where: { shortId } });
  if (!giveaway) throw new GiveawayError(`No giveaway with ID ${shortId}.`, 'NOT_FOUND');
  if (giveaway.status !== 'active') throw new GiveawayError(`Giveaway ${shortId} is not active.`, 'NOT_ACTIVE');
  if (giveaway.createdByUserId !== userId && !isMod) {
    throw new GiveawayError('Only the creator or a moderator can stop this giveaway.', 'FORBIDDEN');
  }

  const timer = activeTimers.get(giveaway.id);
  if (timer) { clearTimeout(timer); activeTimers.delete(giveaway.id); }
  const reminderTimer = activeReminderTimers.get(giveaway.id);
  if (reminderTimer) { clearTimeout(reminderTimer); activeReminderTimers.delete(giveaway.id); }

  try {
    await prisma.giveaway.update({ where: { id: giveaway.id, status: 'active' }, data: { status: 'cancelled' } });
  } catch (err: any) {
    if (err?.code === 'P2025') {
      throw new GiveawayError(`Giveaway ${shortId} completed before it could be cancelled.`, 'NOT_ACTIVE');
    }
    throw err;
  }

  // Apply create cooldown so the creator can't immediately restart.
  setCreateCooldown(giveaway.createdByUserId);

  const entryCount = await prisma.giveawayEntry.count({ where: { giveawayId: giveaway.id } });

  safeBroadcast(makeBotMessage(
    `❌ Giveaway cancelled: ${giveaway.itemName} [${shortId}]`,
    giveaway.channelId,
    {
      type: 'giveaway_winner',
      giveawayId: giveaway.id,
      shortId,
      itemName: giveaway.itemName,
      createdByUserId: giveaway.createdByUserId,
      creatorName: giveaway.creatorName,
      winnerName: null,
      entryCount,
      cancelled: true,
    },
  ));
  broadcastGiveawayUpdate(giveaway.id, shortId, entryCount, 'cancelled');
  logger.info({ giveawayId: giveaway.id, shortId, cancelledBy: userId, isMod }, 'Giveaway cancelled');
}

export async function listActive(): Promise<GiveawayWithCount[]> {
  if (!deps) throw new Error('giveawayService not initialised');
  const { prisma } = deps;

  const rows = await prisma.giveaway.findMany({
    where: { status: 'active' },
    orderBy: { endsAt: 'asc' },
    include: { _count: { select: { entries: true } } },
  });

  return rows.map(r => ({ ...(r as unknown as GiveawayRow), entryCount: r._count.entries }));
}

export async function listRecent(limit: number): Promise<GiveawayWithCount[]> {
  if (!deps) throw new Error('giveawayService not initialised');
  const { prisma } = deps;

  const clamped = Math.min(10, Math.max(1, limit));

  const rows = await prisma.giveaway.findMany({
    where: { status: { in: ['completed', 'cancelled'] } },
    orderBy: { createdAt: 'desc' },
    take: clamped,
    include: { _count: { select: { entries: true } } },
  });

  return rows.map(r => ({ ...(r as unknown as GiveawayRow), entryCount: r._count.entries }));
}
