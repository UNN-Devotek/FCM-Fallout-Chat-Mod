const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture(failure) {
  const hooks = {}, calls = [], error = new Error('synthetic ' + failure), definitions = [];
  const observer = { connect: async () => { calls.push('connect'); if (failure === 'connect') throw error; },
    query: async sql => { calls.push(sql.startsWith('DROP') ? 'drop' : sql.startsWith('CREATE') ? 'create' : 'identity'); if (failure === 'drop' && sql.startsWith('DROP')) throw error; return { rows: [{ name: 'fcm_test' }] }; },
    end: async () => { calls.push('end'); } };
  const database = { $connect: async () => { calls.push('prisma-connect'); }, $disconnect: async () => { calls.push('disconnect'); if (failure === 'disconnect') throw error; } };
  const test = name => definitions.push(name); test.each = values => name => { for (const value of values) definitions.push(name.replace('%s', value)); };
  const suite = (_name, callback) => callback(); suite.skip = suite;
  const requireFixture = name => {
    if (name === 'pg') return { Client: function () { return observer; } };
    if (name === '@prisma/client') return { PrismaClient: function () { return database; } };
    if (name === '../src/runtime/coordinator') return { RuntimeCoordinator: class { disposeForTests() { calls.push('dispose'); } } };
    if (name.startsWith('.')) return {};
    return require(name);
  };
  const source = fs.readFileSync(path.join(__dirname, 'runtimeTransactionsReal.test.js'), 'utf8');
  vm.runInNewContext(source, { require: requireFixture, process: { env: { FCM_RUNTIME_TRANSACTION_TEST_DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1/fcm_test' } }, URL, expect, jest: { mock() {} }, describe: suite, test,
    beforeAll: callback => { hooks.beforeAll = callback; }, beforeEach: callback => { hooks.beforeEach = callback; }, afterEach: callback => { hooks.afterEach = callback; }, afterAll: callback => { hooks.afterAll = callback; } });
  expect(definitions).toHaveLength(9); return { hooks, calls, error };
}
test('failed transaction fixture setup preserves its original error without an undefined-directory cleanup error', async () => {
  const value = fixture('connect'); await expect(value.hooks.beforeAll()).rejects.toBe(value.error);
  expect(() => value.hooks.afterEach()).not.toThrow(); await expect(value.hooks.afterAll()).resolves.toBeUndefined();
  expect(value.calls).toEqual(['connect', 'end']);
});
test.each(['drop', 'disconnect'])('allocated observer ends even when transaction fixture %s cleanup fails', async failure => {
  const value = fixture(failure); await value.hooks.beforeAll();
  await expect(value.hooks.afterAll()).rejects.toBe(value.error); expect(value.calls.at(-1)).toBe('end'); expect(value.calls.filter(item => item === 'end')).toHaveLength(1);
});
test('successful initialized transaction fixture resources still dispose, drop and end', async () => {
  const value = fixture('none'); await value.hooks.beforeAll(); value.hooks.beforeEach(); value.hooks.afterEach(); await value.hooks.afterAll();
  expect(value.calls).toEqual(['connect', 'identity', 'create', 'prisma-connect', 'dispose', 'disconnect', 'drop', 'end']);
});
