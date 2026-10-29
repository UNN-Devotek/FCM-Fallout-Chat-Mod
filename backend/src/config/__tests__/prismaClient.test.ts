import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrismaClient } from '../prismaClient';

test('the runtime client initializes with the PostgreSQL adapter without opening a connection', async () => {
  const client = createPrismaClient('postgresql://fixture:fixture@127.0.0.1:1/fixture?schema=public');
  try {
    assert.equal(typeof client.user.findUnique, 'function');
    assert.equal(typeof client.$transaction, 'function');
  } finally {
    await client.$disconnect();
  }
});

test('invalid database configuration fails without exposing its contents', () => {
  assert.throws(() => createPrismaClient(''), { message: 'DATABASE_URL is required for Prisma' });
  for (const value of ['not-a-database-url', 'https://fixture:secret@invalid.example/db']) {
    assert.throws(() => createPrismaClient(value), { message: 'DATABASE_URL must be a PostgreSQL URL' });
  }
});
