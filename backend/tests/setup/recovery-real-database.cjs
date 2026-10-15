const crypto = require('node:crypto');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');

// No fallback to DATABASE_URL, .env, hosted Dev, or an application database.
async function openRecoveryDatabase() {
  const explicit = process.env.FCM_RUNTIME_TRANSACTION_TEST_DATABASE_URL;
  if (!explicit) throw new Error('Recovery compatibility tests require the explicit local synthetic PostgreSQL fixture');
  const url = new URL(explicit);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || (!['localhost', '127.0.0.1', '[::1]', 'docker'].includes(url.hostname) && !/^(?:192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(url.hostname))
    || !/^\/fcm_(?:test|runtime_transaction_test|runtime_task2a_[a-z0-9]+_test)$/.test(url.pathname)) {
    throw new Error('Recovery compatibility tests require an allowlisted local synthetic database');
  }
  url.searchParams.set('sslmode', 'disable');
  const observer = new Client({ connectionString: url.toString() });
  const schema = 'fcm_recovery_' + crypto.randomBytes(8).toString('hex');
  let database, connected = false, schemaCreated = false;
  const close = async () => {
    try { await database?.$disconnect(); if (schemaCreated) await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { if (connected) await observer.end(); }
  };
  try {
    await observer.connect(); connected = true;
    const identity = (await observer.query('SELECT current_database() AS name')).rows[0].name;
    if ('/' + identity !== url.pathname) throw new Error('Recovery fixture database identity mismatch');
    await observer.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    const tables = ['users', 'channels', 'messages', 'audit_logs', 'sessions', 'reports', 'automod_rules', 'word_filter', 'moderation_settings', 'admin_users'];
    for (const table of tables) await observer.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    // LIKE copies serial nextval dependencies; replace all three before any insert.
    for (const table of ['admin_users', 'moderation_settings', 'word_filter']) {
      const sequence = `${table}_id_seq`;
      await observer.query(`CREATE SEQUENCE "${schema}"."${sequence}" OWNED BY "${schema}"."${table}".id`);
      await observer.query(`ALTER TABLE "${schema}"."${table}" ALTER COLUMN id SET DEFAULT nextval('"${schema}"."${sequence}"'::regclass)`);
    }
    await observer.query(`ALTER TABLE "${schema}".audit_logs ADD CONSTRAINT audit_actor_fixture_fk FOREIGN KEY (actor_id) REFERENCES "${schema}".users(id) ON DELETE SET NULL`);
    await observer.query(`ALTER TABLE "${schema}".messages ADD FOREIGN KEY (user_id) REFERENCES "${schema}".users(id) ON DELETE CASCADE`);
    await observer.query(`ALTER TABLE "${schema}".messages ADD FOREIGN KEY (channel_id) REFERENCES "${schema}".channels(id) ON DELETE RESTRICT`);
    await observer.query(`ALTER TABLE "${schema}".automod_rules ADD FOREIGN KEY (created_by_id) REFERENCES "${schema}".users(id) ON DELETE SET NULL`);
    await observer.query(`SET search_path TO "${schema}", public`);
    url.searchParams.set('schema', schema);
    database = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await database.$connect();
    return { database, schema, close, query: (sql, params) => observer.query(sql, params),
      reset: () => observer.query(`TRUNCATE ${tables.map(table => `"${schema}"."${table}"`).join(', ')} CASCADE`) };
  } catch (error) { await close(); throw error; }
}
module.exports = { openRecoveryDatabase };
