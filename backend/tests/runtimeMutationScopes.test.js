const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
let mockRuntime, dir;
jest.mock('../src/runtime', () => ({ get runtime() { return mockRuntime; } }));
const { RuntimeCoordinator, MaintenanceError } = require('../src/runtime/coordinator');
const effects = require('../src/lib/requiredEffects');
const { runRequiredMutation: write, runRequiredTransaction: transaction, runRequiredBundle: bundle, isPrismaAtomicRefusal, isRowCountNoChange } = effects;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { userId: 'fixture-user', stage: 'authority-write-unconfirmed' };
const refusal = () => ({ code: 'P2002' });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-mutation-scope-')); mockRuntime = new RuntimeCoordinator(dir); });
afterEach(() => { mockRuntime.disposeForTests(); fs.rmSync(dir, { recursive: true, force: true }); });
const drain = () => mockRuntime.drain({ timeoutMs: 250 });

test('a caught lookup failure after a committed write stays unresolved without exposing the lookup error', async () => {
  await bundle('session', 'fixture-revoke', async () => {
    await write('session', 'fixture-ban', evidence, async () => 1);
    await effects.runRequiredLookup('session', 'fixture-session-discovery', async () => {
      throw new Error('synthetic-private-token');
    }).catch(() => {});
  });
  expect((await drain()).phase).toBe('failed');
  expect(mockRuntime.snapshot().failures[0].evidence).toMatchObject({
    stage: 'required-discovery-unconfirmed', source: 'fixture-session-discovery',
  });
  expect(JSON.stringify(mockRuntime.snapshot().failures)).not.toContain('synthetic-private-token');
});

test('a successful lookup creates no committed stage and a prewrite lookup refusal stays resolved', async () => {
  await bundle('domain', 'fixture-validate', async () => {
    expect(await effects.runRequiredLookup('domain', 'fixture-validation', async () => 0)).toBe(0);
    throw new Error('validation refused before a write');
  }).catch(() => {});
  await bundle('domain', 'fixture-prewrite', async () => {
    await effects.runRequiredLookup('domain', 'fixture-read', async () => { throw new Error('read unavailable'); });
  }).catch(() => {});
  expect((await drain()).phase).toBe('drained');
});

test('a held required lookup remains owned until its caught failure is recorded', async () => {
  let reject, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const lookup = new Promise((_, fail) => { reject = fail; });
  const operation = bundle('session', 'fixture-held', async () => {
    await write('session', 'fixture-primary', evidence, async () => 1);
    await effects.runRequiredLookup('session', 'fixture-held-discovery', () => { entered(); return lookup; }).catch(() => {});
  });
  await started;
  expect(mockRuntime.snapshot().active.some(item => item.label === 'session:lookup')).toBe(true);
  const closing = drain();
  reject(new Error('lookup unavailable'));
  await operation;
  expect((await closing).phase).toBe('failed');
  expect(mockRuntime.snapshot().active).toEqual([]);
});

test('accepted publication discovery retains failure without a compound bundle', async () => {
  await mockRuntime.run('fixture:accepted-message', async () => {
    await effects.runRequiredLookup('publication', 'fixture-message:publication-client', async () => {
      throw new Error('synthetic-private-token');
    }, 'required').catch(() => {});
  });
  expect((await drain()).phase).toBe('failed');
  expect(mockRuntime.snapshot().failures[0].evidence).toMatchObject({
    source: 'fixture-message:publication-client', stage: 'required-discovery-unconfirmed',
  });
});

test('successful required publication discovery creates no phantom committed mutation', async () => {
  await bundle('publication', 'fixture-lookup-only', async () => {
    await effects.runRequiredLookup('publication', 'fixture-client', async () => 'ready', 'required');
    throw new Error('No publication was attempted');
  }).catch(() => {});
  expect((await drain()).phase).toBe('drained');
});

test('unknown primary disposition is recorded inside the sole retained lease', async () => {
  let reject; const held = new Promise((_, fail) => reject = fail); let retained = false;
  const record = mockRuntime.recordFailure.bind(mockRuntime);
  mockRuntime.recordFailure = (...args) => { retained = mockRuntime.snapshot().active.some(item => item.label === 'authority:primary'); record(...args); };
  const error = new Error('SQL INSERT synthetic-private-token');
  const caller = write('authority', 'fixture-primary', evidence, () => held).catch(value => value);
  const pendingDrain = drain(); await pause(20); expect(mockRuntime.snapshot().active.length).toBeGreaterThan(0);
  reject(error); expect(await caller).toBe(error); expect((await pendingDrain).phase).toBe('failed'); expect(retained).toBe(true);
  expect(JSON.stringify(mockRuntime.snapshot().failures)).not.toContain('synthetic-private-token');
});

test.each(['P2002', 'P2003', 'P2025', 'P2034'])('a traced atomic %s refusal before any committed stage stays resolved', async code => {
  await write('domain', 'fixture-primary', evidence, () => Promise.reject({ code }), isPrismaAtomicRefusal).catch(() => {});
  expect((await drain()).phase).toBe('drained');
});

test('a later definite refusal preserves earlier committed effects in the compound business scope', async () => {
  await bundle('authority', 'fixture-compound', async () => {
    await write('authority', 'fixture-first', { stage: 'first-authority-confirmed' }, async () => ({ count: 1 }));
    await write('authority', 'fixture-second', evidence, async () => { throw refusal(); }, isPrismaAtomicRefusal).catch(() => {});
  });
  expect((await drain()).phase).toBe('failed');
  expect(mockRuntime.snapshot().failures[0].evidence.committedStages).toEqual(['authority-write-confirmed']);
});

test('a fulfilled statement inside a rolled-back transaction never becomes a committed stage', async () => {
  await bundle('domain', 'fixture-atomic', async () => {
    await transaction('domain', 'fixture-tx', evidence, async () => {
      const client = {}; effects.bindRequiredTransactionClient(client);
      await write('domain', 'fixture-inside', { stage: 'inside-statement-confirmed' }, async () => ({ count: 1 }), undefined, client);
      throw refusal();
    }, { confirmedRollback: isPrismaAtomicRefusal }).catch(() => {});
    throw new Error('read-only domain validation after rollback');
  }).catch(() => {});
  expect((await drain()).phase).toBe('drained');
});

test('a known separate rollback cannot erase a previously committed transaction', async () => {
  await bundle('domain', 'fixture-compound', async () => {
    await transaction('domain', 'fixture-first-tx', evidence, async () => {
      const client = {}; effects.bindRequiredTransactionClient(client);
      return write('domain', 'fixture-first', { stage: 'first-transaction-confirmed' }, async () => 1, undefined, client);
    });
    await transaction('domain', 'fixture-second-tx', evidence, async () => {
      const client = {}; effects.bindRequiredTransactionClient(client);
      await write('domain', 'fixture-second', evidence, async () => 1, undefined, client); throw refusal();
    }, { confirmedRollback: isPrismaAtomicRefusal }).catch(() => {});
  });
  expect((await drain()).phase).toBe('failed');
  expect(mockRuntime.snapshot().failures[0].evidence).toMatchObject({ committedStages: ['domain-write-confirmed'], stage: 'previous-effects-committed-transaction-unconfirmed' });
});

test('nested pending statement failures wait for the actual outer rollback disposition', async () => {
  await transaction('domain', 'fixture-outer', evidence, async () => {
    const client = {}; effects.bindRequiredTransactionClient(client);
    await transaction('domain', 'fixture-inner', evidence, async () => {
      await write('domain', 'fixture-inner-write', evidence, async () => { throw new Error('unknown inner response'); }, undefined, client).catch(() => {});
    }, { sameTransaction: client });
    expect(mockRuntime.snapshot().failures).toEqual([]);
    throw refusal();
  }, { confirmedRollback: isPrismaAtomicRefusal }).catch(() => {});
  expect((await drain()).phase).toBe('drained');
});

test('a swallowed unknown statement followed by outer completion keeps the required failure', async () => {
  await transaction('domain', 'fixture-outer', evidence, async () => {
    const client = {}; effects.bindRequiredTransactionClient(client);
    await write('domain', 'fixture-inner', evidence, async () => { throw new Error('unknown statement'); }, undefined, client).catch(() => {});
  });
  expect((await drain()).phase).toBe('failed'); expect(mockRuntime.snapshot().failures).toHaveLength(1);
});

test('unknown commit completion is retained even after every statement has resolved', async () => {
  await transaction('domain', 'fixture-commit', evidence, async () => {
    const client = {}; effects.bindRequiredTransactionClient(client);
    await write('domain', 'fixture-statement', evidence, async () => 1, undefined, client); throw new Error('commit response lost');
  }, { confirmedRollback: isPrismaAtomicRefusal }).catch(() => {});
  expect((await drain()).phase).toBe('failed');
});

test('lazy Prisma array entries are created lazily and only the awaited transaction owns the outcome', async () => {
  let executed = 0; const lazy = { then(resolve) { executed++; resolve(1); } };
  expect(executed).toBe(0);
  await transaction('domain', 'fixture-lazy', evidence, async () => { expect(executed).toBe(0); await Promise.all([lazy]); throw refusal(); }, { lazyArray: true, confirmedRollback: isPrismaAtomicRefusal }).catch(() => {});
  expect(executed).toBe(1); expect((await drain()).phase).toBe('drained');
});

test('parallel transactions cannot share attempt or committed markers', async () => {
  let release; const held = new Promise(resolve => release = resolve);
  await Promise.all([
    transaction('domain', 'fixture-empty', evidence, async () => { await held; throw new Error('read-only unavailable'); }).catch(() => {}),
    transaction('domain', 'fixture-refused', evidence, async () => { const client = {}; effects.bindRequiredTransactionClient(client); await write('domain', 'fixture-other', evidence, async () => 1, undefined, client); release(); throw refusal(); }, { confirmedRollback: isPrismaAtomicRefusal }).catch(() => {}),
  ]);
  expect((await drain()).phase).toBe('drained');
});

test('known zero-change and prewrite validation do not create partial progress', async () => {
  await bundle('domain', 'fixture-noop', async () => {
    await write('domain', 'fixture-zero', evidence, async () => ({ count: 0 }), undefined, undefined, isRowCountNoChange);
    throw new Error('business validation refused');
  }).catch(() => {});
  await transaction('domain', 'fixture-prewrite', evidence, async () => { throw new Error('permission refused before a statement'); }).catch(() => {});
  expect((await drain()).phase).toBe('drained');
});

test('maintenance refusal is never classified as an attempted unknown write', async () => {
  mockRuntime.freeze('fixture');
  let attempted = false; const result = await Promise.resolve().then(() => write('domain', 'fixture-refused', evidence, async () => { attempted = true; })).catch(error => error);
  expect(result).toBeInstanceOf(MaintenanceError); expect(attempted).toBe(false); expect(mockRuntime.snapshot().failures).toEqual([]);
});

test.each(['global-write', 'independent-transaction'])('outer rollback preserves the separately committed %s inside its callback', async mode => {
  await bundle('domain', 'fixture-independent', async () => {
    await transaction('domain', 'fixture-outer', evidence, async () => {
      if (mode === 'global-write') await write('domain', 'fixture-global', { stage: 'independent-global-confirmed' }, async () => 1);
      else await transaction('domain', 'fixture-independent-tx', evidence, async () => write('domain', 'fixture-global', { stage: 'independent-transaction-confirmed' }, async () => 1));
      throw refusal();
    }, { confirmedRollback: isPrismaAtomicRefusal }).catch(() => {});
  });
  expect((await drain()).phase).toBe('failed');
  expect(mockRuntime.snapshot().failures[0].evidence.committedStages).toEqual(['domain-write-confirmed']);
});

test('an explicitly transaction-owned legacy required effect defers failure until proven rollback', async () => {
  const client = {};
  await transaction('audit', 'fixture-audit-tx', evidence, async () => {
    effects.bindRequiredTransactionClient(client);
    await effects.runRequiredEffect('audit:write', evidence, async () => { throw new Error('statement failure before known rollback'); }, undefined, client).catch(() => {});
    throw refusal();
  }, { confirmedRollback: isPrismaAtomicRefusal }).catch(() => {});
  expect((await drain()).phase).toBe('drained');
});

test.each([false, null, 0, { count: 0 }, []])('confirmed no-change result %j does not manufacture partial business progress', async value => {
  await bundle('domain', 'fixture-no-change', async () => {
    await write('domain', 'fixture-no-change-write', evidence, async () => value, undefined, undefined,
      reply => reply === false || reply === null || isRowCountNoChange(reply) || Array.isArray(reply) && reply.length === 0);
    await write('domain', 'fixture-refused-write', evidence, async () => { throw refusal(); }, isPrismaAtomicRefusal).catch(() => {});
  });
  expect((await drain()).phase).toBe('drained');
});

test('an empty lazy transaction has no confirmed progress before a later business refusal', async () => {
  await bundle('domain', 'fixture-empty-array', async () => {
    await transaction('domain', 'fixture-empty-tx', evidence, async () => [], { lazyArray: true, confirmedNoChange: reply => Array.isArray(reply) && reply.length === 0 });
    throw refusal();
  }).catch(() => {});
  expect((await drain()).phase).toBe('drained');
});

test('operator snapshot and reload retain only fixed committed stages and writer hashes', () => {
  const writerId = '0123456789abcdef01234567';
  mockRuntime.recordFailure('domain:primary', new Error('SQL INSERT synthetic-body-token'), {
    stage: 'compound-completion-unconfirmed', committedStages: ['domain-write-confirmed', 'synthetic-body-token', 'SQL INSERT secret'],
    committedWriterIds: [writerId, 'synthetic-body-token', 'https://secret.invalid/token'],
  });
  const expected = { stage: 'compound-completion-unconfirmed', committedStages: ['domain-write-confirmed'], committedWriterIds: [writerId] };
  expect(mockRuntime.snapshot().failures[0].evidence).toEqual(expected);
  mockRuntime.disposeForTests(); mockRuntime = new RuntimeCoordinator(dir);
  expect(mockRuntime.snapshot().failures[0].evidence).toEqual(expected);
  expect(JSON.stringify(mockRuntime.snapshot())).not.toMatch(/synthetic-body-token|SQL INSERT|secret.invalid/);
});

test('a required zero-return schema effect remains committed before a later known refusal', async () => {
  await bundle('domain', 'fixture-schema', async () => {
    await write('domain', 'fixture-zero-ddl', evidence, async () => 0);
    await write('domain', 'fixture-refusal', evidence, async () => { throw refusal(); }, isPrismaAtomicRefusal).catch(() => {});
  });
  expect((await drain()).phase).toBe('failed');
});

test('zero-return schema effects in an awaited lazy array retain default committed completion', async () => {
  await bundle('domain', 'fixture-array-schema', async () => {
    await transaction('domain', 'fixture-array-ddl', evidence, async () => [0], { lazyArray: true });
    throw refusal();
  }).catch(() => {});
  expect((await drain()).phase).toBe('failed');
});
