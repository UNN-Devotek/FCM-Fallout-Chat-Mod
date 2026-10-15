const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const backend=path.resolve(process.env.RUNTIME_FIXTURE_BACKEND||path.join(__dirname,'../..')), source=path.resolve(process.env.RUNTIME_FIXTURE_SOURCE||process.argv[2]||path.join(backend,'src'));
const requireSdk=Module.createRequire(path.join(backend,'package.json')),original=Module._load;
const compiled=!fs.existsSync(path.join(source,'runtime/coordinator.ts'));
if(!compiled){const esbuild=requireSdk('esbuild');Module._extensions['.ts']=(m,f)=>m._compile(esbuild.transformSync(fs.readFileSync(f,'utf8'),{loader:'ts',format:'cjs',target:'node22'}).code,f);}
const actualPath=relative=>path.join(source,compiled?relative.replace(/\.ts$/,'.js'):relative);
const {RuntimeCoordinator}=require(actualPath('runtime/coordinator.ts'));
let runtime,prisma,redis,redisError;const logger={info(){},warn(){},error(){}};
Module._load=function(name,parent,main){
 if(parent?.filename===actualPath('runtime/nativeFetch.ts')&&name==='../runtime')return {get runtime(){if(!runtime)throw new Error('Native helper requested before fixture runtime');return runtime;}};
 if(parent?.filename.startsWith(source+path.sep)&&!parent.filename.includes('/runtime/')){
  const resolved=name.startsWith('.')?path.resolve(path.dirname(parent.filename),name).replace(/\.[jt]s$/,''):name;
  if(name.endsWith('/runtime'))return {runtime};
  if(name.endsWith('/config/prisma'))return {__esModule:true,default:prisma};
  if(name.endsWith('/config/redis'))return {getRedisClient:async()=>{if(redisError)throw redisError;return redis;}};
  if(name.endsWith('/config/logger'))return {__esModule:true,default:logger};
  if(resolved===path.join(source,'config/environment'))return {__esModule:true,default:{NODE_ENV:'test'}};
  if(resolved===path.join(source,'config/storage'))return {ensureBucket:async()=>{throw new Error('Unexpected fixture storage');},uploadAvatar:async()=>{throw new Error('Unexpected fixture storage');}};
  if(name.endsWith('/config/database'))return {query:async()=>{throw new Error('Unexpected fixture read');}};
  if(name.endsWith('/services/discordService'))return {relayToDiscord:async()=>{}};
  if(/\/controllers\/usersController\.[jt]s$/.test(parent.filename)&&['../websocket/handlers','../services/autoModService','../services/chatNameService','../services/supporterSyncService','../utils/mergeUser'].includes(name))return {};
  if(!name.startsWith('.')&&!path.isAbsolute(name))return original.call(this,requireSdk.resolve(name),parent,main);
 }
 return original.call(this,name,parent,main);
};
async function probe(label,prepare,relative,invoke){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fcm-round6-primary-'));runtime=new RuntimeCoordinator(directory);redisError=undefined;
 const facts={},record=runtime.recordFailure.bind(runtime);
 runtime.recordFailure=(label,error,evidence)=>{(facts.activeAtDisposition||=[]).push(runtime.snapshot().active.map(x=>x.label));record(label,error,evidence);};
 try{
  prepare(facts);delete require.cache[actualPath('lib/requiredEffects.ts')];delete require.cache[actualPath(relative)];
  const response={status(n){facts.status=n;return this;},json(data){facts.response=data;return this;}};
  await invoke(require(actualPath(relative)),response,error=>{facts.forwarded=true;},facts);
  const drain=await runtime.drain({timeoutMs:400});return {label,facts,phase:drain.phase,active:drain.active,failures:drain.failures};
 }finally{runtime.disposeForTests();fs.rmSync(directory,{recursive:true,force:true});}
}
(async()=>{
 const results=[];
 if(process.argv.includes('--native-binding-only')){
  const probe=require('./native-helper-binding-probe.cjs');
  for(const mode of ['success','body-held','callback-held']){
   const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fcm-native-binding-'));runtime=new RuntimeCoordinator(directory);
   try{results.push({label:mode,...await probe(runtime,require(actualPath('runtime/nativeFetch.ts')),mode,source)});}
   finally{runtime.disposeForTests();fs.rmSync(directory,{recursive:true,force:true});}
  }
  console.log(JSON.stringify({results}));return;
 }
 for(const count of [0,1])for(const mode of ['unlink-unknown','unlink-success','unlink-noop','scan-unknown','discovery-unknown','no-sessions']){
  results.push(await probe(`nuke-${count}-${mode}`,facts=>{
   const deleter={deleteMany:async()=>({count})};const tx=Object.fromEntries(['message','auditLog','playerReport','report','staffApplication','user'].map(name=>[name,deleter]));
   prisma={$transaction:async fn=>{const value=await fn(tx);facts.databaseCommitted=true;return value;}};
   redis={scan:async()=>{facts.scanAttempted=true;if(mode==='scan-unknown')throw new Error('private session discovery unknown');return {cursor:'0',keys:mode==='no-sessions'?[]:['session:private-fixture-secret']};},unlink:async()=>{facts.unlinkAttempted=true;if(mode==='unlink-unknown')throw new Error('private session command response unknown');return mode==='unlink-noop'?0:1;}};
   if(mode==='discovery-unknown')redisError=new Error('private Redis discovery unknown');
  },'controllers/adminNukeController.ts',async(controller,res,next)=>controller.nukeUsers({query:{confirm:'yes-delete-everything'},body:{},ip:'127.0.0.1'},res,next)));
 }
 for(const count of [0,1])for(const mode of ['refused','success'])results.push(await probe(`scrub-${count}-${mode}`,facts=>{
  prisma={$executeRaw:async()=>count,auditLog:{create:async()=>{facts.auditAttempted=true;if(mode==='refused')throw {code:'P2003',message:'private SQL body secret'};return {id:'fixture-audit'};}}};
 },'controllers/messagesController.ts',async(controller,res,next)=>controller.scrubMessages({body:{messageIds:['10000000-0000-0000-0000-000000000001']},adminUser:{id:'api-key'}},res,next)));
 for(const count of [0,1])for(const operation of ['deleteUser','wipeUser'])for(const mode of ['client-unknown','scan-unknown','session-read-unknown','success'])results.push(await probe(`${operation}-${count}-${mode}`,facts=>{
  const deleter={deleteMany:async()=>({count})};
  prisma={message:deleter,report:deleter,session:{...deleter,findMany:async()=>{if(mode==='session-read-unknown')throw new Error('private-session-discovery');return [{token:'private-session-key'}];}},
    $executeRaw:async()=>count,user:{delete:async()=>({id:'10000000-0000-0000-0000-000000000001',username:'Fixture'})},auditLog:{create:async()=>({})}};
  redis={keys:async()=>{if(mode==='scan-unknown')throw new Error('private-session-discovery');return ['session:private-session-key'];},get:async()=>{if(mode==='session-read-unknown')throw new Error('private-session-response');return '10000000-0000-0000-0000-000000000001';},del:async()=>1};
  if(mode==='client-unknown')redisError=new Error('private-redis-client-discovery');
  if(operation==='wipeUser'&&mode==='scan-unknown')prisma.session.findMany=async()=>{throw new Error('private-session-row-discovery');};
 },'controllers/usersController.ts',async(controller,res,next)=>controller[operation]({params:{id:'10000000-0000-0000-0000-000000000001'},body:{},query:{},adminUser:{id:'api-key'}},res,next)));
 console.log(JSON.stringify({results}));
})().catch(error=>{console.error(error);process.exitCode=1;});
