// This must remain the first server import: dotenv and the durable fence are
// evaluated before modules can register producers or start a Bull worker.
import env from '../config/environment';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import { RuntimeCoordinator } from './coordinator';

export const runtime = new RuntimeCoordinator(env.FCM_RUNTIME_CONTROL_DIR
  || (env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || process.env.NODE_TEST_CONTEXT
    ? path.join(tmpdir(), `fcm-runtime-test-${process.pid}-${randomUUID()}`)
    : env.NODE_ENV === 'production' ? '/app/runtime-control' : path.resolve('.fcm-runtime')), process.env.FCM_RUNTIME_BOOT_NONCE);

type ProducerTimer = ReturnType<typeof setTimeout>;
const producerCancellations = new WeakMap<ProducerTimer, () => void>();

/** Cancel future ticks and dispose only this timer's schedule registration.
 * Admitted callback work has its own runtime owner and is not released here.
 * The returned timers remain native handles, including ref/unref behavior.
 */
export function cancelProducerTimer(timer: ProducerTimer): void {
  const cancel = producerCancellations.get(timer);
  if (cancel) cancel();
  else clearTimeout(timer); // Also safe after natural completion or prior cancellation.
}

function registerProducerTimer(label: string, timer: ProducerTimer, schedule: unknown): void {
  let unregister = () => {};
  let canceled = false;
  const cancel = () => {
    if (canceled) return;
    canceled = true;
    clearTimeout(timer);
    unregister();
    producerCancellations.delete(timer);
  };
  producerCancellations.set(timer, cancel);
  // Frozen registration synchronously cancels the native timer and never adds
  // a schedule. Freeze records actually live schedules before calling cancel.
  unregister = runtime.registerProducer(label, cancel, schedule);
}

export function producerInterval(label: string, callback: () => unknown, delay: number): ReturnType<typeof setInterval> {
  const schedule = { kind: 'interval', intervalMs: delay, nextDueAt: new Date(Date.now() + delay).toISOString() };
  const timer = setInterval(() => {
    schedule.nextDueAt = new Date(Date.now() + delay).toISOString();
    void runProducer(label, callback);
  }, delay);
  registerProducerTimer(label, timer, schedule);
  return timer;
}

export function producerTimeout(label: string, callback: () => unknown, delay: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => { cancelProducerTimer(timer); void runProducer(label, callback); }, delay);
  registerProducerTimer(label, timer, { kind: 'timeout', dueAt: new Date(Date.now() + delay).toISOString() });
  return timer;
}

export async function runProducer(label: string, callback: () => unknown): Promise<void> {
  if (runtime.isFrozen()) return;
  await runtime.required(label, async () => await callback()).catch(() => {});
}

/** A deferred continuation of already accepted work is not a producer tick.
 * Hold its lease across the delay and include any async socket-close effects.
 */
export function acceptedTimeout(label: string, callback: () => unknown, delay: number): ReturnType<typeof setTimeout> {
  const lease = runtime.lease(label);
  return setTimeout(() => {
    let result: unknown;
    try { result = lease.run(callback); }
    catch (err) { runtime.recordFailure(label, err); lease.release(); return; }
    void Promise.resolve(result).catch(err => runtime.recordFailure(label, err)).finally(lease.release);
  }, delay);
}

export function producerCron(expression: string, callback: () => unknown) {
  const task = cron.schedule(expression, () => runProducer(`cron:${expression}`, callback));
  runtime.registerProducer(`cron:${expression}`, () => { void task.stop(); }, { kind: 'cron', expression });
  return task;
}
