'use strict';

/**
 * aiModerationService — OpenAI Moderation API client.
 *
 * The contract under test is narrow but load-bearing: EVERY failure path must
 * return null (never a false "clean"), because engineEvaluate reads null as
 * "degraded, fall back to the keyword filters".
 */

let mockSettingRows = [];

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    moderationSetting: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(mockSettingRows)),
    },
  },
}));

jest.mock('../src/config/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
  return { __esModule: true, default: log, ...log };
});

jest.mock('../src/config/environment', () => ({
  __esModule: true,
  default: { OPENAI_API_KEY: 'sk-test-key' },
}));

// cachedFetch is exercised for real in the "cache hit" case below; by default it
// passes straight through to the fetcher so each test controls its own state.
let mockCacheStore = new Map();
jest.mock('../src/lib/cachedFetch', () => ({
  cachedFetch: jest.fn(async (key, _ttl, fetcher) => {
    if (mockCacheStore.has(key)) return mockCacheStore.get(key);
    const fresh = await fetcher();
    if (!fresh) return null;
    mockCacheStore.set(key, fresh);
    return fresh;
  }),
}));

jest.mock('../src/services/discordService', () => ({
  postModAlert: jest.fn().mockResolvedValue(undefined),
}));

const {
  classifyContent,
  evaluateVerdict,
  getAiModerationSettings,
  screenIdentifier,
  invalidateAiModerationCache,
  __resetAiModerationStateForTests,
  DEFAULT_THRESHOLDS,
  getChatTargetedAttackThresholds,
} = require('../src/services/aiModerationService');

/** Build a well-formed OpenAI moderations response. */
function moderationResponse(scores, flagged = true) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      id: 'modr-test',
      model: 'omni-moderation-latest',
      results: [{
        flagged,
        categories: Object.fromEntries(Object.keys(scores).map((k) => [k, scores[k] >= 0.5])),
        category_scores: scores,
      }],
    }),
  };
}

function enable(mode = 'enforce') {
  mockSettingRows = [
    { key: 'ai_moderation_enabled', value: 'true' },
    { key: 'ai_moderation_mode', value: mode },
  ];
}

beforeEach(() => {
  mockSettingRows = [];
  mockCacheStore = new Map();
  __resetAiModerationStateForTests();
  global.fetch = jest.fn();
});

afterEach(() => {
  delete global.fetch;
});

describe('getAiModerationSettings', () => {
  test('defaults to disabled + shadow when no rows exist', async () => {
    const s = await getAiModerationSettings();
    expect(s.enabled).toBe(false);
    expect(s.mode).toBe('shadow');
  });

  test('mode falls back to shadow for any value that is not exactly "enforce"', async () => {
    mockSettingRows = [
      { key: 'ai_moderation_enabled', value: 'true' },
      { key: 'ai_moderation_mode', value: 'ENFORCE' },
    ];
    const s = await getAiModerationSettings();
    expect(s.enabled).toBe(true);
    expect(s.mode).toBe('shadow');
  });

  test('parses a thresholds override and drops out-of-range entries', async () => {
    mockSettingRows = [
      { key: 'ai_moderation_enabled', value: 'true' },
      { key: 'ai_moderation_thresholds', value: JSON.stringify({ hate: 0.6, bogus: 5, nope: 'abc' }) },
    ];
    const s = await getAiModerationSettings();
    expect(s.thresholds).toEqual({ hate: 0.6 });
  });

  test('falls back to defaults when the thresholds JSON is malformed', async () => {
    mockSettingRows = [
      { key: 'ai_moderation_enabled', value: 'true' },
      { key: 'ai_moderation_thresholds', value: '{not json' },
    ];
    const s = await getAiModerationSettings();
    expect(s.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });

  test('caches, and invalidateAiModerationCache busts it', async () => {
    enable();
    await getAiModerationSettings();
    const callsAfterFirst = require('../src/config/prisma').default.moderationSetting.findMany.mock.calls.length;
    await getAiModerationSettings();
    expect(require('../src/config/prisma').default.moderationSetting.findMany.mock.calls.length).toBe(callsAfterFirst);

    invalidateAiModerationCache();
    await getAiModerationSettings();
    expect(require('../src/config/prisma').default.moderationSetting.findMany.mock.calls.length).toBe(callsAfterFirst + 1);
  });
});

describe('classifyContent', () => {
  test('parses a flagged response into scores, maxScore and topCategory', async () => {
    enable();
    global.fetch.mockResolvedValue(moderationResponse({ hate: 0.91, violence: 0.2 }));

    const verdict = await classifyContent('some text');
    expect(verdict).not.toBeNull();
    expect(verdict.flagged).toBe(true);
    expect(verdict.scores.hate).toBeCloseTo(0.91);
    expect(verdict.maxScore).toBeCloseTo(0.91);
    expect(verdict.topCategory).toBe('hate');
  });

  test('parses a clean response', async () => {
    enable();
    global.fetch.mockResolvedValue(moderationResponse({ hate: 0.001, violence: 0.02 }, false));

    const verdict = await classifyContent('hello friends');
    expect(verdict.flagged).toBe(false);
    expect(verdict.topCategory).toBe('violence');
  });

  test('returns null and never calls fetch when disabled', async () => {
    // mockSettingRows left empty -> disabled
    const verdict = await classifyContent('anything');
    expect(verdict).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns null on empty / whitespace input without calling fetch', async () => {
    enable();
    expect(await classifyContent('   ')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns null on a non-200 response', async () => {
    enable();
    global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => '' });
    expect(await classifyContent('text')).toBeNull();
  });

  test('returns null on a timeout / aborted request', async () => {
    enable();
    global.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    expect(await classifyContent('text', { timeoutMs: 10 })).toBeNull();
  });

  test('returns null on a malformed body', async () => {
    enable();
    global.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) });
    expect(await classifyContent('text')).toBeNull();
  });

  test('returns null when the body is not JSON at all', async () => {
    enable();
    global.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => '<html>502</html>' });
    expect(await classifyContent('text')).toBeNull();
  });

  test('a cache hit does not re-fetch', async () => {
    enable();
    global.fetch.mockResolvedValue(moderationResponse({ hate: 0.9 }));

    await classifyContent('repeated message');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await classifyContent('repeated message');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('the cache key is canonical — diacritic-padded text hits the same entry', async () => {
    enable();
    global.fetch.mockResolvedValue(moderationResponse({ hate: 0.9 }));

    await classifyContent('nigger');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // n + U+0301 combining acute + "igger" canonicalizes to the same string
    await classifyContent('ńigger');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('failures are not cached — a later success still reaches the API', async () => {
    enable();
    global.fetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => '' });
    expect(await classifyContent('text')).toBeNull();

    global.fetch.mockResolvedValueOnce(moderationResponse({ hate: 0.9 }));
    expect(await classifyContent('text')).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('circuit breaker opens after 5 consecutive failures and stops calling out', async () => {
    enable();
    global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => '' });

    for (let i = 0; i < 5; i += 1) {
      // distinct text per iteration so the cache can't mask a skipped call
      expect(await classifyContent(`failing message ${i}`)).toBeNull();
    }
    expect(global.fetch).toHaveBeenCalledTimes(5);

    // Breaker is now open — further calls short-circuit without a request.
    expect(await classifyContent('another message entirely')).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  test('a success resets the failure counter so the breaker never opens', async () => {
    enable();
    for (let i = 0; i < 4; i += 1) {
      global.fetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => '' });
      await classifyContent(`fail ${i}`);
    }
    global.fetch.mockResolvedValueOnce(moderationResponse({ hate: 0.9 }));
    expect(await classifyContent('good one')).not.toBeNull();

    for (let i = 0; i < 4; i += 1) {
      global.fetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => '' });
      await classifyContent(`fail again ${i}`);
    }
    // 4 + 1 + 4 = 9 calls; breaker still closed because the streak was broken.
    expect(global.fetch).toHaveBeenCalledTimes(9);
  });

  test('sends only the message text — no user id, username or channel', async () => {
    enable();
    global.fetch.mockResolvedValue(moderationResponse({ hate: 0.1 }, false));
    await classifyContent('just the text');

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/moderations');
    expect(JSON.parse(init.body)).toEqual({ model: 'omni-moderation-latest', input: 'just the text' });
  });
});

describe('evaluateVerdict', () => {
  const verdict = (scores, flagged = true) => ({
    flagged,
    categories: {},
    scores,
    maxScore: Math.max(0, ...Object.values(scores)),
    topCategory: Object.keys(scores).sort((a, b) => scores[b] - scores[a])[0] ?? null,
  });

  test('blocks at exactly the threshold', () => {
    const r = evaluateVerdict(verdict({ hate: 0.85 }), { hate: 0.85 });
    expect(r.block).toBe(true);
    expect(r.category).toBe('hate');
  });

  test('does not block just below the threshold', () => {
    const r = evaluateVerdict(verdict({ hate: 0.8499 }), { hate: 0.85 });
    expect(r.block).toBe(false);
  });

  test('a category absent from thresholds can never block', () => {
    const r = evaluateVerdict(verdict({ violence: 0.99 }), DEFAULT_THRESHOLDS);
    expect(r.block).toBe(false);
    // ...but the evaluator still reports the strongest signal to its caller
    expect(r.category).toBe('violence');
    expect(r.score).toBeCloseTo(0.99);
  });

  test('reports the highest-scoring breach when several categories trip', () => {
    const r = evaluateVerdict(
      verdict({ hate: 0.9, 'hate/threatening': 0.95 }),
      { hate: 0.85, 'hate/threatening': 0.7 },
    );
    expect(r.block).toBe(true);
    expect(r.category).toBe('hate/threatening');
  });

  test('game-vocabulary violence does not block under the shipped defaults', () => {
    // The calibration that matters most: "nuking your camp" scores high on
    // violence, and violence is deliberately not an enforced category.
    const r = evaluateVerdict(
      verdict({ violence: 0.97, 'violence/graphic': 0.88, harassment: 0.2 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.block).toBe(false);
  });

  test('generic profanity categories are not part of the default chat policy', () => {
    const r = evaluateVerdict(
      verdict({ sexual: 0.99, violence: 0.99, 'self-harm/instructions': 0.99 }),
      DEFAULT_THRESHOLDS,
    );
    expect(r.block).toBe(false);
  });

  test('runtime threshold overrides cannot re-enable non-attack chat categories', () => {
    expect(getChatTargetedAttackThresholds({
      'sexual/minors': 0.1,
      violence: 0.1,
      harassment: 0.95,
      hate: 0.95,
    })).toEqual({ harassment: 0.95, hate: 0.95 });
  });

  test('drops malformed targeted-attack threshold overrides safely', () => {
    expect(getChatTargetedAttackThresholds({
      harassment: 'not-a-number',
      hate: NaN,
      'hate/threatening': 0,
      'harassment/threatening': 1.1,
    })).toEqual({});
  });
});

describe('screenIdentifier', () => {
  test('returns null when disabled', async () => {
    expect(await screenIdentifier('anything')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects a breaching identifier in enforce mode', async () => {
    enable('enforce');
    global.fetch.mockResolvedValue(moderationResponse({ hate: 0.92 }));
    const hit = await screenIdentifier('some-name');
    expect(hit).toEqual({ category: 'hate', score: expect.any(Number) });
  });

  test('allows in shadow mode even when the identifier breaches', async () => {
    enable('shadow');
    global.fetch.mockResolvedValue(moderationResponse({ hate: 0.99 }));
    expect(await screenIdentifier('some-name')).toBeNull();
  });

  test('uses the stricter identifier thresholds, not the chat ones', async () => {
    enable('enforce');
    // harassment 0.75: below the chat default (0.95), but enforced at 0.7
    // for identifiers.
    global.fetch.mockResolvedValue(moderationResponse({ harassment: 0.75 }));
    const hit = await screenIdentifier('some-name');
    expect(hit).not.toBeNull();
    expect(hit.category).toBe('harassment');
  });

  test('returns null (allows) when the API is degraded', async () => {
    enable('enforce');
    global.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => '' });
    expect(await screenIdentifier('some-name')).toBeNull();
  });
});
