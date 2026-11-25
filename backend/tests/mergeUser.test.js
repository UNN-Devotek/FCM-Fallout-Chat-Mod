const { mergeUserInto } = require('../src/utils/mergeUser');

function transactionStub() {
  const models = {};
  return new Proxy(models, {
    get(target, model) {
      if (!target[model]) {
        target[model] = new Proxy({}, {
          get(methods, method) {
            if (!methods[method]) {
              methods[method] = jest.fn(async () => method === 'findMany' ? [] : null);
            }
            return methods[method];
          },
        });
      }
      return target[model];
    },
  });
}

describe('mergeUserInto', () => {
  test('repoints retained messages and HUD pairing tokens before deleting the duplicate', async () => {
    const tx = transactionStub();
    tx.user.delete.mockResolvedValue({ hudAutoEventsMuted: false });

    await mergeUserInto('canonical-user', 'duplicate-user', tx);

    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: { userId: 'duplicate-user' },
      data: { userId: 'canonical-user' },
    });
    expect(tx.hudPairingToken.updateMany).toHaveBeenCalledWith({
      where: { linkedUserId: 'duplicate-user' },
      data: { linkedUserId: 'canonical-user' },
    });
    expect(tx.hudPairingToken.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(tx.user.delete.mock.invocationCallOrder[0]);
    expect(tx.user.delete).toHaveBeenCalledWith({
      where: { id: 'duplicate-user' }, select: { hudAutoEventsMuted: true },
    });
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  test('keeps a HUD auto-event mute when its linked tokens move to the canonical account', async () => {
    const tx = transactionStub();
    tx.user.delete.mockResolvedValue({ hudAutoEventsMuted: true });

    await mergeUserInto('canonical-user', 'duplicate-user', tx);

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'canonical-user', hudAutoEventsMuted: false }, data: { hudAutoEventsMuted: true },
    });
  });

  test('does nothing when both IDs are already canonical', async () => {
    const tx = transactionStub();

    await mergeUserInto('same-user', 'same-user', tx);

    expect(Object.keys(tx)).toHaveLength(0);
  });
});
