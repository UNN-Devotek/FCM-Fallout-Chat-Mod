// Real Lua regression gate. CI always supplies the isolated Redis service URL.
const { createClient } = require('redis');
const { randomUUID } = require('crypto');
let mockRedis;
jest.mock('../src/config/redis', () => ({ getRedisClient: async () => mockRedis }));
const { CHAT_SLOWMODE_SCRIPT, checkChatSlowmode, chatSlowmodeKey,
  CHAT_SLOWMODE_WINDOW_MS, CHAT_SLOWMODE_COOLDOWN_MS, CHAT_SLOWMODE_BURST,
  CHAT_SLOWMODE_MAX_COOLDOWN_MS, CHAT_SLOWMODE_RESET_MS, CHAT_SLOWMODE_HARD_WINDOW_MS,
  CHAT_SLOWMODE_HARD_CAP } = require('../src/services/chatSlowmodeService');
const redisUrl = process.env.CHAT_SLOWMODE_TEST_REDIS_URL;
const redisSocket = process.env.CHAT_SLOWMODE_TEST_REDIS_SOCKET;
const suite = redisUrl || redisSocket ? describe : describe.skip;
suite('shared chat flood control (real Redis)', () => {
  let redis;
  const keys = [];
  const key = () => { const value = `chat_slowmode:test:${randomUUID()}`; keys.push(value); return value; };
  const check = k => redis.eval(CHAT_SLOWMODE_SCRIPT, { keys: [k], arguments: [
    CHAT_SLOWMODE_WINDOW_MS, CHAT_SLOWMODE_COOLDOWN_MS, CHAT_SLOWMODE_BURST,
    CHAT_SLOWMODE_MAX_COOLDOWN_MS, CHAT_SLOWMODE_RESET_MS, CHAT_SLOWMODE_HARD_WINDOW_MS,
    CHAT_SLOWMODE_HARD_CAP].map(String) });
  const now = async () => {
    const t = await redis.sendCommand(['TIME']);
    return Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
  };
  const state = () => ({ version: 2, messages: [], attempts: [], strikes: 0 });
  const seed = (k, value) => redis.set(k, JSON.stringify({ ...state(), ...value }));
  beforeAll(async () => {
    redis = createClient(redisSocket
      ? { socket: { path: redisSocket, reconnectStrategy: false } }
      : { url: redisUrl, socket: { reconnectStrategy: false } });
    redis.on('error', () => {});
    await redis.connect(); mockRedis = redis;
  });
  afterAll(async () => {
    if (redis?.isReady) { if (keys.length) await redis.del(keys); await redis.quit(); }
    else if (redis?.isOpen) await redis.disconnect();
  });
  test('eight simultaneous messages succeed, the ninth starts 35 seconds, retries never extend it', async () => {
    const k = key();
    const results = await Promise.all(Array.from({ length: 20 }, () => check(k)));
    expect(results.filter(r => r[0] === 1)).toHaveLength(8);
    expect(results.find(r => r[0] === 0)).toEqual([0, 0, 35000]);
    const deadline = JSON.parse(await redis.get(k)).blockedUntil;
    expect((await check(k))[0]).toBe(0);
    expect(JSON.parse(await redis.get(k)).blockedUntil).toBe(deadline);
    expect(JSON.parse(await redis.get(k)).strikes).toBe(1);
    expect(await redis.pTTL(k)).toBeLessThanOrEqual(CHAT_SLOWMODE_RESET_MS);
  });
  test('normal conversation has no three-per-minute quota', async () => {
    const k = key(), t = await now();
    await seed(k, { attempts: Array.from({ length: 30 }, (_, i) => t - 59000 + i * 1500),
      messages: [t - 7000, t - 6000, t - 5000] });
    for (let remaining = 4; remaining >= 0; remaining--) {
      expect(await check(k)).toEqual([1, remaining, 0]);
    }
    expect(await check(k)).toEqual([0, 0, 35000]);
  });
  test('rolling window expires old entries and retains recent messages', async () => {
    const k = key(), t = await now();
    await seed(k, { messages: [t - 11000, ...Array(7).fill(t - 1000)] });
    expect(await check(k)).toEqual([1, 0, 0]);
    expect(await check(k)).toEqual([0, 0, 35000]);
  });
  test('cooldown expiry permits a fresh burst instead of repeatedly blocking old history', async () => {
    const k = key();
    await seed(k, { messages: Array(8).fill(await now()), blockedUntil: (await now()) - 1 });
    for (let remaining = 7; remaining >= 0; remaining--) expect(await check(k)).toEqual([1, remaining, 0]);
  });
  test('fresh flood episodes escalate and cap at five minutes; ordinary retries do not add strikes', async () => {
    const k = key();
    for (const wait of [35000, 70000, 140000, 280000, 300000, 300000]) {
      for (let i = 0; i < 8; i++) expect((await check(k))[0]).toBe(1);
      expect(await check(k)).toEqual([0, 0, wait]);
      const blocked = JSON.parse(await redis.get(k));
      expect((await check(k))[0]).toBe(0);
      expect(JSON.parse(await redis.get(k)).blockedUntil).toBe(blocked.blockedUntil);
      expect(JSON.parse(await redis.get(k)).strikes).toBe(blocked.strikes);
      await seed(k, { ...blocked, blockedUntil: (await now()) - 1, attempts: [] });
    }
  });
  test('fifteen minutes without a flood resets the penalty even while normal chat continues', async () => {
    const k = key(), t = await now();
    await seed(k, { strikes: 5, lastViolationAt: t - CHAT_SLOWMODE_RESET_MS - 1000,
      attempts: [t - 1000], messages: Array(8).fill(t - 1000) });
    expect(await check(k)).toEqual([0, 0, 35000]);
    expect(JSON.parse(await redis.get(k)).strikes).toBe(1);
  });
  test('recent penalties survive across backend calls instead of resetting after a cooldown', async () => {
    const k = key(), t = await now();
    await seed(k, { strikes: 2, lastViolationAt: t - CHAT_SLOWMODE_RESET_MS + 10000,
      messages: Array(8).fill(t - 1000) });
    expect(await check(k)).toEqual([0, 0, 140000]);
  });
  test('the sixtieth attempt triggers a hard cooldown once, including attempts during a short cooldown', async () => {
    const k = key();
    for (let i = 1; i < 60; i++) await check(k);
    expect(await check(k)).toEqual([0, 0, 300000]);
    const hard = JSON.parse(await redis.get(k));
    expect(hard).toMatchObject({ hardLimited: true, strikes: 5 });
    for (let i = 0; i < 100; i++) expect((await check(k))[0]).toBe(0);
    const after = JSON.parse(await redis.get(k));
    expect(after.blockedUntil).toBe(hard.blockedUntil);
    expect(after.lastViolationAt).toBe(hard.lastViolationAt);
    expect(after.attempts).toHaveLength(60);
    expect(Object.values(after.messages)).toHaveLength(0);
  });
  test('hard-attempt history rolls off after a minute and cannot count stale attempts', async () => {
    const k = key(), t = await now();
    await seed(k, { attempts: Array(59).fill(t - 61000) });
    expect(await check(k)).toEqual([1, 7, 0]);
    expect(JSON.parse(await redis.get(k)).attempts).toHaveLength(1);
  });
  test('a saturated counter retains the most recent attempts instead of forgetting continued flooding', async () => {
    const k = key(), t = await now();
    await seed(k, { hardLimited: true, blockedUntil: t + 300000, strikes: 5,
      lastViolationAt: t, attempts: Array(60).fill(t - 59000) });
    for (let i = 0; i < 60; i++) await check(k);
    const latest = JSON.parse(await redis.get(k));
    expect(latest.attempts).toHaveLength(60);
    expect(latest.attempts.every(timestamp => timestamp >= t)).toBe(true);
    expect(latest.blockedUntil).toBe(t + 300000);
  });
  test('expired hard cooldowns resume normally when the sender stops flooding', async () => {
    const k = key(), t = await now();
    await seed(k, { hardLimited: true, blockedUntil: t - 1, strikes: 5,
      lastViolationAt: t - 301000, attempts: Array(60).fill(t - 301000) });
    expect(await check(k)).toEqual([1, 7, 0]);
    expect(JSON.parse(await redis.get(k)).hardLimited).toBeUndefined();
  });
  test('continuous extreme flooding starts another bounded cooldown only after the prior deadline', async () => {
    const k = key(), t = await now();
    await seed(k, { hardLimited: true, blockedUntil: t - 1, strikes: 5,
      lastViolationAt: t - 301000, attempts: Array(60).fill(t - 1000) });
    expect(await check(k)).toEqual([0, 0, 300000]);
  });
  test('rollout retires the previous three-message budget and its active cooldown', async () => {
    const k = key();
    await redis.set(k, JSON.stringify({ messages: [], blockedUntil: (await now()) + 35000 }));
    expect(await check(k)).toEqual([1, 7, 0]);
    expect(JSON.parse(await redis.get(k)).version).toBe(2);
  });
  test('older backend writers cannot overwrite or reset the new policy budget', async () => {
    const actor = { id: 'test-' + randomUUID() };
    const current = chatSlowmodeKey(actor), previous = current.replace('chat_slowmode:v2:', 'chat_slowmode:');
    keys.push(current, previous);
    for (let i = 0; i < 8; i++) expect((await checkChatSlowmode(actor)).allowed).toBe(true);
    const cooldown = await checkChatSlowmode(actor);
    expect(cooldown).toEqual({ allowed: false, remaining: 0, retryAfterMs: 35000 });
    const deadline = JSON.parse(await redis.get(current)).blockedUntil;
    await redis.set(previous, JSON.stringify({ messages: [], blockedUntil: (await now()) + 35000 }));
    expect((await checkChatSlowmode(actor)).allowed).toBe(false);
    expect(JSON.parse(await redis.get(current)).blockedUntil).toBe(deadline);
  });
  test('Discord, HUD and overlay consume one burst despite different channels and device IDs', async () => {
    const discordId = `test-${randomUUID()}`;
    const actors = [{ id: discordId, discordId }, { id: 'hud-account', discordId }, { id: 'overlay-account', discordId }];
    keys.push(chatSlowmodeKey(actors[0]));
    for (let i = 0; i < 8; i++) expect((await checkChatSlowmode(actors[i % actors.length])).allowed).toBe(true);
    expect(await checkChatSlowmode(actors[1])).toEqual({ allowed: false, remaining: 0, retryAfterMs: 35000 });
    expect((await checkChatSlowmode(actors[0])).allowed).toBe(false);
    expect((await checkChatSlowmode(actors[2])).allowed).toBe(false);
  });
  test('separate people do not share the cooldown', async () => {
    const a = key(), b = key();
    for (let i = 0; i < 9; i++) await check(a);
    expect(await check(b)).toEqual([1, 7, 0]);
  });
});
