const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
let mockRuntime, dir;
jest.mock('../src/runtime', () => ({ get runtime() { return mockRuntime; } }));
const { RuntimeCoordinator } = require('../src/runtime/coordinator');
const { runRequiredEffect, runRequiredCallback, createRequiredAudit, isPrismaNotFound } = require('../src/lib/requiredEffects');
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-required-effect-')); mockRuntime = new RuntimeCoordinator(dir); });
afterEach(() => { mockRuntime.disposeForTests(); fs.rmSync(dir, { recursive: true, force: true }); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('rejected required work journals its disposition before releasing the sole lease', async () => {
  let reject; const held = new Promise((_, fail) => reject = fail); const original = mockRuntime.recordFailure.bind(mockRuntime); let retainedAtDisposition = false;
  mockRuntime.recordFailure = (...args) => { retainedAtDisposition = mockRuntime.snapshot().active.some(work => work.label === 'fixture:write'); original(...args); };
  const caller = runRequiredEffect('fixture:write', { userId: 'fixture-user', stage: 'write-unconfirmed' }, () => held).catch(error => error);
  const drain = mockRuntime.drain({ timeoutMs: 500 }); await pause(35); expect(mockRuntime.snapshot().active).not.toEqual([]);
  const error = new Error('synthetic-private-write-body'); reject(error); expect(await caller).toBe(error); expect((await drain).phase).toBe('failed'); expect(retainedAtDisposition).toBe(true);
});
test('coordinator.required retains disposition inside its lease even without an outer handler', async () => {
  const original = mockRuntime.recordFailure.bind(mockRuntime); let retained = false;
  mockRuntime.recordFailure = (...args) => { retained = mockRuntime.snapshot().active.some(work => work.label === 'fixture:core'); original(...args); };
  await mockRuntime.required('fixture:core', async () => { throw new Error('private'); }).catch(() => {}); expect(retained).toBe(true);
  expect((await mockRuntime.drain({ timeoutMs: 100 })).phase).toBe('failed');
});
test.each([false, true])('callback completion survives caller disconnect and its failure=%s is durable', async failing => {
  let callback; const caller = runRequiredCallback('fixture:save', { userId: 'fixture-user', stage: 'save-unconfirmed' }, done => callback = done).catch(error => error);
  const drain = mockRuntime.drain({ timeoutMs: 500 }); await pause(35); expect(mockRuntime.snapshot().active).not.toEqual([]);
  callback(failing ? new Error('private token') : null); callback(new Error('duplicate callback')); await caller;
  expect((await drain).phase).toBe(failing ? 'failed' : 'drained'); expect(mockRuntime.snapshot().failures).toHaveLength(failing ? 1 : 0);
});
test('unknown callback state cannot clear a deadline; completing it later permits a new clean inspection', async () => {
 let callback; const pending = runRequiredCallback('fixture:save', { stage: 'save-unconfirmed' }, done => callback = done);
 expect((await mockRuntime.drain({ timeoutMs: 35 })).phase).toBe('failed'); expect(mockRuntime.snapshot().active).not.toEqual([]); expect(mockRuntime.snapshot().failures).toEqual([]);
 callback(); await pending; expect((await mockRuntime.drain({ timeoutMs: 100 })).phase).toBe('drained');
});
test('synchronous callback-start failure records exactly one safe disposition', async () => {
 await runRequiredCallback('fixture:save', { stage: 'save-unconfirmed' }, () => { throw new Error('private'); }).catch(() => {});
 expect((await mockRuntime.drain({ timeoutMs: 100 })).phase).toBe('failed'); expect(mockRuntime.snapshot().failures).toHaveLength(1);
});
test('resolved not-found refuses are distinct from unknown revocation errors', async () => {
 await runRequiredEffect('fixture:delete', { stage: 'delete-unconfirmed' }, () => Promise.reject({ code: 'P2025' }), isPrismaNotFound).catch(() => {});
 expect((await mockRuntime.drain({ timeoutMs: 100 })).phase).toBe('drained');
});
test('a detached audit remains accepted until its writer settles and does not copy content/token metadata', async () => {
 let reject; const held = new Promise((_, fail) => reject = fail);
 const caller = createRequiredAudit({ create: () => held }, { data: { action: 'fixture_action', targetType: 'user', targetId: 'fixture-user', reason: 'private body', metadata: { ruleId: 'fixture-rule', token: 'private token', content: 'private chat' } } }).catch(() => {});
 const drain = mockRuntime.drain({ timeoutMs: 500 }); await pause(35); expect(mockRuntime.snapshot().active).not.toEqual([]); reject(new Error('private SQL')); await caller;
 expect((await drain).phase).toBe('failed'); expect(mockRuntime.snapshot().failures[0].evidence).toEqual({ action: 'fixture_action', targetType: 'user', targetId: 'fixture-user', ruleId: 'fixture-rule', stage: 'audit-write-unconfirmed' });
});
