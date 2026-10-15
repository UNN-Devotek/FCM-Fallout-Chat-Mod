const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),vm=require('node:vm');
const project=path.resolve(__dirname,'../../..');
const sourceRoot=process.env.FCM_REQUIRED_EFFECTS_SOURCE || path.join(project,'backend/src');
const compiled=!fs.existsSync(path.join(sourceRoot,'runtime/coordinator.ts'));
const actualPath=relative=>path.join(sourceRoot,compiled?relative.replace(/\.ts$/,'.js'):relative);
const br=Module.createRequire(path.join(project,'backend/package.json'));const esbuild=br('esbuild');
Module._extensions['.ts']=(module,filename)=>module._compile(esbuild.transformSync(fs.readFileSync(filename,'utf8'),{loader:'ts',format:'cjs',target:'node22',supported:{'dynamic-import':false},sourcefile:filename}).code,filename);
const {RuntimeCoordinator}=require(actualPath('runtime/coordinator.ts'));
const original=Module._load;const logger={info(){},warn(){},error(){},debug(){}};
let runtime,prisma,overrides;
const runtimeBinding={get runtime(){if(!runtime)throw new Error('Native helper requested before required-effects fixture runtime');return runtime;}};
const env={NODE_ENV:'production',SUPPORTER_TIER_ENABLED:true,DISCORD_SERVER_ID:'fixture-guild'};
Module._load=function(request,parent,main){
 if(parent?.filename===actualPath('runtime/nativeFetch.ts')&&request==='../runtime')return runtimeBinding;
 if(parent?.filename.startsWith(sourceRoot+path.sep)&&!parent.filename.includes('/runtime/')){
  const resolved=request.startsWith('.')?path.resolve(path.dirname(parent.filename),request).replace(/\.[jt]s$/,''):request;
  if(resolved===path.join(sourceRoot,'config/environment'))return{__esModule:true,default:env};
  if(resolved===path.join(sourceRoot,'config/prisma'))return{__esModule:true,default:prisma};
  if(resolved===path.join(sourceRoot,'config/logger'))return{__esModule:true,default:logger};
  if(resolved===path.join(sourceRoot,'runtime/nativeFetch'))return original.call(this,actualPath('runtime/nativeFetch.ts'),parent,main);
  if(request.endsWith('/runtime'))return runtimeBinding;
  if(overrides?.[request]!==undefined)return overrides[request];
  if(resolved===path.join(sourceRoot,'config/storage'))return{s3:{send:async()=>{throw new Error('Unexpected fixture storage operation');}},BUCKET:'fixture',ensureBucket:async()=>{}};
  if(resolved===path.join(sourceRoot,'config/database'))return{query:async()=>{throw new Error('Unexpected fixture SQL operation');}};
  if(resolved===path.join(sourceRoot,'config/redis'))throw new Error('Unbound synthetic Redis fixture boundary');

 }
 try { return original.call(this,request,parent,main); } catch (error) { if (sourceRoot !== path.join(project,'backend/src') && !request.startsWith('.') && error.code === 'MODULE_NOT_FOUND') return br(request); throw error; }
};
const safeDiscord={getDiscordClient:()=>null,postModAlert:async()=>{}};
const safeWs={broadcastMessageDeletion(){},markClientMuted(){},notifyAndDisconnect:()=>0,refreshClientIdentity(){},refreshClientCosmetics(){}};
async function scenario(label,fn){for(const file of Object.keys(require.cache))if(file.startsWith(sourceRoot))delete require.cache[file];const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fcm-spec-round4-'));runtime=new RuntimeCoordinator(dir);
 overrides={'../websocket/handlers':safeWs,'../../websocket/handlers':safeWs,'../../websocket/handlers.js':safeWs,'./discordService':safeDiscord,'../discordService':safeDiscord,'./userRoleService':{isProtectedTarget:async()=>false},'./relay/relayHandler':{evictRelayUser:async()=>0},'./relay/tokenService':{revokeTokensForLinkedUser:async()=>{}},'../../config/redis':{getRedisClient:async()=>({get:async()=>null,del:async()=>1,set:async()=>{}})}};
 try{const facts={};const returned=await runtime.run('fixture:'+label,()=>fn(facts));const drain=await runtime.drain({timeoutMs:250});return{label,facts,returned,phase:drain.phase,active:drain.active,failures:drain.failures,reproduced:drain.phase==='drained'&&drain.active.length===0&&drain.failures.length===0};}
 finally{runtime.disposeForTests();runtime=undefined;fs.rmSync(dir,{recursive:true,force:true});}
}
function actual(relative){const filename=actualPath(relative);delete require.cache[filename];return require(filename);}
 const vmFull=(relative,unused={},append="",fixtureProcess=process)=>{
  const filename=actualPath(relative),m={exports:{}};
  const load=name=>{
   if(name.endsWith('/config/prisma'))return{__esModule:true,default:prisma};
   if(name.endsWith('/config/logger'))return{__esModule:true,default:logger};
   if(name.endsWith('/config/environment'))return{__esModule:true,default:env};
   const resolved=name.startsWith('.')?path.resolve(path.dirname(filename),name).replace(/\.[jt]s$/,''):name;
   if(resolved===path.join(sourceRoot,'runtime/nativeFetch'))return actual('runtime/nativeFetch.ts');
   if(name.endsWith('/runtime'))return runtimeBinding;
   if(unused[name]!==undefined)return unused[name];
   if(overrides?.[name]!==undefined)return overrides[name];
   if(name.startsWith('../services/')||name.startsWith('./services/'))return {};
   if(name.startsWith('.'))return require(path.resolve(path.dirname(filename),name));
   return br(name);
  };
  vm.runInNewContext(esbuild.transformSync(fs.readFileSync(filename,'utf8')+append,{loader:'ts',format:'cjs',target:'node22',supported:{'dynamic-import':false}}).code,{require:load,module:m,exports:m.exports,console,Buffer,process:fixtureProcess,setTimeout,clearTimeout,URL,URLSearchParams});return m.exports;
 };
const unknown=()=>new Error('fixture required mutation response unknown');
(async()=>{
 const results=[];
 if(process.argv.includes('--native-before-runtime')){
  const helper=actual('runtime/nativeFetch.ts');let refused=false;
  try{helper.beginRuntimeFetch('http://127.0.0.1:1/',{method:'POST',body:'{}'});}catch(error){refused=error.message==='Native helper requested before required-effects fixture runtime';}
  if(!refused)throw new Error('Native helper failed to refuse absent fixture runtime');
  const value={guardRefused:true,unintendedRuntimeLoaded:[actualPath('runtime.ts'),actualPath('runtime/index.ts')].some(file=>Boolean(require.cache[file])),unintendedEnvironmentLoaded:Boolean(require.cache[actualPath('config/environment.ts')])};
  if(process.env.FCM_REQUIRED_EFFECTS_OUTPUT)fs.writeFileSync(process.env.FCM_REQUIRED_EFFECTS_OUTPUT,JSON.stringify(value)+'\n');console.log(JSON.stringify(value));return;
 }
 if(process.argv.includes('--native-binding-only')){
  const probe=require('./native-helper-binding-probe.cjs');
  for(const loader of ['module','vm'])for(const mode of ['success','body-held','callback-held']){
   const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fcm-required-native-'));runtime=new RuntimeCoordinator(dir);overrides={};
   try{
    const helper=loader==='module'?actual('runtime/nativeFetch.ts'):vmFull('lib/imageStorage.ts',{'../config/storage':{s3:{},BUCKET:'fixture',ensureBucket:async()=>{}}},'\nmodule.exports.__fixtureNativeHelper=require("../runtime/nativeFetch");').__fixtureNativeHelper;
    results.push({label:loader+'-'+mode,...await probe(runtime,helper,mode,sourceRoot)});
   }finally{runtime.disposeForTests();runtime=undefined;fs.rmSync(dir,{recursive:true,force:true});}
  }
  const value={compiled,results};if(process.env.FCM_REQUIRED_EFFECTS_OUTPUT)fs.writeFileSync(process.env.FCM_REQUIRED_EFFECTS_OUTPUT,JSON.stringify(value)+'\n');console.log(JSON.stringify(value));return;
 }
 results.push(await scenario('moderation-message-audit',async facts=>{
  prisma={$executeRaw:async()=>{facts.primarySoftDeleteCommitted=true;return 1;},auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}};
  await actual('services/moderationActionsService.ts').deleteMessageById('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','fixture');
  facts.actionReturnedSuccess=true;return{acknowledged:true};
 }));
 for(const mode of ['device','relay'])results.push(await scenario('permanent-ban-'+mode+'-revocation',async facts=>{
  prisma={ban:{create:async()=>{facts.banCommitted=true;return{id:'fixture-ban'};}},user:{findUnique:async({select})=>select.installToken?{installToken:'synthetic-install-token'}:select.username?{username:'SyntheticFixture'}:{discordId:null},update:async()=>{facts.userBanCommitted=true;return{};}},device:{updateMany:async()=>{facts.deviceRevokeAttempted=true;if(mode==='device')throw unknown();return{count:1};}},auditLog:{create:async()=>({})}};
  overrides['./relay/tokenService']={revokeTokensForLinkedUser:async()=>{facts.relayRevokeAttempted=true;if(mode==='relay')throw unknown();}};
  return actual('services/moderationActionsService.ts').createBan('fixture-target','fixture-actor','Other','fixture',null,[{type:'text',textContent:'synthetic evidence'}]);
 }));
 results.push(await scenario('chat-name-audit',async facts=>{
  const user={id:'fixture-user',chatName:'OldFixture',username:'SyntheticFixture',discordId:null};
  prisma={user:{findUnique:async()=>user,update:async()=>{facts.nameCommitted=true;return{...user,chatName:null};}},auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}};
  overrides['./nameBlacklistService']={findBlacklistMatch:()=>null};overrides['./autoModService']={findProhibitedPhrase:async()=>null};
  return actual('services/chatNameService.ts').setChatName({userId:user.id,chatName:null,source:'website'});
 }));
 results.push(await scenario('cosmetics-audit',async facts=>{
  const row={cosmeticsEnabled:false};prisma={user:{findUnique:async()=>({id:'fixture-user',discordId:null})},userCosmetic:{findUnique:async()=>row,upsert:async()=>{facts.cosmeticsCommitted=true;return row;}},auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}};
  overrides['../supporterService']={getSupporterTierByUserId:async()=> 'none'};
  return actual('services/cosmetics/cosmeticsService.ts').applyCosmetics({userId:'fixture-user',patch:{cosmeticsEnabled:false},actor:{kind:'self'}});
 }));
 results.push(await scenario('automod-violation-and-audit',async facts=>{
  prisma={autoModRule:{findMany:async()=>[{id:'fixture-rule',name:'Fixture rule',enabled:true,triggerType:'LINK',triggerMetadata:{},actions:[{type:'BLOCK'}],exemptChannelIds:[],exemptRoles:[]}]},autoModViolation:{create:async()=>{facts.violationAttempted=true;throw unknown();}},auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}};
  overrides['./autoModService']={filterContent:async()=>({blocked:false}),detectSpam:async()=>({spamDetected:false})};
  overrides['./moderationActionsService']={muteUser:async()=>{}};
  overrides['./aiModerationService']={getAiModerationSettings:async()=>({enabled:false,mode:'off',thresholds:{}})};
  return actual('services/autoModEngine.ts').engineEvaluate('https://fixture.invalid/synthetic','fixture-channel',{id:'fixture-user'},{spamPolicy:'shared-chat'});
 }));
 results.push(await scenario('relay-link-account-name',async facts=>{
  prisma={hudPairingToken:{updateMany:async()=>{facts.linkCommitted=true;return{count:1};},findFirst:async()=>({fo76Name:'SyntheticFixture'})},user:{update:async()=>{facts.accountNameWriteAttempted=true;throw unknown();}}};
  return{linkedTokenCount:await actual('services/relay/tokenService.ts').markRelayTokenLinked('user_synthetic','fixture-account')};
 }));

 const response=facts=>({status(n){facts.status=n;return this;},json(value){facts.response=value;return this;},send(){facts.responded=true;return this;},redirect(dest){facts.redirect=dest;return this;}});
 for(const kind of ['update','delete'])results.push(await scenario('admin-'+kind+'-audit',async facts=>{
  prisma={adminUser:{[kind]:async()=>{facts.primaryCommitted=true;return{id:'fixture-admin',discordId:'100000000000000001',username:'fixture'};}},auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}};
  const controller=actual('controllers/adminUsersController.ts');
  await controller[kind+'AdminUser']({params:{discordId:'100000000000000001'},body:{role:'moderator'},adminUser:{id:'100000000000000002'}},response(facts),err=>{throw err;});return facts.response??{status:facts.status};
 }));
 results.push(await scenario('device-revoke-audit',async facts=>{
  prisma={device:{findUnique:async()=>({id:'fixture-device'}),update:async()=>{facts.deviceRevoked=true;return{};}},auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}};
  await vmFull('controllers/devicesController.ts',{'../services/deviceAuthService':{}}).revokeDevice({params:{installToken:'synthetic-install'},adminUser:{id:'fixture-admin'}},response(facts),err=>{throw err;});return facts.response;
 }));
 results.push(await scenario('overlay-logout-session-delete',async facts=>{
  prisma={session:{delete:async()=>{facts.sessionDeleteAttempted=true;throw unknown();}}};
  overrides['../config/redis']={getRedisClient:async()=>({del:async()=>{facts.redisSessionDeleted=true;return 1;}})};
  await vmFull('controllers/usersController.ts').deleteSession({sessionToken:'synthetic-token'},response(facts),err=>{facts.returnedError=true;});return{status:facts.status};
 }));
 results.push(await scenario('mcp-audit-finalization',async facts=>{
  prisma={auditLog:{update:async()=>{facts.finalizationAttempts=(facts.finalizationAttempts||0)+1;throw unknown();}}};
  facts.primaryMutationAlreadyApplied=true;
  return{finalized:await actual('services/mcpAuditService.ts').finalizeMcpMutationAudit({id:'fixture-audit',createdAt:new Date(),startedAt:Date.now()},{discordId:'100000000000000001',clientId:'synthetic-client',grantId:'synthetic-grant'},'embed_send','100000000000000003','success')};
 }));
 const inline=(filename,prefix,bindings)=>{
  const callbackRoot=compiled?(process.env.FCM_REQUIRED_EFFECTS_CALLBACK_SOURCE||path.join(project,'backend/src')):sourceRoot;const source=fs.readFileSync(path.join(callbackRoot,filename),'utf8');const start=source.indexOf(prefix)+prefix.length,end=source.indexOf('\n});',start)+2;
  if(start<prefix.length||end<start)throw new Error('Actual registered callback not found');
  return vm.runInNewContext(esbuild.transformSync('const handler='+source.slice(start,end)+';handler;', {loader:'ts',target:'node22'}).code,{...(fs.existsSync(actualPath('lib/requiredEffects.ts'))?actual('lib/requiredEffects.ts'):{}),...actual('runtime/nativeFetch.ts'),logger,...bindings,console,URLSearchParams,Buffer});
 };
 for(const mode of ['admin-upsert','admin-save','public-save'])results.push(await scenario('discord-oauth-'+mode,async facts=>{
  const intent=mode==='public-save'?'report':'admin';
  Object.assign(env,{CLIENT_ORIGINS:['https://fixture.invalid'],DISCORD_CLIENT_ID:'fixture-client',DISCORD_CLIENT_SECRET:'synthetic-secret',DISCORD_REDIRECT_URI:'https://fixture.invalid/auth/discord/callback',OWNER_ROLE_ID:'fixture-owner',ADMIN_ROLE_ID:'fixture-admin',MODERATOR_ROLE_ID:'fixture-mod'});
  prisma={adminUser:{upsert:async()=>{facts.adminWriteAttempted=true;if(mode==='admin-upsert')throw unknown();return{};}},user:{upsert:async()=>{facts.accountCommitted=true;return{};},updateMany:async()=>{facts.accountCommitted=true;return{count:1};}}};
  const redis={getDel:async()=>JSON.stringify({intent,sessionId:'fixture-session'})};
  const fetcher=async url=>({ok:true,json:async()=>url.includes('/oauth2/token')?{access_token:'synthetic-access'}:url.includes('/members')||url.includes('/member')?{roles:['fixture-admin']}:{id:'100000000000000001',username:'SyntheticFixture',global_name:'Synthetic Fixture',avatar:null}});
  const handler=inline('server.ts',"app.get('/auth/discord/callback', authLimiter, ",{getRedisClient:async()=>redis,parseBoundOAuthState:actual('utils/oauthState.ts').parseBoundOAuthState,env,logger,fetch:fetcher,prisma,roleVerificationService:{resolveRole:()=> 'admin',cacheRole:async()=>{}},captureAvatar:async()=>null,uuidv4:br('uuid').v4});
  const req={query:{code:'synthetic-code',state:'synthetic-state'},sessionID:'fixture-session',session:{save:cb=>{facts.sessionSaveAttempted=true;cb(mode.includes('save')?unknown():null);}}};
  await handler(req,response(facts));return{redirect:facts.redirect};
 }));
 results.push(await scenario('browser-logout-session-destroy',async facts=>{
  const handler=inline('server.ts',"app.get('/auth/logout', apiLimiter, ",{});
  handler({session:{destroy:cb=>{facts.sessionDestroyAttempted=true;cb(unknown());}}},response(facts));return{redirect:facts.redirect};
 }));
 for(const provider of ['discord','steam'])results.push(await scenario(provider+'-unlink-session-effects',async facts=>{
  prisma={user:{findUnique:async()=>({discordId:provider==='discord'?'100000000000000001':null,steamId:'76561198000000000',installToken:'synthetic-install'}),update:async()=>{facts.identityUnlinked=true;return{};}},linkedIdentity:{count:async()=>0},session:{delete:async()=>{facts.dbSessionDeleteAttempted=true;throw unknown();}}};
  const redis={del:async()=>{facts.redisDeleteAttempted=true;throw unknown();}};
  const handler=inline('routes/link.ts',"router.delete('/provider/:provider', requireAuth, ",{prisma,getRedisClient:async()=>redis,logger,paramStr:(req,name)=>req.params[name],isValidSteamId:()=>true,require:()=>({evictRelayUser:async()=>0}),createError:(status,message)=>Object.assign(new Error(message),{status})});
  await handler({user:{id:'fixture-user'},params:{provider},sessionToken:'synthetic-token'},response(facts),err=>{throw err;});return facts.response;
 }));

 for(const kind of ['ephemeral','persistent'])results.push(await scenario('party-reap-'+kind+'-audit',async facts=>{
  const deps={prisma:{party:{findMany:async({where})=>where.reapPolicy===kind?[{id:'fixture-party'}]:[],update:async()=>{facts.partySoftDeleted=true;return{};}},partyMember:{findMany:async()=>[],count:async()=>0},partyInvite:{updateMany:async()=>({count:0})},auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}},getOnlineUserIds:()=>new Set(),broadcastToPartyMembers:async()=>0};
  return actual('jobs/partyReap.ts').runPartyReap(deps);
 }));
 results.push(await scenario('relay-cursor-backfill-advance',async facts=>{
  prisma={$executeRaw:async()=>{facts.backfillCommitted=true;return 1;},$queryRaw:async()=>[{max:42n}]};
  overrides['../../config/redis']={getRedisClient:async()=>({get:async()=> '0',set:async()=>{facts.counterAdvanceAttempted=true;throw unknown();}})};
  return{updatedRowsReported:await actual('services/relay/relaySeq.ts').backfillMissingRelaySeq()};
 }));
 results.push(await scenario('camp-atom-price-persistence',async facts=>{
  prisma={campItem:{upsert:async()=>{facts.campItemCommitted=true;return{id:'fixture-camp',name:'Synthetic Fixture'};}},$queryRaw:async()=>[{id:'fixture-camp',name:'Synthetic Fixture',form_id:null}],$executeRaw:async()=>{facts.atomPriceWriteAttempted=true;throw unknown();}};
  overrides['../config/redis']={getRedisClient:async()=>({get:async()=>JSON.stringify({entries:[{formId:null,name:'Synthetic Fixture',atomPrice:100,atomBundle:null}],bundlePrice:{}})})};
  overrides['./campImageService']={campImageFormId:()=>null,deriveCampSource:()=>({sourceType:'unknown',sourceLabel:null})};
  overrides['./atomPriceService']=actual('services/atomPriceService.ts');
  return actual('services/campService.ts').ingestCampDatabase(JSON.stringify([{Name:'Synthetic Fixture',Category:'Fixture',SubCategory:'Fixture'}]));
 }));
 results.push(await scenario('shared-image-put',async facts=>{
  overrides['../config/storage']={s3:{send:async command=>{facts.putAttempted=true;facts.objectKey=command.input.Key;throw unknown();}},BUCKET:'fixture',ensureBucket:async()=>{}};
  return{storedKey:await actual('lib/imageStorage.ts').putToMinio('camp-images/10000000.webp',Buffer.from('synthetic fixture'),'image/webp')};
 }));
 for(const mode of ['carousel-create','locations-update','entry-and-error-row'])results.push(await scenario('wiki-ingest-'+mode,async facts=>{
  let lockValue;
  const redis={set:async(key,value)=>{if(key.endsWith(':lock'))lockValue=value;return 'OK';},get:async()=>lockValue,del:async()=>1};
  overrides['../config/redis']={getRedisClient:async()=>redis};
  prisma={wikiEntry:{findUnique:async()=>null,upsert:async()=>{facts.entryWriteAttempted=true;if(mode==='entry-and-error-row')throw unknown();facts.entryCommitted=true;return{id:'fixture-entry'};},update:async()=>{facts.locationsWriteAttempted=true;if(mode==='locations-update')throw unknown();return{};}},wikiAlias:{upsert:async()=>({})},wikiImage:{deleteMany:async()=>{facts.imageRowsDeleted=true;return{count:1};},createMany:async()=>{facts.imageRowsCreateAttempted=true;if(mode==='carousel-create')throw unknown();return{count:1};}},wikiIngestError:{create:async()=>{facts.errorRowWriteAttempted=true;throw unknown();}}};
  const append=`\nfetchPageMeta=async()=>({pageId:1,title:'Synthetic Fixture',revId:1,imageUrl:'https://fixture.invalid/image.png',imgWidth:100,imgHeight:100});fetchWikitext=async()=> '{{Infobox weapon FO76\\n|name=Synthetic Fixture\\n}}';fetchAllPageImages=async()=>[{title:'File:Synthetic weapon.png',url:'https://fixture.invalid/image.png',mime:'image/png',width:100,height:100}];fetchLocations=async()=>[];`;
  const service=vmFull('services/wikiIngestionService.ts',{'../lib/fandomApiClient':{sleep:async()=>{},apiGet:async()=>{throw new Error('Unexpected synthetic upstream call');}}},append,{env:{WIKI_DEFER_IMAGES:'1'}});
  const result=await service.runWikiIngestion(['Synthetic Fixture']);
  const expected=mode==='carousel-create'?'imageRowsCreateAttempted':mode==='locations-update'?'locationsWriteAttempted':'errorRowWriteAttempted';
  if(!facts[expected])throw new Error('Fixture did not reach intended actual write stage: '+expected);
  return result;
 }));
 const fixtureId='10000000-0000-0000-0000-000000000001';
 for(const operation of ['create','update','delete','toggle']) results.push(await scenario('rule-'+operation+'-audit',async facts=>{
  const row={id:fixtureId,name:'SyntheticFixture',triggerType:'LINK',enabled:true};
  prisma={autoModRule:{findUnique:async()=>row,create:async()=>{facts.primaryCommitted=true;return row;},update:async()=>{facts.primaryCommitted=true;return row;},delete:async()=>{facts.primaryCommitted=true;return row;}},auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}};
  const controller=vmFull('controllers/autoModRulesController.ts',{'../services/autoModEngine':{invalidateRulesCache(){}},'../utils/resolveActorId':{resolveInternalActorId:async()=>null}});
  await controller[operation+'AutoModRule']({params:{id:fixtureId},body:{name:'SyntheticFixture',enabled:true,triggerType:'LINK',triggerMetadata:{},actions:[{type:'BLOCK'}]}},response(facts),error=>{throw error;});return facts.response;
 }));
 for(const mode of ['voice','ai']) results.push(await scenario('moderation-'+mode+'-audit',async facts=>{
  prisma={moderationSetting:{upsert:async()=>{facts.settingCommitted=true;return{};}},$transaction:async values=>Promise.all(values),auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}};
  const controller=vmFull('controllers/moderationController.ts',{'../services/voiceService':{invalidateVoiceCache(){}},'../services/aiModerationService':{invalidateAiModerationCache(){}},'../utils/resolveActorId':{resolveInternalActorId:async()=>null}});
  await controller[mode==='voice'?'updateVoiceSettings':'updateSettings']({params:{key:'ai_moderation_enabled'},body:mode==='voice'?{enabled:false,lobbyChannelId:'',categoryId:'',nameTemplate:'Fixture'}:{key:'ai_moderation_enabled',value:'true'}},response(facts),error=>{throw error;});return facts.response;
 }));
 results.push(await scenario('legacy-word-filter-test-audit',async facts=>{
  prisma={wordFilter:{findMany:async()=>[{phrase:'fixtureword',isRegex:false,testMode:true}]},auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}};
  overrides['../config/redis']={getRedisClient:async()=>({get:async()=>null})};
  const result=await actual('services/autoModService.ts').filterContent('fixtureword synthetic evidence','fixture-user');facts.contentAccepted=!result.blocked;return result;
 }));
 for(const mode of ['unknown','absent','audit']) results.push(await scenario('account-delete-'+mode,async facts=>{
  prisma={message:{deleteMany:async()=>{facts.messagesDeleted=true;}},report:{deleteMany:async()=>{facts.reportsDeleted=true;}},session:{deleteMany:async()=>{facts.sessionsDeleted=true;}},user:{delete:async()=>{facts.accountDeleteAttempted=true;if(mode!=='audit')throw mode==='absent'?Object.assign(new Error('already absent'),{code:'P2025'}):unknown();facts.accountDeleted=true;return{username:'SyntheticFixture'};}},auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}};
  overrides['../config/redis']={getRedisClient:async()=>({keys:async()=>[]})};
  await vmFull('controllers/usersController.ts').deleteUser({params:{id:fixtureId}},response(facts),error=>{facts.returnedStatus=error.status;});return facts;
 }));
 results.push(await scenario('overlay-logout-already-absent',async facts=>{
  prisma={session:{delete:async()=>{facts.sessionDeleteAttempted=true;throw Object.assign(new Error('already absent'),{code:'P2025'});}}};overrides['../config/redis']={getRedisClient:async()=>({del:async()=>0})};
  await vmFull('controllers/usersController.ts').deleteSession({sessionToken:'synthetic-token'},response(facts),error=>{facts.returnedError=true;});return facts;
 }));
 for(const mode of ['seed-write','seed-read-fallback','backfill-write','backfill-max','optional-next']) results.push(await scenario('cursor-'+mode,async facts=>{
  prisma={$executeRaw:async()=>{facts.cursorWriteAttempted=true;if(mode==='backfill-write')throw unknown();facts.backfillCommitted=true;return 1;},$queryRaw:async()=>{facts.maxReadAttempted=true;if(mode==='seed-read-fallback'||mode==='backfill-max')throw unknown();return[{max:42n}];}};
  overrides['../../config/redis']={getRedisClient:async()=>({get:async()=> '0',set:async()=>{facts.cursorSetAttempted=true;if(mode==='seed-write')throw unknown();return 'OK';},incr:async()=>{facts.nextAttempted=true;throw unknown();}})};
  const service=actual('services/relay/relaySeq.ts');return mode==='optional-next'?{next:await service.tryNextRelaySeq()}:mode.startsWith('seed')?{seed:await service.seedRelaySeq()}:{backfilled:await service.backfillMissingRelaySeq()};
 }));
 results.push(await scenario('reaction-panel-rollback-delete',async facts=>{
  prisma={reactionRolePanel:{upsert:async()=>{facts.panelCommitted=true;return{};},deleteMany:async()=>{facts.panelDeleteAttempted=true;throw unknown();}}};
  const service=actual('services/reactionRoleService.ts');try{await service.createPanel({id:fixtureId,channelId:'fixture-channel',guildId:'fixture-guild',react:async()=>{facts.reactionAttempted=true;throw Object.assign(new Error('invalid emoji'),{code:10014});},reactions:{removeAll:async()=>{facts.reactionsRemoved=true;}}},[{reactValue:'x'}]);}catch(error){facts.partialPanelError=true;}return facts;
 }));
 results.push(await scenario('validation-rule-no-write',async facts=>{
  prisma={};const service=vmFull('controllers/autoModRulesController.ts');await service.createAutoModRule({body:{}},response(facts),error=>{facts.expectedValidation=true;facts.status=error.status;});return facts;
 }));

 for(const result of results){result.blockingTask1Finding=result.label!=='shared-image-put';if(!result.blockingTask1Finding)result.classification='Existing optional mirror/source-URL cache fallback; excluded from blocking verdict.';}
 const r={at:new Date().toISOString(),sourceOnly:!compiled,syntheticBoundariesOnly:true,noProductionServicesOrCredentials:true,results};
if(process.env.FCM_REQUIRED_EFFECTS_OUTPUT)fs.writeFileSync(process.env.FCM_REQUIRED_EFFECTS_OUTPUT,JSON.stringify(r)+'\n');
process.stdout.write(JSON.stringify(r)+'\n');
})().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;}).finally(()=>{Module._load=original;});
