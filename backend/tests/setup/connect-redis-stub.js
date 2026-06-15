'use strict';
const EventEmitter = require('events');

class RedisStore extends EventEmitter {
  constructor() { super(); }
  get(sid, cb) { cb(null, null); }
  set(sid, session, cb) { cb && cb(null); }
  destroy(sid, cb) { cb && cb(null); }
  touch(sid, session, cb) { cb && cb(null); }
}

// server.ts does `import RedisStore from 'connect-redis'` (default import).
// esbuild interop reads .default when __esModule is set.
module.exports = { __esModule: true, default: RedisStore, RedisStore };
