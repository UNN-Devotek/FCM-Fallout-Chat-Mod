import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import env from '../../config/environment';
import prisma from '../../config/prisma';
import { getRedisClient } from '../../config/redis';
import { applyRoomAssignments, clearRoomMembership, coordinateRooms } from './roomCoordinator';
import { canRestoreRoomAffinity, normalizeRosterName, readRoster, setRoster } from './worldRosterService';
import { getWorldId, setWorldId } from './worldIdService';
import type { BridgeResolution } from './overlayServerBridge';
import { opaqueRef, recordRoomDiagnostic } from './roomDiagnostics';

export const LOCAL_OBSERVATION_MS = 30_000;
export const SOFT_LEAVE_MS = 30_000;
export const BRIDGE_LEAVE_REASONS = ['observation_timeout', 'game_exit', 'main_menu', 'explicit_inactive',
  'account_change', 'socket_replaced', 'app_quit', 'invalid_export', 'provider_conflict'] as const;
export type BridgeLeaveReason = typeof BRIDGE_LEAVE_REASONS[number];
export function isBridgeLeaveReason(value: unknown): value is BridgeLeaveReason {
  return typeof value === 'string' && (BRIDGE_LEAVE_REASONS as readonly string[]).includes(value);
}
const nonce = z.string().regex(/^[a-z0-9-]{1,64}$/);
const observationSchema = z.strictObject({
  schemaVersion: z.literal(1), environment: z.enum(['dev', 'prod']), provider: z.enum(['zfe', 'xscal']),
  build: z.string().min(1).max(64), sessionId: nonce, worldGeneration: nonce,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observationSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observationAgeMs: z.number().min(0).max(60_000), state: z.enum(['active', 'holding', 'inactive']),
  ownName: z.string().max(64), names: z.array(z.string().max(64)).max(24),
});
export type LocalBridgeObservation = z.infer<typeof observationSchema>;

export function localBridgeEnvironment(): 'dev' | 'prod' | null {
  if (env.NODE_ENV !== 'production') return 'dev';
  try {
    const host = new URL(env.FCM_PUBLIC_BASE_URL).hostname;
    if (host === 'dev.falloutchatmod.com') return 'dev';
    if (host === 'falloutchatmod.com' || host === 'www.falloutchatmod.com') return 'prod';
  } catch { /* An unknown deployment must explicitly configure its public URL. */ }
  return null;
}

export function parseLocalBridgeObservation(value: unknown): LocalBridgeObservation | null {
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 8192) return null;
    const result = observationSchema.safeParse(value);
    return result.success ? result.data : null;
  } catch { return null; }
}

interface ObservationState {
  owner: string;
  snapshot: LocalBridgeObservation | null;
  expiresAt: number;
  active: boolean;
  retiredSessions: string[];
  retiredWorlds: string[];
  softLeaveUntil?: number;
  affinity?: { roomKey: string; lastDirectEvidenceAt: number; sessionStartedAt: number };
}
const STATE_SECONDS = 86_400;
const MAX_RETIRED_GENERATIONS = 512;
const requestIdFor = (snapshot: LocalBridgeObservation): string => createHash('sha256')
  .update(`${snapshot.sessionId}\0${snapshot.worldGeneration}`).digest('hex');

/** One authenticated desktop session, owned by exactly one socket. The token
 * remains backend-only; neither exported metadata nor an account-wide lease can
 * choose another device's actor. Redis state survives WS replacement. */
export class LocalExportBridge {
  readonly actorId: string;
  private readonly owner = randomUUID();
  private readonly stateKey: string;
  private initialized: Promise<void> | undefined;
  private closeTask: Promise<void> | undefined;
  private closed = false;
  private activityEpoch = 0;
  private revoked = false;
  private softLeaveTimer: NodeJS.Timeout | undefined;
  private readonly connectionKey: string;
  private readonly connectionOrder: Promise<number>;

  constructor(private readonly accountId: string, private readonly token: string,
    private readonly isCurrent: () => boolean, private readonly isInGame: () => boolean = () => true) {
    this.actorId = `overlay_${createHash('sha256').update(`${accountId}\0${token}`).digest('hex')}`;
    this.stateKey = `relay:local-export:${this.actorId}`;
    this.connectionKey = `${this.stateKey}:connection`;
    // Reserve ownership when the authenticated socket is constructed, NOT when
    // it eventually watches/observes. An older lazy socket cannot steal a newer
    // connection's actor on a different backend replica.
    this.connectionOrder = getRedisClient().then(async redis => {
      const order = await redis.incr(this.connectionKey);
      await redis.expire(this.connectionKey, STATE_SECONDS);
      return order;
    }).catch(() => 0); // Storage failure denies ownership; no unhandled startup rejection.
  }

  private async ownsConnection(): Promise<boolean> {
    const order = await this.connectionOrder;
    return order > 0 && await (await getRedisClient()).get(this.connectionKey) === String(order);
  }

  private async readState(): Promise<ObservationState | null> {
    const raw = await (await getRedisClient()).get(this.stateKey);
    return raw ? JSON.parse(raw) as ObservationState : null;
  }
  private async save(state: ObservationState): Promise<void> {
    await (await getRedisClient()).set(this.stateKey, JSON.stringify(state), { EX: STATE_SECONDS });
  }
  private async authenticated(): Promise<boolean> {
    if (this.closed || !this.isCurrent() || !(await this.ownsConnection())) return false;
    const redis = await getRedisClient();
    if (await redis.get(`session:${this.token}`) !== this.accountId) return false;
    const user = await prisma.user.findUnique({ where: { id: this.accountId }, select: { isBanned: true, kickedUntil: true } });
    return !!user && !user.isBanned && !(user.kickedUntil && +user.kickedUntil > Date.now())
      && !this.closed && this.isCurrent() && await this.ownsConnection();
  }

  private cancelSoftLeaveTimer(): void {
    if (this.softLeaveTimer) clearTimeout(this.softLeaveTimer);
    this.softLeaveTimer = undefined;
  }

  private scheduleSoftLeaveExpiry(until: number): void {
    this.cancelSoftLeaveTimer();
    this.softLeaveTimer = setTimeout(() => { void this.expireSoftLeave(until).catch(() => {}); }, Math.max(1, until - Date.now()));
    this.softLeaveTimer.unref?.();
  }

  private async expireSoftLeave(until: number): Promise<void> {
    await coordinateRooms(async assertCurrent => {
      const state = await this.readState();
      if (!state || state.owner !== this.owner || state.active || state.softLeaveUntil !== until
        || state.softLeaveUntil > Date.now()) return;
      await assertCurrent();
      delete state.softLeaveUntil;
      await this.save(state);
      await clearRoomMembership(this.actorId, assertCurrent);
      await recordRoomDiagnostic(this.actorId, { event: 'soft_leave_expired', reason: 'observation_timeout' });
    });
  }

  initialize(): Promise<void> {
    return this.initialized ??= coordinateRooms(async assertCurrent => {
      if (!(await this.authenticated())) return;
      const prior = await this.readState();
      await assertCurrent();
      await this.save({ ...(prior ?? { snapshot: null, expiresAt: 0, retiredSessions: [], retiredWorlds: [] }),
        owner: this.owner, active: false });
      await clearRoomMembership(this.actorId, assertCurrent);
    }).catch(error => { this.initialized = undefined; throw error; });
  }

  /** Invalid, stale and replayed payloads never create/renew membership. */
  async observe(value: unknown, receivedAt = Date.now()): Promise<boolean> {
    const epoch = this.activityEpoch;
    const snapshot = parseLocalBridgeObservation(value);
    if (!snapshot || snapshot.environment !== localBridgeEnvironment()) return false;
    await this.initialize();
    return coordinateRooms(async assertCurrent => {
      if (!this.isInGame() || !(await this.authenticated()) || epoch !== this.activityEpoch) return false;
      const state = await this.readState();
      if (!state || state.owner !== this.owner) return false;
      if (state.softLeaveUntil !== undefined && state.softLeaveUntil <= Date.now()) {
        await clearRoomMembership(this.actorId, assertCurrent);
        delete state.softLeaveUntil;
      }
      const old = state.snapshot;
      const sessionChanged = !!old && snapshot.sessionId !== old.sessionId;
      const worldChanged = !!old && (sessionChanged || snapshot.worldGeneration !== old.worldGeneration);
      if (state.retiredSessions.includes(snapshot.sessionId)
        || state.retiredWorlds.includes(`${snapshot.sessionId}/${snapshot.worldGeneration}`)
        || (old && !sessionChanged && snapshot.sequence <= old.sequence)
        || (old && !sessionChanged && snapshot.observationSequence < old.observationSequence)) return false;
      if (state.retiredSessions.length + state.retiredWorlds.length >= MAX_RETIRED_GENERATIONS) return false;
      const sameObservation = !!old && !sessionChanged && snapshot.observationSequence === old.observationSequence;
      if (this.revoked && sameObservation) return false;
      if (snapshot.state !== 'inactive' && sameObservation && (worldChanged || normalizeRosterName(old.ownName) !== normalizeRosterName(snapshot.ownName)
        || JSON.stringify(old.names.map(normalizeRosterName).sort()) !== JSON.stringify(snapshot.names.map(normalizeRosterName).sort())
        || old.provider !== snapshot.provider)) return false;
      // A holding heartbeat may only preserve a known observation; it may not
      // invent one or move its expiry forward, even with a new writer sequence.
      if (snapshot.state === 'holding' && (!sameObservation || !state.active)) return false;
      const deadline = receivedAt + LOCAL_OBSERVATION_MS - snapshot.observationAgeMs;
      const expiresAt = sameObservation ? Math.min(state.expiresAt, deadline) : deadline;
      const fresh = snapshot.state !== 'inactive' && expiresAt > Date.now() && !!normalizeRosterName(snapshot.ownName);
      if (sameObservation && fresh) {
        // File publication is not new roster evidence. A heartbeat cannot renew
        // the roster, restore a cleared membership, recompute peers or replay
        // their history. Only a tighter age bound may shorten persisted expiry.
        const roster = await readRoster(this.actorId);
        const room = await getWorldId(this.actorId);
        if (epoch !== this.activityEpoch || !this.isInGame()) return false;
        state.active = state.active && roster?.requestId === requestIdFor(snapshot) && !!room;
        await assertCurrent();
        if (state.active && room && expiresAt < state.expiresAt) {
          await setRoster(this.actorId, snapshot.ownName, snapshot.names, requestIdFor(snapshot), expiresAt, [],
            { observationSource: `bridge:${snapshot.provider}` });
          await setWorldId(this.actorId, room, expiresAt);
        }
        state.snapshot = snapshot;
        state.expiresAt = expiresAt;
        await this.save(state);
        return epoch === this.activityEpoch && this.isInGame();
      }
      if (sessionChanged && old) state.retiredSessions.push(old.sessionId);
      if (worldChanged && old) state.retiredWorlds.push(`${old.sessionId}/${old.worldGeneration}`);
      await assertCurrent();
      if (epoch !== this.activityEpoch || !this.isInGame()) return false;
      if (worldChanged || !fresh) await clearRoomMembership(this.actorId, assertCurrent);
      state.snapshot = snapshot;
      state.expiresAt = expiresAt;
      state.active = false; // Assignment must finish before any ready confirmation.
      const recoveringSoftLeave = state.softLeaveUntil !== undefined && state.softLeaveUntil > Date.now()
        && !worldChanged;
      const restoreAffinity = recoveringSoftLeave && state.affinity
        && await canRestoreRoomAffinity(this.actorId, state.affinity.roomKey, snapshot.names,
          state.affinity.lastDirectEvidenceAt, Date.now()) ? state.affinity : undefined;
      delete state.softLeaveUntil;
      await this.save(state);
      if (!fresh) return true;
      // A replay after expiry cannot revive a room even if it reports age zero.
      await setRoster(this.actorId, snapshot.ownName, snapshot.names, requestIdFor(snapshot), expiresAt, [],
        { observationSource: `bridge:${snapshot.provider}`, ...(restoreAffinity ? { restoreAffinity } : {}) });
      await applyRoomAssignments(this.actorId, assertCurrent);
      await assertCurrent();
      if (!this.isInGame() || !(await this.authenticated()) || epoch !== this.activityEpoch || expiresAt <= Date.now()) {
        await clearRoomMembership(this.actorId, assertCurrent);
        return false;
      }
      await assertCurrent();
      state.active = true;
      const roster = await readRoster(this.actorId);
      const assignedRoom = await getWorldId(this.actorId);
      state.affinity = assignedRoom && roster?.lastDirectEvidenceAt !== undefined ? {
        roomKey: assignedRoom, lastDirectEvidenceAt: roster.lastDirectEvidenceAt,
        sessionStartedAt: roster.sessionStartedAt ?? Date.now(),
      } : undefined;
      await this.save(state);
      if (epoch !== this.activityEpoch || !this.isInGame()) return false;
      this.revoked = false;
      this.cancelSoftLeaveTimer();
      if (recoveringSoftLeave) await recordRoomDiagnostic(this.actorId, {
        event: 'soft_leave_recovered', reason: restoreAffinity ? 'shared_population' : 'new_room',
        roomRef: opaqueRef(await getWorldId(this.actorId) ?? ''),
      });
      return true;
    });
  }

  async resolve(): Promise<BridgeResolution> {
    const epoch = this.activityEpoch;
    await this.initialize();
    if (this.revoked || !this.isInGame() || !(await this.authenticated())) return { status: 'inactive' };
    const state = await this.readState();
    const snapshot = state?.snapshot;
    if (!state || state.owner !== this.owner || !state.active || !snapshot || state.expiresAt <= Date.now()) return { status: 'inactive' };
    const requestId = requestIdFor(snapshot);
    const roster = await readRoster(this.actorId);
    const room = await getWorldId(this.actorId);
    if (!room?.startsWith('r:') || roster?.requestId !== requestId) return { status: 'inactive' };
    // Auth, owner, expiry and generation can change during any storage read.
    const latest = await this.readState();
    if (this.closed || this.revoked || epoch !== this.activityEpoch || !this.isCurrent() || !this.isInGame() || !(await this.ownsConnection())
      || latest?.owner !== this.owner || !latest.active
      || latest.expiresAt <= Date.now() || !latest.snapshot || requestIdFor(latest.snapshot) !== requestId
      || await (await getRedisClient()).get(`session:${this.token}`) !== this.accountId
      || await getWorldId(this.actorId) !== room) return { status: 'inactive' };
    return { status: 'ready', binding: { accountId: this.accountId, relayUserId: this.actorId,
      requestId, room, displayName: snapshot.ownName.trim(), sessionId: snapshot.sessionId,
      worldGeneration: snapshot.worldGeneration, sequence: snapshot.sequence } };
  }

  async leave(reason: BridgeLeaveReason = 'explicit_inactive'): Promise<void> {
    this.invalidate();
    if (!this.initialized) return;
    await this.initialized;
    const soft = reason === 'observation_timeout';
    let softUntil: number | undefined;
    await coordinateRooms(async assertCurrent => {
      const state = await this.readState();
      if (!state || state.owner !== this.owner) return;
      await assertCurrent();
      state.active = false;
      // Preserve replay watermarks, including on socket replacement.
      if (soft) {
        const roster = await readRoster(this.actorId);
        const roomKey = await getWorldId(this.actorId);
        if (roomKey && roster?.lastDirectEvidenceAt !== undefined) state.affinity = {
          roomKey, lastDirectEvidenceAt: roster.lastDirectEvidenceAt,
          sessionStartedAt: roster.sessionStartedAt ?? Date.now(),
        };
        const started = state.softLeaveUntil === undefined;
        softUntil = state.softLeaveUntil ?? Date.now() + SOFT_LEAVE_MS;
        state.softLeaveUntil = softUntil;
        await this.save(state);
        if (started) await recordRoomDiagnostic(this.actorId, { event: 'soft_leave_started', reason,
          roomRef: opaqueRef(await getWorldId(this.actorId) ?? '') });
      } else {
        delete state.softLeaveUntil;
        await this.save(state);
      }
      // Authority is always removed immediately. Soft loss preserves only the
      // private tombstone above, never a live roster/world membership.
      await clearRoomMembership(this.actorId, assertCurrent);
    });
    if (softUntil !== undefined) this.scheduleSoftLeaveExpiry(softUntil);
    else this.cancelSoftLeaveTimer();
  }

  /** Synchronous fence: queued cleanup must not allow an old observation to
   * publish a ready confirmation while awaiting storage/moderation work. */
  invalidate(): void { this.activityEpoch++; this.revoked = true; }

  close(): Promise<void> { this.closed = true; this.invalidate(); return this.closeTask ??= this.leave('socket_replaced'); }
}
