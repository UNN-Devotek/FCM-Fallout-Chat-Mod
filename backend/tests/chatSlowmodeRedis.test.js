// Real Lua regression gate. CI always supplies the isolated Redis service URL.
const { createClient } = require('redis');
const { randomUUID } = require('crypto');
let mockRedis;
jest.mock('../src/config/redis', () => ({ getRedisClient: async () => mockRedis }));
const { CHAT_SLOWMODE_SCRIPT, checkChatSlowmode, chatSlowmodeKey } = require('../src/services/chatSlowmodeService');
const redisUrl = process.env.CHAT_SLOWMODE_TEST_REDIS_URL;
const suite = redisUrl ? describe : describe.skip;
suite('shared chat slowmode (real Redis)', () => {
  let redis;
  const keys = [];
  const key = () => { const value = `chat_slowmode:test:${randomUUID()}`; keys.push(value); return value; };
  const check = k => redis.eval(CHAT_SLOWMODE_SCRIPT, { keys: [k], arguments: ['60000', '35000', '3'] });
  const now = async () => {
    const t = await redis.sendCommand(['TIME']);
    return Number(t[0]) * 1000 + Math.floor(Number(t[1]) / 1000);
  };
  beforeAll(async () => { redis = createClient({ url: redisUrl }); await redis.connect(); mockRedis = redis; });
  afterAll(async () => { if (redis) { if (keys.length) await redis.del(keys); await redis.quit(); } });
  test('three simultaneous messages succeed, the fourth starts 35 seconds, retries never extend it', async () => {
    const k = key();
    const results = await Promise.all(Array.from({ length: 20 }, () => check(k)));
    expect(results.filter(r => r[0] === 1)).toHaveLength(3);
    expect(results.find(r => r[0] === 0)).toEqual([0, 0, 35000]);
    const deadline = JSON.parse(await redis.get(k)).blockedUntil;
    expect((await check(k))[0]).toBe(0);
    expect(JSON.parse(await redis.get(k)).blockedUntil).toBe(deadline);
    expect(await redis.pTTL(k)).toBeLessThanOrEqual(35000);
  });
  test('rolling window expires old entries and retains recent messages', async () => {
    const k = key(), t = await now();
    await redis.set(k, JSON.stringify({ messages: [t - 60001, t - 30000, t - 1000] }));
    expect(await check(k)).toEqual([1, 0, 0]);
    expect(await check(k)).toEqual([0, 0, 35000]);
  });
  test('cooldown expiry permits a fresh burst instead of repeatedly blocking old history', async () => {
    const k = key();
    await redis.set(k, JSON.stringify({ messages: [], blockedUntil: (await now()) - 1 }));
    expect(await check(k)).toEqual([1, 2, 0]);
    expect(await check(k)).toEqual([1, 1, 0]);
    expect(await check(k)).toEqual([1, 0, 0]);
  });
  test('Discord, HUD and overlay consume one burst despite different channels and device IDs', async () => {
    const discordId = `test-${randomUUID()}`;
    const actors = [{ id: discordId, discordId }, { id: 'hud-account', discordId }, { id: 'overlay-account', discordId }];
    keys.push(chatSlowmodeKey(actors[0]));
    for (const actor of actors) expect((await checkChatSlowmode(actor)).allowed).toBe(true);
    expect(await checkChatSlowmode(actors[1])).toEqual({ allowed: false, remaining: 0, retryAfterMs: 35000 });
    expect((await checkChatSlowmode(actors[0])).allowed).toBe(false);
    expect((await checkChatSlowmode(actors[2])).allowed).toBe(false);
  });
  test('separate people do not share the cooldown', async () => {
    const a = key(), b = key();
    for (let i = 0; i < 4; i++) await check(a);
    expect(await check(b)).toEqual([1, 2, 0]);
  });
});
