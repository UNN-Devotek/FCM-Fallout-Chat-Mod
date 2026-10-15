const { execFileSync } = require('node:child_process'), path = require('node:path');
let proof;
beforeAll(() => { proof = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'setup/runtime-round9-fixtures.cjs')], { encoding: 'utf8', timeout: 20000 })); expect(proof.results).toHaveLength(9); }, 25000);
test.each(['redirect-close-held', 'status-close-held', 'media-close-held', 'success-held', 'json-malformed-held', 'size-close-held', 'peer-abort-close-held', 'timeout-close-held', 'request-error-close-held'])('actual MCP metadata %s awaits request/response terminal signals', mode => {
  const result = proof.results.find(value => value.label === 'mcp-read-' + mode);
  expect(result.facts.actualRequest).toBe(true); expect(result.facts.pinnedLookup).toBe(true);
  if (mode !== 'request-error-close-held') { expect(result.facts.actualResponse).toBe(true); expect(result.facts.responseClosed).toBe(true); }
  expect(result.facts.held.phase).toBe('failed'); expect(result.facts.held.active.length).toBeGreaterThan(0);
  expect(result.facts.completedAtCheckpoint).toBe(false); expect(result.facts.responseClosedAtCheckpoint).toBe(false);
  expect(result.facts.requestClosed).toBe(true); expect(result.phase).toBe('closed'); expect(result.ingressClosed).toBe(true); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
  if (mode === 'success-held') expect(result.facts.value).toEqual({ fixture: true }); else expect(result.facts.rejected).toBe(true);
});
