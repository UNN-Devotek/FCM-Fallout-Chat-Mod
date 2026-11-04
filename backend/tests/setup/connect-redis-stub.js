'use strict';
const EventEmitter = require('events');

class RedisStore extends EventEmitter {
  constructor() { super(); }
  get(sid, cb) { cb(null, null); }
  set(sid, session, cb) { cb && cb(null); }
  destroy(sid, cb) { cb && cb(null); }
  touch(sid, session, cb) { cb && cb(null); }
  clear(cb) { cb && cb(null); }
}

// Keep both forms for existing unit fixtures. Runtime SDK acceptance tests
// bypass this mapper and load the actual installed connect-redis module.
module.exports = { __esModule: true, default: RedisStore, RedisStore };
