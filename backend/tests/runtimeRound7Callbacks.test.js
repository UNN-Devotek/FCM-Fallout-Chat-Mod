const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
let proof;
beforeAll(() => {
  const sdk = createRequire(path.join(__dirname, '../package.json'));
  const installedMulter = JSON.parse(fs.readFileSync(path.join(path.dirname(sdk.resolve('multer')), 'package.json'), 'utf8')).version;
  expect(installedMulter).toBe(require('../package-lock.json').packages['node_modules/multer'].version);
  proof = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'setup/runtime-round7-fixtures.cjs')], { encoding: 'utf8', timeout: 20000 }));
  expect(proof.sdks.multer.version).toBe(installedMulter);
}, 25000);
const value = label => proof.results.find(result => result.label === label);
test.each(['success', 'held', 'error', 'timeout', 'request-held', 'request-error', 'constructor-error', 'rebound-held', 'rebound-timeout'])('actual embed helper %s retains only unfinished lookup/request work', mode => {
  const result = value('embed-' + mode);
  expect(result.phase).toBe('closed'); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
  if (mode.includes('held') || mode.endsWith('timeout')) { expect(result.facts.held.phase).toBe('failed'); expect(result.facts.held.active.length).toBeGreaterThan(0); }
  if (mode.endsWith('timeout')) expect(result.facts.status).toBe(504);
  if (mode === 'success') { expect(result.facts.bytes).toBe(3); expect(result.facts.lookups).toBe(2); }
});
test.each(['success', 'aborted', 'held', 'error', 'preopen-abort', 'frozen-success', 'frozen-aborted', 'frozen-held', 'sendfile-success', 'sendfile-aborted', 'sendfile-held', 'sendfile-preopen-abort', 'sendfile-preopen-held', 'frozen-script-success', 'frozen-script-aborted', 'frozen-script-held'])('installed static/sendFile middleware %s awaits actual read-stream teardown', mode => {
  const result = value('static-' + mode);
  expect(result.facts.actualReadStream).toBe('ReadStream'); expect(result.facts.streamClosed).toBe(true);
  expect(result.phase).toBe('closed'); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
  if (mode.endsWith('held')) { expect(result.facts.closedWhileHeld).toBe(false); expect(result.facts.held.phase).toBe('failed'); expect(result.facts.held.active.length).toBeGreaterThan(0); }
});
test.each(['head-success', 'head-aborted', '304-success', '304-aborted', 'sendfile-missing-abort'])('installed file transfer %s completes metadata without inventing a body stream', mode => {
  const result = value('static-' + mode);
  expect(result.facts.actualReadStream).toBeUndefined(); expect(result.phase).toBe('closed'); expect(result.active).toEqual([]);
  if (mode === 'head-success') expect(result.facts.status).toBe(200);
  if (mode === '304-success') expect(result.facts.status).toBe(304);
});
test.each(['write-held', 'write-close-held'])('installed diskStorage %s retains concrete output work after callback/response disconnect', mode => {
  const result = value('upload-' + mode);
  expect(result.facts.actualWriteStream).toBe('WriteStream'); expect(result.facts.outputClosed).toBe(true);
  expect(result.facts.held.phase).toBe('failed'); expect(result.facts.held.active.length).toBeGreaterThan(0);
  expect(result.phase).toBe('closed'); expect(result.failures).toEqual([]); expect(result.facts.saved).toBe(25);
});
test.each(['partial-error', 'permission-refused', 'size-limit', 'invalid-filename'])('installed diskStorage %s verifies no effect or actual new-file rollback', mode => {
  const result = value('upload-' + mode);
  expect(result.facts.status).toBe(500); expect(result.facts.residual).toEqual([]);
  expect(result.phase).toBe('closed'); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
});
test.each(['partial-cleanup-failure', 'replacement-partial'])('installed diskStorage %s retains partial/replacement failure', mode => {
  const result = value('upload-' + mode);
  expect(result.facts.status).toBe(500); expect(result.phase).toBe('failed'); expect(result.failures).toHaveLength(1);
  expect(result.facts.outputClosed).toBe(true); expect(result.active).toEqual([]);
  if (mode === 'partial-cleanup-failure') { expect(result.facts.residualBytes).toBe(5); expect(result.failures[0].errorCode).toBe('EACCES'); }
  else expect(result.failures[0].evidence.stage).toBe('prior-artifact-overwritten');
});
test.each(['cleanup-callback-held', 'cleanup-stream-close-held', 'callback-held'])('installed multipart %s retains callbacks and actual teardown through freeze', mode => {
  const result = value('upload-' + mode);
  expect(result.facts.held.phase).toBe('failed'); expect(result.facts.held.active.length).toBeGreaterThan(0);
  expect(result.phase).toBe('closed'); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
  if (mode === 'cleanup-stream-close-held') { expect(result.facts.fileExistsWhileHeld).toBe(true); expect(result.facts.outputClosed).toBe(true); }
  if (mode === 'callback-held') expect(result.facts.callbackCompleted).toBe(true);
});
test.each(['metadata-destination-abort', 'metadata-filename-abort', 'metadata-lstat-abort'])('actual installed multipart %s retains requested metadata after input abort', mode => {
  const result = value('upload-' + mode);
  expect(result.facts.inputClosed).toBe(true);
  expect(result.facts.pendingAtCheckpoint).toBe(true); expect(result.facts.held.phase).toBe('failed');
  expect(result.facts.held.active).toContainEqual(expect.objectContaining({ label: 'filesystem:upload', callbackPending: true }));
  expect(result.facts.residual).toEqual([]); expect(result.phase).toBe('closed'); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
  if (mode === 'metadata-lstat-abort') expect(result.facts.actualMetadataResource).toBe('FSREQCALLBACK');
});
test('installed diskStorage abort waits for the actual pipeline result and confirmed cleanup', () => {
  const result = value('upload-write-abort-canceled');
  expect(result.facts.held.phase).toBe('failed'); expect(result.facts.held.active.length).toBeGreaterThan(0);
  expect(result.facts.closedAtCheckpoint).toBe(false); expect(result.facts.fileExistsAtCheckpoint).toBe(true);
  expect(result.facts.actualWriteStream).toBe('WriteStream'); expect(result.facts.outputClosed).toBe(true);
  expect(result.facts.outputFinished).not.toBe(true); expect(result.facts.outputErrored).not.toBe(true);
  expect(result.facts.storageCallbacksAtCheckpoint).toBe(0); expect(result.facts.storageCallbackCalls).toBe(1); expect(result.facts.cleanupCompleted).toBe(true);
  expect(result.facts.residual).toEqual([]); expect(result.phase).toBe('closed'); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
});
test('confirmed cleanup retains the installed pipeline result callback before the adapter receives it', () => {
  const result = value('upload-cleanup-result-callback-abort');
  expect(result.facts.resultPendingAtCheckpoint).toBe(true); expect(result.facts.closedAtCheckpoint).toBe(true);
  expect(result.facts.storageCallbacksAtCheckpoint).toBe(0);
  expect(result.facts.fileExistsAtCheckpoint).toBe(false); expect(result.facts.cleanupCompleted).toBe(true);
  expect(result.facts.held.phase).toBe('failed');
  expect(result.facts.held.active).toContainEqual(expect.objectContaining({ label: 'filesystem:upload', callbackPending: true }));
  expect(result.facts.outputFinished).not.toBe(true); expect(result.facts.outputErrored).not.toBe(true);
  expect(result.facts.actualPipelineResultCalls).toBe(1); expect(result.facts.pipelineErrored).toBe(true); expect(result.facts.storageCallbackCalls).toBe(1);
  expect(result.facts.residual).toEqual([]); expect(result.phase).toBe('closed'); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
});
test('successful installed output retains actual pipeline result before adapter completion', () => {
  const result = value('upload-result-success-held');
  expect(result.facts.resultPendingAtCheckpoint).toBe(true); expect(result.facts.closedAtCheckpoint).toBe(true);
  expect(result.facts.storageCallbacksAtCheckpoint).toBe(0); expect(result.facts.fileExistsAtCheckpoint).toBe(true);
  expect(result.facts.actualPipelineResultCalls).toBe(1); expect(result.facts.pipelineErrored).toBe(false);
  expect(result.facts.held.phase).toBe('failed');
  expect(result.facts.held.active).toContainEqual(expect.objectContaining({ label: 'filesystem:upload', callbackPending: true }));
  expect(result.facts.outputFinished).toBe(true); expect(result.facts.storageCallbackCalls).toBe(1);
  expect(result.facts.residual).toHaveLength(1); expect(result.phase).toBe('closed'); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
});
test.each(['success', 'cleanup-success', 'cleanup-held'])('installed multipart storage %s closes with a confirmed filesystem result', mode => {
  const result = value('upload-' + mode);
  expect(result.phase).toBe('closed'); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
  expect(result.facts.residual).toHaveLength(mode === 'success' ? 1 : 0);
  if (mode === 'cleanup-held') { expect(result.facts.held.phase).toBe('failed'); expect(result.facts.held.active.length).toBeGreaterThan(0); }
});
test('installed multipart cleanup EACCES remains required despite the HTTP error callback', () => {
  const result = value('upload-cleanup-failure');
  expect(result.facts.storageErrors).toContain('EACCES'); expect(result.facts.residual).toHaveLength(1);
  expect(result.phase).toBe('failed'); expect(result.failures).toContainEqual(expect.objectContaining({ label: 'filesystem:upload-cleanup' }));
  expect(result.failures[0].evidence.artifactId).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result.failures)).not.toMatch(/FalloutChatMod_Setup|synthetic-installer|older-installer|\/tmp\//);
});
test('removing an overwritten older installer cannot establish rollback of its original contents', () => {
  const result = value('upload-replacement-cleanup');
  expect(result.facts.residual).toEqual([]); expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ evidence: expect.objectContaining({ stage: 'prior-artifact-overwritten' }) }));
});
test('the actual post-upload path validation cannot suppress its required filesystem cleanup outcome', () => {
  const result = value('upload-validation-cleanup-failure');
  expect(result.facts.status).toBe(400); expect(result.facts.residualBytes).toBe(25); expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ label: 'filesystem:release-validation-cleanup',
    evidence: expect.objectContaining({ stage: 'storage-validation-cleanup-unconfirmed' }) }));
});
test('actual freeze CLI fails when the durable operator marker was not persisted', () => {
  const result = value('control-freeze-failure');
  expect(result.facts.markerExists).toBe(false); expect(result.facts.command.code).not.toBe(0);
  expect(result.fences).toContain('restart-active.json');
});
test('actual shutdown CLI joining nonclosing drain closes ingress/process before success', () => {
  const result = value('control-join-shutdown');
  expect(result.facts.shutdown.code).toBe(0); expect(result.facts.shutdown.response.phase).toBe('closed');
  expect(result.facts.ingressClosed).toBe(true); expect(result.facts.processClosed).toBe(true);
});
test.each(['freeze-prior-failure', 'freeze-journal-failure', 'checkpoint-failure', 'shutdown-held-timeout', 'already-closed-no-ingress'])('actual operator CLI %s reports incomplete or failed outcomes nonzero', mode => {
  const result = value('control-' + mode);
  expect(result.facts.command.code).not.toBe(0); expect(result.facts.markerExists).toBe(true);
  expect(result.fences).toContain('restart-active.json');
  expect(result.facts.processClosed).not.toBe(true);
  if (mode === 'shutdown-held-timeout') { expect(result.facts.incomplete.phase).toBe('failed'); expect(result.facts.incomplete.active.length).toBeGreaterThan(0); }
});
