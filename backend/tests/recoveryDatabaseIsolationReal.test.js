const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { openRecoveryDatabase } = require('./setup/recovery-real-database.cjs');
const serialTables = ['admin_users', 'moderation_settings', 'word_filter'];
let observer;
const observations = [];
beforeAll(async () => {
  const url = new URL(process.env.FCM_RUNTIME_TRANSACTION_TEST_DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || (!['localhost', '127.0.0.1', '[::1]', 'docker'].includes(url.hostname) && !/^(?:192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(url.hostname))
    || !/^\/fcm_(?:test|runtime_transaction_test|runtime_task2a_[a-z0-9]+_test)$/.test(url.pathname)) throw Error('Explicit local synthetic database required');
  url.searchParams.set('sslmode', 'disable');
  observer = new Client({ connectionString: url.toString() }); await observer.connect();
  await observer.query('SET default_transaction_read_only = on');
});
afterAll(async () => {
  await observer?.end();
  if (process.env.FCM_RECOVERY_FIXTURE_PROOF) fs.writeFileSync(process.env.FCM_RECOVERY_FIXTURE_PROOF, JSON.stringify(observations, null, 2) + '\n');
});
async function publicState() {
  const state = {};
  for (const table of serialTables) state[table] = {
    ...(await observer.query(`SELECT last_value::text, is_called FROM public.${table}_id_seq`)).rows[0],
    rows: (await observer.query(`SELECT count(*)::int AS count FROM public.${table}`)).rows[0].count,
  };
  return state;
}
async function schemaCount(schema) {
  return (await observer.query('SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1', [schema])).rows[0].count;
}
async function insertSerialRows(database) {
  const tag = randomUUID();
  return Promise.all([
    database.adminUser.create({ data: { discordId: tag, username: 'Synthetic sequence admin' } }),
    database.moderationSetting.create({ data: { key: tag, value: 'synthetic sequence setting' } }),
    database.wordFilter.create({ data: { phrase: tag } }),
  ]);
}
test('all copied serial defaults generate privately across setup, inserts, reset and close', async () => {
  const before = await publicState(); let fixture;
  const facts = { before }; observations.push(facts);
  try {
    fixture = await openRecoveryDatabase(); facts.schema = fixture.schema;
    facts.afterSetup = await publicState(); expect(facts.afterSetup).toEqual(before);
    facts.defaults = (await fixture.query(`SELECT t.relname AS table_name, sn.nspname AS sequence_schema, s.relname AS sequence_name,
      own.refobjid = t.oid AND own.refobjsubid = a.attnum AS owned_by_column
      FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid JOIN pg_attrdef ad ON ad.adrelid = t.oid AND ad.adnum = a.attnum
      JOIN pg_depend d ON d.classid = 'pg_attrdef'::regclass AND d.objid = ad.oid
      JOIN pg_class s ON s.oid = d.refobjid AND s.relkind = 'S' JOIN pg_namespace sn ON sn.oid = s.relnamespace
      LEFT JOIN pg_depend own ON own.classid = 'pg_class'::regclass AND own.objid = s.oid AND own.refclassid = 'pg_class'::regclass AND own.deptype IN ('a', 'i')
      WHERE n.nspname = $1 ORDER BY table_name`, [fixture.schema])).rows;
    // Refuse legacy defaults before any insert can advance a shared sequence.
    expect(facts.defaults.map(row => row.table_name)).toEqual(serialTables);
    expect(facts.defaults.every(row => row.sequence_schema === fixture.schema && row.owned_by_column)).toBe(true);
    facts.firstIds = (await insertSerialRows(fixture.database)).map(row => row.id);
    expect(facts.firstIds).toEqual([1, 1, 1]);
    facts.afterInsert = await publicState(); expect(facts.afterInsert).toEqual(before);
    await fixture.reset(); facts.afterReset = await publicState(); expect(facts.afterReset).toEqual(before);
    expect(await fixture.database.adminUser.count()).toBe(0); expect(await fixture.database.moderationSetting.count()).toBe(0); expect(await fixture.database.wordFilter.count()).toBe(0);
    facts.secondIds = (await insertSerialRows(fixture.database)).map(row => row.id);
    expect(facts.secondIds).toEqual([2, 2, 2]);
    facts.afterSecondInsert = await publicState(); expect(facts.afterSecondInsert).toEqual(before);
  } finally {
    if (fixture) { await fixture.close(); facts.schemaCountAfterClose = await schemaCount(fixture.schema); expect(facts.schemaCountAfterClose).toBe(0); }
    facts.afterClose = await publicState(); expect(facts.afterClose).toEqual(before);
  }
});
test('partial setup failure removes only its owned schema and leaves every public sequence unchanged', async () => {
  const before = await publicState(), query = Client.prototype.query; let schema;
  const spy = jest.spyOn(Client.prototype, 'query').mockImplementation(function (sql, ...args) {
    if (typeof sql === 'string' && sql.startsWith('CREATE SCHEMA "fcm_recovery_')) schema = sql.match(/"([^"]+)"/)[1];
    if (typeof sql === 'string' && sql.includes('ADD CONSTRAINT audit_actor_fixture_fk')) return Promise.reject(Error('Synthetic fixture setup refusal'));
    return query.call(this, sql, ...args);
  });
  try {
    await expect(openRecoveryDatabase()).rejects.toThrow('Synthetic fixture setup refusal');
    expect(schema).toMatch(/^fcm_recovery_[a-f0-9]+$/); expect(await schemaCount(schema)).toBe(0);
    const afterFailure = await publicState(); expect(afterFailure).toEqual(before);
    observations.push({ setupFailure: true, schema, schemaCountAfterFailure: 0, before, afterFailure });
  } finally { spy.mockRestore(); }
});
