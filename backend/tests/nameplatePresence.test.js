const { createHash } = require('node:crypto');
const values = new Map();
const rosters = new Map();
const rooms = new Map();
const redis = { get: jest.fn(async key => values.get(key) ?? null),
  set: jest.fn(async (key, value) => { values.set(key, value); return 'OK'; }) };
jest.mock('../src/config/redis', () => ({ getRedisClient: async () => redis }));
jest.mock('../src/config/prisma', () => ({ __esModule:true, default: {
  user: { findUnique: jest.fn(async () => ({ isBanned:false, kickedUntil:null })) },
  hudPairingToken: { findFirst: jest.fn(async ({ where }) => ({ linkedUserId:where.userId + '-account' })) },
} }));
jest.mock('../src/services/relay/worldRosterService', () => ({
  readRoster: jest.fn(async id => rosters.get(id) ?? null),
  getAllRosters: async () => [...rosters.values()],
  normalizeRosterName: name => String(name).split('<')[0].trim().toLowerCase(),
}));
jest.mock('../src/services/relay/worldIdService', () => ({ getWorldId: async id => rooms.get(id) ?? null }));
const { NAMEPLATE_CONTROL, nameplateReply, indexBridgeNameplates, parseNameplateRequest, parseNameplateReply } = require('../src/services/relay/nameplatePresence');
const prisma = require('../src/config/prisma').default;
const { readRoster } = require('../src/services/relay/worldRosterService');
const bridgeRequestId = (sessionId, worldGeneration) => createHash('sha256').update(`${sessionId}\0${worldGeneration}`).digest('hex');

async function actor(id, kind, name, seen, options = {}) {
  const sessionId = `${id}-movie`, worldGeneration = `${id}-world`;
  const bridge = kind.startsWith('bridge:');
  const requestId = bridge ? bridgeRequestId(sessionId, worldGeneration) : `${id}-native`;
  rosters.set(id, { userId:id, name, seen, aliases:[], roomKey:'r:shared', observedAt:100000,
    expiresAt:130000, requestId, observationSource:bridge ? kind : 'native', ...options });
  rooms.set(id, 'r:shared');
  if (bridge) {
    const snapshot = { sessionId, worldGeneration };
    values.set(`relay:local-export:${id}`, JSON.stringify({ active:true, owner:`${id}-owner`, snapshot, expiresAt:130000 }));
    values.set(`relay:local-export:${id}:connection`, '7');
    values.set(`session:${id}-token`, `${id}-account`);
    await indexBridgeNameplates(snapshot, `${id}-account`, `${id}-token`, id, `${id}-owner`, 7, 130000);
  }
  return bridge ? { mode:'bridge', requestId:'request-1', sessionId, worldGeneration }
    : { mode:'hud', requestId:'request-1', nativeRequestId:requestId };
}
beforeEach(() => {
  values.clear(); rosters.clear(); rooms.clear(); jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(100000);
  prisma.user.findUnique.mockResolvedValue({ isBanned:false, kickedUntil:null });
  prisma.hudPairingToken.findFirst.mockImplementation(async ({ where }) => ({ linkedUserId:where.userId + '-account' }));
  readRoster.mockImplementation(async id => rosters.get(id) ?? null);
});
afterEach(() => jest.restoreAllMocks());

const kinds = ['hud:zfe','hud:xscal','bridge:zfe','bridge:xscal'];
test.each(kinds.flatMap(viewer => kinds.map(peer => [viewer, peer])))('%s sees %s only in the same canonical room', async (viewer, peer) => {
  const request = await actor('viewer', viewer, 'Viewer', ['Peer']);
  await actor('peer', peer, 'Peer', ['Viewer']);
  const response = await nameplateReply(request, { userId:'viewer', linkedUserId:request.mode === 'hud' ? 'viewer-account' : null });
  expect(response.names).toEqual(['peer']); expect(response.ttlMs).toBe(10000);
  rooms.set('peer', 'r:other');
  expect((await nameplateReply(request, { userId:'viewer', linkedUserId:'viewer-account' })).names).toEqual([]);
});
test('private control and replica replies have strict bounded schemas', () => {
  const request = { mode:'bridge',requestId:'a',sessionId:'b',worldGeneration:'c' };
  expect(parseNameplateRequest(NAMEPLATE_CONTROL + JSON.stringify(request))).toEqual(request);
  for (const invalid of [{...request, token:'secret'}, {...request,sessionId:'BAD'}, {...request,worldGeneration:'x'.repeat(65)}])
    expect(parseNameplateRequest(NAMEPLATE_CONTROL + JSON.stringify(invalid))).toBeNull();
  const reply = { version:1,requestId:'a',context:'bridge:b/c',ttlMs:10000,names:['peer'] };
  expect(parseNameplateReply(reply)).toEqual(reply);
  for (const invalid of [{...reply,ttlMs:10001},{...reply,names:['Peer']},{...reply,names:Array(25).fill('peer')},{...reply,token:'x'}])
    expect(parseNameplateReply(invalid)).toBeNull();
});
test('aliases match only observed names, never nearby nonusers or unlinked native users', async () => {
  const request = await actor('viewer','hud:zfe','Viewer',['RosterPeer','Stranger']);
  await actor('peer','hud:xscal','DiscordPeer',['Viewer'],{ aliases:['RosterPeer'] });
  expect((await nameplateReply(request, {userId:'viewer',linkedUserId:'account'})).names).toEqual(['rosterpeer']);
  prisma.hudPairingToken.findFirst.mockResolvedValue(null);
  expect((await nameplateReply(request, {userId:'viewer',linkedUserId:'account'})).names).toEqual([]);
  expect((await nameplateReply(request, {userId:'viewer',linkedUserId:null})).ttlMs).toBe(0);
});
test('transport heartbeat cannot renew observation freshness or ten-second leases', async () => {
  const request = await actor('viewer','hud:zfe','Viewer',['Peer']);
  await actor('peer','hud:xscal','Peer',['Viewer'],{observedAt:71500,expiresAt:200000});
  expect((await nameplateReply(request, {userId:'viewer',linkedUserId:'account'})).ttlMs).toBe(1500);
  Date.now.mockReturnValue(101500);
  expect((await nameplateReply(request, {userId:'viewer',linkedUserId:'account'})).names).toEqual([]);
});
test.each(['logout','owner','connection','expired','world','generation','ban'])('bridge rendezvous rejects %s and never falls back to another device', async reason => {
  const request = await actor('viewer','bridge:xscal','Viewer',['Peer']);
  await actor('peer','hud:zfe','Peer',['Viewer']);
  const state = JSON.parse(values.get('relay:local-export:viewer'));
  if (reason === 'logout') values.delete('session:viewer-token');
  if (reason === 'owner') state.owner = 'replacement-owner';
  if (reason === 'connection') values.set('relay:local-export:viewer:connection','8');
  if (reason === 'expired') state.expiresAt = 100000;
  if (reason === 'world') rooms.set('viewer','r:other');
  if (reason === 'generation') state.snapshot.worldGeneration = 'next-world';
  if (reason === 'ban') prisma.user.findUnique.mockResolvedValue({isBanned:true});
  values.set('relay:local-export:viewer',JSON.stringify(state));
  expect((await nameplateReply(request, {userId:'unlinked-transport',linkedUserId:null})).ttlMs).toBe(0);
});
test('a hop during asynchronous reads fences the outgoing response', async () => {
  const request = await actor('viewer','hud:zfe','Viewer',['Peer']);
  await actor('peer','hud:xscal','Peer',['Viewer']);
  readRoster.mockImplementationOnce(async id => rosters.get(id));
  readRoster.mockImplementationOnce(async id => ({...rosters.get(id),requestId:'new-world'}));
  expect((await nameplateReply(request,{userId:'viewer',linkedUserId:'account'})).ttlMs).toBe(0);
});
