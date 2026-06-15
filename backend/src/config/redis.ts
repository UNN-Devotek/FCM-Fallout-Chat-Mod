import { createClient, RedisClientType } from 'redis';
import env from './environment';
import logger from './logger';

// Build client options once. Prefer REDIS_URL (e.g. redis://:pass@host:6379)
// when set; otherwise host/port + optional password. Redis now requires a
// password in production (compose --requirepass), so unauthenticated configs
// only work for local dev where no password is set.
function redisOptions() {
  if (env.REDIS_URL) return { url: env.REDIS_URL };
  return {
    socket: { host: env.REDIS_HOST, port: env.REDIS_PORT },
    ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
  };
}

// Create the client at module load so it can be passed synchronously to
// connect-redis. Commands are queued in the offline queue until connect() is
// called in start(). This preserves correct middleware registration order.
const client = createClient(redisOptions());

client.on('error', (err: Error) => logger.error({ err }, 'Redis client error'));
client.on('connect', () => logger.info('Redis connected'));
client.on('reconnecting', () => logger.warn('Redis reconnecting'));

// Dedicated subscriber client for Redis Pub/Sub.
// A Redis client in subscribe mode cannot issue other commands, so we need
// a separate instance exclusively for subscriptions.
const subscriberClient = createClient(redisOptions());

subscriberClient.on('error', (err: Error) => logger.error({ err }, 'Redis subscriber client error'));
subscriberClient.on('connect', () => logger.info('Redis subscriber connected'));
subscriberClient.on('reconnecting', () => logger.warn('Redis subscriber reconnecting'));

async function getRedisClient(): Promise<ReturnType<typeof createClient>> {
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}

async function getSubscriberClient(): Promise<ReturnType<typeof createClient>> {
  if (!subscriberClient.isOpen) {
    await subscriberClient.connect();
  }
  return subscriberClient;
}

async function healthCheck(): Promise<boolean> {
  const c = await getRedisClient();
  const pong = await c.ping();
  return pong === 'PONG';
}

export { getRedisClient, getSubscriberClient, healthCheck, client, subscriberClient };
module.exports = { getRedisClient, getSubscriberClient, healthCheck, client, subscriberClient };
