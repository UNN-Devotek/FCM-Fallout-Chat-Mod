// Regression contracts. Unchanged selected application functions, actual helper/coordinator;
// explicit synthetic database, provider, response and presentation boundaries. No global patches.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const br=require('node:module').createRequire(path.join(__dirname, '../../package.json')),parser=br('@babel/parser'),esbuild=br('esbuild');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const uid='11111111-1111-1111-1111-111111111111',install='22222222-2222-2222-2222-222222222222';
function loader(root){
 const compiled=!fs.existsSync(path.join(root,'runtime/coordinator.ts')),cache=new Map(),hashes={};let runtime;
 const filename=r=>path.join(root,r+(compiled?'.js':'.ts'));
 const transform=s=>compiled?s:esbuild.transformSync(s,{loader:'ts',format:'cjs',target:'node22',supported:{'dynamic-import':false}}).code;
 function load(r){const file=filename(r);if(cache.has(file))return cache.get(file).exports;const m={exports:{}};cache.set(file,m);const raw=fs.readFileSync(file,'utf8');hashes[path.relative(root,file)]=sha(raw);
  const req=n=>n==='../runtime'&&r==='lib/requiredEffects'?{runtime}:n.startsWith('.')?load(path.relative(root,path.resolve(path.dirname(file),n)).replace(/\.[jt]s$/,'')):br(n);
  vm.runInThisContext('(function(require,module,exports){'+transform(raw)+'\n})',{filename:file})(req,m,m.exports);return m.exports;}
 function selected(r,name,bindings,route){const file=filename(r),raw=fs.readFileSync(file,'utf8'),ast=parser.parse(raw,{sourceType:'unambiguous',plugins:['typescript']});let found;
  function walk(n){if(!n||typeof n!=='object')return;if(name==='queue-add'&&n.type==='AssignmentExpression'&&n.left?.object?.name==='messageQueue'&&n.left?.property?.name==='add')found=n.right;if(!route&&n.type==='FunctionDeclaration'&&n.id?.name===name)found=n;if(route&&n.type==='CallExpression'&&n.arguments?.[0]?.value===route&&n.callee?.property?.name==='get')found=n.arguments.at(-1);for(const[k,v]of Object.entries(n)){if(['loc','tokens','comments'].includes(k))continue;if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);}}walk(ast);assert(found,'Missing '+r+'#'+name);
  const exact=raw.slice(found.start,found.end);hashes[path.relative(root,file)]=sha(raw);hashes[r+'#'+name]=sha(exact);
  return vm.runInNewContext(transform(route||name==='queue-add'?'('+exact+')':exact+'\n'+name),{module:{exports:{}},exports:{},Buffer,URL,URLSearchParams,console,setTimeout,clearTimeout,...bindings},{filename:file});}
 return {load,selected,hashes,bind:r=>runtime=r};
}
async function execute(root,group,mode){
 const m=loader(root),dir=fs.mkdtempSync(path.join(os.tmpdir(),'spec-v20-')),Runtime=m.load('runtime/coordinator').RuntimeCoordinator,runtime=new Runtime(dir);m.bind(runtime);const fx=m.load('lib/requiredEffects');
 const state={primary:false,deviceRevoked:false,audits:0,notices:0,projection:false,subscriberWrites:0};const logs=[],forwarded=[];
 const fault=()=>Object.assign(new Error('synthetic-private-secret'),{code:mode==='primary-refusal'?'P2025':'ECONNRESET'});
 const fail=s=>{if(mode===s||(mode==='provider-discovery-no-primary'&&s==='provider-discovery'))throw fault();};
 const logger=Object.fromEntries(['warn','error','info','debug'].map(k=>[k,()=>logs.push(k)]));
 const prisma={};const common={...fx,requiredEffects_1:fx,prisma,prisma_1:{default:prisma},logger,logger_1:{default:logger},runtime,runtime_1:{runtime}};
 const fn=(file,name,extra={})=>m.selected(file,name,{...common,...extra});
 const res={status(n){this.statusCode=n;return this},json(v){this.body=v;return this},send(v){this.body=v;return this},redirect(v){this.redirected=v;return this}};
 let action;
 if(group==='permanent-ban'){
  prisma.ban={create:async()=>{fail('primary-refusal');state.primary=true;return{id:uid}}};
  prisma.user={update:async()=>{state.banned=true;return{id:uid}},findUnique:async({select})=>{if(select.installToken){fail('device-discovery');return{installToken:install}}return{discordId:null}}};
  prisma.device={updateMany:async()=>{fail('device-write');state.deviceRevoked=true;return{count:1}}};prisma.auditLog={create:async()=>{state.audits++;return{id:uid}}};
  prisma.hudPairingToken={updateMany:async()=>({count:0})};
  const revoke=fn('services/relay/tokenService','revokeTokensForLinkedUser',{invalidateVerificationCacheByLinkedUserId:()=>{}});
  const getRedisClient=async()=>{fail('eviction-discovery');return{publish:async()=>{fail('eviction-publication');state.notices++;return 1}}};
  const evict=fn('services/relay/relayHandler','evictRelayUser',{evictLocalRelayUser:()=>0,getRedisClient,redis_1:{getRedisClient},RELAY_CONTROL_CHANNEL:'fixture'});
  const evictRelaySessions=fn('services/moderationActionsService','evictRelaySessions',{require:()=>({evictRelayUser:evict})});
  const notifyAndDisconnect=()=>0,postModAlert=async()=>{},extra={WS_CLOSE_BANNED:4002,ensureNotProtected:async()=>{},applyDiscordBanLockdown:async()=>({stripped:[],warnings:[],guildBanApplied:false}),notifyAndDisconnect,handlers_1:{notifyAndDisconnect},revokeTokensForLinkedUser:revoke,tokenService_1:{revokeTokensForLinkedUser:revoke},postModAlert,discordService_1:{postModAlert},displayNameOf:async()=>'',evictRelaySessions,audit:fn('services/moderationActionsService','audit')};
  const entry=fn('services/moderationActionsService','createBan',extra);action=()=>entry(uid,uid,'fixture','fixture',null,[{type:'text',textContent:'fixture'}]);
 }else if(group==='event'){
  const mirror={id:uid,announcementChannelId:'fixture-channel',announcementMessageId:null,fcmMessageId:null,sourceFingerprint:'fixture',finalInterestedCount:2};
  prisma.discordEventMirror={findUnique:async()=>mirror,upsert:async()=>{state.primary=true;return mirror},update:async()=>mirror};
  prisma.discordEventSubscriber={count:async()=>2,findMany:async()=>[],upsert:async()=>{fail('subscriber-write');state.subscriberWrites++;return{}},deleteMany:async()=>{fail('subscriber-write');return{count:0}}};prisma.$transaction=async cb=>cb(prisma);prisma.user={findMany:async()=>[]};
  const event={guildId:'fixture-guild',id:'fixture-event',status:1,userCount:2,fetchSubscribers:async()=>{fail('optional-fetch');return new Map()}};
  const eventSnapshot=()=>({guildId:event.guildId,scheduledEventId:event.id,eventCode:'fixture',sourceState:'SCHEDULED',sourceFingerprint:'fixture',publicStatus:'Deleted',interestedCount:2,terminal:false});
  const environment={DISCORD_SERVER_ID:'fixture-guild',DISCORD_EVENTS_CHANNEL_ID:'fixture-channel'};
  const extra={maintenance:runtime,runtime_1:{runtime},runtime:{broadcast:()=>{}},env:environment,environment_1:{default:environment},sourceStateFromDiscordStatus:()=> 'SCHEDULED',shouldIgnoreStaleState:()=>false,descriptionSummary:()=>'',eventSnapshot,ensureAnnouncement:async()=>({id:'fixture',url:'fixture'}),validHttpUrl:x=>x,updateFcmProjection:async()=>{state.projection=true;return'fixture'},broadcastViewerChanges:async()=>{},BROADCAST_EVENT_UPDATE:'fixture',discordEventProjection_1:{shouldIgnoreStaleState:()=>false},discordReferences_1:{validHttpUrl:x=>x}};
  extra.reconcileSubscribers=fn('services/discordEventService','reconcileSubscribers',extra);
  const entry=fn('services/discordEventService','syncEvent',extra);action=()=>entry(event);
 }else if(group==='steam'){
  let acquisition=0;const redis={getDel:async()=>install,set:async()=>{fail('required-set');state.notices++;return'OK'}};const getRedisClient=async()=>{if(++acquisition>1)fail('client-discovery');return redis};
  prisma.user={findUnique:async({where})=>{if(where.id){fail('target-discovery');return{id:uid,username:'fixture'}}return{id:uid,isBanned:false,bannedUntil:null}},findFirst:async()=>null,update:async()=>{state.primary=true;return{id:uid}}};prisma.$transaction=async cb=>cb(prisma);
  const steamAuth={extractSteamId:()=> '76561198000000000',validateSteamAssertion:async()=>true,fetchSteamDisplayName:async()=>null,STEAM_OPENID_ENDPOINT:'fixture-endpoint'};
  const identity={resolveSteamLinkTarget:()=>({kind:'use-install',targetId:uid})};
  const extra={...steamAuth,...identity,getRedisClient,redis_1:{getRedisClient},steamAuthService_1:steamAuth,steamProfileService_1:steamAuth,steamAccountLinkService_1:identity,steamIdentityResolution_1:identity,steamLinkIdentity_1:identity,STEAM_INSTALL_TOKEN_RE:/^[a-f0-9-]+$/,STEAM_LINK_ACCOUNT_SELECT:{id:true},toSteamLinkAccount:x=>x,isBannedIdentity:async()=>false,linkedIdentityService_1:{isBannedIdentity:async()=>false},link_2:{isBannedIdentity:async()=>false},refreshClientIdentity:()=>{},handlers_1:{refreshClientIdentity:()=>{}},PIP_BOY_HTML:()=> 'ok',steamFailure:(response,...args)=>{response.failure=args[1]}};
  const entry=m.selected('server','steam-callback',{...common,...extra},'/auth/steam/callback');
  action=()=>entry({query:{state:'fixture-state','openid.mode':'id_res','openid.op_endpoint':'fixture-endpoint','openid.claimed_id':'fixture-claimed','openid.identity':'fixture-identity'}},res);
 }else if(group==='finalized-message'){
  const ledger=new(m.load('runtime/messageLedger').MessageLedger)(dir);const stored=[];
  const add=async data=>{state.primary=true;stored.push({id:data.id,created_at:data.createdAt,content:data.content,user_id:data.userId,channel_id:data.channelId,parent_channel_id:data.parentChannelId??null,source:data.source,metadata:data.metadata??null,relay_seq:data.relaySeq??null});return{data,finished:async()=>{}}};
  const messageQueue={add:fn('queues/messagePersist','queue-add',{add,ledger})};
  runtime.registerParticipant('fixture-canonical-rows',{inspect:async()=>{const proof=await ledger.verify(async()=>stored);state.canonicalVerified=proof.verified;return{pending:0,failures:proof.failures}}});
  const getRedisClient=async()=>{fail('client-discovery');return{publish:async()=>{fail('required-publication');state.notices++;return 1}}};
  const broadcast=fn('websocket/handlers','broadcast',{localBroadcast:()=>{state.localDelivered=true},pubsubActive:true,INSTANCE_ID:'fixture',instanceIdentity_1:{INSTANCE_ID:'fixture'},PUBSUB_CHANNEL:'fixture',getRedisClient,redis_1:{getRedisClient}});
  const extra={projectionForSharedEvent:async()=>null,discordEventService_1:{projectionForSharedEvent:async()=>null},tryNextRelaySeq:async()=>1,relaySeq_1:{tryNextRelaySeq:async()=>1},getChannelInfo:async()=>({parentId:null,name:'fixture'}),messageQueue,messagePersist_1:{default:messageQueue},broadcast,handlers_1:{broadcast},incrementMessageCount:()=>{},healthController_1:{incrementMessageCount:()=>{}}};
  extra.finalizeAdmittedMessage=fn('services/ingestMessage','finalizeAdmittedMessage',extra);const entry=fn('services/ingestMessage','finalizeMessage',extra);
  action=()=>entry({userId:uid,channelId:install,content:'synthetic chat',displayName:'fixture',source:'bot',messageId:uid,createdAt:'2026-10-14T00:00:00.000Z',waitForPersistence:true,suppressDiscordRelay:true});
 }else if(group==='party-delete'){
  const params=m.load('utils/reqParams');prisma.partyMessage={findFirst:async()=>({id:uid,partyId:install}),updateMany:async()=>{state.primary=true;return{count:1}}};prisma.partyMember={findMany:async()=>{fail('member-discovery');return[{userId:uid}]}};
  const getRedisClient=async()=>{fail('client-discovery');return{publish:async()=>{fail('required-publication');state.notices++;return 1}}};
  const broadcast=fn('websocket/handlers','broadcastToPartyMembers',{clients:new Map(),pubsubActive:true,INSTANCE_ID:'fixture',instanceIdentity_1:{INSTANCE_ID:'fixture'},PUBSUB_CHANNEL:'fixture',getRedisClient,redis_1:{getRedisClient}});
  const entry=fn('controllers/partiesController','adminDeletePartyMessage',{...params,reqParams_1:params,PARTIES_ENABLED:true,features_1:{PARTIES_ENABLED:true},UUID_RE:/^[a-f0-9-]+$/,importHandlers:()=>({broadcastToPartyMembers:broadcast})});
  action=()=>entry({params:{partyId:install,messageId:uid}},res,e=>forwarded.push(e.code));
 }else if(group==='session-broadcast'||group==='user-broadcast'){
  const getRedisClient=async()=>{state.clientAcquisitions=(state.clientAcquisitions||0)+1;fail('client-discovery');return{publish:async()=>{fail('required-publication');state.notices++;return 1}}};
  const entry=fn('websocket/handlers',group==='session-broadcast'?'broadcastToSession':'broadcastToUsers',{clients:new Map(),pubsubActive:mode!=='publication-inactive',INSTANCE_ID:'fixture',instanceIdentity_1:{INSTANCE_ID:'fixture'},PUBSUB_CHANNEL:'fixture',getRedisClient,redis_1:{getRedisClient}});
  action=()=>entry({type:'fixture',payload:{}},group==='session-broadcast'?install:[uid]);
 }else if(group==='register'){
  const existing={id:uid,username:'pending-fixture',isBanned:false,discordId:null,steamId:'76561198000000000',installToken:install};
  prisma.device={findUnique:async()=>null,upsert:async()=>{state.primary=true;return{}}};
  prisma.user={findUnique:async()=>{fail('provider-discovery');return existing},findFirst:async()=>null,upsert:async()=>{state.primary=true;return existing}};prisma.session={create:async()=>({})};
  const getRedisClient=async()=>({set:async()=>{state.notices++;return'OK'}});
  const names=m.load('utils/nameBlacklist'),discriminator=m.load('utils/discriminator'),equality=m.load('utils/constantTimeEquals'),params=m.load('utils/reqParams');
  const environment={APP_CLIENT_KEY:'synthetic-key'},handlers={refreshClientIdentity:()=>0,resolveDisplayName:u=>u.username};
  const extra={...names,...discriminator,...equality,...params,...handlers,nameBlacklist_1:names,discriminator_1:discriminator,constantTimeEquals_1:equality,handlers_1:handlers,reqParams_1:params,env:environment,environment_1:{default:environment},getRedisClient,redis_1:{getRedisClient},SESSION_TTL_SECONDS:30,isValidSteamId:()=>true,steamAuthService_1:{isValidSteamId:()=>true},uuidv4:()=>uid,uuid_1:{v4:()=>uid},require:n=>n.includes('deviceAuthService')?{extractSignatureHeaders:()=>null,isValidP256Spki:()=>true}:n.includes('nameBlacklistService')?{findBlacklistMatch:()=>null}:handlers,__importStar:x=>x};
  const entry=fn('controllers/usersController','register',extra);action=()=>entry({body:{username:'pending-fixture',installToken:install,...(mode==='provider-discovery-no-primary'?{}:{publicKey:'fixture-public'})},headers:{'x-app-client-key':'synthetic-key'}},res,e=>forwarded.push(e.code));
 }else throw Error(group);
 try{let rejected;await runtime.run('review:admitted',action).catch(e=>rejected={code:e.code,message:e.message});await new Promise(setImmediate);const final=await runtime.drain({timeoutMs:350,close:true,maintenance:false,closeIngress:async()=>{}});const persisted=JSON.parse(fs.readFileSync(runtime.checkpointPath,'utf8'));const journal=fs.existsSync(runtime.failuresPath)?fs.readFileSync(runtime.failuresPath,'utf8'):'';return{group,mode,state,logs,forwarded,response:res,rejected,final,persisted,journal,hashes:m.hashes};}finally{runtime.disposeForTests();fs.rmSync(dir,{recursive:true,force:true})}
}
const cases = [
 ['permanent-ban', ['healthy', 'device-discovery', 'device-write', 'eviction-discovery', 'eviction-publication', 'primary-refusal']],
 ['event', ['healthy', 'optional-fetch', 'subscriber-write']],
 ['steam', ['healthy', 'target-discovery', 'client-discovery', 'required-set']],
 ['finalized-message', ['healthy', 'client-discovery', 'required-publication']],
 ['party-delete', ['healthy', 'member-discovery', 'client-discovery', 'required-publication']],
 ['register', ['healthy', 'provider-discovery', 'provider-discovery-no-primary']],
 ['session-broadcast', ['healthy', 'client-discovery', 'required-publication', 'publication-inactive']],
 ['user-broadcast', ['healthy', 'client-discovery', 'required-publication', 'publication-inactive']],
].flatMap(([group, modes]) => modes.map(mode => ({ group, mode,
 failure: !['healthy', 'primary-refusal', 'optional-fetch', 'provider-discovery-no-primary', 'publication-inactive'].includes(mode), label: group + ':' + mode })));
async function run(root) {
 const results = [];
 for (const spec of cases) results.push({ ...spec, ...await execute(root, spec.group, spec.mode) });
 return { node: process.version, syntheticOnly: true, results };
}
module.exports = { cases, run };
if (require.main === module) run(process.argv[2]).then(result => {
 fs.writeFileSync(process.env.FCM_DISCOVERY_RESULT, JSON.stringify(result, null, 2) + '\n');
}).catch(error => { console.error(error); process.exitCode = 1; });
