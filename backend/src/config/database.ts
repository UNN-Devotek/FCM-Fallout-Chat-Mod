import { Pool, PoolClient, QueryResult } from 'pg';
import env from './environment';
import logger from './logger';
import { createError } from '../middleware/errorHandler';

const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000, // 10s per-query timeout; prevents runaway queries
});

pool.on('error', (err: Error) => {
  logger.error({ err }, 'Unexpected database pool error');
});

/**
 * Acquire a client from the pool with exhaustion handling.
 * On timeout / max-connections, throws an RFC 7807 503 error
 * that the global error handler can serialize directly.
 */
async function getClient(): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (err: any) {
    const isExhaustion =
      err.message?.includes('timeout') ||
      err.message?.includes('Cannot use a pool after calling end') ||
      err.message?.includes('too many clients');

    if (isExhaustion) {
      logger.warn({ err, totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount },
        'Database pool exhausted');
      throw createError(503, 'Database temporarily unavailable. Please retry shortly.', {
        type: 'https://fo76chat.app/errors/pool-exhaustion',
        title: 'Service Unavailable',
      });
    }
    throw err;
  }
}

async function query(text: string, params?: any[]): Promise<QueryResult> {
  const start = Date.now();
  const client = await getClient();
  try {
    const result = await client.query(text, params);
    const duration = Date.now() - start;
    logger.debug({ query: text, duration, rows: result.rowCount }, 'DB query');
    return result;
  } finally {
    client.release();
  }
}

async function healthCheck(): Promise<boolean> {
  const client = await getClient();
  try {
    await client.query('SELECT 1');
    return true;
  } finally {
    client.release();
  }
}

/**
 * Run a callback inside a single DB transaction on a dedicated client.
 * Automatically commits on success, rolls back on error.
 * Usage: await withTransaction(async (client) => { await client.query(...); })
 */
async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export { query, pool, healthCheck, withTransaction, getClient };
module.exports = { query, pool, healthCheck, withTransaction, getClient };
