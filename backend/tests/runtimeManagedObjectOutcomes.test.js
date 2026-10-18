const {execFileSync}=require('node:child_process');const path=require('node:path');
const run=(client,mode)=>JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'setup/object-sdk-outcomes-fixtures.cjs'),client,mode],{timeout:15000,maxBuffer:2*1024*1024,env:{...process.env,NODE_ENV:'test'}}));
test.each(['shared','evidence'])('actual %s S3 client success preserves exact large bytes and completes its own lease',client=>{
 const result=run(client,'success');expect(result.phase).toBe('drained');expect(result.active).toEqual([]);expect(result.storedHash).toBe(result.expectedHash);
 expect(result.requests.filter(request=>request.method==='PUT')).toEqual([expect.objectContaining({bodyBytes:3*1024*1024,expect:null})]);
},20000);
test.each(['shared','evidence'])('actual %s S3 client retains a held PUT through freeze without an outer handler lease',client=>{
 const result=run(client,'held');expect(result.heldActive).toContain('object:primary');expect(result.phase).toBe('drained');expect(result.active).toEqual([]);expect(result.storedHash).toBe(result.expectedHash);
},20000);
test.each(['shared','evidence'])('actual %s S3 client rejects first-attempt permission refusal with no accepted object',client=>{
 const result=run(client,'first-403');expect(result.errorMetadata).toMatchObject({name:'AccessDenied',status:403,attempts:1});expect(result.attempts).toBe(1);expect(result.storedHash).toBeNull();
 expect(result.phase).toBe('drained');expect(result.failures).toEqual([]);
},20000);
test.each(['shared','evidence'])('actual %s S3 client keeps response-lost writes unknown across its existing retries',client=>{
 const result=run(client,'stored-loss');expect(result.attempts).toBeGreaterThan(1);expect(result.storedHash).toBe(result.expectedHash);expect(result.rejected).toBe(true);
 expect(result.phase).toBe('failed');expect(result.active).toEqual([]);expect(result.failures[0].evidence.sha256).toBe(result.expectedHash);
 expect(new Set(result.requests.filter(request=>request.method==='PUT').map(request=>request.key)).size).toBe(1);
},20000);
test.each(['shared','evidence'])('actual %s final403 cannot clear an earlier stored PUT with a lost response',client=>{
 const result=run(client,'stored-loss-then-403');expect(result.errorMetadata).toMatchObject({name:'AccessDenied',status:403});expect(result.errorMetadata.attempts).toBeGreaterThan(1);
 expect(result.storedHash).toBe(result.expectedHash);expect(result.phase).toBe('failed');expect(result.active).toEqual([]);expect(result.failures.length).toBeGreaterThan(0);
},20000);
test('ordinary shared avatar cache loss stays an optional outcome',()=>{
 const result=run('shared','optional-avatar-loss');expect(result.rejected).toBe(true);expect(result.storedHash).toBe(result.expectedHash);expect(result.phase).toBe('drained');expect(result.failures).toEqual([]);
},20000);
test('invalid evidence magic is rejected before any request or required write',()=>{
 const result=run('evidence','invalid-before-write');expect(result.rejected).toBe(true);expect(result.requests).toEqual([]);expect(result.phase).toBe('drained');expect(result.failures).toEqual([]);
},20000);
test.each(['shared','evidence'])('actual %s bucket ownership confirmation permits the exact managed upload',client=>{
 const result=run(client,'bucket-owned');expect(result.namespaceAttempts).toBe(1);expect(result.rejected).toBe(false);expect(result.storedHash).toBe(result.expectedHash);expect(result.phase).toBe('drained');
},20000);
test.each(['shared','evidence'])('actual %s owned namespace confirms desired state after a lost creation response',client=>{
 const result=run(client,'bucket-owned-after-loss');expect(result.namespaceAttempts).toBeGreaterThan(1);expect(result.rejected).toBe(false);expect(result.storedHash).toBe(result.expectedHash);expect(result.phase).toBe('drained');expect(result.failures).toEqual([]);
},20000);
