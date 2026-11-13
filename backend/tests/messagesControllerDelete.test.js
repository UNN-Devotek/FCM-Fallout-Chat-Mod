'use strict';

// DELETE /api/messages/:id must go through the shared moderation service so the
// delete is audited with its reason, broadcast and posted to the mod alerts.

jest.mock('../src/config/prisma', () => require('./setup/prisma-stub'));
jest.mock('../src/services/discordService', () => ({ relayToDiscord: jest.fn() }));
jest.mock('../src/services/moderationActionsService', () => ({ deleteMessageById: jest.fn() }));
jest.mock('../src/utils/resolveActorId', () => ({ resolveInternalActorId: jest.fn() }));

const { deleteMessageById } = require('../src/services/moderationActionsService');
const { resolveInternalActorId } = require('../src/utils/resolveActorId');
const { deleteMessage } = require('../src/controllers/messagesController');

const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';

function makeReq({ body, query = {}, id = MESSAGE_ID } = {}) {
  return {
    params: { id },
    body,
    query,
    adminUser: { id: '123456789012345678' },
  };
}

function makeRes() {
  return { json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveInternalActorId.mockResolvedValue(ACTOR_ID);
  deleteMessageById.mockResolvedValue(undefined);
});

describe('deleteMessage controller', () => {
  it('deletes through deleteMessageById with the resolved actor and body reason', async () => {
    const res = makeRes();
    const next = jest.fn();

    await deleteMessage(makeReq({ body: { reason: '  spam link  ' } }), res, next);

    expect(resolveInternalActorId).toHaveBeenCalledWith('123456789012345678');
    expect(deleteMessageById).toHaveBeenCalledWith(MESSAGE_ID, ACTOR_ID, 'spam link');
    expect(res.json).toHaveBeenCalledWith({ data: { deleted: true } });
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts the reason from the query string and ignores non-string values', async () => {
    await deleteMessage(makeReq({ query: { reason: 'slur' } }), makeRes(), jest.fn());
    expect(deleteMessageById).toHaveBeenLastCalledWith(MESSAGE_ID, ACTOR_ID, 'slur');

    await deleteMessage(makeReq({ query: { reason: ['a', 'b'] } }), makeRes(), jest.fn());
    expect(deleteMessageById).toHaveBeenLastCalledWith(MESSAGE_ID, ACTOR_ID, '');
  });

  it('maps a missing message to 404', async () => {
    deleteMessageById.mockRejectedValue(new Error('Message not found'));
    const next = jest.fn();

    await deleteMessage(makeReq(), makeRes(), next);

    expect(next.mock.calls[0][0]).toMatchObject({ status: 404 });
  });

  it('rejects a malformed id without touching the service', async () => {
    const next = jest.fn();
    await deleteMessage(makeReq({ id: 'not-a-uuid' }), makeRes(), next);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400 });
    expect(deleteMessageById).not.toHaveBeenCalled();
  });
});
