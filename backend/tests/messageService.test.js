'use strict';
/**
 * Unit tests for messageService.persistMessage
 * (backend/src/services/messageService.ts).
 *
 * Focus: the relay_seq persistence fix. persistMessage must INSERT
 * messages.relay_seq when a relaySeq is provided (relay source) and write NULL
 * when it is omitted (all other sources). Without this, relay messages persist
 * with relay_seq = NULL and poll/history (WHERE relay_seq IS NOT NULL) never
 * return them.
 *
 * Strategy: mock prisma so $executeRaw is a jest.fn(). $executeRaw is a tagged
 * template — it is called as ($executeRaw`...`) so the mock receives
 * (templateStringsArray, ...interpolatedValues). We inspect the joined template
 * (column list) and the interpolated values (the relay_seq position).
 */

jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));

const { persistMessage } = require('../src/services/messageService');
const prismaStub = require('./setup/prisma-stub').default;

const BASE = {
  id: '11111111-1111-1111-1111-111111111111',
  content: 'hello',
  userId: '22222222-2222-2222-2222-222222222222',
  channelId: '33333333-3333-3333-3333-333333333333',
  parentChannelId: '44444444-4444-4444-4444-444444444444',
  source: 'relay',
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaStub.$executeRaw.mockResolvedValue(1);
});

/** Reconstruct the full SQL text from the tagged-template strings array. */
function sqlOf(call) {
  const strings = call[0];
  // strings is a TemplateStringsArray (array-like of static chunks).
  return Array.from(strings).join(' ');
}

describe('persistMessage — relay_seq column', () => {
  it('INSERT statement includes the relay_seq column', async () => {
    await persistMessage({ ...BASE, relaySeq: 7 });
    expect(prismaStub.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf(prismaStub.$executeRaw.mock.calls[0]);
    expect(sql).toContain('relay_seq');
  });

  it('persists relaySeq as a BigInt value when provided (relay source)', async () => {
    await persistMessage({ ...BASE, relaySeq: 7 });
    const values = prismaStub.$executeRaw.mock.calls[0].slice(1);
    // The relay_seq interpolation is BigInt(7) when a seq is provided.
    expect(values).toContain(BigInt(7));
  });

  it('persists NULL relay_seq when relaySeq is omitted (non-relay source)', async () => {
    await persistMessage({ ...BASE, source: 'hud' });
    const values = prismaStub.$executeRaw.mock.calls[0].slice(1);
    // No BigInt anywhere in the interpolated values → relay_seq bound to NULL.
    const hasBigInt = values.some((v) => typeof v === 'bigint');
    expect(hasBigInt).toBe(false);
    // And the column is still present in the statement (bound to NULL::bigint).
    const sql = sqlOf(prismaStub.$executeRaw.mock.calls[0]);
    expect(sql).toContain('relay_seq');
  });
});
