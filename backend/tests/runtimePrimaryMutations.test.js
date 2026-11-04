const { execFileSync } = require('node:child_process'); const path = require('node:path');
let results;
beforeAll(() => { results = JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'setup/primary-mutations-fixtures.cjs')],{timeout:30000,maxBuffer:2*1024*1024,env:{...process.env,NODE_ENV:'test'}})).results; },35000);
test.each(['ban-flag-after-confirmed-ban-row','overlay-logout-redis-delete-unknown','account-session-cleanup-after-confirmed-message-report-deletes','admin-update-primary-authority-unknown','admin-delete-primary-authority-unknown','expired-ban-inline-authority-write-unknown','mcp-token-revocation-primary-unknown','device-revoke-primary-authority-unknown'])('%s retains the unknown primary outcome despite the current availability/error response',label=>{
 const result=results.find(value=>value.label===label);expect(result).toBeDefined();expect(result.requiredFailureRetained).toBe(true);expect(result.failures.some(value=>value.evidence?.stage)).toBe(true);
 expect(JSON.stringify(result.failures)).not.toMatch(/synthetic-token|synthetic-install|synthetic evidence|synthetic-reason|SQL INSERT/);
});
test('producer failure disposition happens while the sole lease is retained',()=>{
 const result=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'setup/producer-disposition-fixtures.cjs')],{timeout:3000,env:{...process.env,NODE_ENV:'test'}}));
 expect(result.activeAtDisposition).toContainEqual(expect.objectContaining({label:'fixture-required-producer'}));expect(result.result.phase).toBe('failed');
});
test('the second actual S3 SDK client completes a large evidence upload without retained SDK timer promises',()=>{
 const result=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'setup/ban-evidence-sdk-fixtures.cjs')],{timeout:5000,env:{...process.env,NODE_ENV:'test'}}));
 expect(result.uploadedBytes).toBe(3*1024*1024);expect(result.requests.find(value=>value.method==='PUT')).toMatchObject({bodyBytes:3*1024*1024,expect:null});expect(result.phase).toBe('drained');expect(result.active).toEqual([]);
});
