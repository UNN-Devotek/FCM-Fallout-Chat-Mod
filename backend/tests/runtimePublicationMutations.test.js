const {execFileSync}=require('node:child_process'),path=require('node:path');
let results;
beforeAll(()=>{results=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'setup/primary-mutations-fixtures.cjs')],{timeout:30000,maxBuffer:4*1024*1024,env:{...process.env,NODE_ENV:'test'}})).results;},35000);
test.each(['binding','rebind','history','bridge'])('canonical %s unknown write retains required disposition inside its actual lease',kind=>{
 const result=results.find(value=>value.label==='canonical-'+kind+'-unknown');expect(result.phase).toBe('failed');expect(result.failures.length).toBeGreaterThan(0);
 expect(result.facts.activeAtDisposition.every(disposition=>disposition.active.some(label=>/primary|effect/.test(label)))).toBe(true);
 expect(JSON.stringify(result.failures)).not.toContain('synthetic private chat');
});
test('direct persistence records failed disposition before releasing its own accepted write lease',()=>{
 const result=results.find(value=>value.label==='direct-message-persist-own-disposition');expect(result.phase).toBe('failed');expect(result.facts.persistAttempted).toBe(true);
 expect(result.facts.activeAtDisposition.every(disposition=>disposition.active.some(label=>/primary|effect/.test(label)))).toBe(true);
});

test('an actual held canonical history write survives freeze and finishes its already accepted publication without an outer lease',()=>{
 const result=results.find(value=>value.label==='canonical-held-history-after-freeze');
 expect(result.facts.heldActive).toContain('publication:primary');expect(result.facts).toMatchObject({historyCommitted:true,trimAfterFreeze:true,expiryAfterFreeze:true,publicationAfterFreeze:true,firstDrainPhase:'drained'});
 expect(result.phase).toBe('drained');expect(result.failures).toEqual([]);
});
