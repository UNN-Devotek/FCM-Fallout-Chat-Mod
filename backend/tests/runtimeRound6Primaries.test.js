const {execFileSync}=require('node:child_process'),path=require('node:path');let results;
beforeAll(()=>{results=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'setup/round6-primary-fixtures.cjs')],{timeout:15000,encoding:'utf8'})).results;});
for(const count of [0,1]){
 test(`actual nuke unknown UNLINK with ${count} database rows retains a session disposition`,()=>{
  const result=results.find(x=>x.label===`nuke-${count}-unlink-unknown`);expect(result.facts.unlinkAttempted).toBe(true);expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({label:'session:primary',evidence:expect.objectContaining({targetCount:1,stage:'session-unlink-unconfirmed'})}));
  expect(result.facts.activeAtDisposition.every(active=>active.includes('session:primary'))).toBe(true);expect(JSON.stringify(result.failures)).not.toMatch(/private|session:private-fixture-secret/);
 });
 for(const mode of ['unlink-success','unlink-noop','no-sessions'])test(`actual nuke ${count} rows/${mode} completes cleanly`,()=>{
  const result=results.find(x=>x.label===`nuke-${count}-${mode}`);expect(result.phase).toBe('drained');expect(result.failures).toEqual([]);
 });
 for(const mode of ['scan-unknown','discovery-unknown'])test(`actual nuke ${count} rows/${mode} requires accepted session discovery`,()=>{
  const result=results.find(x=>x.label===`nuke-${count}-${mode}`);expect(result.facts.forwarded).toBe(true);expect(result.phase).toBe('failed');
  if(count)expect(result.failures[0].evidence.committedStages).toContain('identity-write-confirmed');
 });
 test(`actual scrub ${count} rows still requires a refused audit`,()=>{
  const result=results.find(x=>x.label===`scrub-${count}-refused`);expect(result.facts.auditAttempted).toBe(true);expect(result.phase).toBe('failed');expect(result.failures).toContainEqual(expect.objectContaining({label:'audit:primary'}));
  expect(result.facts.activeAtDisposition.every(active=>active.includes('audit:primary'))).toBe(true);expect(JSON.stringify(result.failures)).not.toMatch(/private SQL body/);
 });
 test(`actual scrub ${count} rows and successful audit completes`,()=>expect(results.find(x=>x.label===`scrub-${count}-success`).phase).toBe('drained'));
}
for(const count of [0,1])for(const operation of ['deleteUser','wipeUser']){
 test.each(['client-unknown','scan-unknown','session-read-unknown'])(`accepted ${operation} ${count} row cleanup %s retains its discovery disposition`,mode=>{
  const result=results.find(x=>x.label===`${operation}-${count}-${mode}`);expect(result.facts.forwarded).toBe(true);expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({label:'session:primary'}));expect(JSON.stringify(result.failures)).not.toMatch(/private-session|private-redis/);
 });
 test(`accepted ${operation} ${count} row cleanup succeeds normally`,()=>expect(results.find(x=>x.label===`${operation}-${count}-success`).phase).toBe('drained'));
}
