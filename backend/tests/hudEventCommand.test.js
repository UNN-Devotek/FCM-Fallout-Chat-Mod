const { hudEventCommand } = require('../src/services/relay/hudEventCommand');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const event = (overrides = {}) => ({
  id: 1, trigger: '/sbq', alias: '/queen', description: 'Scorched Earth',
  response: 'Scorched Earth event', actionType: 'announce',
  targetChannelId: 'events', allowedChannelId: 'general', cooldownSec: 30,
  enabled: true, requiresArgs: false, responseColor: null, relayToDiscord: true,
  ...overrides,
});

describe('HUD event command boundary', () => {
  test('the private HUD guide contains every seeded event shortcut', () => {
    const root = resolve(__dirname, '../..');
    const hud = readFileSync(resolve(root, 'game-mods/FCMBridge/hudmodloader-chat/FcmEventCommands.hx'), 'utf8');
    const seed = [
      '20260418210000_event_commands',
      '20260608020000_infests_channel_and_sinkhole_command',
    ].map((migration) => readFileSync(resolve(root, 'backend/prisma/migrations', migration, 'migration.sql'), 'utf8')).join('\n');
    const hudCodes = [...hud.matchAll(/"([a-z]+)\|/g)].map((match) => match[1]).sort();
    const seedCodes = [...seed.matchAll(/VALUES\s*\(\s*'\/([a-z]+)'/g)].map((match) => match[1]).sort();
    expect(hudCodes).toEqual(seedCodes);
  });

  test('restores slash and accepts the event namespace and alias', () => {
    expect(hudEventCommand('sbq', [event()])).toBe('/sbq');
    expect(hudEventCommand('/event sbq', [event()])).toBe('/sbq');
    expect(hudEventCommand('.queen now', [event()])).toBe('/queen now');
  });

  test('rejects ordinary chat and other command types', () => {
    expect(hudEventCommand('events tonight', [event()])).toBeNull();
    expect(hudEventCommand('/sbqx', [event()])).toBeNull();
    expect(hudEventCommand('/sbq', [event({ actionType: 'private' })])).toBeNull();
    expect(hudEventCommand('/ban user', [event()])).toBeNull();
  });
});
