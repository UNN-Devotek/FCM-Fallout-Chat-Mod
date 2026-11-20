// Actual native control callers with explicit synthetic identity/store/socket boundaries.
// The shared VM loader binds each selected source/emitted function to its actual runtime.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { loader } = require('./runtime-publication-prerequisites.cjs');
const uid = '11111111-1111-1111-1111-111111111111';
const pid = '22222222-2222-2222-2222-222222222222';
async function executeControl(root,group,mode){
 const m=loader(root),dir=fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-native-publication-')),runtime=new(m.load('runtime/coordinator').RuntimeCoordinator)(dir);m.bind(runtime);const fx=m.load('lib/requiredEffects');
 const state={writes:0,increments:0,local:0,publications:0,clientCalls:0,acks:0,errors:0},logs=[];
 const fault=()=>new Error('synthetic-private-publication-secret');
 const prisma={user:{findUnique:async()=>({isBanned:false,isMuted:false})},hudPairingToken:{updateMany:async()=>{if(mode==='primary-refusal')throw Object.assign(fault(),{code:'P2003'});if(mode==='zero-row')return {count:0};state.writes++;return{count:1}},findFirst:async()=>({hudLayout:{x:10,y:10,width:300,height:200}})}};
 const getRedisClient=async()=>{state.clientCalls++;if(mode==='client-fail'&&state.clientCalls===2||mode==='local-client-fail'&&state.clientCalls===1)throw fault();return {incr:async()=>++state.increments,publish:async()=>{if(mode==='publish-fail')throw fault();state.publications++;return 1}}};
 const logger=Object.fromEntries(['warn','error','info','debug'].map(k=>[k,(...args)=>logs.push({level:k,detail:args.map(a=>a?.err?.message||a?.message||a)})]));
 const common={...fx,prisma,logger,runtime};const fn=(r,n,b={})=>m.selected(r,n,{...common,...b});
 const subscribers=new Set([{userId:uid}]);const sendSubscriberFrame=()=>{state.local++};
 const parseHudLayout=fn('services/relay/hudLayoutService','parseHudLayout',{HUD_COLOR_FIELDS:['bgColor','tabRowColor','inputBgColor','borderColor','textColor','inputTextColor','senderColor','tabActiveColor','tabInactiveColor','selectedRowColor','promptColor']});
 const parseHudLayoutControl=fn('services/relay/hudLayoutService','parseHudLayoutControl',{parseHudLayout});
 const writeHudLayout=fn('services/relay/hudLayoutService','writeHudLayout');
 const readHudLayout=fn('services/relay/hudLayoutService','readHudLayout',{parseHudLayout});
 const pushHudLayoutLocal=fn('services/relay/relayHandler','pushHudLayoutLocal',{getRedisClient,HUD_LAYOUT_EVENT:'FCMLAYOUT/1;',parseHudLayout,subscribers,sendSubscriberFrame});
 const nextRelaySeq=fn('services/relay/relaySeq','nextRelaySeq',{getRedisClient,RELAY_SEQ_KEY:'relay:seq'});
 const pushNameplatePresenceLocal=fn('services/relay/relayHandler','pushNameplatePresenceLocal',{nextRelaySeq,NAMEPLATE_EVENT:'FCMNAMEPLATES/1;',subscribers,sendSubscriberFrame});
 const identity={userId:uid,linkedUserId:pid,isLinked:true};
 const constants=Object.fromEntries(['NATIVE_BRIDGE_CONTROL','HUD_OPEN_URL_CONTROL','ROOM_DIAGNOSTIC_CONTROL_PREFIX','WORLD_ID_SENTINEL_PREFIX','LEGACY_WORLD_ID_SENTINEL_PREFIX','WORLD_LEAVE_SENTINEL_PREFIX','LEGACY_WORLD_LEAVE_SENTINEL_PREFIX','WORLD_ROSTER_SENTINEL_PREFIX','LEGACY_WORLD_ROSTER_SENTINEL_PREFIX','HISTORY_RESYNC_SENTINEL'].map((x,i)=>[x,'NOT-THIS-'+i]));
 const entry=fn('services/relay/relayHandler','handleSend',{...constants,NAMEPLATE_CONTROL:'FCMCTL/1/NAMEPLATES;',HUD_LAYOUT_CONTROL:'FCMCTL/1/LAYOUT/',ALL_SLUGS:['server'],verifyToken:async()=>mode==='invalid-token'?null:identity,repairChannel:x=>({slug:x,mangled:false}),repairBody:x=>x||'',parseHudSendCarrier:()=>null,send:()=>state.errors++,errEnvelope:(code,message)=>({error:{code,message}}),checkWorldControlRateLimit:async()=>true,parseHudLayoutControl,writeHudLayout,readHudLayout,pushHudLayoutLocal,getRedisClient,RELAY_CONTROL_CHANNEL:'fixture-control',relayInstanceId:'fixture',sendControlAck:()=>state.acks++,parseNameplateRequest:()=>({mode:'hud',requestId:'fixture',nativeRequestId:'fixture'}),allowNameplateRequest:async()=>true,nameplateReply:async()=>({version:1,requestId:'fixture',context:'hud:fixture',ttlMs:100,names:[]}),pushNameplatePresenceLocal});
 let body=group==='layout'?'FCMCTL/1/LAYOUT/SET;fixture;'+JSON.stringify({x:10,y:10,width:300,height:200}):'FCMCTL/1/NAMEPLATES;fixture';
 if(mode==='invalid-layout')body='FCMCTL/1/LAYOUT/SET;fixture;{}';
 try{
  let rejected;await runtime.run('native-control:accepted',()=>entry({},{token:'synthetic-token',channel:'server',body})).catch(e=>{rejected=e.message});
  await new Promise(setImmediate);
  const final=await runtime.drain({timeoutMs:500,close:true,maintenance:false,closeIngress:async()=>{}});
  const checkpoint=JSON.parse(fs.readFileSync(runtime.checkpointPath,'utf8')),journal=fs.existsSync(runtime.failuresPath)?fs.readFileSync(runtime.failuresPath,'utf8'):'';
  const result={group,mode,state,logs,rejected,final,checkpoint,journal,hashes:m.hashes,aliases:[...new Set(m.aliases)]};
  assert.equal(rejected,undefined,JSON.stringify(result));assert.equal(final.active.length,0);assert(!journal.includes('synthetic-private-publication-secret'));
  if(mode==='healthy'||mode==='zero-row'){assert.equal(final.phase,'closed',JSON.stringify(result));assert.equal(state.publications,1);assert.equal(state.local,1);assert.equal(state.acks,1);assert.equal(state.errors,0)}
  if(['invalid-token','invalid-layout','primary-refusal'].includes(mode)){assert.equal(final.phase,'closed',JSON.stringify(result));assert.equal(state.writes,0);assert.equal(state.publications,0);assert.equal(state.local,0);assert.equal(state.errors,1)}
  if(mode==='publish-fail'||mode==='local-client-fail'){assert.equal(final.phase,'failed',JSON.stringify(result));assert(final.failures.length>0)}
  if(mode==='client-fail'){assert.equal(state.publications,0);assert.equal(state.local,1);assert.equal(state.clientCalls,2);assert.equal(state.errors,1)}
  return result;
 }finally{runtime.disposeForTests();fs.rmSync(dir,{recursive:true,force:true});assert(!fs.existsSync(dir))}
}

async function executeRecovery(root,group,mode){
 const m=loader(root),dir=fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-native-recovery-')),runtime=new(m.load('runtime/coordinator').RuntimeCoordinator)(dir);m.bind(runtime);const fx=m.load('lib/requiredEffects');
 const state={writes:0,clientCalls:0,publications:0,local:0,acks:0,responses:[],codeReads:0,claimAttempts:0,claimReads:0},logs=[];
 const fault=()=>new Error('synthetic-private-recovery-secret');
 const prisma={user:{findUnique:async()=>({isBanned:false,isMuted:false})},hudLinkCode:{findFirst:async()=>{state.codeReads++;return mode==='new-code-client-fail'?null:{code:'ABCDEFGH'}},deleteMany:async()=>({count:0}),create:async()=>{state.writes++;return{}}}};
 let fingerprint;
 const redis={incr:async()=>1,publish:async()=>{if(mode==='publish-fail')throw fault();state.publications++;return 1},set:async(k,value)=>{state.claimAttempts++;fingerprint=JSON.parse(value).fingerprint;return null},get:async()=>{state.claimReads++;return JSON.stringify({fingerprint,response:{success:true,messageId:pid}})}};
 const getRedisClient=async()=>{state.clientCalls++;const finalCall=group==='link-recovery'?1:2;if((['client-fail','new-code-client-fail'].includes(mode)&&state.clientCalls===finalCall)||(mode==='initial-client-fail'&&state.clientCalls===1))throw fault();return redis};
 const logger=Object.fromEntries(['warn','error','info','debug'].map(k=>[k,(...args)=>logs.push({level:k,detail:args.map(a=>a?.err?.message||a?.message||a)})]));
 const common={...fx,prisma,logger,runtime};const fn=(r,n,b={})=>m.selected(r,n,{...common,...b});
 const subscribers=new Set(),nextRelaySeq=fn('services/relay/relaySeq','nextRelaySeq',{getRedisClient,RELAY_SEQ_KEY:'relay:seq'}),sendSubscriberFrame=()=>{state.local++};
 const localLink=fn('services/relay/relayHandler','pushRecoveredLinkNoticeLocal',{subscribers,nextRelaySeq,sendSubscriberFrame,linkNoticeBody:()=> 'synthetic-code'});
 const serviceIssue=fn('services/linkCodeService','issueLinkCode',{MAX_ATTEMPTS:5,TTL_MS:600000,generateLinkCode:()=> 'ABCDEFGH'});
 const issueLinkCode=fn('services/relay/relayHandler','issueLinkCode',{require:n=>{assert(n.endsWith('linkCodeService'));return{issueLinkCode:serviceIssue}}});
 const recoverLinkNotice=fn('services/relay/relayHandler','recoverLinkNotice',{issueLinkCode,pushRecoveredLinkNoticeLocal:localLink,getRedisClient,RELAY_CONTROL_CHANNEL:'fixture',relayInstanceId:'fixture'});
 const pushHudSendReceiptLocal=fn('services/relay/relayHandler','pushHudSendReceiptLocal',{subscribers,nextRelaySeq,sendSubscriberFrame});
 const publishHudSendReceipt=fn('services/relay/relayHandler','publishHudSendReceipt',{pushHudSendReceiptLocal,getRedisClient,RELAY_CONTROL_CHANNEL:'fixture',relayInstanceId:'fixture'});
 const parseHudSendCarrier=fn('services/relay/hudSendReceipt','parseHudSendCarrier'),hudSendResponse=fn('services/relay/hudSendReceipt','hudSendResponse'),hudSendReceiptIdentity=fn('services/relay/hudSendReceipt','hudSendReceiptIdentity',{createHash:crypto.createHash}),claimHudSend=fn('services/relay/hudSendReceipt','claimHudSend',{HUD_SEND_RECEIPT_SECONDS:604800});
 const identity={userId:uid,linkedUserId:group==='link-recovery'?null:pid,isLinked:group!=='link-recovery'};
 const constants=Object.fromEntries(['NAMEPLATE_CONTROL','NATIVE_BRIDGE_CONTROL','HUD_LAYOUT_CONTROL','HUD_OPEN_URL_CONTROL','ROOM_DIAGNOSTIC_CONTROL_PREFIX','WORLD_ID_SENTINEL_PREFIX','LEGACY_WORLD_ID_SENTINEL_PREFIX','WORLD_LEAVE_SENTINEL_PREFIX','LEGACY_WORLD_LEAVE_SENTINEL_PREFIX','WORLD_ROSTER_SENTINEL_PREFIX','LEGACY_WORLD_ROSTER_SENTINEL_PREFIX'].map((x,i)=>[x,'NOT-THIS-'+i]));
 const entry=fn('services/relay/relayHandler','handleSend',{...constants,HISTORY_RESYNC_SENTINEL:'RESYNC',ALL_SLUGS:['server','general'],verifyToken:async()=>mode==='invalid-token'?null:identity,repairChannel:x=>({slug:x,mangled:false}),repairBody:x=>x||'',parseHudSendCarrier,hudSendResponse,publishHudSendReceipt,send:(_,response)=>state.responses.push(response),errEnvelope:(code,message)=>({error:{code,message}}),checkWorldControlRateLimit:async()=>mode!=='rate-refusal',recoverLinkNotice,getRedisClient,claimHudSend,hudSendReceiptIdentity,sendControlAck:()=>state.acks++});
 const frame=group==='link-recovery'?{token:'synthetic-token',channel:'server',body:'RESYNC'}:{token:'synthetic-token',channel:'general',body:'synthetic old message',targetUserId:'FCMOUT/1;i=fixture0000000001;r='};
 try{
  let rejected;await runtime.run('native-control:accepted',()=>entry({},frame)).catch(e=>rejected=e.message);await new Promise(setImmediate);
  const final=await runtime.drain({timeoutMs:500,close:true,maintenance:false,closeIngress:async()=>{}}),checkpoint=JSON.parse(fs.readFileSync(runtime.checkpointPath,'utf8')),journal=fs.existsSync(runtime.failuresPath)?fs.readFileSync(runtime.failuresPath,'utf8'):'';
  const result={group,mode,state,logs,rejected,final,checkpoint,journal,hashes:m.hashes};assert.equal(rejected,undefined,JSON.stringify(result));assert.equal(final.active.length,0);assert(!journal.includes('synthetic-private-recovery-secret'));
  if(mode==='healthy'){assert.equal(final.phase,'closed',JSON.stringify(result));assert.equal(state.publications,1)}
  if(mode==='publish-fail'||mode==='new-code-client-fail'){assert.equal(final.phase,'failed',JSON.stringify(result));assert(final.failures.length>0)}
  if(['invalid-token','rate-refusal','initial-client-fail'].includes(mode)){assert.equal(final.phase,'closed',JSON.stringify(result));assert.equal(state.writes,0);assert.equal(state.publications,mode==='initial-client-fail'?1:0)}
  if(mode==='client-fail'){assert.equal(state.writes,0);assert.equal(state.publications,0);assert.equal(state.local,0);if(group==='receipt-replay'){assert.equal(state.claimAttempts,1);assert.equal(state.claimReads,1);assert.equal(state.responses[0].success,true)}else{assert.equal(state.codeReads,1);assert.equal(state.responses[0].error.code,'link_unavailable')}}
  return result;
 }finally{runtime.disposeForTests();fs.rmSync(dir,{recursive:true,force:true});assert(!fs.existsSync(dir))}
}

async function executeNativeLocal(root,group,mode){
 const m=loader(root),dir=fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-native-local-')),runtime=new(m.load('runtime/coordinator').RuntimeCoordinator)(dir);m.bind(runtime);const fx=m.load('lib/requiredEffects');
 const state={writes:0,increments:0,local:0,publications:0,clientCalls:0,acks:0,errors:0},logs=[];
 const fault=()=>new Error('synthetic-private-publication-secret');
 const prisma={user:{findUnique:async()=>({isBanned:false,isMuted:false})},hudPairingToken:{updateMany:async()=>{if(mode==='primary-refusal')throw Object.assign(fault(),{code:'P2003'});if(mode==='zero-row')return {count:0};state.writes++;return{count:1}},findFirst:async()=>({hudLayout:{x:10,y:10,width:300,height:200}})}};
 const getRedisClient=async()=>{state.clientCalls++;if(mode==='client-fail'&&state.clientCalls===2||mode==='local-client-fail'&&state.clientCalls===1)throw fault();return {incr:async()=>{state.cursorAttempts=(state.cursorAttempts||0)+1;if(mode==='cursor-fail')throw fault();return ++state.increments},publish:async()=>{if(mode==='publish-fail')throw fault();state.publications++;return 1}}};
 const logger=Object.fromEntries(['warn','error','info','debug'].map(k=>[k,(...args)=>logs.push({level:k,detail:args.map(a=>a?.err?.message||a?.message||a)})]));
 const common={...fx,prisma,logger,runtime};const fn=(r,n,b={})=>m.selected(r,n,{...common,...b});
 const subscribers=new Set([{userId:uid}]);const sendSubscriberFrame=()=>{state.local++};
 const parseHudLayout=fn('services/relay/hudLayoutService','parseHudLayout',{HUD_COLOR_FIELDS:['bgColor','tabRowColor','inputBgColor','borderColor','textColor','inputTextColor','senderColor','tabActiveColor','tabInactiveColor','selectedRowColor','promptColor']});
 const parseHudLayoutControl=fn('services/relay/hudLayoutService','parseHudLayoutControl',{parseHudLayout});
 const writeHudLayout=fn('services/relay/hudLayoutService','writeHudLayout');
 const readHudLayout=fn('services/relay/hudLayoutService','readHudLayout',{parseHudLayout});
 const pushHudLayoutLocal=fn('services/relay/relayHandler','pushHudLayoutLocal',{getRedisClient,HUD_LAYOUT_EVENT:'FCMLAYOUT/1;',parseHudLayout,subscribers,sendSubscriberFrame});
 const nextRelaySeq=fn('services/relay/relaySeq','nextRelaySeq',{getRedisClient,RELAY_SEQ_KEY:'relay:seq'});
 const pushNameplatePresenceLocal=fn('services/relay/relayHandler','pushNameplatePresenceLocal',{nextRelaySeq,NAMEPLATE_EVENT:'FCMNAMEPLATES/1;',subscribers,sendSubscriberFrame});
 const identity={userId:uid,linkedUserId:pid,isLinked:true};
 const constants=Object.fromEntries(['NATIVE_BRIDGE_CONTROL','HUD_OPEN_URL_CONTROL','ROOM_DIAGNOSTIC_CONTROL_PREFIX','WORLD_ID_SENTINEL_PREFIX','LEGACY_WORLD_ID_SENTINEL_PREFIX','WORLD_LEAVE_SENTINEL_PREFIX','LEGACY_WORLD_LEAVE_SENTINEL_PREFIX','WORLD_ROSTER_SENTINEL_PREFIX','LEGACY_WORLD_ROSTER_SENTINEL_PREFIX','HISTORY_RESYNC_SENTINEL'].map((x,i)=>[x,'NOT-THIS-'+i]));
 const entry=fn('services/relay/relayHandler','handleSend',{...constants,NAMEPLATE_CONTROL:'FCMCTL/1/NAMEPLATES;',HUD_LAYOUT_CONTROL:'FCMCTL/1/LAYOUT/',ALL_SLUGS:['server'],verifyToken:async()=>mode==='invalid-token'?null:identity,repairChannel:x=>({slug:x,mangled:false}),repairBody:x=>x||'',parseHudSendCarrier:()=>null,send:()=>state.errors++,errEnvelope:(code,message)=>({error:{code,message}}),checkWorldControlRateLimit:async()=>mode!=='rate-refusal',parseHudLayoutControl,writeHudLayout,readHudLayout,pushHudLayoutLocal,getRedisClient,RELAY_CONTROL_CHANNEL:'fixture-control',relayInstanceId:'fixture',sendControlAck:()=>state.acks++,parseNameplateRequest:()=>({mode:'hud',requestId:'fixture',nativeRequestId:'fixture'}),allowNameplateRequest:async()=>mode!=='rate-refusal',nameplateReply:async()=>({version:1,requestId:'fixture',context:'hud:fixture',ttlMs:100,names:[]}),pushNameplatePresenceLocal});
 let body=group.startsWith('layout')?'FCMCTL/1/LAYOUT/SET;fixture;'+JSON.stringify({x:10,y:10,width:300,height:200}):'FCMCTL/1/NAMEPLATES;fixture';
 if(group==='layout-get')body='FCMCTL/1/LAYOUT/GET;fixture';
 if(mode==='invalid-layout')body='FCMCTL/1/LAYOUT/SET;fixture;{}';
 try{
  let rejected;await runtime.run('native-control:accepted',()=>entry({},{token:'synthetic-token',channel:'server',body})).catch(e=>{rejected=e.message});
  await new Promise(setImmediate);
  const final=await runtime.drain({timeoutMs:500,close:true,maintenance:false,closeIngress:async()=>{}});
  const checkpoint=JSON.parse(fs.readFileSync(runtime.checkpointPath,'utf8')),journal=fs.existsSync(runtime.failuresPath)?fs.readFileSync(runtime.failuresPath,'utf8'):'';
  const result={group,mode,state,logs,rejected,final,checkpoint,journal,hashes:m.hashes,aliases:[...new Set(m.aliases)]};
  assert.equal(rejected,undefined,JSON.stringify(result));assert.equal(final.active.length,0);assert(!journal.includes('synthetic-private-publication-secret'));
  if(mode==='healthy'||mode==='zero-row'){assert.equal(final.phase,'closed',JSON.stringify(result));assert.equal(state.publications,1);assert.equal(state.local,1);assert.equal(state.acks,1);assert.equal(state.errors,0)}
  if(['invalid-token','invalid-layout','primary-refusal','rate-refusal'].includes(mode)){assert.equal(final.phase,'closed',JSON.stringify(result));assert.equal(state.writes,0);assert.equal(state.publications,0);assert.equal(state.local,0);assert.equal(state.errors,1)}
  if(['local-client-fail','cursor-fail'].includes(mode)){assert.equal(state.publications,0);assert.equal(state.local,0)}
  if(mode==='client-fail'){assert.equal(state.publications,0);assert.equal(state.local,1);assert.equal(state.clientCalls,2);assert.equal(state.errors,1)}
  return result;
 }finally{runtime.disposeForTests();fs.rmSync(dir,{recursive:true,force:true});assert(!fs.existsSync(dir))}
}

async function executeRecoveryLocal(root,group,mode){
 const m=loader(root),dir=fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-native-local-recovery-')),runtime=new(m.load('runtime/coordinator').RuntimeCoordinator)(dir);m.bind(runtime);const fx=m.load('lib/requiredEffects');
 const state={writes:0,clientCalls:0,publications:0,local:0,acks:0,responses:[],codeReads:0,claimAttempts:0,claimReads:0},logs=[];
 const fault=()=>new Error('synthetic-private-recovery-secret');
 const prisma={user:{findUnique:async()=>({isBanned:false,isMuted:false})},hudLinkCode:{findFirst:async()=>{state.codeReads++;return mode==='new-code-local-client-fail'?null:{code:'ABCDEFGH'}},deleteMany:async()=>({count:0}),create:async()=>{state.writes++;return{}}}};
 let fingerprint;
 const redis={incr:async()=>{state.cursorAttempts=(state.cursorAttempts||0)+1;if(mode==='cursor-fail')throw fault();return 1},publish:async()=>{if(mode==='publish-fail')throw fault();state.publications++;return 1},set:async(k,value)=>{state.claimAttempts++;fingerprint=JSON.parse(value).fingerprint;return null},get:async()=>{state.claimReads++;return JSON.stringify({fingerprint,response:{success:true,messageId:pid}})}};
 const getRedisClient=async()=>{state.clientCalls++;const finalCall=group==='link-recovery'?1:2;if((['local-client-fail','new-code-local-client-fail'].includes(mode)&&state.clientCalls===finalCall)||(mode==='initial-client-fail'&&state.clientCalls===1))throw fault();return redis};
 const logger=Object.fromEntries(['warn','error','info','debug'].map(k=>[k,(...args)=>logs.push({level:k,detail:args.map(a=>a?.err?.message||a?.message||a)})]));
 const common={...fx,prisma,logger,runtime};const fn=(r,n,b={})=>m.selected(r,n,{...common,...b});
 const subscribers=new Set([{userId:uid,linkedUserId:group==='link-recovery'?null:pid,ws:{readyState:1}}]),nextRelaySeq=fn('services/relay/relaySeq','nextRelaySeq',{getRedisClient,RELAY_SEQ_KEY:'relay:seq'}),sendSubscriberFrame=()=>{state.local++;return true};
 const localLink=fn('services/relay/relayHandler','pushRecoveredLinkNoticeLocal',{subscribers,nextRelaySeq,sendSubscriberFrame,linkNoticeBody:()=> 'synthetic-code'});
 const serviceIssue=fn('services/linkCodeService','issueLinkCode',{MAX_ATTEMPTS:5,TTL_MS:600000,generateLinkCode:()=> 'ABCDEFGH'});
 const issueLinkCode=fn('services/relay/relayHandler','issueLinkCode',{require:n=>{assert(n.endsWith('linkCodeService'));return{issueLinkCode:serviceIssue}}});
 const recoverLinkNotice=fn('services/relay/relayHandler','recoverLinkNotice',{issueLinkCode,pushRecoveredLinkNoticeLocal:localLink,getRedisClient,RELAY_CONTROL_CHANNEL:'fixture',relayInstanceId:'fixture'});
 const pushHudSendReceiptLocal=fn('services/relay/relayHandler','pushHudSendReceiptLocal',{subscribers,nextRelaySeq,sendSubscriberFrame});
 const publishHudSendReceipt=fn('services/relay/relayHandler','publishHudSendReceipt',{pushHudSendReceiptLocal,getRedisClient,RELAY_CONTROL_CHANNEL:'fixture',relayInstanceId:'fixture'});
 const parseHudSendCarrier=fn('services/relay/hudSendReceipt','parseHudSendCarrier'),hudSendResponse=fn('services/relay/hudSendReceipt','hudSendResponse'),hudSendReceiptIdentity=fn('services/relay/hudSendReceipt','hudSendReceiptIdentity',{createHash:crypto.createHash}),claimHudSend=fn('services/relay/hudSendReceipt','claimHudSend',{HUD_SEND_RECEIPT_SECONDS:604800});
 const identity={userId:uid,linkedUserId:group==='link-recovery'?null:pid,isLinked:group!=='link-recovery'};
 const constants=Object.fromEntries(['NAMEPLATE_CONTROL','NATIVE_BRIDGE_CONTROL','HUD_LAYOUT_CONTROL','HUD_OPEN_URL_CONTROL','ROOM_DIAGNOSTIC_CONTROL_PREFIX','WORLD_ID_SENTINEL_PREFIX','LEGACY_WORLD_ID_SENTINEL_PREFIX','WORLD_LEAVE_SENTINEL_PREFIX','LEGACY_WORLD_LEAVE_SENTINEL_PREFIX','WORLD_ROSTER_SENTINEL_PREFIX','LEGACY_WORLD_ROSTER_SENTINEL_PREFIX'].map((x,i)=>[x,'NOT-THIS-'+i]));
 const entry=fn('services/relay/relayHandler','handleSend',{...constants,HISTORY_RESYNC_SENTINEL:'RESYNC',ALL_SLUGS:['server','general'],verifyToken:async()=>mode==='invalid-token'?null:identity,repairChannel:x=>({slug:x,mangled:false}),repairBody:x=>x||'',parseHudSendCarrier,hudSendResponse,publishHudSendReceipt,send:(_,response)=>state.responses.push(response),errEnvelope:(code,message)=>({error:{code,message}}),checkWorldControlRateLimit:async()=>mode!=='rate-refusal',recoverLinkNotice,getRedisClient,claimHudSend,hudSendReceiptIdentity,sendControlAck:()=>state.acks++});
 const frame=group==='link-recovery'?{token:'synthetic-token',channel:'server',body:'RESYNC'}:{token:'synthetic-token',channel:'general',body:'synthetic old message',targetUserId:'FCMOUT/1;i=fixture0000000001;r='};
 try{
  let rejected;await runtime.run('native-control:accepted',()=>entry({},frame)).catch(e=>rejected=e.message);await new Promise(setImmediate);
  const final=await runtime.drain({timeoutMs:500,close:true,maintenance:false,closeIngress:async()=>{}}),checkpoint=JSON.parse(fs.readFileSync(runtime.checkpointPath,'utf8')),journal=fs.existsSync(runtime.failuresPath)?fs.readFileSync(runtime.failuresPath,'utf8'):'';
  const result={group,mode,state,logs,rejected,final,checkpoint,journal,hashes:m.hashes};assert.equal(rejected,undefined,JSON.stringify(result));assert.equal(final.active.length,0);assert(!journal.includes('synthetic-private-recovery-secret'));
  if(mode==='healthy'){assert.equal(final.phase,'closed',JSON.stringify(result));assert.equal(state.publications,1);assert.equal(state.local,1)}
  if(mode==='new-code-local-client-fail'){assert.equal(final.phase,'failed',JSON.stringify(result));assert(final.failures.length>0)}
  if(['invalid-token','rate-refusal','initial-client-fail'].includes(mode)){assert.equal(final.phase,'closed',JSON.stringify(result));assert.equal(state.writes,0);assert.equal(state.publications,mode==='initial-client-fail'?1:0)}
  if(mode==='local-client-fail'||mode==='cursor-fail'){assert.equal(state.writes,0);assert.equal(state.publications,0);assert.equal(state.local,0);if(group==='receipt-replay'){assert.equal(state.claimAttempts,1);assert.equal(state.claimReads,1);assert.equal(state.responses[0].success,true)}else{assert.equal(state.codeReads,1);assert.equal(state.responses[0].error.code,'link_unavailable')}}
  return result;
 }finally{runtime.disposeForTests();fs.rmSync(dir,{recursive:true,force:true});assert(!fs.existsSync(dir))}
}
const modes = {
  layout: ['healthy', 'client-fail', 'publish-fail', 'local-client-fail', 'invalid-token', 'invalid-layout', 'primary-refusal', 'zero-row'],
  nameplate: ['healthy', 'client-fail', 'publish-fail', 'invalid-token'],
  'link-recovery': ['healthy', 'client-fail', 'publish-fail', 'new-code-client-fail', 'invalid-token', 'rate-refusal'],
  'receipt-replay': ['healthy', 'client-fail', 'publish-fail', 'invalid-token', 'initial-client-fail'],
};
const cases = Object.entries(modes).flatMap(([group, values]) => values.map(mode => ({
  group, mode, family: 'publication', label: group + ':' + mode,
  failure: ['client-fail', 'publish-fail', 'local-client-fail', 'new-code-client-fail'].includes(mode),
})));
const localModes = {
  'layout-get': ['healthy', 'local-client-fail', 'cursor-fail', 'invalid-token', 'rate-refusal'],
  'layout-set': ['local-client-fail'],
  nameplate: ['healthy', 'local-client-fail', 'cursor-fail', 'invalid-token', 'rate-refusal'],
  'link-recovery': ['healthy', 'local-client-fail', 'cursor-fail', 'new-code-local-client-fail', 'invalid-token', 'rate-refusal'],
  'receipt-replay': ['healthy', 'local-client-fail', 'cursor-fail', 'invalid-token', 'initial-client-fail'],
};
cases.push(...Object.entries(localModes).flatMap(([group, values]) => values.map(mode => ({
  group, mode, family: 'local', label: 'local:' + group + ':' + mode,
  failure: ['local-client-fail', 'cursor-fail', 'new-code-local-client-fail'].includes(mode),
}))));
async function run(root) {
  const results = [];
  for (const spec of cases) {
    const native = spec.group.startsWith('layout') || spec.group === 'nameplate';
    const execute = spec.family === 'local'
      ? native ? executeNativeLocal : executeRecoveryLocal
      : native ? executeControl : executeRecovery;
    results.push({ ...spec, ...await execute(root, spec.group, spec.mode) });
  }
  return { node: process.version, syntheticOnly: true, results };
}
module.exports = { cases, run };
if (require.main === module) run(process.argv[2]).then(result => {
  fs.writeFileSync(process.env.FCM_DISCOVERY_RESULT, JSON.stringify(result, null, 2) + '\n');
}).catch(error => { console.error(error); process.exitCode = 1; });
