import { safeDiagnostic, safeFailureEvidence, safeInspectionFailure, safeInspectionDetail } from './failureEvidence';
import { AsyncLocalStorage, createHook, type AsyncHook } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { claimProcessFence, fenceNames, inheritedProcessFence, syncControlDirectory, type ProcessFence } from './bootstrap';
import { DiscordRelayJournal } from './discordRelayJournal';

export class MaintenanceError extends Error {
  readonly retryAfterMs = 30_000;
  constructor() { super('Maintenance in progress. Please retry shortly.'); }
}

type Work = { id: string; label: string; rootOpen: boolean; promises: Set<number> };
export type DrainInspection = { pending: number; failures?: unknown[]; detail?: unknown };
export type DrainParticipant = { inspect: () => Promise<DrainInspection>; close?: () => Promise<void> };
export type RuntimeFailure = { id: string; label: string; at: string; message: string; errorClass?: string; errorCode?: string | number; evidence?: unknown };
type Phase = 'running' | 'frozen' | 'draining' | 'drained' | 'closing' | 'failed' | 'closed';
type DrainOptions = { timeoutMs: number; close?: boolean; closeIngress?: () => Promise<void>; maintenance?: boolean };
type DrainRequest = { deadline: number; close: boolean; maintenance: boolean; ingress: Set<() => Promise<void>> };

/** A process-local accounting boundary, fenced by an operator-owned durable file.
 * Promise resources capture detached .then()/void work inside an admitted handler.
 * Callback-only middleware uses an explicit lease; disconnect is not completion.
 */
export class RuntimeCoordinator {
  readonly discordRelays: DiscordRelayJournal;
  readonly markerPath: string;
  readonly checkpointPath: string;
  readonly failuresPath: string;
  private phase: Phase;
  private readonly context = new AsyncLocalStorage<Work | undefined>();
  private readonly work = new Map<string, Work>();
  private readonly promiseOwners = new Map<number, Work>();
  private readonly producers = new Map<string, { label: string; stop: () => void; schedule?: unknown }>();
  private readonly stoppedProducers: Array<{ label: string; schedule?: unknown }> = [];
  private readonly participants = new Map<string, DrainParticipant>();
  private readonly closedParticipants = new Set<string>();
  private readonly failures: RuntimeFailure[] = [];
  private readonly hook: AsyncHook;
  private drainPromise: Promise<ReturnType<RuntimeCoordinator['snapshot']>> | undefined;
  private drainRequest: DrainRequest | undefined;
  private readonly ingressClosures = new Map<() => Promise<void>, Promise<void>>();
  private readonly closedIngress = new Set<() => Promise<void>>();
  private restartFence: ProcessFence | undefined;
  private operatorRequested = false;
  private operatorMarkerPersisted = false;
  private accountingEpoch = 0;
  private inspectionEpoch: number | null = null;

  constructor(readonly controlDir: string, bootstrapNonce?: string) {
    this.discordRelays = new DiscordRelayJournal(controlDir);
    this.markerPath = path.join(controlDir, 'maintenance.json');
    this.checkpointPath = path.join(controlDir, 'checkpoint.json');
    this.failuresPath = path.join(controlDir, 'failures.jsonl');
    this.restartFence = bootstrapNonce
      ? inheritedProcessFence(controlDir, bootstrapNonce, process.pid)
      : claimProcessFence(controlDir, process.pid);
    this.phase = this.otherFenceNames().length || !this.restartFence || this.discordRelays.inspect().pending ? 'frozen' : 'running';
    this.registerParticipant('discord-relays', { inspect: async () => this.discordRelays.inspect() });
    if (existsSync(this.failuresPath)) {
      for (const line of readFileSync(this.failuresPath, 'utf8').split('\n').filter(Boolean)) {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || !('id' in value) || !('label' in value)) {
          throw new Error('Invalid runtime failure journal; operator recovery required');
        }
        const prior = value as RuntimeFailure;
        this.failures.push({ id: prior.id, label: prior.label, at: prior.at, ...safeDiagnostic(prior),
          ...(safeFailureEvidence(prior.evidence) ? { evidence: safeFailureEvidence(prior.evidence) } : {}) });
      }
      if (this.failures.length) this.phase = 'failed';
    }
    this.hook = createHook({
      init: (id, type) => {
        if (type !== 'PROMISE') return;
        const owner = this.context.getStore();
        if (!owner || !this.work.has(owner.id)) return;
        owner.promises.add(id);
        this.promiseOwners.set(id, owner);
      },
      promiseResolve: (id) => {
        const owner = this.promiseOwners.get(id);
        if (!owner) return;
        owner.promises.delete(id);
        this.promiseOwners.delete(id);
        this.releaseCompleted(owner);
      },
    });
    this.hook.enable();
  }

  isFrozen(): boolean {
    if (this.phase === 'running') {
      try {
        if (!this.restartFence || readFileSync(this.restartFence.path, 'utf8') !== this.restartFence.content) {
          throw new Error('Active process fence identity changed');
        }
      } catch (err) { this.recordFailure('restart-fence', err); this.freeze('active process fence changed'); }
      if (this.otherFenceNames().length) this.freeze('operator marker');
    }
    return this.phase !== 'running';
  }

  assertAdmission(): void {
    // Descendants of work already admitted before freeze may finish normally.
    const owner = this.context.getStore();
    if ((!owner || !this.work.has(owner.id)) && this.isFrozen()) throw new MaintenanceError();
  }

  private releaseCompleted(owner: Work): void {
    if (!owner.rootOpen && owner.promises.size === 0 && this.work.delete(owner.id)) this.accountingEpoch++;
  }

  lease(label: string, accepted = false): { run: <T>(fn: () => T) => T; release: () => void } {
    if (!accepted) this.assertAdmission();
    const owner: Work = { id: randomUUID(), label, rootOpen: true, promises: new Set() };
    this.work.set(owner.id, owner);
    this.accountingEpoch++;
    return {
      run: fn => this.context.run(owner, fn),
      release: () => { owner.rootOpen = false; this.releaseCompleted(owner); },
    };
  }

  run<T>(label: string, fn: () => T | Promise<T>, accepted = false): Promise<T> {
    const lease = this.lease(label, accepted);
    let result: T | Promise<T>;
    try { result = lease.run(fn); }
    catch (err) { lease.release(); return Promise.reject(err); }
    // Install this observer outside the lease, so bookkeeping does not account
    // for its own promise. Its children still inherit the handler's ALS scope.
    return Promise.resolve(result).finally(lease.release);
  }

  /** Initiate only SDK lifetimes outside an admitted handler. pg's
   * parser awaits socket end; Redis keeps losing handshake race promises. These
   * are closed by registered participants, not unfinished application effects.
   * Bull's local pause similarly retains a resume gate; Discord queues and
   * gateway throttlers retain unused internal head promises. Concrete callers
   * still await connect/pause/query/command/login/request/close in their scope,
   * with SDK application callbacks entering independent accounted boundaries.
   */
  initializeSdkLifetime<T>(fn: () => T): T {
    // Node 22's exit() disables this storage globally. An independently scoped
    // SDK callback re-enables it and can restore the outer login owner on the
    // current async resource. An explicit empty store survives that reentry.
    return this.context.run(undefined, fn);
  }

  async required<T>(label: string, fn: () => Promise<T>, evidence?: unknown, accepted = false): Promise<T> {
    return this.run(label, async () => {
      try { return await fn(); }
      catch (err) {
        if (!(err instanceof MaintenanceError)) this.recordFailure(label, err, evidence);
        throw err;
      }
    }, accepted);
  }

  recordFailure(label: string, error: unknown, evidence?: unknown): void {
    const failure: RuntimeFailure = { id: randomUUID(), label, at: new Date().toISOString(),
      ...safeDiagnostic(error), ...(safeFailureEvidence(evidence) ? { evidence: safeFailureEvidence(evidence) } : {}) };
    this.failures.push(failure);
    this.accountingEpoch++;
    try {
      mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
      appendFileSync(this.failuresPath, `${JSON.stringify(failure)}\n`, { mode: 0o600, flush: true });
    } catch (err) {
      this.failures.push({ id: randomUUID(), label: 'failure-journal', at: new Date().toISOString(), ...safeDiagnostic(err, 'Failure journal persistence failed') });
    }
  }

  registerProducer(label: string, stop: () => void, schedule?: unknown): () => void {
    const id = `${label}:${randomUUID()}`;
    if (this.isFrozen()) stop();
    else this.producers.set(id, { label, stop, ...(schedule === undefined ? {} : { schedule }) });
    return () => this.producers.delete(id);
  }

  registerParticipant(label: string, participant: DrainParticipant): void {
    if (this.participants.has(label)) throw new Error(`Duplicate drain participant: ${label}`);
    this.participants.set(label, participant);
    this.accountingEpoch++;
  }

  private fenceNames(): string[] {
    return fenceNames(this.controlDir);
  }

  private otherFenceNames(): string[] {
    return this.fenceNames().filter(name => !this.restartFence || name !== path.basename(this.restartFence.path));
  }

  freeze(reason: string): boolean {
    this.operatorRequested = true;
    if (!['closed', 'draining', 'closing'].includes(this.phase)) this.phase = 'frozen';
    // Fence in memory even when persistence fails, but expose that distinction.
    this.operatorMarkerPersisted = false;
    try {
      mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
      if (!this.fenceNames().includes('maintenance.json')) {
        writeFileSync(this.markerPath, JSON.stringify({ kind: 'operator', reason,
          at: new Date().toISOString(), pid: process.pid }), { flag: 'wx', mode: 0o600, flush: true });
      }
      syncControlDirectory(this.controlDir);
      this.operatorMarkerPersisted = this.fenceNames().includes('maintenance.json');
    } catch (err) {
      this.recordFailure('maintenance-marker', err);
    }
    this.stopProducers();
    return this.operatorMarkerPersisted;
  }

  /** The claim exists before any writers, so an unsignalled crash is fenced too.
   * A separate operator filename cannot be deleted by ordinary restart cleanup.
   */
  freezeForRestart(): void {
    if (this.phase === 'closed') return;
    if (!['draining', 'closing'].includes(this.phase)) this.phase = 'frozen';
    this.stopProducers();
  }

  private stopProducers(): void {
    for (const { label, stop, schedule } of this.producers.values()) {
      this.stoppedProducers.push({ label, schedule });
      try { stop(); }
      catch (err) { this.recordFailure(`stop:${label}`, err); }
    }
    this.producers.clear();
  }

  snapshot() {
    this.isFrozen();
    return { format: 'fcm-runtime-drain-v1', phase: this.phase, pid: process.pid,
      at: new Date().toISOString(), frozen: this.phase !== 'running', markerPath: this.markerPath,
      fences: this.fenceNames(), operatorRequested: this.operatorRequested,
      operatorMarkerPersisted: this.operatorMarkerPersisted, ingressClosed: this.closedIngress.size > 0,
      restartFence: this.restartFence ? { path: this.restartFence.path, cleared: this.restartFence.cleared } : null,
      accountingEpoch: this.accountingEpoch, inspectionEpoch: this.inspectionEpoch,
      closedParticipants: [...this.closedParticipants],
      active: [...this.work.values()].map(owner => ({ label: owner.label, callbackPending: owner.rootOpen,
        promiseCount: owner.promises.size })), producers: [...this.producers.values()].map(value => ({ label: value.label,
        schedule: value.schedule })), stoppedProducers: [...this.stoppedProducers], failures: [...this.failures] };
  }

  private checkpoint(detail: unknown): void {
    mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.checkpointPath}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...this.snapshot(), participants: detail }, null, 2),
      { mode: 0o600, flush: true });
    renameSync(temporary, this.checkpointPath);
    syncControlDirectory(this.controlDir);
  }

  /** No force-exit fallback: an unknown or failed drain keeps dependencies usable.
   * Producers never resume in-process. Remove the marker and restart only after
   * operator recovery/disposition; failure journals are deliberately retained.
   */
  drain(options: DrainOptions) {
    // An operator joining a signal drain still establishes durable maintenance.
    if (options.maintenance !== false) this.freeze('local operator drain');
    if (this.phase === 'closed') return Promise.resolve(this.snapshot());
    if (this.drainRequest && this.drainPromise) {
      this.drainRequest.close ||= options.close === true;
      this.drainRequest.maintenance ||= options.maintenance !== false;
      if (options.closeIngress) this.drainRequest.ingress.add(options.closeIngress);
      return this.drainPromise;
    }
    const request: DrainRequest = { deadline: Date.now() + options.timeoutMs, close: options.close === true,
      maintenance: options.maintenance !== false, ingress: new Set(options.closeIngress ? [options.closeIngress] : []) };
    this.drainRequest = request;
    return this.drainPromise = this.performDrain(request).finally(() => {
      this.drainPromise = undefined; this.drainRequest = undefined;
    });
  }

  private async performDrain(request: DrainRequest) {
    if (!request.maintenance) this.freezeForRestart();
    else this.freeze('drain');
    this.phase = 'draining';
    let inspections: Record<string, DrainInspection> = {};
    const wait = async (fn: () => Promise<unknown>): Promise<void> => {
      const remaining = request.deadline - Date.now();
      if (remaining <= 0) throw new Error('Drain deadline exceeded');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Drain deadline exceeded')), remaining);
        Promise.resolve().then(fn).then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
    };
    const settle = async () => {
      while (true) {
        const epoch = this.accountingEpoch;
        let sample: Record<string, DrainInspection> = {};
        await wait(async () => {
          const values = await Promise.all([...this.participants].filter(([label]) => !this.closedParticipants.has(label))
            .map(async ([label, participant]) =>
            [label, await participant.inspect()] as const));
          sample = Object.fromEntries(values.map(([label, inspection]) => [label, { ...inspection,
            ...(inspection.detail === undefined ? {} : { detail: safeInspectionDetail(inspection.detail) }),
            ...(inspection.failures ? { failures: inspection.failures.map(safeInspectionFailure) } : {}) }]));
        });
        // An accepted producer/consumer can enqueue and finish while an
        // inspector is awaiting I/O. Its old zero sample is not drain evidence.
        if (epoch !== this.accountingEpoch) continue;
        inspections = { ...inspections, ...sample };
        this.inspectionEpoch = epoch;
        this.checkpoint(inspections);
        if (this.failures.length || Object.values(inspections).some(value => value.failures?.length)) {
          throw new Error('Drain has unresolved failures; operator disposition required');
        }
        if (this.work.size === 0 && Object.values(inspections).every(value => value.pending === 0)) return;
        await wait(() => new Promise<void>(resolve => setTimeout(resolve, 25)));
      }
    };
    const closeRequestedIngress = async () => {
      // A shutdown may join while inspection or another close callback awaits.
      // All joins share the original total deadline and concrete close result.
      for (const close of request.ingress) {
        if (this.closedIngress.has(close)) continue;
        let operation = this.ingressClosures.get(close);
        if (!operation) {
          operation = this.required('close:ingress', close, { stage: 'ingress-close-unconfirmed' }, true);
          this.ingressClosures.set(close, operation);
        }
        await wait(() => operation);
        this.closedIngress.add(close);
        this.accountingEpoch++;
        await settle();
      }
    };
    try {
      await settle();
      // Closing sockets can create Redis/room/presence writes. Account for those
      // cleanup scopes and inspect queues again before closing any dependency.
      await closeRequestedIngress();
      this.phase = 'drained';
      this.checkpoint(inspections);
      if (request.close) {
        this.phase = 'closing';
        this.checkpoint(inspections);
        for (const [label, participant] of this.participants) {
          if (participant.close && !this.closedParticipants.has(label)) {
            await wait(() => this.run(`close:${label}`, async () => {
              try { await participant.close!(); } catch (err) { this.recordFailure(`close:${label}`, err); throw err; }
            }, true));
            this.closedParticipants.add(label);
            this.accountingEpoch++;
            // Void close listeners can enqueue more accepted work. Reinspect
            // and consume it while remaining dependencies are still open;
            // querying an already closed pool/queue would itself be unsafe.
            await settle();
            await closeRequestedIngress();
          }
        }
        await closeRequestedIngress();
        this.phase = 'closed';
        this.checkpoint(inspections);
        if (!request.maintenance && request.ingress.size > 0 && this.restartFence && !this.operatorRequested) {
          const otherFences = this.fenceNames().filter(name => name !== path.basename(this.restartFence!.path));
          if (otherFences.length === 0) {
            // Only an exact fence created by this process is eligible. A crash,
            // missing file, malformed/modified marker or failed close cannot be
            // silently converted into permission to start a fresh writer.
            if (readFileSync(this.restartFence.path, 'utf8') !== this.restartFence.content) {
              throw new Error('Restart fence identity changed; operator recovery required');
            }
            if (this.work.size || this.failures.length) throw new Error('Restart has unresolved accepted work');
            unlinkSync(this.restartFence.path);
            syncControlDirectory(this.controlDir);
            this.restartFence.cleared = true;
            this.checkpoint(inspections);
          }
        }
      }
    } catch (err) {
      // A missing/partially removed restart claim cannot permit a new writer
      // after an incomplete close/checkpoint. Restore a persistent operator fence.
      if (!request.maintenance && this.restartFence && !existsSync(this.restartFence.path)) {
        this.freeze('restart cleanup incomplete');
      }
      this.phase = 'failed';
      if (this.restartFence && !existsSync(this.restartFence.path) && !this.restartFence.cleared) {
        this.recordFailure('restart-fence-missing', err);
      }
      // Keep a timeout/failure visible, without erasing the original active work
      // or making a transient timeout an irreversible failure journal entry.
      try { this.checkpoint({ ...inspections, drainError: safeDiagnostic(err, 'Drain incomplete; operator disposition required') }); }
      catch (checkpointError) { this.recordFailure('checkpoint', checkpointError); }
    }
    return this.snapshot();
  }

  disposeForTests(): void { this.hook.disable(); this.context.disable(); }
}
