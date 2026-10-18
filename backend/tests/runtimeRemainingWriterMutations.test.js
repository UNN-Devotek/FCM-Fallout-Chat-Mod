const {execFileSync}=require('node:child_process'),path=require('node:path');
let results;
beforeAll(()=>{results=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'setup/primary-mutations-fixtures.cjs')],{timeout:30000,maxBuffer:4*1024*1024,env:{...process.env,NODE_ENV:'test'}})).results;},35000);
test.each(['camp-primary-upsert-unknown','hud-receipt-claim-unknown','voice-owner-write-own-disposition','migration-sql-dynamic-unknown','local-export-connection-unknown','local-export-state-unknown','mcp-authorize-session-save-unknown'])('%s cannot become clean through its caller catch',label=>{
 const result=results.find(value=>value.label===label);expect(result.phase).toBe('failed');expect(result.failures.length).toBeGreaterThan(0);
 expect(result.facts.activeAtDisposition.every(disposition=>disposition.active.some(label=>!label.startsWith('fixture:') && /primary|effect|session-save/.test(label)))).toBe(true);
 expect(JSON.stringify(result.failures)).not.toMatch(/synthetic_secret|synthetic private chat/);
});

test.each(['unknown','invalid-response'])('managed GitHub %s retains its request and interpretation disposition inside its own lease',mode=>{
 const result=results.find(value=>value.label==='managed-github-'+mode);expect(result.facts.requestAttempted).toBe(true);expect(result.phase).toBe('failed');
 expect(result.facts.activeAtDisposition.every(disposition=>disposition.active.some(label=>label==='domain:primary'))).toBe(true);expect(JSON.stringify(result.failures)).not.toMatch(/private-github-token|private github body/);
});
test.each(['not-configured','invalid-input'])('managed GitHub %s is rejected before any attempted request',mode=>{
 const result=results.find(value=>value.label==='managed-github-'+mode);expect(result.facts.requestAttempted).toBeUndefined();expect(result.phase).toBe('drained');expect(result.failures).toEqual([]);
});
