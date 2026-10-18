import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { RedisStore } from 'connect-redis';
import type { RuntimeCoordinator } from './coordinator';
import { MaintenanceError } from './coordinator';

type StoreOptions = ConstructorParameters<typeof RedisStore>[0];
type Operation = (...args: unknown[]) => unknown;
const COMMANDS = new Set(['set', 'expire', 'del']);
/** A private adapter for this store, never the shared Redis client. Guard only
 * actual session commands; SDK serialization/TTL/read refusal before a write
 * stays ordinary. The public SDK method scope also retains callback descendants. */
export function createRuntimeSessionStore(options: StoreOptions, runtime: RuntimeCoordinator): RedisStore {
  const methods = new AsyncLocalStorage<{ name: string; commandAttempted: boolean; discoveryFailed: boolean }>();
  const client = new Proxy(options.client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      const operation = value.bind(target) as Operation;
      if (typeof key !== 'string' || !COMMANDS.has(key)) return operation;
      return (...args: unknown[]) => runtime.required(`session-store:${key}`, async () => {
        const scope = methods.getStore();
        if (scope) scope.commandAttempted = true;
        return await operation(...args);
      }, { stage: `browser-session-${key}-unconfirmed`,
        sha256: createHash('sha256').update(JSON.stringify(args[0])).digest('hex') });
    },
  });
  const store = new RedisStore({ ...options, client });
  const writers = store as unknown as Record<'set' | 'touch' | 'destroy' | 'clear', Operation>;
  for (const name of ['set', 'touch', 'destroy', 'clear'] as const) {
    const operation = writers[name].bind(store);
    writers[name] = async (...args: unknown[]) => {
      const scope = { name, commandAttempted: false, discoveryFailed: false };
      const retainDiscoveryFailure = (error: unknown) => {
        if (name === 'clear' && error && !(error instanceof MaintenanceError) && !scope.commandAttempted && !scope.discoveryFailed) {
          scope.discoveryFailed = true;
          runtime.recordFailure('session-store:clear-discovery', error, { stage: 'browser-session-clear-discovery-unconfirmed' });
        }
      };
      const callback = args.at(-1);
      let notified = false;
      if (typeof callback === 'function') args[args.length - 1] = (...result: unknown[]) => {
        if (notified) return;
        notified = true;
        retainDiscoveryFailure(result[0]);
        return callback(...result);
      };
      try {
        return await runtime.run(`session-store:${name}-callback`, () => methods.run(scope, async () => {
          try { return await operation(...args); }
          catch (error) { retainDiscoveryFailure(error); throw error; }
        }));
      } catch (error) {
        // Admission can throw before runtime.run returns a promise. SDK input
        // validation can reject before its callback. Preserve both callback and
        // promise APIs without an ignored rejection or a second notification.
        if (typeof callback === 'function' && !notified) { notified = true; return callback(error); }
        throw error;
      }
    };
  }
  return store;
}
