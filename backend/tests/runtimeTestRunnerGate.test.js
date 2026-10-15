const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const runner=path.resolve(__dirname,'../src/testRunner.ts');
function runFixture(source){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fcm-unit-gate-'));
 try{
  fs.mkdirSync(path.join(directory,'src'));fs.symlinkSync(path.resolve(__dirname,'../node_modules'),path.join(directory,'node_modules'),'dir');
  fs.writeFileSync(path.join(directory,'src/example.test.ts'),source);
  return spawnSync(process.execPath,['--import','tsx',runner],{cwd:directory,encoding:'utf8',timeout:15000,env:{...process.env,NODE_ENV:'test'}});
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
test('the actual required unit runner returns nonzero for a reported assertion failure',()=>{
 const result=runFixture("import test from 'node:test';import assert from 'node:assert/strict';test('gate fixture failure',()=>assert.equal(1,2));");
 expect(result.error).toBeUndefined();expect(result.stdout).toMatch(/fail 1/);expect(result.status).not.toBe(0);
});
test('the actual runner reports and fails a cancelled unresolved test',()=>{
 const result=runFixture("import test from 'node:test';test('gate fixture cancellation',{timeout:50},async()=>await new Promise(()=>{}));");
 expect(result.error).toBeUndefined();expect(result.stdout).toMatch(/cancelled 1/);expect(result.status).not.toBe(0);
});
test('the actual runner fails an incomplete child that exits before the test completes',()=>{
 const result=runFixture("import test from 'node:test';test('gate fixture incomplete',()=>{process.exit(0);});");
 expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);
});
test('the actual runner finishes a successful test despite its test-only open timer',()=>{
 const result=runFixture("import test from 'node:test';test('gate fixture success',()=>{setInterval(()=>{},1000);});");
 expect(result.error).toBeUndefined();expect(result.stdout).toMatch(/pass 1/);expect(result.stdout).toMatch(/fail 0/);expect(result.status).toBe(0);
});
