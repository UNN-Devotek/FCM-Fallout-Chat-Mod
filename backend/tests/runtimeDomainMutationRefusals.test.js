const {execFileSync}=require('node:child_process'),path=require('node:path');
test('a real party accept callback rolls its tentative invite update back on the authoritative full-party refusal',()=>{
 const results=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'setup/primary-mutations-fixtures.cjs')],{timeout:30000,maxBuffer:3*1024*1024,env:{...process.env,NODE_ENV:'test'}})).results;
 const result=results.find(value=>value.label==='party-invite-full-known-rollback');
 expect(result.facts).toMatchObject({inviteStatementResolved:true,rollbackConfirmed:true,inviteRemainsPending:true,publicStatus:409});
 expect(result.phase).toBe('drained');expect(result.failures).toEqual([]);
},35000);

test('a failed download metric remains optional and completes without a required failure',()=>{
 const results=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'setup/primary-mutations-fixtures.cjs')],{timeout:30000,maxBuffer:3*1024*1024,env:{...process.env,NODE_ENV:'test'}})).results;
 const result=results.find(value=>value.label==='release-download-count-optional');
 expect(result.facts.counterAttempted).toBe(true);expect(result.returned).toEqual({completed:true});expect(result.phase).toBe('drained');expect(result.failures).toEqual([]);
},35000);

test('a confirmed constraint refusal of accepted moderation audit remains a required failure',()=>{
 const results=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'setup/primary-mutations-fixtures.cjs')],{timeout:30000,maxBuffer:3*1024*1024,env:{...process.env,NODE_ENV:'test'}})).results;
 const result=results.find(value=>value.label==='accepted-audit-known-fk-refusal');
 expect(result.facts).toMatchObject({primarySoftDeleteCommitted:true,auditAttempted:true});expect(result.phase).toBe('failed');expect(result.failures.length).toBeGreaterThan(0);
 expect(result.facts.activeAtDisposition.some(disposition=>disposition.active.some(label=>/audit|effect/.test(label)))).toBe(true);
},35000);
