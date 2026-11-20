const { execFileSync } = require('node:child_process'), path = require('node:path');
let proof;
beforeAll(() => { proof = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'setup/runtime-round8-responses.cjs'), '--native-sdk'], { encoding: 'utf8', timeout: 20000 })); expect(proof.results).toHaveLength(14); }, 25000);
test.each(['json-success', 'form-success', 'json-headers-held', 'form-headers-held', 'json-body-held', 'form-body-held', 'json-callback-held', 'form-callback-held', 'get-body-held', 'json-preparation-held'])('actual native fetch %s retains real result/body/application work through freeze', mode => {
  const result = proof.results.find(value => value.label === 'native-fetch-' + mode);
  expect(result.facts.nativeFetch).toBe(true); expect(result.facts.parsed).toBe(true);
  expect(result.phase).toBe('closed'); expect(result.active).toEqual([]); expect(result.failures).toEqual([]);
  expect(result.facts.requestEnded).toBe(true); expect(result.facts.responseFinished).toBe(true); expect(result.facts.responseClosed).toBe(true); expect(result.facts.openServerSockets).toBe(0);
  if (mode.endsWith('held')) { expect(result.facts.held.phase).toBe('failed'); expect(result.facts.held.active.length).toBeGreaterThan(0); }
  if (mode.endsWith('headers-held') || mode.endsWith('body-held') || mode.endsWith('callback-held')) expect(result.facts.completedAtCheckpoint).toBe(false);
  if (mode.endsWith('callback-held')) expect(result.facts.callbackDone).toBe(true);
  if (mode === 'json-preparation-held') { expect(result.facts.preparationEntered).toBe(true); expect(result.facts.preparationDoneAtCheckpoint).toBe(false); expect(result.facts.preparationDone).toBe(true); }
  if (mode.startsWith('form-')) expect(result.facts.contentType).toMatch(/^application\/x-www-form-urlencoded/);
});
test.each(['json-http-error', 'form-http-error', 'json-aborted', 'form-aborted'])('actual native fetch %s retains failure after concrete body completion', mode => {
  const result = proof.results.find(value => value.label === 'native-fetch-' + mode);
  expect(result.facts.rejected).toBe(true); expect(result.phase).toBe('failed'); expect(result.active).toEqual([]);
  expect(result.facts.responseClosed).toBe(true); expect(result.facts.openServerSockets).toBe(0);
  expect(result.failures).toContainEqual(expect.objectContaining({ label: 'native-fetch:accepted-result', evidence: expect.objectContaining({ stage: 'native-fetch-result-unconfirmed' }) }));
});
