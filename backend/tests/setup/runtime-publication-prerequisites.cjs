// Actual-caller regression contracts; explicit synthetic stores, no global patches.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const br=require('node:module').createRequire(path.join(__dirname, '../../package.json')),parser=br('@babel/parser'),esbuild=br('esbuild'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const uid='11111111-1111-1111-1111-111111111111',pid='22222222-2222-2222-2222-222222222222';
function loader(root){
 const compiled=!fs.existsSync(path.join(root,'runtime/coordinator.ts')),cache=new Map(),hashes={},aliases=[];let runtime;
 const file=r=>path.join(root,r+(compiled?'.js':'.ts'));
 const transform=s=>compiled?s:esbuild.transformSync(s,{loader:'ts',format:'cjs',target:'node22',supported:{'dynamic-import':false}}).code;
 function load(r){if(cache.has(r))return cache.get(r).exports;const f=file(r),raw=fs.readFileSync(f,'utf8'),m={exports:{}};cache.set(r,m);hashes[path.relative(root,f)]=sha(raw);const req=n=>n==='../runtime'&&r==='lib/requiredEffects'?{runtime}:n.startsWith('.')?load(path.relative(root,path.resolve(path.dirname(f),n)).replace(/\.[jt]s$/,'')):br(n);vm.runInThisContext('(function(require,module,exports){'+transform(raw)+'\n})',{filename:f})(req,m,m.exports);return m.exports}
 function selected(r,name,bindings={}){
  const f=file(r),raw=fs.readFileSync(f,'utf8'),tree=parser.parse(raw,{sourceType:'unambiguous',plugins:['typescript']});let node,expr=false;
  function walk(n){if(!n||typeof n!=='object')return;
   if(['FunctionDeclaration','ClassDeclaration'].includes(n.type)&&n.id?.name===name)node=n;
   if(name.startsWith('adapter:')&&n.type==='ObjectProperty'&&n.key?.value===name.slice(8)){node=n.value;expr=true}
   if(name.startsWith('ws:')&&n.type==='CallExpression'&&n.callee?.property?.name==='on'&&n.arguments[0]?.value==='message'){
    const cb=n.arguments[1],text=raw.slice(cb?.start,cb?.end);
    if(name==='ws:game'&&text.includes('psAllMembers')||name==='ws:admin'&&text.includes('Admin observer: DB error resolving game user for edit')){node=cb;expr=true}
   }
   for(const[k,v]of Object.entries(n)){if(['loc','tokens','comments'].includes(k))continue;if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v)}
  }walk(tree);assert(node,'Missing '+r+'#'+name);
  const exact=raw.slice(node.start,node.end);hashes[path.relative(root,f)]=sha(raw);hashes[r+'#'+name]=sha(exact);
  const scope={module:{exports:{}},exports:{},Buffer,URL,URLSearchParams,console,setTimeout,clearTimeout,...bindings};
  for(const alias of new Set(exact.match(/\b[A-Za-z_$][\w$]*_\d+\b/g)||[])){
   if(alias in scope)continue;
   scope[alias]=new Proxy({}, {get(_,key){
    const defaults={prisma:bindings.prisma,logger:bindings.logger,environment:bindings.env};
    const value=key==='default'?defaults[alias.replace(/_\d+$/,'')]:bindings[key];
    if(value===undefined)throw Error('Unbound fixture alias '+alias+'.'+String(key));
    aliases.push(alias+'.'+String(key));return value;
   }});
  }
  return vm.runInNewContext(transform(expr?'('+exact+')':exact+'\n'+name),scope,{filename:f,importModuleDynamically:async spec=>{if(!spec.includes('features'))throw Error('Unbound dynamic import '+spec);const mod=new vm.SyntheticModule(['PARTIES_ENABLED'],function(){this.setExport('PARTIES_ENABLED',true)});await mod.link(()=>{});await mod.evaluate();return mod}});
 }
 return{load,selected,hashes,aliases,bind:r=>runtime=r};
}
async function execute(root,group,mode){
 const m=loader(root),dir=fs.mkdtempSync(path.join(os.tmpdir(),'v21-review-')),runtime=new(m.load('runtime/coordinator').RuntimeCoordinator)(dir);m.bind(runtime);const fx=m.load('lib/requiredEffects');
 const state={writes:0,notices:0,acks:0,errors:0,audits:0},logs=[],prisma={},logger=Object.fromEntries(['warn','error','info','debug'].map(k=>[k,(...args)=>logs.push({level:k,detail:args.map(a=>a?.err?.message||a?.message||a)})]));
 const fault=()=>new Error('synthetic-private-secret');
 const common={...fx,prisma,logger,runtime,__importStar:x=>x,require:n=>n.includes('features')?{PARTIES_ENABLED:true}:n.includes('userRoleService')?{isPrivilegedRole:()=>false}:(()=>{throw Error('Unbound require '+n)})()};
 const fn=(r,n,b={})=>m.selected(r,n,{...common,...b});
 const getRedisClient=async()=>{if(mode==='client-fail')throw fault();return {publish:async()=>{if(mode==='publish-fail')throw fault();state.notices++;return 1}}};
 let action;const held=[];
 if(group==='history-resync'){
  const publishHistoryResync=fn('services/relay/serverChat','publishHistoryResync',{getRedisClient,SERVER_EVENTS_CHANNEL:'fixture'});
  const subscribers=new Set(),historyReplayTasks=new Map();
  const replayHistoryToUser=fn('services/relay/relayHandler','replayHistoryToUser',{subscribers,historyReplayTasks});
  const backfillStaticHistoryToUser=fn('services/relay/relayHandler','backfillStaticHistoryToUser',{replayHistoryToUser});
  const identity={userId:uid,linkedUserId:pid,isLinked:true},ws={send:()=>state.acks++};prisma.user={findUnique:async()=>({isBanned:false,isMuted:false})};
  const constants=Object.fromEntries(['NAMEPLATE_CONTROL','NATIVE_BRIDGE_CONTROL','HUD_LAYOUT_CONTROL','HUD_OPEN_URL_CONTROL','ROOM_DIAGNOSTIC_CONTROL_PREFIX','WORLD_ID_SENTINEL_PREFIX','LEGACY_WORLD_ID_SENTINEL_PREFIX','WORLD_LEAVE_SENTINEL_PREFIX','LEGACY_WORLD_LEAVE_SENTINEL_PREFIX','WORLD_ROSTER_SENTINEL_PREFIX','LEGACY_WORLD_ROSTER_SENTINEL_PREFIX'].map((x,i)=>[x,'NOT-THIS-'+i]));
  const entry=fn('services/relay/relayHandler','handleSend',{...constants,HISTORY_RESYNC_SENTINEL:'RESYNC',ALL_SLUGS:['server'],verifyToken:async()=>mode==='no-primary'?null:identity,repairChannel:x=>({slug:x,mangled:false}),repairBody:x=>x||'',parseHudSendCarrier:()=>null,send:()=>state.errors++,errEnvelope:()=>({error:true}),checkWorldControlRateLimit:async()=>true,markServerHistoryResyncPending:()=>{state.pending=true},backfillStaticHistoryToUser,publishHistoryResync,relayInstanceId:'fixture',sendControlAck:()=>state.acks++});
  action=()=>entry(ws,{token:'synthetic-token',channel:'server',body:'RESYNC'});
 } else if(group==='party-send'||group==='party-edit'||group==='admin-party-edit'){
  const ws={send:()=>state.acks++,readyState:1},user={id:uid,username:'fixture',discordId:'fixture'},token='fixture-token',clients=new Map([[token,{ws,userId:uid,isMuted:false}]]);
  prisma.user={findFirst:async()=>user};
  prisma.partyMember={findFirst:async()=>mode==='no-primary'?null:{userId:uid},findMany:async()=>{if(mode==='member-fail'||mode==='member-fail-held'){state.writesAtDiscovery=state.writes;throw fault();}return[{userId:uid}]}};
  const write=async()=>{if(mode==='member-fail-held')await new Promise(r=>held.push(r));state.writes++;return{id:pid}};prisma.partyMessage={create:write};prisma.party={update:write};prisma.$executeRaw=async()=>{state.writes++;return 1};
  const MessageEditError=fn('services/messageEditService','MessageEditError');
  const emojifyShortcodes=x=>x,engineEvaluate=async()=>({block:false});
  const validateContent=fn('services/messageEditService','validateContent',{MessageEditError,emojifyShortcodes});
  const assertAllowedByAutoMod=fn('services/messageEditService','assertAllowedByAutoMod',{MessageEditError,engineEvaluate});
  const editOwnedMessage=fn('services/messageEditService','editOwnedMessage',{MessageEditError,validateContent,assertAllowedByAutoMod,EDITABLE_MESSAGE_MAX_LENGTH:500,EDITABLE_PRIVATE_MESSAGE_MAX_LENGTH:255});
  const broadcastToPartyMembers=fn('websocket/handlers','broadcastToPartyMembers',{clients:new Map(),pubsubActive:true,INSTANCE_ID:'fixture',PUBSUB_CHANNEL:'fixture',getRedisClient});
  const entry=fn('websocket/handlers',group==='admin-party-edit'?'ws:admin':'ws:game',{ws,user,token,clients,displayName:'fixture',identity:{discordId:'fixture'},UUID_RE:/^[a-f0-9-]+$/,MessageEditError,editOwnedMessage,broadcastToPartyMembers,checkWsRateLimit:async()=>false,engineEvaluate,emojifyShortcodes,uuidv4:()=>pid,v4:()=>pid,sendWsError:(_,message)=>{state.errors++;state.lastError=message},buildAvatarUrl:()=>null,CLIENT_TIMESTAMP_SKEW_MS:30000,incrementMessageCount:()=>{}});
  const frame=group==='party-send'?{type:'party:send',payload:{partyId:pid,content:'fixture'}}:{type:'chat:edit',payload:{messageId:pid,channelId:pid,source:'party',content:'edited'}};
  action=()=>entry(Buffer.from(JSON.stringify(frame)));
 } else if(group==='mcp-blacklist'){
  prisma.user={findUnique:async()=>({id:uid})};prisma.auditLog={create:async()=>{state.audits++;return{id:uid,createdAt:new Date()}},update:async()=>{state.audits++;return{}}};
  prisma.nameBlacklistEntry={create:async()=>{if(mode==='no-primary')throw Object.assign(fault(),{code:'P2002'});state.writes++;return{id:pid}}};
  const refreshBlacklist=fn('services/nameBlacklistService','refreshBlacklist',{loadBlacklist:async()=>{},getRedisClient,PUBSUB_CHANNEL:'fixture'});
  const adapter=fn('mcp/legacyActionAdapters','adapter:name-blacklist.add',{text:(o,k)=>o[k],optionalText:(o,k)=>o[k],refreshBlacklist});
  const auditExtra={randomUUID:()=>uid,redactMcpData:x=>x,pseudonymizeMcpId:()=> 'fixture',recordMcpMetric:()=>{},noteMcpSecurityEvent:()=>{}};
  const beginMcpMutationAudit=fn('services/mcpAuditService','beginMcpMutationAudit',auditExtra),finalizeMcpMutationAudit=fn('services/mcpAuditService','finalizeMcpMutationAudit',auditExtra);
  const runMutation=fn('mcp/tools/shared','runMutation',{beginMcpMutationAudit,finalizeMcpMutationAudit,jsonResult:x=>({result:x}),toolError:()=>({error:true}),isPartialMutationError:()=>false});
  action=()=>runMutation({discordId:'fixture',grantId:'fixture',clientId:'fixture'},'fixture','fixture',pid,()=>adapter({pattern:'fixture'}));
 } else if(group==='bridge-close'){
  const values=new Map(),redis={get:async k=>values.get(k)??null,set:async(k,v)=>{state.writes++;values.set(k,v);return'OK'},del:async k=>{state.writes++;values.delete(k);return 1}};
  const localClient=async()=>redis;
  const publishRebind=fn('services/relay/serverChat','publishRebind',{getRedisClient,SERVER_EVENTS_CHANNEL:'fixture'});
  const clearWorldId=fn('services/relay/worldIdService','clearWorldId',{getRedisClient:localClient,worldKey:x=>'world:'+x});
  const clearRoster=fn('services/relay/worldRosterService','clearRoster',{getRedisClient:localClient,readRoster:async()=>null,KEY_PREFIX:'roster:'});
  const clearRoomMembership=fn('services/relay/roomCoordinator','clearRoomMembership',{clearWorldId,clearRoster,publishRebind,nativeHooks:undefined,INSTANCE_ID:'fixture'});
  const Bridge=fn('services/relay/localExportBridge','LocalExportBridge',{getRedisClient:localClient,STATE_SECONDS:86400,coordinateRooms:async cb=>cb(async()=>{}),clearRoomMembership,cancelProducerTimer:()=>{}});
  const bridge=Object.create(Bridge.prototype);Object.assign(bridge,{actorId:uid,accountId:pid,owner:'fixture',stateKey:'fixture-state',initialized:Promise.resolve(),activityEpoch:0});values.set('fixture-state',JSON.stringify({owner:mode==='no-primary'?'other':'fixture',active:true,snapshot:null}));
  action=()=>bridge.close();
 }else throw Error(group);
 try{
  let rejected;await runtime.run('review:accepted',action).catch(e=>{rejected={message:e.message,code:e.code}});
  for(const release of held)release();await new Promise(setImmediate);
  const final=await runtime.drain({timeoutMs:500,close:true,maintenance:false,closeIngress:async()=>{}});
  const checkpoint=JSON.parse(fs.readFileSync(runtime.checkpointPath,'utf8')),journal=fs.existsSync(runtime.failuresPath)?fs.readFileSync(runtime.failuresPath,'utf8'):'';
  const result={group,mode,state,logs,rejected,final,checkpoint,journal,hashes:m.hashes,aliases:[...new Set(m.aliases)]};
  assert.equal(rejected,undefined,JSON.stringify(result));
  assert.equal(final.active.length,0);assert(!journal.includes('synthetic-private-secret'));
  if(mode==='healthy'){assert.equal(final.phase,'closed',JSON.stringify(result));assert(state.notices>0,JSON.stringify(result));assert.equal(state.errors,0,JSON.stringify(result))}
  if(mode==='no-primary'){assert.equal(final.phase,'closed',JSON.stringify(result));assert.equal(state.writes,0,JSON.stringify(result));assert.equal(state.notices,0)}
  if(mode==='publish-fail'){assert.equal(final.phase,'failed',JSON.stringify(result));assert(final.failures.length>0)}
  if(mode==='member-fail'||mode==='member-fail-held'){if(mode==='member-fail-held')assert.equal(state.writesAtDiscovery,0);assert(state.writes>0,JSON.stringify(result));assert.equal(state.notices,0);}
  if(mode==='client-fail'){assert.equal(state.notices,0);if(group!=='history-resync')assert(state.writes>0,JSON.stringify(result));else assert.equal(state.acks,1,JSON.stringify(result))}
  return result;
 }finally{runtime.disposeForTests();fs.rmSync(dir,{recursive:true,force:true})}
}
const cases = ['history-resync','party-send','party-edit','admin-party-edit','mcp-blacklist','bridge-close'].flatMap(group =>
 ['healthy', group.includes('party') ? 'member-fail' : 'client-fail', 'publish-fail', 'no-primary', ...(group === 'party-send' ? ['member-fail-held'] : [])].map(mode => ({ group, mode, failure: !['healthy','no-primary'].includes(mode), label: group + ':' + mode })));
async function run(root) {
 const results = [];
 for (const spec of cases) results.push({ ...spec, ...await execute(root, spec.group, spec.mode) });
 return { node: process.version, syntheticOnly: true, results };
}
module.exports = { cases, run, loader };
if (require.main === module) run(process.argv[2]).then(result => {
 fs.writeFileSync(process.env.FCM_DISCOVERY_RESULT, JSON.stringify(result, null, 2) + '\n');
}).catch(error => { console.error(error); process.exitCode = 1; });
