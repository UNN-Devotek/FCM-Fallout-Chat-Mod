import Bull from 'bull';
import env from '../config/environment';
import { persistMessage } from '../services/messageService';
import logger from '../config/logger';

const messageQueue = new Bull('message-persist', {
  redis: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD || undefined,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// Worker
messageQueue.process(async (job) => {
  await persistMessage(job.data);
});

messageQueue.on('failed', (job, err) => {
  logger.error({ err, jobId: job.id }, 'Message persist job failed');
});

export default messageQueue;
module.exports = messageQueue;
