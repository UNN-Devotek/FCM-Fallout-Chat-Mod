import { RedisStore, type SendCommandFn } from 'rate-limit-redis';
import type { Store } from 'express-rate-limit';
import { runtime } from './index';
import { MaintenanceError } from './coordinator';

export function frozenRateLimitStore(): Store {
  return { init: () => {}, increment: async () => { throw new MaintenanceError(); },
    decrement: async () => {}, resetKey: async () => {} };
}

/** RedisStore eagerly loads scripts while importing routes. Check the durable
 * fence before construction, and account for each live store operation.
 */
export function runtimeRedisStore(options: { prefix?: string; sendCommand: SendCommandFn }): Store {
  if (runtime.isFrozen()) return frozenRateLimitStore();
  return new RedisStore({ ...options,
    sendCommand: (...args) => runtime.run('rate-limit-store', () => options.sendCommand(...args)) });
}
