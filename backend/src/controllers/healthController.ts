import { Request, Response, NextFunction } from 'express';
import * as db from '../config/database';
import { healthCheck as redisHealthCheck } from '../config/redis';

// Set externally by server.ts via the exported setter functions.
let wsClientCount = 0;
let discordStatus = 'disconnected';

// Rolling messages/sec counter: incremented by WebSocket handlers on each
// broadcast, sampled every second to compute a rate.
let messageCount = 0;
let messagesPerSecond = 0;

setInterval(() => {
  messagesPerSecond = messageCount;
  messageCount = 0;
}, 1000);

function incrementMessageCount(): void { messageCount++; }

// Clients report fullscreen state via the `client:status` WS event; tracked by userId.
const fullscreenClients = new Set<string>();

function setFullscreenStatus(userId: string, isFullscreen: boolean): void {
  if (isFullscreen) {
    fullscreenClients.add(userId);
  } else {
    fullscreenClients.delete(userId);
  }
}

function removeFullscreenClient(userId: string): void {
  fullscreenClients.delete(userId);
}

function setWsClientCount(count: number): void { wsClientCount = count; }
function setDiscordStatus(status: string): void { discordStatus = status; }

async function getHealth(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Sample CPU over 100 ms
    const startUsage = process.cpuUsage();
    await new Promise(r => setTimeout(r, 100));
    const endUsage = process.cpuUsage(startUsage);
    const cpuPercent = Math.round(((endUsage.user + endUsage.system) / 1000 / 100) * 100) / 100;

    const mem = process.memoryUsage();

    const [dbOk, redisOk] = await Promise.allSettled([
      db.healthCheck(),
      redisHealthCheck(),
    ]);

    const pool = db.pool;
    const poolStats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };

    res.json({ data: {
      status: 'ok',
      uptime: process.uptime(),
      database: dbOk.status === 'fulfilled' && dbOk.value ? 'connected' : 'disconnected',
      redis: redisOk.status === 'fulfilled' && redisOk.value ? 'connected' : 'disconnected',
      discord: discordStatus,
      websocket_clients: wsClientCount,
      messagesPerSecond,
      poolStats,
      fullscreenClients: fullscreenClients.size,
      process: {
        uptimeSeconds: Math.floor(process.uptime()),
        memoryMB: {
          rss: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
        },
        cpuPercent,
      },
      timestamp: new Date().toISOString(),
    } });
  } catch (err) {
    next(err);
  }
}

export {
  getHealth,
  setWsClientCount,
  setDiscordStatus,
  incrementMessageCount,
  setFullscreenStatus,
  removeFullscreenClient,
};
module.exports = {
  getHealth,
  setWsClientCount,
  setDiscordStatus,
  incrementMessageCount,
  setFullscreenStatus,
  removeFullscreenClient,
};
