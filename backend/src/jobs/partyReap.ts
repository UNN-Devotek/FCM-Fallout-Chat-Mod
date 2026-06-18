/**
 * Party reap sweep.
 *
 * Runs every ~60 seconds.
 *
 * Three passes each tick:
 *   1. Ephemeral parties with 0 online members → soft-delete + party:deleted broadcast + audit.
 *   2. Persistent parties with 0 members (no membership rows) → GC soft-delete (defensive).
 *   3. Expire pending PartyInvites older than 7 days.
 *
 * Model mirrors stalePresence.ts: DI deps for testability, setInterval + startup reconcile.
 */

import { PrismaClient } from '@prisma/client';
import logger from '../config/logger';
import { makeJobTracker } from './jobTracker';

export const REAP_INTERVAL_MS = 60_000;
const INVITE_EXPIRY_DAYS = 7;

export interface PartyReapDeps {
  prisma: {
    party: Pick<PrismaClient['party'], 'findMany' | 'update'>;
    partyMember: Pick<PrismaClient['partyMember'], 'findMany' | 'count'>;
    partyInvite: Pick<PrismaClient['partyInvite'], 'updateMany'>;
    auditLog: Pick<PrismaClient['auditLog'], 'create'>;
  };
  /** Returns a Set of userIds that currently have an OPEN WebSocket. */
  getOnlineUserIds: () => Set<string>;
  /** Broadcasts a payload to a list of member user IDs. Fire-and-forget. */
  broadcastToPartyMembers: (payload: any, memberUserIds: string[]) => Promise<number>;
  /** Override the wall clock for tests. */
  now?: () => Date;
}

export interface PartyReapResult {
  ephemeralReaped: string[];
  persistentGCd: string[];
  invitesExpired: number;
}

export async function runPartyReap(deps: PartyReapDeps): Promise<PartyReapResult> {
  const now = (deps.now ?? (() => new Date()))();
  const ephemeralReaped: string[] = [];
  const persistentGCd: string[] = [];
  let invitesExpired = 0;

  // Collect failures of whole top-level passes (not individual party rows — a
  // single bad row is logged and skipped). If any top-level pass fails we throw
  // an aggregate at the end so the job tracker can count consecutive failures
  // and escalate warn → error once the threshold is hit. Without re-throwing,
  // the tracker's promise always resolves and the escalation is dead code.
  const passFailures: { pass: string; err: unknown }[] = [];

  try {
    // ── Pass 1: Ephemeral parties with 0 online members ──────────────────────
    const ephemeralParties = await deps.prisma.party.findMany({
      where: { isDeleted: false, reapPolicy: 'ephemeral' },
      select: { id: true },
    });

    for (const ep of ephemeralParties) {
      try {
        const members = await deps.prisma.partyMember.findMany({
          where: { partyId: ep.id },
          select: { userId: true },
        });
        const memberIds = members.map(m => m.userId);
        const onlineIds = deps.getOnlineUserIds();
        const onlineCount = memberIds.filter(id => onlineIds.has(id)).length;

        if (onlineCount > 0) continue;

        // Soft-delete
        await deps.prisma.party.update({
          where: { id: ep.id },
          data: { isDeleted: true },
        });

        // Audit
        await deps.prisma.auditLog.create({
          data: {
            actorId: null,
            action: 'party_reap',
            targetId: ep.id,
            targetType: 'party',
            metadata: { reason: 'ephemeral-no-online', memberCount: memberIds.length },
          },
        } as any);

        // Broadcast party:deleted to members
        try {
          await deps.broadcastToPartyMembers(
            { type: 'party:deleted', payload: { partyId: ep.id } },
            memberIds,
          );
        } catch (err) {
          logger.warn({ err, partyId: ep.id }, '[partyReap] broadcastToPartyMembers failed (non-fatal)');
        }

        ephemeralReaped.push(ep.id);
        logger.info({ partyId: ep.id, memberCount: memberIds.length }, '[partyReap] ephemeral party reaped');
      } catch (err) {
        logger.warn({ err, partyId: ep.id }, '[partyReap] error processing ephemeral party (non-fatal)');
      }
    }
  } catch (err) {
    logger.warn({ err }, '[partyReap] ephemeral scan failed (non-fatal)');
    passFailures.push({ pass: 'ephemeral', err });
  }

  try {
    // ── Pass 2: Persistent parties with 0 members — defensive GC ─────────────
    const persistentParties = await deps.prisma.party.findMany({
      where: { isDeleted: false, reapPolicy: 'persistent' },
      select: { id: true },
    });

    for (const pp of persistentParties) {
      try {
        const memberCount = await deps.prisma.partyMember.count({ where: { partyId: pp.id } });
        if (memberCount > 0) continue;

        await deps.prisma.party.update({
          where: { id: pp.id },
          data: { isDeleted: true },
        });
        await deps.prisma.auditLog.create({
          data: {
            actorId: null,
            action: 'party_reap',
            targetId: pp.id,
            targetType: 'party',
            metadata: { reason: 'persistent-zero-members' },
          },
        } as any);

        persistentGCd.push(pp.id);
        logger.info({ partyId: pp.id }, '[partyReap] persistent party GC\'d (0 members)');
      } catch (err) {
        logger.warn({ err, partyId: pp.id }, '[partyReap] error GCing persistent party (non-fatal)');
      }
    }
  } catch (err) {
    logger.warn({ err }, '[partyReap] persistent GC scan failed (non-fatal)');
    passFailures.push({ pass: 'persistent', err });
  }

  try {
    // ── Pass 3: Expire stale pending invites ──────────────────────────────────
    const cutoff = new Date(now.getTime() - INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const result = await deps.prisma.partyInvite.updateMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      data: { status: 'expired' },
    });
    invitesExpired = result.count;
    if (invitesExpired > 0) {
      logger.info({ invitesExpired, cutoff }, '[partyReap] expired stale invites');
    }
  } catch (err) {
    logger.warn({ err }, '[partyReap] invite expiry scan failed (non-fatal)');
    passFailures.push({ pass: 'invites', err });
  }

  // If one or more whole passes failed, surface it to the caller (the job
  // tracker) so consecutive-failure escalation can fire. We still completed
  // whatever passes succeeded; the partial results are dropped because the
  // tick is reported as failed.
  if (passFailures.length > 0) {
    const failedPasses = passFailures.map(f => f.pass).join(', ');
    throw new AggregateError(
      passFailures.map(f => f.err),
      `[partyReap] ${passFailures.length} pass(es) failed: ${failedPasses}`,
    );
  }

  return { ephemeralReaped, persistentGCd, invitesExpired };
}

/**
 * Wire the recurring job. Returns a stop function for graceful shutdown.
 *
 * Overlap guard: a single `running` flag is shared by BOTH the startup
 * reconcile pass and every interval tick, so two passes never execute
 * concurrently against the same rows. The startup reconcile sets the flag, so
 * if the first interval fires before that reconcile finishes it is skipped.
 */
export function startPartyReapJob(deps: PartyReapDeps): () => void {
  let running = false;
  const tracked = makeJobTracker('[partyReap]');

  // Run one reap pass under BOTH the shared overlap guard AND the failure
  // tracker. The overlap guard (`running`) ensures the startup reconcile and
  // every interval tick never execute concurrently against the same rows. The
  // tracker observes each run's outcome: runPartyReap re-throws whole-pass
  // failures (see its AggregateError), so consecutive failures escalate
  // warn → error. The tracker swallows the rejection (counting it for
  // escalation) and always resolves, so `.finally` reliably clears `running`;
  // errors are never floated unhandled.
  const runGuardedTick = (label: 'startup reconcile' | 'tick'): void => {
    if (running) {
      logger.warn(`[partyReap] previous tick still running — skipping this ${label}`);
      return;
    }
    running = true;
    void tracked(() => runPartyReap(deps).then(() => {})).finally(() => {
      running = false;
    });
  };

  // Run once at startup to reconcile any parties that should have been reaped.
  // This goes through the same guard so it cannot overlap the first interval tick.
  runGuardedTick('startup reconcile');

  const interval = setInterval(() => runGuardedTick('tick'), REAP_INTERVAL_MS);

  // Don't keep the event loop alive on shutdown.
  if (typeof (interval as any).unref === 'function') (interval as any).unref();
  return () => clearInterval(interval);
}
