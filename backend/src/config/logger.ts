import pino from 'pino';
import env from './environment';

const logger = pino({
  level: env.LOG_LEVEL,
  // Redact sensitive fields anywhere in the log object. installToken is a
  // replayable client-auth credential; truncate it to the first 8 chars (enough
  // to correlate, useless to replay) and fully censor obvious secrets.
  redact: {
    paths: [
      'installToken', '*.installToken',
      'token', '*.token',
      'password', '*.password',
      'authorization', '*.authorization',
      'apiKey', '*.apiKey',
    ],
    censor: (value) =>
      typeof value === 'string' && value.length > 8 ? `${value.slice(0, 8)}...` : '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino/file', options: { destination: 1 } } }
    : {}),
});

export default logger;
module.exports = logger;
