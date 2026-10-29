// Run against the disposable CI database after schema push and compilation.
// Exercise the production adapter, not Jest's Prisma mocks.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import clientModule from '../dist/config/prismaClient.js';

if (process.env.NODE_ENV !== 'test') throw new Error('Prisma runtime smoke requires NODE_ENV=test');
const databaseUrl = process.env.PRISMA_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Prisma runtime smoke requires an explicit PRISMA_TEST_DATABASE_URL');
const { createPrismaClient } = clientModule;
const client = createPrismaClient(databaseUrl);
const id = randomUUID();
const username = `prisma-smoke-${id}`;
try {
  assert.deepEqual(await client.$queryRaw`SELECT 42::integer AS value`, [{ value: 42 }]);
  const created = await client.user.create({ data: {
    id, username, installToken: `fixture-${id}`,
    savedDiscordRoles: ['fixture-role'],
  } });
  assert.equal(created.id, id);
  assert.deepEqual(created.savedDiscordRoles, ['fixture-role']);
  assert.ok(created.createdAt instanceof Date);

  const rollback = new Error('fixture rollback');
  await assert.rejects(client.$transaction(async tx => {
    await tx.user.update({ where: { id }, data: { username: `${username}-rolled-back` } });
    throw rollback;
  }), error => error === rollback);
  assert.equal((await client.user.findUniqueOrThrow({ where: { id } })).username, username);

  await assert.rejects(client.user.create({ data: {
    username, installToken: `duplicate-fixture-${id}`,
  } }), error => error.code === 'P2002');
  console.log('PASS Prisma adapter: query, model write/read, JSON/date, transaction rollback and unique-error mapping');
} finally {
  try {
    await client.user.deleteMany({ where: { id } });
  } finally {
    await client.$disconnect();
  }
}
