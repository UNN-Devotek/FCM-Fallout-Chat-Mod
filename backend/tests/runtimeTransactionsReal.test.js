const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const crypto = require('node:crypto');
const { Client } = require('pg'); const { PrismaClient } = require('@prisma/client');
const { createCommitResponseProxy } = require('./setup/commit-response-proxy.cjs');
let mockRuntime, directory, database, observer, observerConnected = false;
jest.mock('../src/runtime', () => ({ get runtime() { return mockRuntime; } }));
const { RuntimeCoordinator } = require('../src/runtime/coordinator');
const { runRequiredMutation: write, runRequiredTransaction: transaction, runRequiredBundle: bundle, isPrismaAtomicRefusal, bindRequiredTransactionClient, createRequiredAudit, isRowCountNoChange } = require('../src/lib/requiredEffects');
const explicitUrl = process.env.FCM_RUNTIME_TRANSACTION_TEST_DATABASE_URL;
// Deliberately never fall back to DATABASE_URL, .env, or an application store.
const suite = explicitUrl ? describe : describe.skip;
const table = `fcm_runtime_transaction_probe_${crypto.randomBytes(8).toString('hex')}`;
const insert = (tx, id, owned = true) => write('domain', 'real-transaction-insert', { rowId: id, stage: 'fixture-row-confirmed' }, () => tx.$executeRawUnsafe(`INSERT INTO "${table}" (id) VALUES ($1)`, id), undefined, owned ? tx : undefined);
suite('real Prisma transaction dispositions against a verified synthetic database', () => {
  beforeAll(async () => {
    const target = new URL(explicitUrl);
    if (!['postgres:', 'postgresql:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]', 'docker'].includes(target.hostname)
      || !['/fcm_test', '/fcm_runtime_transaction_test'].includes(target.pathname)) throw new Error('Runtime transaction fixture requires an explicitly allowed local synthetic database');
    target.searchParams.set('sslmode', 'disable');
    observer = new Client({ connectionString: target.toString() }); await observer.connect(); observerConnected = true;
    const identity = await observer.query('SELECT current_database() AS name');
    expect(['fcm_test', 'fcm_runtime_transaction_test']).toContain(identity.rows[0].name);
    await observer.query(`CREATE TABLE "${table}" (id text PRIMARY KEY)`);
    database = new PrismaClient({ datasources: { db: { url: target.toString() } } }); await database.$connect();
  }, 20000);
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-real-tx-')); mockRuntime = new RuntimeCoordinator(directory); });
  afterEach(() => { mockRuntime?.disposeForTests(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
  afterAll(async () => {
    try { await database?.$disconnect(); if (observerConnected) await observer.query(`DROP TABLE IF EXISTS "${table}"`); }
    finally { await observer?.end(); }
  });

  test('a real constraint rollback removes every in-transaction statement and stays resolved', async () => {
    await transaction('domain', 'real-atomic-tx', { stage: 'fixture-transaction-unconfirmed' }, () => database.$transaction(async tx => {
      bindRequiredTransactionClient(tx);
      await insert(tx, 'atomic'); await insert(tx, 'atomic');
    }), { confirmedRollback: isPrismaAtomicRefusal }).catch(error => expect(isPrismaAtomicRefusal(error)).toBe(true));
    expect((await observer.query(`SELECT count(*)::int AS count FROM "${table}" WHERE id = 'atomic'`)).rows[0].count).toBe(0);
    expect((await mockRuntime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
  });

  test('confirmed earlier commit survives a separate known rollback and requires partial completion evidence', async () => {
    await bundle('domain', 'real-compound', async () => {
      await transaction('domain', 'real-first-tx', { stage: 'fixture-transaction-unconfirmed' }, () => database.$transaction(tx => { bindRequiredTransactionClient(tx); return insert(tx, 'previous'); }));
      await transaction('domain', 'real-later-tx', { stage: 'fixture-transaction-unconfirmed' }, () => database.$transaction(async tx => {
        bindRequiredTransactionClient(tx);
        await insert(tx, 'later'); await insert(tx, 'later');
      }), { confirmedRollback: isPrismaAtomicRefusal }).catch(() => {});
    });
    const rows = (await observer.query(`SELECT id FROM "${table}" WHERE id IN ('previous', 'later') ORDER BY id`)).rows;
    expect(rows).toEqual([{ id: 'previous' }]); expect((await mockRuntime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
    expect(mockRuntime.snapshot().failures[0].evidence.committedStages).toEqual(['domain-write-confirmed']);
  });

  test.each(['global-write', 'second-transaction'])('a real outer rollback cannot erase an independently committed %s in its callback', async mode => {
    const rolledBack = `outer-${mode}`, committed = `independent-${mode}`;
    await bundle('domain', 'real-independent', async () => {
      await transaction('domain', 'real-outer', { stage: 'outer-transaction-unconfirmed' }, () => database.$transaction(async tx => {
        bindRequiredTransactionClient(tx); await insert(tx, rolledBack);
        if (mode === 'global-write') await insert(database, committed, false);
        else await transaction('domain', 'real-independent-tx', { stage: 'independent-transaction-unconfirmed' }, () => database.$transaction(other => {
          bindRequiredTransactionClient(other); return insert(other, committed);
        }));
        await insert(tx, rolledBack);
      }), { confirmedRollback: isPrismaAtomicRefusal }).catch(() => {});
    });
    expect((await observer.query(`SELECT id FROM "${table}" WHERE id = ANY($1) ORDER BY id`, [[rolledBack, committed]])).rows).toEqual([{ id: committed }]);
    expect((await mockRuntime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
    expect(mockRuntime.snapshot().failures[0].evidence.committedStages).toEqual(['domain-write-confirmed']);
  });

  test('an explicitly tx-owned required audit uses the real atomic rollback instead of sticky statement failure', async () => {
    await transaction('audit', 'real-audit-tx', { stage: 'audit-transaction-unconfirmed' }, () => database.$transaction(async tx => {
      bindRequiredTransactionClient(tx);
      const writer = { create: () => tx.$executeRawUnsafe(`INSERT INTO "${table}" (id) VALUES ('rolled-audit')`) };
      await createRequiredAudit(writer, { data: { action: 'fixture_audit', targetType: 'fixture' } }, {}, tx);
      await createRequiredAudit(writer, { data: { action: 'fixture_audit', targetType: 'fixture' } }, {}, tx);
    }), { confirmedRollback: isPrismaAtomicRefusal }).catch(error => expect(isPrismaAtomicRefusal(error)).toBe(true));
    expect((await observer.query(`SELECT count(*)::int AS count FROM "${table}" WHERE id = 'rolled-audit'`)).rows[0].count).toBe(0);
    expect((await mockRuntime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
  });

  test('parallel real transactions keep a prewrite failure independent from an atomic write refusal', async () => {
    await Promise.all([
      transaction('domain', 'real-empty', {}, () => database.$transaction(async () => { throw new Error('read-only unavailable before a mutation'); })).catch(() => {}),
      transaction('domain', 'real-refused', {}, () => database.$transaction(async tx => {
        bindRequiredTransactionClient(tx); await insert(tx, 'parallel-rolled'); await insert(tx, 'parallel-rolled');
      }), { confirmedRollback: isPrismaAtomicRefusal }).catch(() => {}),
    ]);
    expect((await observer.query(`SELECT count(*)::int AS count FROM "${table}" WHERE id = 'parallel-rolled'`)).rows[0].count).toBe(0);
    expect((await mockRuntime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
  });

  test('a zero-row DML no-op uses its explicit result contract before a later known refusal', async () => {
    await bundle('domain', 'real-zero-dml', async () => {
      const count = await write('domain', 'real-zero-update', {}, () => database.$executeRawUnsafe(`UPDATE "${table}" SET id = id WHERE id = 'never-created'`), undefined, undefined, isRowCountNoChange);
      expect(count).toBe(0);
      await write('domain', 'real-refused', {}, async () => { throw { code: 'P2002' }; }, isPrismaAtomicRefusal).catch(() => {});
    });
    expect((await mockRuntime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
  });

  test('a real zero-return DDL commit remains progress before a later known refusal', async () => {
    const index = `${table}_zero_ddl`;
    await bundle('domain', 'real-zero-ddl', async () => {
      const count = await write('domain', 'real-zero-create-index', {}, () => database.$executeRawUnsafe(`CREATE INDEX "${index}" ON "${table}" (id)`));
      expect(count).toBe(0);
      await write('domain', 'real-refused', {}, async () => { throw { code: 'P2002' }; }, isPrismaAtomicRefusal).catch(() => {});
    });
    expect((await observer.query('SELECT count(*)::int AS count FROM pg_indexes WHERE indexname = $1', [index])).rows[0].count).toBe(1);
    expect((await mockRuntime.drain({ timeoutMs: 1000 })).phase).toBe('failed');
  });

  test('lost COMMIT response remains unknown after an independent connection proves the server committed', async () => {
    const proxy = await createCommitResponseProxy(new URL(explicitUrl), async () => {
      const result = await observer.query(`SELECT count(*)::int AS count FROM "${table}" WHERE id = 'lost-commit'`);
      if (result.rows[0].count !== 1) throw new Error('Commit fixture did not independently prove durable state');
      return { committed: true };
    });
    const proxied = new PrismaClient({ datasources: { db: { url: proxy.url } } });
    try {
      await mockRuntime.initializeSdkLifetime(() => proxied.$connect());
      await expect(transaction('domain', 'real-unknown-commit', { stage: 'fixture-commit-unconfirmed' }, () => proxied.$transaction(tx => { bindRequiredTransactionClient(tx); return insert(tx, 'lost-commit'); }), { confirmedRollback: isPrismaAtomicRefusal })).rejects.toBeDefined();
      expect(await proxy.proof).toEqual({ committed: true });
      const result = await mockRuntime.drain({ timeoutMs: 1000 }); expect(result.phase).toBe('failed'); expect(result.failures.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.failures)).not.toContain('INSERT INTO');
    } finally { await proxy.close(); await proxied.$disconnect(); }
  }, 20000);
});
