import { Request, Response, NextFunction } from 'express';
import * as db from '../config/database';
import { getRedisClient, healthCheck as redisHealthCheck } from '../config/redis';
import prisma from '../config/prisma';
import env from '../config/environment';
import os from 'os';

/**
 * GET /api/admin/status — comprehensive server diagnostics (API key required)
 */
async function getAdminStatus(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Sample CPU over 100 ms
    const startUsage = process.cpuUsage();
    await new Promise(r => setTimeout(r, 100));
    const endUsage = process.cpuUsage(startUsage);
    const cpuPercent = Math.round(((endUsage.user + endUsage.system) / 1000 / 100) * 100) / 100;

    const mem = process.memoryUsage();
    const pool = db.pool;

    const [dbOk, redisOk] = await Promise.allSettled([
      db.healthCheck(),
      redisHealthCheck(),
    ]);

    let dbStats: any = {};
    try {
      const [userCount, msgCount, channelCount, adminCount, reportCount] = await Promise.all([
        prisma.user.count(),
        prisma.message.count(),
        prisma.channel.count(),
        prisma.adminUser.count(),
        prisma.report.count(),
      ]);
      dbStats = { users: userCount, messages: msgCount, channels: channelCount, admins: adminCount, reports: reportCount };
    } catch (err) {
      dbStats = { error: 'Failed to query counts' };
    }

    let redisStats: any = {};
    try {
      const redis = await getRedisClient();
      const info = await redis.info('memory');
      const usedMemMatch = info.match(/used_memory_human:(\S+)/);
      const keysInfo = await redis.info('keyspace');
      const keysMatch = keysInfo.match(/keys=(\d+)/);
      redisStats = {
        memory: usedMemMatch?.[1] || 'unknown',
        keys: keysMatch ? parseInt(keysMatch[1]) : 0,
      };
    } catch {
      redisStats = { error: 'Failed to query Redis' };
    }

    // Safe subset of environment config exposed to admins
    const envInfo = {
      NODE_ENV: env.NODE_ENV,
      PORT: env.PORT,
      MESSAGE_RETENTION_DAYS: env.MESSAGE_RETENTION_DAYS,
      LOG_LEVEL: env.LOG_LEVEL,
      DISCORD_SERVER_ID: env.DISCORD_SERVER_ID,
      CLIENT_ORIGINS: env.CLIENT_ORIGINS,
      SPAM_MESSAGE_LIMIT: env.SPAM_MESSAGE_LIMIT,
      SPAM_WINDOW_MS: env.SPAM_WINDOW_MS,
    };

    res.json({ data: {
      server: {
        uptime: Math.floor(process.uptime()),
        uptimeHuman: formatUptime(process.uptime()),
        nodeVersion: process.version,
        platform: `${os.type()} ${os.release()} ${os.arch()}`,
        hostname: os.hostname(),
        pid: process.pid,
        cpuPercent,
        memory: {
          rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
          external: `${Math.round(mem.external / 1024 / 1024)}MB`,
        },
        loadAvg: os.loadavg().map(l => Math.round(l * 100) / 100),
        totalMemory: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
        freeMemory: `${Math.round(os.freemem() / 1024 / 1024)}MB`,
      },
      services: {
        database: dbOk.status === 'fulfilled' && dbOk.value ? 'connected' : 'disconnected',
        redis: redisOk.status === 'fulfilled' && redisOk.value ? 'connected' : 'disconnected',
        dbPool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
      },
      database: dbStats,
      redis: redisStats,
      environment: envInfo,
      timestamp: new Date().toISOString(),
    }});
  } catch (err) {
    next(err);
  }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

export { getAdminStatus };
