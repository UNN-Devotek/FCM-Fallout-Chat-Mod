import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';
import { runtime } from '../runtime';
import { MaintenanceError } from '../runtime/coordinator';

/** Apply only at an explicitly required mutation boundary. Read/validation/cache
 * fallbacks stay outside this helper. Disposition happens before lease release. */
export function runRequiredEffect<T>(label: string, evidence: Record<string, unknown>,
  effect: () => T | PromiseLike<T>, expectedError?: (error: unknown) => boolean,
  transactionClient?: object, confirmedNoChange?: (result: T) => boolean): Promise<T> {
  const transaction = transactionClient ? transactionOwners.get(transactionClient) : undefined;
  return runtime.run(label, async () => {
    if (transaction && !transaction.closed) transaction.attempted = true;
    try {
      const result = await effect();
      if (!confirmedNoChange?.(result)) {
        const stage = { writerId: label, stage: 'required-effect-confirmed' };
        if (transaction && !transaction.closed) transaction.stages.push(stage);
        else bundles.getStore()?.committed.push(stage);
      }
      return result;
    }
    catch (error) {
      if (!(error instanceof MaintenanceError) && !expectedError?.(error)) {
        if (transaction && !transaction.closed) transaction.pending.push({ business: 'domain', label, error, evidence });
        else { runtime.recordFailure(label, error, evidence); const bundle = bundles.getStore(); if (bundle) bundle.failureRecorded = true; }
      }
      throw error;
    }
  });
}

export function runRequiredCallback(label: string, evidence: Record<string, unknown>,
  start: (done: (error?: unknown) => void) => void): Promise<void> {
  return runRequiredEffect(label, evidence, () => new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve();
    };
    try { start(done); } catch (error) { done(error); }
  }));
}

export function isPrismaNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2025';
}

type AuditWriter = { create: (args: Prisma.AuditLogCreateArgs) => PromiseLike<unknown> };
/** Audit metadata contains names/content/tokens. Only explicit IDs are copied to
 * the control journal; the audit row itself keeps its existing domain format. */
export function createRequiredAudit(writer: AuditWriter, args: Prisma.AuditLogCreateArgs,
  evidence: Record<string, unknown> = {}, transactionClient?: object): Promise<unknown> {
  const data = args.data;
  const metadata = data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
    ? data.metadata as Record<string, unknown> : {};
  const ids = Object.fromEntries(['ruleId', 'reportId', 'channelId', 'partyId', 'messageId', 'discordId']
    .filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]]));
  return runRequiredEffect('audit:write', { action: data.action, targetType: data.targetType,
    actorId: data.actorId, targetId: data.targetId, ...ids, ...evidence, stage: 'audit-write-unconfirmed' }, () => writer.create(args), undefined, transactionClient);
}

/** Business classification is explicit at the caller. No SDK/client is patched
 * and optional reads, caches, counters and proven refusals use their own paths. */
export type MutationBusiness = 'authority' | 'identity' | 'session' | 'oauth' | 'moderation'
  | 'domain' | 'publication' | 'producer' | 'object' | 'audit';
type ConfirmedStage = { writerId: string; stage: string };
type BundleScope = { committed: ConfirmedStage[]; failureRecorded: boolean };
type TransactionScope = { attempted: boolean; closed: boolean; pending: Array<{ business: MutationBusiness; label?: string; error: unknown; evidence: Record<string, unknown> }>; stages: ConfirmedStage[] };
const bundles = new AsyncLocalStorage<BundleScope>();
const transactions = new AsyncLocalStorage<TransactionScope>();
const transactionOwners = new WeakMap<object, TransactionScope>();

/** Bind only the actual callback client supplied by the awaited SQL transaction.
 * ALS nesting does not establish SQL ownership: global writes and independent
 * transactions can commit while that callback is still running. */
export function bindRequiredTransactionClient(client: object): void {
  const scope = transactions.getStore();
  if (!scope || scope.closed) throw new Error('Required transaction client has no owning transaction');
  transactionOwners.set(client, scope);
}

/** Apply only to an explicitly counted row DML contract. DDL/TRUNCATE can
 * commit while reporting zero; ordinary fulfilled effects default to changed. */
export function isRowCountNoChange(value: unknown): boolean {
  return value === 0 || !!value && typeof value === 'object'
    && ('count' in value && value.count === 0 || 'rowCount' in value && value.rowCount === 0);
}
function recordMutationFailure(business: MutationBusiness, error: unknown, evidence: Record<string, unknown>): void {
  const bundle = bundles.getStore();
  runtime.recordFailure(`${business}:primary`, error, { ...evidence,
    ...(bundle?.committed.length ? { committedStages: bundle.committed.map(value => value.stage),
      committedWriterIds: bundle.committed.map(value => value.writerId) } : {}) });
  if (bundle) bundle.failureRecorded = true;
}

export function runRequiredMutation<T>(business: MutationBusiness, writerId: string,
  evidence: Record<string, unknown>, effect: () => T | PromiseLike<T>,
  confirmedRefusal?: (error: unknown) => boolean, transactionClient?: object,
  confirmedNoChange?: (result: T) => boolean): Promise<T> {
  const bound = transactionClient ? transactionOwners.get(transactionClient) : undefined;
  const transaction = bound && !bound.closed ? bound : undefined;
  return runtime.run(`${business}:primary`, async () => {
    if (transaction) transaction.attempted = true;
    try {
      const result = await effect();
      if (!confirmedNoChange?.(result)) {
        const stage = { writerId, stage: `${business}-write-confirmed` };
        if (transaction) transaction.stages.push(stage); // not committed yet
        else bundles.getStore()?.committed.push(stage);
      }
      return result;
    } catch (error) {
      // An accepted audit is itself required even when its SQL statement was
      // definitely refused. Actual tx-owned statements still defer disposition
      // to the owning transaction's verified rollback below.
      const refused = business !== 'audit' && confirmedRefusal?.(error) === true;
      const previouslyCommitted = bundles.getStore()?.committed.length ?? 0;
      if (!(error instanceof MaintenanceError) && (!refused || previouslyCommitted > 0)) {
        const detail = { ...evidence, writerId,
          ...(refused ? { stage: 'previous-effects-committed-write-refused' } : {}) };
        if (transaction) transaction.pending.push({ business, error, evidence: detail });
        else recordMutationFailure(business, error, detail);
      }
      throw error;
    }
  });
}

/** Call only around an awaited, traced Prisma transaction. Lazy array entries
 * stay untouched; their owning transaction marks the attempt. A fulfilled
 * statement inside the callback is never recorded as a committed stage. */
export function runRequiredTransaction<T>(business: MutationBusiness, writerId: string,
  evidence: Record<string, unknown>, effect: () => T | PromiseLike<T>,
  options: { lazyArray?: boolean; confirmedRollback?: (error: unknown) => boolean; sameTransaction?: object;
    confirmedNoChange?: (result: T) => boolean } = {}): Promise<T> {
  if (options.sameTransaction) {
    const owner = transactionOwners.get(options.sameTransaction);
    if (!owner || owner.closed) throw new Error('Required same-transaction marker has no owning transaction');
    return runtime.run(`${business}:transaction`, async () => await effect());
  }
  const scope: TransactionScope = { attempted: options.lazyArray === true, closed: false, pending: [], stages: [] };
  return runtime.run(`${business}:transaction`, () => transactions.run(scope, async () => {
    try {
      const result = await effect();
      // This awaited SQL transaction owns its commit, even if invoked inside
      // another SQL callback. Reusing an actual client is explicit above.
      for (const pending of scope.pending) {
        if (pending.label) { runtime.recordFailure(pending.label, pending.error, pending.evidence); const bundle = bundles.getStore(); if (bundle) bundle.failureRecorded = true; }
        else recordMutationFailure(pending.business, pending.error, pending.evidence);
      }
      if (options.lazyArray && !options.confirmedNoChange?.(result)) scope.stages.push({ writerId, stage: `${business}-transaction-confirmed` });
      bundles.getStore()?.committed.push(...scope.stages);
      return result;
    } catch (error) {
      const previouslyCommitted = bundles.getStore()?.committed.length ?? 0;
      if ((scope.attempted || previouslyCommitted > 0) && !(error instanceof MaintenanceError)
        && (!options.confirmedRollback?.(error) || previouslyCommitted > 0)) {
        const detail = { ...evidence, writerId, stage: previouslyCommitted > 0
          ? 'previous-effects-committed-transaction-unconfirmed' : evidence.stage };
        recordMutationFailure(business, error, detail);
      }
      throw error;
    } finally { scope.closed = true; }
  }));
}

/** Explicit compound business callers retain only successful required stages.
 * This is independent of the HTTP response/error status and SDK reads/caches. */
export function runRequiredBundle<T>(business: MutationBusiness, source: string,
  effect: () => T | PromiseLike<T>, expectedCompletion?: (error: unknown) => boolean): Promise<T> {
  const scope: BundleScope = bundles.getStore() ?? { committed: [], failureRecorded: false };
  return runtime.run(`${business}:bundle`, () => bundles.run(scope, async () => {
    try { return await effect(); }
    catch (error) {
      if (scope.committed.length && !scope.failureRecorded && !(error instanceof MaintenanceError) && !expectedCompletion?.(error)) {
        recordMutationFailure(business, error, { source, stage: 'compound-completion-unconfirmed' });
      }
      throw error;
    }
  }));
}

/** A lookup needed to finish already committed work must retain its failure
 * before an HTTP/logging catch consumes it. Reads never create committed stages;
 * validation, optional reads and rolled-back work keep their existing policy.
 * Use required retention for an accepted publication even when its canonical
 * receipt is owned by the message ledger rather than a compound bundle. */
export function runRequiredLookup<T>(business: MutationBusiness, source: string,
  lookup: () => T | PromiseLike<T>, retention: 'after-commit' | 'required' = 'after-commit'): Promise<T> {
  return runtime.run(`${business}:lookup`, async () => {
    try { return await lookup(); }
    catch (error) {
      const scope = bundles.getStore();
      if ((retention === 'required' || scope?.committed.length && !scope.failureRecorded)
        && !(error instanceof MaintenanceError)) {
        recordMutationFailure(business, error, { source, stage: 'required-discovery-unconfirmed' });
      }
      throw error;
    }
  });
}

/** Required preparation after a publication's identity and reply are selected.
 * Retain local-delivery/client failures even without a prior committed stage.
 * Successful preparation adds no stage; its nested mutations keep their own. */
export function runRequiredPublicationPrerequisite<T>(source: string,
  prepare: () => T | PromiseLike<T>): Promise<T> {
  return runRequiredLookup('publication', source, prepare, 'required');
}

/** Use only where the caller's existing contract resolves a definite atomic
 * constraint/absence/concurrent claim. Unknown/network/commit errors are never
 * inferred from HTTP status or error messages. */
export function isPrismaAtomicRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; meta?: { code?: unknown }; name?: unknown };
  return ['P2002', 'P2003', 'P2025', 'P2034'].includes(String(value.code))
    || value.code === 'P2010' && ['23505', '23503', '23514', '40001', '40P01'].includes(String(value.meta?.code))
    || value.name === 'PrismaClientValidationError';
}

/** The final denial cannot disprove an earlier ambiguous PUT. Missing or
 * multiple-attempt SDK metadata stays unresolved. Managed callers only. */
export function isConfirmedObjectRefusal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; $metadata?: { attempts?: unknown; httpStatusCode?: unknown } };
  const status = value.$metadata?.httpStatusCode;
  return value.$metadata?.attempts === 1 && typeof status === 'number' && status >= 400 && status < 500
    && ['AccessDenied','Forbidden','InvalidRequest','InvalidArgument','MalformedXML','NoSuchBucket','NoSuchKey',
      'PreconditionFailed','BucketAlreadyExists','InvalidAccessKeyId','SignatureDoesNotMatch',
      'AuthorizationHeaderMalformed','EntityTooLarge','BadDigest','InvalidDigest','MethodNotAllowed'].includes(String(value.name));
}

/** CreateBucket's owned-by-this-credential reply confirms that namespace.
 * It is a distinct desired-state contract, never a proof of PUT bytes. */
export function isConfirmedBucketOwnership(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'BucketAlreadyOwnedByYou'
    && (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === 409;
}
