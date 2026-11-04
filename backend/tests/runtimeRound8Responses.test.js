const path = require('node:path');
const { execFileSync } = require('node:child_process');
let proof;
beforeAll(() => {
  proof = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'setup/runtime-round8-responses.cjs')], { encoding: 'utf8', timeout: 20000 }));
  expect(proof.results).toHaveLength(10);
}, 25000);
test.each(['redirect-held', 'success-held', 'status-close-held', 'encoding-close-held', 'declared-size-close-held', 'chunk-size-close-held', 'peer-abort-close-held', 'rebound-close-held', 'deadline-close-held', 'redirect-deadline-close-held'])('actual HTTP embed %s owns end or concrete cancellation close', mode => {
  const result = proof.results.find(result => result.label === 'embed-stream-' + mode);
  expect(result.facts.actualIncomingMessage).toBe(true); expect(result.facts.actualClientRequest).toBe(true);
  expect(result.facts.held.phase).toBe('failed'); expect(result.facts.held.active.length).toBeGreaterThan(0);
  expect(result.facts.completedAtCheckpoint).toBe(false); expect(result.facts.responseClosedAtCheckpoint).toBe(false);
  expect(result.phase).toBe('closed'); expect(result.ingressClosed).toBe(true); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
  expect(result.facts.responseClosed).toBe(true); expect(result.facts.requestClosed).toBe(true);
  if (mode.endsWith('close-held')) expect(result.facts.destroyRequested).toBe(true);
  else { expect(result.facts.responseEndedAtCheckpoint).toBe(false); expect(result.facts.bytes).toBe(3); }
  if (mode.includes('deadline')) expect(result.facts.status).toBe(504);
});
