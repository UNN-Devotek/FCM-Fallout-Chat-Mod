import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { discordEventShortcutName } from '../discordOverlayCommandService';

describe('discordEventShortcutName', () => {
  test('converts every requested overlay event trigger to a Discord command name', () => {
    const triggers = [
      '/gu', '/dc', '/lits', '/mj', '/mw', '/nw', '/uf', '/gm', '/dg', '/dpt',
      '/en', '/enc', '/fr', '/ftp', '/hots', '/jb', '/lb', '/ovn', '/pp', '/pte',
      '/rr', '/rs', '/sa', '/sas', '/sbq', '/sos', '/sts', '/tol', '/tt', '/tym', '/ss',
    ];

    assert.deepEqual(triggers.map(discordEventShortcutName), triggers.map((trigger) => trigger.slice(1)));
  });

  test('does not allow malformed or reserved commands to replace existing Discord commands', () => {
    assert.equal(discordEventShortcutName('gu'), null);
    assert.equal(discordEventShortcutName('/wiki'), null);
    assert.equal(discordEventShortcutName('/moderate'), null);
    assert.equal(discordEventShortcutName('/not valid'), null);
  });
});
