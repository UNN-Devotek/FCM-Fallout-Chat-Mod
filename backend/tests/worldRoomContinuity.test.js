const values = new Map();
const redis = {
  get: jest.fn(async key => values.get(key) ?? null),
  set: jest.fn(async (key, value, options = {}) => {
    if (options.XX && !values.has(key)) return null;
    values.set(key, value); return 'OK';
  }),
  del: jest.fn(async key => values.delete(key)),
  copy: jest.fn(async () => false),
  lPush: jest.fn(async () => 1),
  lTrim: jest.fn(async () => 'OK'),
  expire: jest.fn(async () => true),
  scanIterator: async function* () { yield [...values.keys()]; },
};
jest.mock('../src/config/redis', () => ({ getRedisClient: async () => redis }));
jest.mock('../src/config/logger', () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
const logger = require('../src/config/logger').default;
const { setRoster, clearRoster, computeRooms, readRoster } = require('../src/services/relay/worldRosterService');
beforeEach(() => { values.clear(); jest.clearAllMocks(); });

test.each([false, true])('rejoin keeps the continuously occupied room regardless of UUID order (reverse=%s)', async reverse => {
  const low = 'r:00000000-0000-4000-8000-000000000001';
  const high = 'r:ffffffff-ffff-4fff-8fff-ffffffffffff';
  const survivor = reverse ? low : high, returning = reverse ? high : low;
  values.set('relay:roster:laptop', JSON.stringify({ name: 'alice', seen: ['bob'], session: 'stay', requestId: 'stay', roomKey: survivor, sessionStartedAt: 1000 }));
  values.set('relay:roster:desktop', JSON.stringify({ name: 'bob', seen: ['alice'], session: 'return', requestId: 'return', roomKey: returning, sessionStartedAt: 2000 }));
  const rooms = await computeRooms();
  expect(rooms.get('laptop')).toBe(survivor);
  expect(rooms.get('desktop')).toBe(survivor);
  expect(redis.copy).not.toHaveBeenCalled();
});

test.each([false, true])('verified 5+1 join keeps the majority room even when the singleton is older (reverse=%s)', async reverse => {
  const low = 'r:00000000-0000-4000-8000-000000000001';
  const high = 'r:ffffffff-ffff-4fff-8fff-ffffffffffff';
  const stableRoom = reverse ? low : high;
  const singletonRoom = reverse ? high : low;
  const stable = ['alice', 'bob', 'carol', 'dave', 'erin'];
  for (const name of stable) values.set(`relay:roster:${name}`, JSON.stringify({
    name, seen: [...stable.filter(peer => peer !== name), 'frank'],
    session: name, requestId: name, roomKey: stableRoom, sessionStartedAt: 2000,
  }));
  values.set('relay:roster:frank', JSON.stringify({
    name: 'frank', seen: stable, session: 'frank', requestId: 'frank',
    roomKey: singletonRoom, sessionStartedAt: 1000,
  }));

  const rooms = await computeRooms();
  expect(new Set(rooms.values())).toEqual(new Set([stableRoom]));
  expect((await readRoster('frank')).roomKey).toBe(stableRoom);
  expect(redis.copy).not.toHaveBeenCalled();
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'room_rebind',
    reason: 'component_join', componentSize: 6, memberRefs: [expect.any(String)] }),
  '[worldRoster] canonical room reassigned');
});

test('a 1+1 join still uses oldest-session tie break even when its room UUID sorts last', async () => {
  const olderRoom = 'r:ffffffff-ffff-4fff-8fff-ffffffffffff';
  const newerRoom = 'r:00000000-0000-4000-8000-000000000001';
  values.set('relay:roster:a', JSON.stringify({ name: 'alice', seen: ['bob'], session: 'a',
    requestId: 'a', roomKey: olderRoom, sessionStartedAt: 1000 }));
  values.set('relay:roster:b', JSON.stringify({ name: 'bob', seen: ['alice'], session: 'b',
    requestId: 'b', roomKey: newerRoom, sessionStartedAt: 2000 }));
  expect(new Set((await computeRooms()).values())).toEqual(new Set([olderRoom]));
  expect(redis.copy).not.toHaveBeenCalled();
});

test('clearing a missing roster does not fill the diagnostics ring, but clearing an existing roster does', async () => {
  await clearRoster('missing');
  await clearRoster('missing');
  expect(redis.del).toHaveBeenCalledTimes(2);
  expect(redis.lPush).not.toHaveBeenCalled();

  const room = 'r:aaaaaaaa-0000-4000-8000-000000000001';
  values.set('relay:roster:present', JSON.stringify({ name: 'alice', seen: ['bob'],
    session: 'present', requestId: 'present', roomKey: room }));
  await clearRoster('present');
  const globalEvents = redis.lPush.mock.calls
    .filter(([key]) => key === 'relay:room-diagnostics:recent')
    .map(([, payload]) => JSON.parse(payload));
  expect(globalEvents).toEqual([expect.objectContaining({ event: 'roster_cleared',
    previousRosterCount: 1, previousRoomRef: expect.any(String) })]);

  await clearRoster('present');
  expect(redis.del).toHaveBeenCalledTimes(4);
  expect(redis.lPush).toHaveBeenCalledTimes(2);
});

test('session age survives observations but resets on generation change', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await setRoster('a', 'Alice', [], 'one');
    clock.mockReturnValue(2000);
    await setRoster('a', 'Alice', ['Bob'], 'one');
    expect((await readRoster('a')).sessionStartedAt).toBe(1000);
    await setRoster('a', 'Alice', [], 'two');
    expect((await readRoster('a')).sessionStartedAt).toBe(2000);
    await clearRoster('a');
    clock.mockReturnValue(3000);
    await setRoster('a', 'Alice', [], 'two');
    expect((await readRoster('a')).sessionStartedAt).toBe(3000);
  } finally { clock.mockRestore(); }
});

test('a verified HUD reload may rotate its request nonce without rotating room affinity', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await setRoster('a', 'Alice', ['Bob'], 'first');
    const first = await computeRooms();
    const before = await readRoster('a');
    clock.mockReturnValue(2000);
    await setRoster('a', 'Alice', ['Bob'], 'replacement', undefined, [], { preserveExistingSession: true });
    const after = await readRoster('a');
    expect(after).toMatchObject({ requestId: 'replacement', session: before.session,
      roomKey: first.get('a'), sessionStartedAt: 1000 });
    expect((await computeRooms()).get('a')).toBe(first.get('a'));
  } finally { clock.mockRestore(); }
});

test('verified HUD reloads preserve a continuously connected multi-user room', async () => {
  const users = ['alice', 'bob', 'carol', 'dave', 'erin'];
  for (const user of users) {
    await setRoster(user, user, users.filter(peer => peer !== user), `first-${user}`);
  }
  const before = await computeRooms();
  const room = before.get('alice');
  expect(new Set(before.values())).toEqual(new Set([room]));

  // A UI reload can reconstruct every active widget without anyone leaving the
  // Fallout server. Each verified replacement nonce must retain the component.
  for (const user of users) {
    await setRoster(user, user, users.filter(peer => peer !== user), `reload-${user}`, undefined, [],
      { preserveExistingSession: true });
    expect(new Set((await computeRooms()).values())).toEqual(new Set([room]));
  }
});

test('a replacement HUD cannot erase fresh roster evidence before its data sources recover', async () => {
  await setRoster('a', 'Alice', ['Bob', 'Carol'], 'first-a');
  await setRoster('b', 'Bob', ['Alice', 'Carol'], 'first-b');
  await setRoster('c', 'Carol', ['Alice', 'Bob'], 'first-c');
  const room = (await computeRooms()).get('a');
  const before = await readRoster('a');

  // A reconstructed HUDMenu initially reports an empty MapMenuData snapshot. The
  // backend must leave its fresh evidence and TTL untouched and wait for recovery.
  await expect(setRoster('a', 'Alice', [], 'reload-a', undefined, [],
    { recoverHudReplacement: true })).resolves.toBe(false);
  expect(await readRoster('a')).toEqual(before);
  expect(new Set((await computeRooms()).values())).toEqual(new Set([room]));

  // Once the replacement sees any prior peer, the existing roster-overlap
  // heuristic proves continuity and the delivery nonce may rotate safely.
  await expect(setRoster('a', 'Alice', ['Bob'], 'reload-a', undefined, [],
    { recoverHudReplacement: true })).resolves.toBe(true);
  expect(await readRoster('a')).toMatchObject({ requestId: 'reload-a', session: before.session,
    roomKey: room, sessionStartedAt: before.sessionStartedAt });
  expect(new Set((await computeRooms()).values())).toEqual(new Set([room]));
});

test('simultaneous empty snapshots from reconstructed HUDs leave the whole room intact', async () => {
  const users = ['alice', 'bob', 'carol', 'dave', 'erin'];
  for (const user of users) await setRoster(user, user, users.filter(peer => peer !== user), `first-${user}`);
  const room = (await computeRooms()).get('alice');
  const before = new Map(await Promise.all(users.map(async user => [user, await readRoster(user)])));

  for (const user of users) {
    await expect(setRoster(user, user, [], `reload-${user}`, undefined, [],
      { recoverHudReplacement: true })).resolves.toBe(false);
    expect(await readRoster(user)).toEqual(before.get(user));
    expect(new Set((await computeRooms()).values())).toEqual(new Set([room]));
  }
});

test('a disjoint replacement roster remains a new world generation', async () => {
  await setRoster('a', 'Alice', ['Bob'], 'first');
  const oldRoom = (await computeRooms()).get('a');
  const oldSession = (await readRoster('a')).session;
  await expect(setRoster('a', 'Alice', ['Carol'], 'replacement', undefined, [],
    { recoverHudReplacement: true })).resolves.toBe(true);
  expect((await readRoster('a')).session).not.toBe(oldSession);
  expect((await computeRooms()).get('a')).not.toBe(oldRoom);
});

test('a populated HUD replacement may retain its established room from a matching current peer', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    const users = [
      ['a', 'Alice', 'native'],
      ['b', 'Bob', 'bridge:xscal'],
      ['c', 'Carol', 'native'],
    ];
    for (const [id, name, source] of users) {
      await setRoster(id, name, users.filter(([peerId]) => peerId !== id).map(([, peerName]) => peerName),
        `first-${id}`, undefined, [], { observationSource: source });
    }
    const oldRoom = (await computeRooms()).get('a');
    const before = await readRoster('a');
    const population = Array.from({ length: 23 }, (_, index) => `RaidPlayer${index}`);

    clock.mockReturnValue(2_000);
    await setRoster('b', 'Bob', population, 'first-b', undefined, [], { observationSource: 'bridge:xscal' });
    await setRoster('c', 'Carol', population.slice(0, 22), 'first-c', undefined, [], { observationSource: 'native' });
    await expect(setRoster('a', 'Alice', [], 'replacement-a', undefined, [],
      { recoverHudReplacement: true, observationSource: 'native' })).resolves.toBe(false);
    await expect(setRoster('a', 'Alice', [], 'replacement-a', undefined, [],
      { recoverHudReplacement: true, observationSource: 'native' })).resolves.toBe(false);

    await expect(setRoster('a', 'Alice', population, 'replacement-a', undefined, [],
      { recoverHudReplacement: true, observationSource: 'native' })).resolves.toBe(true);
    expect(await readRoster('a')).toMatchObject({
      requestId: 'replacement-a', session: before.session, roomKey: oldRoom,
      lastDirectEvidenceAt: before.lastDirectEvidenceAt,
    });
    expect(new Set((await computeRooms()).values())).toEqual(new Set([oldRoom]));
  } finally { clock.mockRestore(); }
});

test.each([
  [18, true],
  [17, false],
  [2, false],
])('replacement peer overlap boundary with %i of 24 names preserves session=%s', async (sharedCount, retained) => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    await setRoster('a', 'Alice', ['Bob'], 'first-a');
    await setRoster('b', 'Bob', ['Alice'], 'first-b');
    await computeRooms();
    const before = await readRoster('a');
    const shared = Array.from({ length: sharedCount }, (_, index) => `Shared${index}`);
    const candidate = [...shared, ...Array.from({ length: 24 - sharedCount }, (_, index) => `OnlyA${index}`)];
    const peer = [...shared, ...Array.from({ length: 24 - sharedCount }, (_, index) => `OnlyB${index}`)];
    clock.mockReturnValue(2_000);
    await setRoster('b', 'Bob', peer, 'first-b');
    await setRoster('a', 'Alice', candidate, 'replacement-a', undefined, [], { recoverHudReplacement: true });
    expect((await readRoster('a')).session === before.session).toBe(retained);
  } finally { clock.mockRestore(); }
});

test('replacement shared-population evidence expires and never renews direct evidence', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    await setRoster('a', 'Alice', ['Bob'], 'first-a');
    await setRoster('b', 'Bob', ['Alice'], 'first-b');
    await computeRooms();
    const before = await readRoster('a');
    const population = Array.from({ length: 24 }, (_, index) => `WorldPlayer${index}`);
    clock.mockReturnValue(2_000);
    await setRoster('b', 'Bob', population, 'first-b');
    await setRoster('a', 'Alice', population, 'replacement-a', undefined, [], { recoverHudReplacement: true });
    expect((await readRoster('a')).lastDirectEvidenceAt).toBe(before.lastDirectEvidenceAt);

    const preservedSession = (await readRoster('a')).session;
    clock.mockReturnValue(3_601_001);
    const nextPopulation = Array.from({ length: 24 }, (_, index) => `NextWorldPlayer${index}`);
    await setRoster('b', 'Bob', nextPopulation, 'first-b');
    await setRoster('a', 'Alice', nextPopulation, 'replacement-b', undefined, [], { recoverHudReplacement: true });
    expect((await readRoster('a')).session).not.toBe(preservedSession);
  } finally { clock.mockRestore(); }
});

test('replacement peer evidence cannot survive an authenticated account change', async () => {
  await setRoster('a', 'Alice', ['Bob'], 'first-a');
  await setRoster('b', 'Bob', ['Alice'], 'first-b');
  await computeRooms();
  const oldSession = (await readRoster('a')).session;
  const population = Array.from({ length: 24 }, (_, index) => `WorldPlayer${index}`);
  await setRoster('b', 'Bob', population, 'first-b');
  await setRoster('a', 'DifferentAccount', population, 'replacement-a', undefined, [],
    { recoverHudReplacement: true });
  expect((await readRoster('a')).session).not.toBe(oldSession);
});

test('pre-upgrade active sessions retain priority without resetting their age', async () => {
  const room = 'r:ffffffff-ffff-4fff-8fff-ffffffffffff';
  values.set('relay:roster:a', JSON.stringify({ name: 'alice', seen: [], session: 'old', requestId: 'old', roomKey: room }));
  await setRoster('a', 'Alice', ['Bob'], 'old');
  expect((await readRoster('a')).sessionStartedAt).toBe(0);
  await setRoster('b', 'Bob', [], 'new');
  await computeRooms();
  await setRoster('b', 'Bob', ['Alice'], 'new');
  expect((await computeRooms()).get('b')).toBe(room);
});

test.each([-1, 1.5, 'old'])('invalid persisted session age is rejected: %s', async sessionStartedAt => {
  values.set('relay:roster:a', JSON.stringify({ name: 'alice', seen: [], session: 'old', requestId: 'old', sessionStartedAt }));
  expect(await readRoster('a')).toBeNull();
  expect((await computeRooms()).size).toBe(0);
});

test('equal-age candidates use deterministic UUID order independent of scan order', async () => {
  for (const id of ['b', 'a']) values.set(`relay:roster:${id}`, JSON.stringify({ name: id, seen: [id === 'a' ? 'b' : 'a'],
    session: id, requestId: id, sessionStartedAt: 1000, roomKey: `r:${id.repeat(8)}-0000-4000-8000-000000000001` }));
  expect((await computeRooms()).get('b')).toBe('r:aaaaaaaa-0000-4000-8000-000000000001');
});

test.each(['a', 'b'])('survivor keeps the canonical history key when %s leaves', async departing => {
  await setRoster('a', 'Alice', ['Bob'], 'world-a');
  await setRoster('b', 'Bob', ['Alice'], 'world-b');
  const before = await computeRooms();
  expect(before.get('a')).toBe(before.get('b'));
  await clearRoster(departing);
  const survivor = departing === 'a' ? 'b' : 'a';
  await setRoster(survivor, survivor === 'a' ? 'Alice' : 'Bob', [], `world-${survivor}`);
  expect((await computeRooms()).get(survivor)).toBe(before.get(survivor));
  expect(redis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), { XX: true, KEEPTTL: true });
});
test('a transient one-sided missing sighting keeps the room during a non-renewing grace', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await setRoster('a', 'Alice', ['Bob', 'Carol'], 'a');
    await setRoster('b', 'Bob', ['Alice'], 'b');
    await setRoster('c', 'Carol', ['Alice'], 'c');
    const old = (await computeRooms()).get('a');
    clock.mockReturnValue(2000);
    await setRoster('a', 'Alice', ['Carol'], 'a');
    expect(new Set((await computeRooms()).values())).toEqual(new Set([old]));

    // Repeating the same incomplete observation must not extend the original deadline.
    clock.mockReturnValue(9000);
    await setRoster('a', 'Alice', ['Carol'], 'a');
    clock.mockReturnValue(12001);
    const separated = await computeRooms();
    expect(separated.get('a')).not.toBe(separated.get('b'));
  } finally { clock.mockRestore(); }
});

test('an established two-client room survives fresh empty rosters without renewing direct evidence', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    await setRoster('a', 'Alice', ['Bob'], 'world-a');
    await setRoster('b', 'Bob', ['Alice'], 'world-b');
    const oldRoom = (await computeRooms()).get('a');
    const directEvidenceAt = (await readRoster('a')).lastDirectEvidenceAt;

    clock.mockReturnValue(2_000);
    await setRoster('a', 'Alice', [], 'world-a');
    await setRoster('b', 'Bob', [], 'world-b');
    clock.mockReturnValue(12_001);
    expect(new Set((await computeRooms()).values())).toEqual(new Set([oldRoom]));
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({
      event: 'room_continuity', reason: 'empty_roster',
    }), '[worldRoster] canonical room continuity retained');

    clock.mockReturnValue(3_500_000);
    await setRoster('a', 'Alice', [], 'world-a');
    await setRoster('b', 'Bob', [], 'world-b');
    expect(new Set((await computeRooms()).values())).toEqual(new Set([oldRoom]));
    expect((await readRoster('a')).lastDirectEvidenceAt).toBe(directEvidenceAt);

    clock.mockReturnValue(3_601_001);
    const expired = await computeRooms();
    expect(expired.get('a')).not.toBe(expired.get('b'));
    expect([expired.get('a'), expired.get('b')]).toContain(oldRoom);
  } finally { clock.mockRestore(); }
});

test('a populated observation immediately stops using empty-roster continuity evidence', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    await setRoster('a', 'Alice', ['Bob'], 'world-a');
    await setRoster('b', 'Bob', ['Alice'], 'world-b');
    await computeRooms();
    clock.mockReturnValue(2_000);
    await setRoster('a', 'Alice', [], 'world-a');
    await setRoster('b', 'Bob', [], 'world-b');
    clock.mockReturnValue(12_001);
    await setRoster('a', 'Alice', ['DifferentPlayer'], 'world-a');
    await setRoster('b', 'Bob', ['AnotherPlayer'], 'world-b');
    clock.mockReturnValue(22_002);
    const separated = await computeRooms();
    expect(separated.get('a')).not.toBe(separated.get('b'));
  } finally { clock.mockRestore(); }
});

test('empty-roster continuity cannot merge clients assigned to different rooms', async () => {
  const until = Date.now() + 60_000;
  const roomA = 'r:aaaaaaaa-0000-4000-8000-000000000001';
  const roomB = 'r:bbbbbbbb-0000-4000-8000-000000000001';
  values.set('relay:roster:a', JSON.stringify({ name: 'alice', seen: [], session: 'a', requestId: 'a',
    roomKey: roomA, lastDirectEvidenceAt: Date.now(), emptyRosterContinuity: { names: ['bob'], until } }));
  values.set('relay:roster:b', JSON.stringify({ name: 'bob', seen: [], session: 'b', requestId: 'b',
    roomKey: roomB, lastDirectEvidenceAt: Date.now(), emptyRosterContinuity: { names: ['alice'], until } }));
  const rooms = await computeRooms();
  expect(rooms.get('a')).toBe(roomA);
  expect(rooms.get('b')).toBe(roomB);
});

test('a sustained split preserves the old room for the largest stable component', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    for (const id of ['a', 'b', 'c']) {
      const peers = ['a', 'b', 'c'].filter(peer => peer !== id).map(peer => peer === 'a' ? 'Alice' : peer === 'b' ? 'Bob' : 'Carol');
      await setRoster(id, id === 'a' ? 'Alice' : id === 'b' ? 'Bob' : 'Carol', peers, id, undefined, [],
        { observationSource: id === 'c' ? 'bridge:zfe' : 'native' });
    }
    const old = (await computeRooms()).get('a');
    clock.mockReturnValue(2000);
    await setRoster('a', 'Alice', ['Bob'], 'a');
    await setRoster('b', 'Bob', ['Alice'], 'b');
    await setRoster('c', 'Carol', [], 'c');
    clock.mockReturnValue(12001);
    const rooms = await computeRooms();
    expect(rooms.get('a')).toBe(old);
    expect(rooms.get('b')).toBe(old);
    expect(rooms.get('c')).not.toBe(old);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'room_split', componentCount: 2, winnerSize: 2,
    }), '[worldRoster] canonical room split');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'room_rebind', observationSources: ['bridge:zfe'],
    }), '[worldRoster] canonical room reassigned');
  } finally { clock.mockRestore(); }
});

test('a split-losing room is excluded before majority ranking against an eligible room', async () => {
  const priorRoom = 'r:00000000-0000-4000-8000-000000000001';
  const eligibleRoom = 'r:ffffffff-ffff-4fff-8fff-ffffffffffff';
  const losingMembers = ['a', 'b'];
  const winningMembers = ['c', 'd', 'e'];
  for (const name of losingMembers) values.set(`relay:roster:${name}`, JSON.stringify({
    name, seen: [...losingMembers.filter(peer => peer !== name), 'f'],
    session: name, requestId: name, roomKey: priorRoom, sessionStartedAt: 1000,
  }));
  for (const name of winningMembers) values.set(`relay:roster:${name}`, JSON.stringify({
    name, seen: winningMembers.filter(peer => peer !== name),
    session: name, requestId: name, roomKey: priorRoom, sessionStartedAt: 1000,
  }));
  values.set('relay:roster:f', JSON.stringify({ name: 'f', seen: losingMembers,
    session: 'f', requestId: 'f', roomKey: eligibleRoom, sessionStartedAt: 2000 }));

  const rooms = await computeRooms();
  for (const name of winningMembers) expect(rooms.get(name)).toBe(priorRoom);
  for (const name of [...losingMembers, 'f']) expect(rooms.get(name)).toBe(eligibleRoom);
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
    event: 'room_split', componentSizes: [3, 2], winnerSize: 3,
  }), '[worldRoster] canonical room split');
  expect(redis.copy).not.toHaveBeenCalled();
});

test('daily ops keeps an established room when party names disappear but the public-world roster remains identical', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const users = [
      ['a', 'Alice'], ['b', 'Bob'], ['c', 'Carol'], ['d', 'Dave'],
    ];
    for (const [id, name] of users) {
      await setRoster(id, name, users.filter(([peerId]) => peerId !== id).map(([, peerName]) => peerName), id);
    }
    const oldRoom = (await computeRooms()).get('a');
    expect(new Set((await computeRooms()).values())).toEqual(new Set([oldRoom]));

    // Daily Ops removes the party members from MapMenuData, but every client
    // continues to report the exact same public-world population behind them.
    const publicWorld = Array.from({ length: 17 }, (_, index) => `WorldPlayer${index}`);
    clock.mockReturnValue(2000);
    for (const [id, name] of users) await setRoster(id, name, publicWorld, id);
    clock.mockReturnValue(12_001);

    expect(new Set((await computeRooms()).values())).toEqual(new Set([oldRoom]));
  } finally { clock.mockRestore(); }
});

test.each([
  [['native', 'bridge:xscal', 'bridge:xscal']],
  [['bridge:xscal', 'native', 'bridge:xscal']],
  [['bridge:xscal', 'bridge:xscal', 'native']],
])('raid transition remains atomic for sequential mixed-transport 24-to-23 observations: %j', async sources => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    const users = [
      { id: 'a', name: 'Alice', source: sources[0] },
      { id: 'b', name: 'Bob', source: sources[1] },
      { id: 'c', name: 'Carol', source: sources[2] },
    ];
    for (const user of users) {
      await setRoster(user.id, user.name, users.filter(peer => peer.id !== user.id).map(peer => peer.name), user.id,
        undefined, [], { observationSource: user.source });
    }
    const established = await computeRooms();
    const oldRoom = established.get('a');
    expect(new Set(established.values())).toEqual(new Set([oldRoom]));

    const population24 = Array.from({ length: 24 }, (_, index) => `WorldPlayer${index}`);
    const observations = [population24, population24.slice(0, 23), population24.slice(1)];
    for (let index = 0; index < users.length; index += 1) {
      clock.mockReturnValue(2_000 + index);
      const user = users[index];
      await setRoster(user.id, user.name, observations[index], user.id, undefined, [],
        { observationSource: user.source });
      expect(new Set((await computeRooms()).values())).toEqual(new Set([oldRoom]));
    }

    clock.mockReturnValue(12_001);
    expect(new Set((await computeRooms()).values())).toEqual(new Set([oldRoom]));
  } finally { clock.mockRestore(); }
});

test.each([
  [18, true],
  [17, false],
  [2, false],
])('shared-population boundary with %i of 24 names retains room=%s', async (sharedCount, retained) => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    await setRoster('a', 'Alice', ['Bob'], 'a');
    await setRoster('b', 'Bob', ['Alice'], 'b');
    const oldRoom = (await computeRooms()).get('a');
    const shared = Array.from({ length: sharedCount }, (_, index) => `Shared${index}`);
    const aRoster = [...shared, ...Array.from({ length: 24 - sharedCount }, (_, index) => `OnlyA${index}`)];
    const bRoster = [...shared, ...Array.from({ length: 24 - sharedCount }, (_, index) => `OnlyB${index}`)];
    clock.mockReturnValue(2_000);
    await setRoster('a', 'Alice', aRoster, 'a');
    await setRoster('b', 'Bob', bRoster, 'b');
    clock.mockReturnValue(12_001);
    const rooms = await computeRooms();
    expect(rooms.get('a') === rooms.get('b')).toBe(retained);
    if (retained) expect(rooms.get('a')).toBe(oldRoom);
  } finally { clock.mockRestore(); }
});

test('shared-population observations cannot renew the one-hour direct-evidence deadline', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    await setRoster('a', 'Alice', ['Bob'], 'a');
    await setRoster('b', 'Bob', ['Alice'], 'b');
    const oldRoom = (await computeRooms()).get('a');
    const population = Array.from({ length: 24 }, (_, index) => `WorldPlayer${index}`);
    clock.mockReturnValue(2_000);
    await setRoster('a', 'Alice', population, 'a');
    await setRoster('b', 'Bob', population, 'b');
    for (const at of [12_001, 1_800_000, 3_599_999]) {
      clock.mockReturnValue(at);
      await setRoster('a', 'Alice', population, 'a');
      await setRoster('b', 'Bob', population, 'b');
      expect(new Set((await computeRooms()).values())).toEqual(new Set([oldRoom]));
    }
    clock.mockReturnValue(3_601_001);
    const expired = await computeRooms();
    expect(expired.get('a')).not.toBe(expired.get('b'));
    expect([expired.get('a'), expired.get('b')]).toContain(oldRoom);
  } finally { clock.mockRestore(); }
});

test('account identity change invalidates direct and shared-population continuity', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    await setRoster('a', 'Alice', ['Bob'], 'a');
    await setRoster('b', 'Bob', ['Alice'], 'b');
    await computeRooms();
    const population = Array.from({ length: 24 }, (_, index) => `WorldPlayer${index}`);
    clock.mockReturnValue(2_000);
    await setRoster('a', 'DifferentAccount', population, 'a');
    await setRoster('b', 'Bob', population, 'b');
    const rooms = await computeRooms();
    expect(rooms.get('a')).not.toBe(rooms.get('b'));
  } finally { clock.mockRestore(); }
});

test('shared population evidence cannot merge previously separate rooms', async () => {
  await setRoster('a', 'Alice', [], 'a');
  await setRoster('b', 'Bob', [], 'b');
  const before = await computeRooms();
  expect(before.get('a')).not.toBe(before.get('b'));

  const publicWorld = ['WorldPlayer1', 'WorldPlayer2', 'WorldPlayer3', 'WorldPlayer4'];
  await setRoster('a', 'Alice', publicWorld, 'a');
  await setRoster('b', 'Bob', publicWorld, 'b');
  const after = await computeRooms();

  expect(after.get('a')).toBe(before.get('a'));
  expect(after.get('b')).toBe(before.get('b'));
  expect(after.get('a')).not.toBe(after.get('b'));
});

test('equal stable components choose one deterministic old-room survivor', async () => {
  await setRoster('a', 'Alice', ['Bob'], 'a'); await setRoster('b', 'Bob', ['Alice'], 'b');
  const old = (await computeRooms()).get('a');
  await setRoster('a', 'Alice', [], 'a'); await setRoster('b', 'Bob', [], 'b');
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001);
  const rooms = await computeRooms();
  clock.mockRestore();
  expect(rooms.get('a')).not.toBe(rooms.get('b'));
  expect([rooms.get('a'), rooms.get('b')]).toContain(old);
});
test('roster-only self aliases bridge account-name differences without weakening mutual sighting', async () => {
  await setRoster('a', 'AccountAlice', ['VisibleBob'], 'a', undefined, ['VisibleAlice']);
  await setRoster('b', 'AccountBob', ['VisibleAlice'], 'b', undefined, ['VisibleBob']);
  const rooms = await computeRooms();
  expect(rooms.get('a')).toBe(rooms.get('b'));

  await setRoster('b', 'AccountBob', ['SomeoneElse'], 'b', undefined, ['VisibleBob']);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_001);
  const separated = await computeRooms();
  clock.mockRestore();
  expect(separated.get('a')).not.toBe(separated.get('b'));
});
test('world generation change and leave/rejoin do not inherit old history', async () => {
  await setRoster('a', 'Alice', [], 'old'); const old = (await computeRooms()).get('a');
  await setRoster('a', 'Alice', [], 'new');
  expect((await readRoster('a')).roomKey).toBeUndefined();
  expect((await computeRooms()).get('a')).not.toBe(old);
  await clearRoster('a'); await setRoster('a', 'Alice', [], 'new');
  expect((await readRoster('a')).roomKey).toBeUndefined();
  expect(redis.copy).not.toHaveBeenCalled();
});

test('split history is not granted to a newly joined member', async () => {
  await setRoster('a', 'Alice', ['Bob'], 'a');
  await setRoster('b', 'Bob', ['Alice'], 'b');
  const old = (await computeRooms()).get('a');
  await setRoster('a', 'Alice', ['Charlie'], 'a');
  await setRoster('c', 'Charlie', ['Alice'], 'c');
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_001);
  const rooms = await computeRooms();
  clock.mockRestore();
  expect(rooms.get('a')).toBe(rooms.get('c'));
  expect(rooms.get('a')).not.toBe(rooms.get('b'));
  expect(redis.copy).not.toHaveBeenCalledWith(`relay:serverchat:${old}`, `relay:serverchat:${rooms.get('a')}`);
  expect(redis.copy).toHaveBeenCalledWith(`relay:serverchat:${old}`, `relay:serverchat:${rooms.get('b')}`);
});

test('history storage failure aborts a split before changing room affinity', async () => {
  await setRoster('a', 'Alice', ['Bob'], 'a');
  await setRoster('b', 'Bob', ['Alice'], 'b');
  const old = (await computeRooms()).get('a');
  await setRoster('a', 'Alice', [], 'a');
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001);
  redis.copy.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(computeRooms()).rejects.toThrow('storage unavailable');
  clock.mockRestore();
  expect((await readRoster('a')).roomKey).toBe(old);
  expect((await readRoster('b')).roomKey).toBe(old);
});
