import { safeInspectionFailure } from '../runtime/failureEvidence';
import Bull from 'bull';
import env from '../config/environment';
import { persistMessage } from '../services/messageService';
import logger from '../config/logger';
import prisma from '../config/prisma';
import { runtime } from '../runtime';
import { MessageLedger, type PersistedCanonicalRow } from '../runtime/messageLedger';

const ledger = new MessageLedger(runtime.controlDir);
const loadCanonicalRows = (ids: string[]) => prisma.$queryRawUnsafe<PersistedCanonicalRow[]>(
  'SELECT id::text, created_at, content, user_id::text, channel_id::text, parent_channel_id::text, source, metadata, relay_seq FROM messages WHERE id::text = ANY($1::text[])', ids);

const queueOptions = {
  skipVersionCheck: runtime.isFrozen(),
  redis: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    // Failed accepted work is recovery evidence, never a bounded auto-delete list.
    removeOnFail: false,
  },
} satisfies Bull.QueueOptions & { skipVersionCheck: boolean };
const messageQueue = new Bull('message-persist', queueOptions);

const add = messageQueue.add.bind(messageQueue);
messageQueue.add = (async (...args: unknown[]) => {
  runtime.assertAdmission();
  const named = typeof args[0] === 'string';
  const index = named ? 1 : 0;
  const data = args[index] as Parameters<typeof persistMessage>[0];
  args[index + 1] = { ...(args[index + 1] as Bull.JobOptions | undefined), removeOnFail: false };
  // Bull retries must reuse the same composite primary key even for callers
  // that did not supply a timestamp. Never regenerate it in the worker.
  args[index] = { ...data, createdAt: data.createdAt ?? new Date().toISOString() };
  return runtime.required('message-persist:acceptance', async () => {
    const job = await (named ? add(args[0] as string, args[1], args[2] as Bull.JobOptions | undefined)
      : add(args[0], args[1] as Bull.JobOptions | undefined));
    ledger.record(job.data);
    return job;
  }, { canonicalId: data.id });
}) as typeof messageQueue.add;

// A restored, frozen destination must not consume jobs before operator recovery.
// The running source keeps consuming accepted jobs after its producers freeze.
if (!runtime.isFrozen()) messageQueue.process(job => runtime.run('message-persist:worker', async () => {
  // Jobs accepted by the previous image still carry its removeOnFail:50 option.
  // The consuming worker must retain those failures too.
  job.opts.removeOnFail = false;
  ledger.record(job.data);
  await persistMessage(job.data, { retryable: true });
  const proof = await ledger.verify(loadCanonicalRows, [job.data.id]);
  if (proof.failures.length) throw new Error(`Canonical persistence could not be proved for job ${job.id}`);
}, true));

messageQueue.on('failed', (job, err) => {
  logger.error({ err, jobId: job.id }, 'Message persist job failed');
});
messageQueue.on('error', err => logger.error({ err }, 'Message queue connection error'));

runtime.registerParticipant('message-persist', {
  inspect: async () => {
    const states = ['waiting', 'active', 'delayed', 'paused', 'failed'] as const;
    const counts = { ...await messageQueue.getJobCounts(), paused: await messageQueue.getPausedCount() };
    const stalled = await (await messageQueue.client).smembers(messageQueue.toKey('stalled'));
    const jobs = await messageQueue.getJobs([...states], 0, -1);
    for (const job of jobs) {
      // Legacy missing timestamps cannot be proved exactly once. Expose them;
      // do not invent one or quietly discard/requeue accepted work.
      try { ledger.record(job.data); }
      catch (err) { runtime.recordFailure('message-persist:legacy-receipt', err, { jobId: job.id, canonicalId: job.data?.id }); }
    }
    const failures = jobs.filter(job => job.failedReason && counts.failed > 0)
      .map(job => safeInspectionFailure({ jobId: job.id, canonicalId: job.data?.id, stage: 'persisted-job-failed' }));
    if (counts.failed > 0 && failures.length === 0) failures.push(safeInspectionFailure({ jobId: 'unknown', count: counts.failed, stage: 'failed-job-record-unavailable' }));
    const pending = counts.waiting + counts.active + counts.delayed + counts.paused + stalled.length;
    const proof = pending === 0 ? await ledger.verify(loadCanonicalRows)
      : { verified: 0, failures: [] };
    return { pending, failures: [...failures, ...proof.failures], detail: { counts, stalled, verifiedCanonicalIds: proof.verified } };
  },
  close: async () => {
    // Local pause allocates Bull's SDK resume gate, which intentionally never
    // resolves on shutdown. Await pause outside the application promise scope;
    // close itself stays scoped so asynchronous close handlers remain work.
    await runtime.initializeSdkLifetime(() => messageQueue.pause(true));
    await messageQueue.close();
  },
});

export default messageQueue;
module.exports = messageQueue;
