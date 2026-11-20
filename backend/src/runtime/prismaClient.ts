import type { PrismaClient } from '@prisma/client';
import type { RuntimeCoordinator } from './coordinator';

/** Keep Prisma's parser/transaction-watchdog lifetimes outside accepted work.
 * Callers still await each public operation and retain its required disposition.
 * Interactive callbacks reenter an admitted lease, including after a freeze;
 * detached application work in those callbacks remains counted through close.
 * The underlying SDK instance and global prototypes are never patched.
 */
export function withRuntimePrisma(client: PrismaClient, getRuntime: () => RuntimeCoordinator): PrismaClient {
  const queries = client.$extends({ query: {
    $allOperations: ({ args, query }) => getRuntime().initializeSdkLifetime(async () => await query(args)),
  } });
  return new Proxy(client, {
    get(target, key) {
      const owner = Reflect.has(queries, key) ? queries : target;
      const value: unknown = Reflect.get(owner, key, owner);
      if (typeof value !== 'function') return value;
      if (key === '$transaction') return (...args: unknown[]) => {
        const runtime = getRuntime();
        const lease = runtime.lease('prisma:transaction');
        const callback = args[0];
        const scoped = typeof callback === 'function'
          ? [(...values: unknown[]) => lease.run(() => Reflect.apply(callback, undefined, values)), ...args.slice(1)]
          : args;
        let result: unknown;
        try { result = runtime.initializeSdkLifetime(() => Reflect.apply(value, owner, scoped)); }
        catch (error) { lease.release(); throw error; }
        return Promise.resolve(result).finally(lease.release);
      };
      if (key === '$connect' || key === '$disconnect') return (...args: unknown[]) =>
        getRuntime().initializeSdkLifetime(async () => await Reflect.apply(value, owner, args));
      return value.bind(owner);
    },
  });
}
