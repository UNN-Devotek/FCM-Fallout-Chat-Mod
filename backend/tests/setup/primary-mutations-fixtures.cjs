const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('node:module'),vm=require('node:vm');
const project=path.resolve(__dirname,'../../..');
const sourceBase=path.resolve(process.argv[2]||path.join(project,'backend/src'));
const br=Module.createRequire(path.join(project,'backend/package.json'));const esbuild=br('esbuild');
Module._extensions['.ts']=(module,filename)=>module._compile(esbuild.transformSync(fs.readFileSync(filename,'utf8'),{loader:'ts',format:'cjs',target:'node22',supported:{'dynamic-import':false},sourcefile:filename}).code,filename);
const {RuntimeCoordinator}=require(path.join(project,'backend/src/runtime/coordinator.ts'));
const original=Module._load;const logger={info(){},warn(){},error(){},debug(){}};
let runtime,prisma,overrides;
const env={NODE_ENV:'production',SUPPORTER_TIER_ENABLED:true,DISCORD_SERVER_ID:'fixture-guild',MCP_RESOURCE_URL:'https://fixture.invalid/mcp',MCP_OAUTH_STATE_SECRET:'synthetic-secret'};
Module._load=function(request,parent,main){
 if(parent?.filename===path.join(sourceBase,'runtime/nativeFetch.ts')&&request==='../runtime')return{get runtime(){if(!runtime)throw new Error('Native helper requested before fixture runtime');return runtime;}};
 if(parent?.filename.startsWith(sourceBase+path.sep)&&!parent.filename.includes('/runtime/')){
  const resolved=request.startsWith('.')?path.resolve(path.dirname(parent.filename),request).replace(/\.[jt]s$/,''):request;
  if(resolved===path.join(sourceBase,'config/environment'))return{__esModule:true,default:env};
  if(resolved===path.join(sourceBase,'config/prisma'))return{__esModule:true,default:prisma};
  if(resolved===path.join(sourceBase,'config/logger'))return{__esModule:true,default:logger};
  if(request.endsWith('/runtime'))return{get runtime(){return runtime;}};
  if(overrides[request]!==undefined)return overrides[request];
  if(resolved===path.join(sourceBase,'config/storage'))return{s3:{send:async()=>{throw new Error('Unexpected fixture storage operation');}},BUCKET:'fixture',ensureBucket:async()=>{}};
  if(resolved===path.join(sourceBase,'config/database'))return{query:async()=>{throw new Error('Unexpected fixture SQL operation');}};
  if(resolved===path.join(sourceBase,'config/redis'))throw new Error('Unbound synthetic Redis fixture boundary');
  if(!request.startsWith('.')&&!path.isAbsolute(request))return original.call(this,br.resolve(request),parent,main);

 }
 return original.call(this,request,parent,main);
};
const safeDiscord={getDiscordClient:()=>null,postModAlert:async()=>{}};
const safeWs={broadcastMessageDeletion(){},markClientMuted(){},notifyAndDisconnect:()=>0,refreshClientIdentity(){},refreshClientCosmetics(){}};
async function scenario(label,fn,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fcm-spec-round5-'));runtime=new RuntimeCoordinator(dir);
 overrides={'../websocket/handlers':safeWs,'../../websocket/handlers':safeWs,'../../websocket/handlers.js':safeWs,'./discordService':safeDiscord,'../discordService':safeDiscord,'./userRoleService':{isProtectedTarget:async()=>false},'./relay/relayHandler':{evictRelayUser:async()=>0},'./relay/tokenService':{revokeTokensForLinkedUser:async()=>{}},'../../config/redis':{getRedisClient:async()=>({get:async()=>null,del:async()=>1,set:async()=>{}})}};
 try{const facts={};const record=runtime.recordFailure.bind(runtime);runtime.recordFailure=(label,error,evidence)=>{(facts.activeAtDisposition ||= []).push({label,active:runtime.snapshot().active.map(value=>value.label)});record(label,error,evidence);};const returned=await (options.bare?fn(facts):runtime.run('fixture:'+label,()=>fn(facts)));const drain=await runtime.drain({timeoutMs:250});return{label,facts,returned,phase:drain.phase,active:drain.active,failures:drain.failures,requiredFailureRetained:drain.phase==='failed'&&drain.active.length===0&&drain.failures.length>0};}
 finally{runtime.disposeForTests();fs.rmSync(dir,{recursive:true,force:true});}
}
function actual(relative){const filename=path.join(sourceBase,relative);delete require.cache[filename];return require(filename);}
const unknown=()=>new Error('fixture required mutation response unknown');
(async()=>{
 const results=[];
 if(process.argv.includes('--native-binding-only')){
  const probe=require('./native-helper-binding-probe.cjs');
  for(const mode of ['success','body-held','callback-held']){
   const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fcm-native-binding-'));runtime=new RuntimeCoordinator(directory);
   try{results.push({label:mode,...await probe(runtime,actual('runtime/nativeFetch.ts'),mode,sourceBase)});}
   finally{runtime.disposeForTests();fs.rmSync(directory,{recursive:true,force:true});}
  }
  console.log(JSON.stringify({results}));return;
 }
 results.push(await scenario('moderation-message-audit',async facts=>{
  prisma={$executeRaw:async()=>{facts.primarySoftDeleteCommitted=true;return 1;},auditLog:{create:async()=>{facts.auditAttempted=true;throw unknown();}}};
  await actual('services/moderationActionsService.ts').deleteMessageById('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','fixture');
  facts.actionReturnedSuccess=true;return{acknowledged:true};
 }));
 results.push(await scenario('accepted-audit-known-fk-refusal',async facts=>{
  prisma={$executeRaw:async()=>{facts.primarySoftDeleteCommitted=true;return 1;},auditLog:{create:async()=>{facts.auditAttempted=true;throw{code:'P2003'};}}};
  await actual('services/moderationActionsService.ts').deleteMessageById('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','fixture');return{acknowledged:true};
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

 const vmFull=(relative,unused={},append="",fixtureProcess=process,globals={})=>{
  const filename=path.join(sourceBase,relative),m={exports:{}};
  const load=name=>{
   if(name.endsWith('/config/prisma'))return{__esModule:true,default:prisma};
   if(name.endsWith('/config/logger'))return{__esModule:true,default:logger};
   if(name.endsWith('/config/environment'))return{__esModule:true,default:env};
   if(name.endsWith('/runtime'))return{get runtime(){return runtime;}};
   if(unused[name]!==undefined)return unused[name];
   if(overrides[name]!==undefined)return overrides[name];
   if(name.startsWith('../services/')||name.startsWith('./services/'))return {};
   if(name.startsWith('.'))return require(path.resolve(path.dirname(filename),name));
   return br(name);
  };
  vm.runInNewContext(esbuild.transformSync(fs.readFileSync(filename,'utf8')+append,{loader:'ts',format:'cjs',target:'node22',supported:{'dynamic-import':false}}).code,{require:load,module:m,exports:m.exports,console,Buffer,process:fixtureProcess,setTimeout,clearTimeout,URL,URLSearchParams,...globals});return m.exports;
 };
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
  await vmFull('controllers/usersController.ts').deleteSession({sessionToken:'synthetic-token'},response(facts),err=>{throw err;});return{status:facts.status};
 }));
 results.push(await scenario('mcp-audit-finalization',async facts=>{
  prisma={auditLog:{update:async()=>{facts.finalizationAttempts=(facts.finalizationAttempts||0)+1;throw unknown();}}};
  facts.primaryMutationAlreadyApplied=true;
  return{finalized:await actual('services/mcpAuditService.ts').finalizeMcpMutationAudit({id:'fixture-audit',createdAt:new Date(),startedAt:Date.now()},{discordId:'100000000000000001',clientId:'synthetic-client',grantId:'synthetic-grant'},'embed_send','100000000000000003','success')};
 }));
 const inline=(filename,prefix,bindings)=>{
  const source=fs.readFileSync(path.join(sourceBase,filename),'utf8');const start=source.indexOf(prefix)+prefix.length,end=source.indexOf('\n});',start)+2;
  if(start<prefix.length||end<start)throw new Error('Actual registered callback not found');
  return vm.runInNewContext(esbuild.transformSync('const handler='+source.slice(start,end)+';handler;', {loader:'ts',target:'node22'}).code,{...actual('lib/requiredEffects.ts'),logger,...bindings,console,URLSearchParams,Buffer});
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

 results.push(await scenario('ban-flag-after-confirmed-ban-row',async facts=>{
  prisma={ban:{create:async()=>{facts.banRowConfirmed=true;return{id:'fixture-ban'};}},user:{findUnique:async()=>({discordId:null}),update:async()=>{facts.flagWriteAttempted=true;throw unknown();}},auditLog:{create:async()=>({})}};
  try { await actual('services/moderationActionsService.ts').createBan('fixture-target','fixture-actor','Other','synthetic-reason',new Date(Date.now()+1000),[{type:'text',textContent:'synthetic evidence'}]); }
  catch(error){facts.problemResponse500=true;}
  return {status:500};
 }));
 results.push(await scenario('overlay-logout-redis-delete-unknown',async facts=>{
  prisma={session:{delete:async()=>{facts.dbAttempted=true;return{};}}};
  overrides['../config/redis']={getRedisClient:async()=>({del:async()=>{facts.redisRevocationAttempted=true;throw unknown();}})};
  await vmFull('controllers/usersController.ts').deleteSession({sessionToken:'synthetic-token',user:{id:'fixture-user'}},response(facts),error=>{facts.problemResponse500=true;});return{status:500};
 }));
 results.push(await scenario('account-session-cleanup-after-confirmed-message-report-deletes',async facts=>{
  prisma={message:{deleteMany:async()=>{facts.messagesDeleted=true;return{count:1};}},report:{deleteMany:async()=>{facts.reportsDeleted=true;return{count:1};}},session:{deleteMany:async()=>{facts.sessionDeleteAttempted=true;throw unknown();}},user:{delete:async()=>{facts.userDeleteAttempted=true;return{};}}};
  await vmFull('controllers/usersController.ts').deleteUser({params:{id:'10000000-0000-0000-0000-000000000001'},adminUser:{id:'api-key'}},response(facts),error=>{facts.problemResponse500=true;});return{status:500};
 }));
 for(const kind of ['update','delete']) results.push(await scenario('admin-'+kind+'-primary-authority-unknown',async facts=>{
  prisma={adminUser:{[kind]:async()=>{facts.authorityMutationAttempted=true;throw unknown();}},auditLog:{create:async()=>({})}};
  await actual('controllers/adminUsersController.ts')[kind+'AdminUser']({params:{discordId:'100000000000000001'},body:{role:'moderator'},adminUser:{id:'100000000000000002'}},response(facts),error=>{facts.problemResponse500=true;});return{status:500};
 }));

 results.push(await scenario('expired-ban-inline-authority-write-unknown',async facts=>{
  prisma={user:{findFirst:async()=>({id:'fixture-target',isBanned:true,bannedUntil:new Date(Date.now()-1000)}),update:async()=>{facts.unbanAuthorityMutationAttempted=true;throw unknown();}},adminUser:{findUnique:async()=>({role:'admin'})}};
  overrides['../config/redis']={getRedisClient:async()=>({get:async()=>null})};overrides['../services/roleVerificationService']={getCachedRole:async()=>null,resolveRole:()=> 'admin'};
  const req={headers:{},session:{discordUser:{id:'100000000000000001',role:'admin',roles:['fixture-admin']}}};
  await actual('middleware/auth.ts').requireDiscordRole('fixture-admin')(req,response(facts),error=>{facts.authorityGranted=!error;});return{authorityGranted:!!req.adminUser};
 }));
 results.push(await scenario('mcp-token-revocation-primary-unknown',async facts=>{
  prisma={mcpApiKey:{findUnique:async()=>({id:'fixture-token-row',ownerId:'fixture-owner',revokedAt:null}),update:async()=>{facts.tokenRevocationAttempted=true;throw unknown();}}};
  try {await actual('services/mcpTokenService.ts').revokeToken('fixture-owner','fixture-token-row');}catch(error){facts.problemResponse500=true;}return{status:500};
 }));
 results.push(await scenario('device-revoke-primary-authority-unknown',async facts=>{
  prisma={device:{findUnique:async()=>({id:'fixture-device'}),update:async()=>{facts.deviceRevocationAttempted=true;throw unknown();}},auditLog:{create:async()=>({})}};
  await vmFull('controllers/devicesController.ts',{'../services/deviceAuthService':{}}).revokeDevice({params:{installToken:'synthetic-install'},adminUser:{id:'fixture-admin'}},response(facts),error=>{facts.problemResponse500=true;});return{status:500};
 }));

 const clientRecord={clientId:'fcm_client_fixture',disabledAt:null,redirectUris:['http://localhost/callback']};
 const createMcp=(db)=>new (actual('services/mcpAuthorizationService.ts').McpAuthorizationService)({prisma:db,enabled:()=>true,roleService:{authorize:async()=>({authorized:true,role:'admin'})}});
 results.push(await scenario('oauth-code-primary-unknown',async facts=>{
  prisma={mcpOAuthClient:{findUnique:async()=>clientRecord},mcpOAuthCode:{create:async()=>{facts.codeAttempted=true;throw unknown();}}};
  try {await createMcp(prisma).issueAuthorizationCode({clientId:clientRecord.clientId,discordId:'100000000000000001',redirectUri:clientRecord.redirectUris[0],resource:env.MCP_RESOURCE_URL,pkceChallenge:'a'.repeat(43),codeChallengeMethod:'S256',scopes:['fcm:read']});}catch(error){facts.denied=true;}
  return{denied:true};
 }));
 for(const mode of ['unknown-commit','atomic-refusal'])results.push(await scenario('oauth-grant-transaction-'+mode,async facts=>{
  const tx={mcpOAuthCode:{updateMany:async()=>{facts.codeStatementResolved=true;return{count:1};}},mcpOAuthGrant:{create:async()=>{facts.grantStatementAttempted=true;if(mode==='atomic-refusal')throw{code:'P2002'};facts.grantStatementResolved=true;return{};}}};
  prisma={mcpOAuthClient:{findUnique:async()=>clientRecord},mcpOAuthCode:{findUnique:async()=>({...clientRecord,discordId:'100000000000000001',resource:env.MCP_RESOURCE_URL,scopes:['fcm:read']})},$transaction:async fn=>{try{const value=await fn(tx);if(mode==='unknown-commit'){facts.commitResponseUnknown=true;throw unknown();}return value;}catch(error){if(mode==='atomic-refusal')facts.transactionRolledBack=true;throw error;}}};
  try {await createMcp(prisma).exchangeAuthorizationCode({code:'synthetic-code',clientId:clientRecord.clientId,redirectUri:clientRecord.redirectUris[0],resource:env.MCP_RESOURCE_URL,codeVerifier:'v'.repeat(43)});}catch(error){facts.denied=true;}
  return{denied:true};
 }));
 for(const mode of ['unknown','confirmed'])results.push(await scenario('oauth-expired-family-revoke-'+mode,async facts=>{
  prisma={mcpOAuthGrant:{findFirst:async()=>({id:'fixture-grant',clientId:clientRecord.clientId,audience:env.MCP_RESOURCE_URL,familyId:'fixture-family',usedRefreshTokenHashes:[],refreshTokenExpiresAt:new Date(0)}),updateMany:async()=>{facts.revokeAttempted=true;if(mode==='unknown')throw unknown();facts.revocationConfirmed=true;return{count:1};}}};
  try {await createMcp(prisma).refresh({refreshToken:'synthetic-refresh-token',clientId:clientRecord.clientId,resource:env.MCP_RESOURCE_URL});}catch(error){facts.expectedInvalidGrant=error.code==='invalid_grant';}
  return{denied:true};
 }));
 results.push(await scenario('oauth-access-last-used-optional',async facts=>{
  prisma={mcpOAuthClient:{findUnique:async()=>clientRecord},mcpOAuthGrant:{findUnique:async()=>({id:'fixture-grant',clientId:clientRecord.clientId,discordId:'100000000000000001',audience:env.MCP_RESOURCE_URL,accessTokenExpiresAt:new Date(Date.now()+60000),refreshTokenExpiresAt:new Date(Date.now()+60000),scopes:['fcm:read']}),update:async()=>{facts.lastUsedAttempted=true;throw unknown();}}};
  await createMcp(prisma).verifyAccessToken('synthetic-access-token',env.MCP_RESOURCE_URL).catch(()=>{});return{unavailable:true};
 }));
 results.push(await scenario('oauth-client-registration-alias-unknown',async facts=>{
  prisma={mcpOAuthClient:{create:async()=>{facts.clientBindingAttempted=true;throw unknown();}}};
  await actual('services/mcpClientMetadataService.ts').registerOAuthClient({redirect_uris:['http://localhost/callback']}).catch(()=>{});return{unavailable:true};
 }));
 for(const mode of ['unknown','last-provider'])results.push(await scenario('linked-identity-unlink-'+mode,async facts=>{
  prisma={user:{findUnique:async()=>mode==='last-provider'?{discordId:null,steamId:null}:{discordId:'100000000000000001',steamId:null}},linkedIdentity:{findFirst:async()=>({id:'fixture-identity'}),count:async()=>0,deleteMany:async()=>{facts.unlinkAttempted=true;throw unknown();}}};
  return actual('services/linkedIdentityService.ts').unlinkProviderIdentity('fixture-user','nexus').catch(()=>({unavailable:true}));
 }));
 results.push(await scenario('device-nonce-authority-unknown',async facts=>{
  prisma={device:{findUnique:async()=>({revokedAt:null,publicKey:'synthetic-key'})}};
  overrides['../config/redis']={getRedisClient:async()=>({set:async()=>{facts.nonceAttempted=true;throw unknown();}})};
  return actual('services/deviceAuthService.ts').verifySignedRequest('GET','/fixture',Buffer.alloc(0),{timestamp:String(Date.now()),nonce:'a'.repeat(32),installToken:'synthetic-install-token',signature:'synthetic-signature'});
 }));

 for(const kind of ['binding','rebind','history','bridge'])results.push(await scenario('canonical-'+kind+'-unknown',async facts=>{
  const redis={get:async()=>null,lPush:async()=>{facts.historyCommitted=true;return 1;},lTrim:async()=>{},expire:async()=>{if(kind==='history'){facts.expiryAttempted=true;throw unknown();}return 1;},publish:async()=>{facts.publicationAttempted=true;throw unknown();},set:async()=>{facts.bindingAttempted=true;if(kind==='binding')throw unknown();facts.bindingCommitted=true;return 'OK';},zRemRangeByScore:async()=>0,zAdd:async()=>{facts.indexAttempted=true;throw unknown();}};
  overrides['../../config/redis']={getRedisClient:async()=>redis};overrides['./serverModeration']={noteModerationRoom:async()=>{}};overrides['./worldRosterService']={readRoster:async()=>({requestId:'fixture-request'})};
  try {
   if(kind==='binding')await actual('services/relay/worldIdService.ts').setWorldId('fixture-relay','r:fixture');
   if(kind==='rebind')await actual('services/relay/serverChat.ts').publishRebind('fixture-relay','r:fixture');
   if(kind==='history')await actual('services/relay/serverChat.ts').publishServerMessage('r:fixture',1,{id:1,kind:'chat.message',messageId:'fixture-message',channel:'server',senderUserId:'fixture-relay',linkedUserId:'fixture-account',senderDisplayName:'Fixture',body:'synthetic private chat',targetUserId:'',createdAt:new Date().toISOString()});
   if(kind==='bridge')await actual('services/relay/overlayServerBridge.ts').renewBridgeLease('fixture-account','fixture-relay','fixture-request');
  }catch(error){facts.currentUnavailable=true;}
  return{unavailable:!!facts.currentUnavailable};
 }));
 results.push(await scenario('canonical-held-history-after-freeze',async facts=>{
  let signalStarted,permit;const started=new Promise(resolve=>{signalStarted=resolve;}),held=new Promise(resolve=>{permit=resolve;});
  const redis={lPush:async()=>{signalStarted();await held;facts.historyCommitted=true;return 1;},lTrim:async()=>{facts.trimAfterFreeze=runtime.isFrozen();},expire:async()=>{facts.expiryAfterFreeze=runtime.isFrozen();return 1;},publish:async()=>{facts.publicationAfterFreeze=runtime.isFrozen();return 0;}};
  overrides['../../config/redis']={getRedisClient:async()=>redis};overrides['./serverModeration']={noteModerationRoom:async()=>{}};
  const pending=actual('services/relay/serverChat.ts').publishServerMessage('r:fixture',1,{id:1,kind:'chat.message',messageId:'fixture-message',channel:'server',senderUserId:'fixture-relay',linkedUserId:'fixture-account',senderDisplayName:'Fixture',body:'synthetic private chat',targetUserId:'',createdAt:new Date().toISOString()});
  await started;runtime.freeze('fixture');const draining=runtime.drain({timeoutMs:250});await new Promise(resolve=>setImmediate(resolve));facts.heldActive=runtime.snapshot().active.map(work=>work.label);permit();await pending;facts.firstDrainPhase=(await draining).phase;return{completed:true};
 },{bare:true}));
 results.push(await scenario('direct-message-persist-own-disposition',async facts=>{
  prisma={$executeRaw:async()=>{facts.persistAttempted=true;throw unknown();}};try{await actual('services/messageService.ts').persistMessage({id:'fixture-message',content:'synthetic private chat',userId:'fixture-user',channelId:'fixture-channel'});}catch(error){facts.currentUnavailable=true;}return{unavailable:true};
 }));
 results.push(await scenario('camp-primary-upsert-unknown',async facts=>{
  prisma={campItem:{upsert:async()=>{facts.campPrimaryAttempted=true;throw unknown();}}};overrides['../config/redis']={getRedisClient:async()=>({get:async()=>null})};overrides['./atomPriceService']={updateCampAtomPrices:async()=>0};overrides['./campImageService']={campImageFormId:()=>null,deriveCampSource:()=>({sourceType:'unknown',sourceLabel:null})};
  try{await actual('services/campService.ts').ingestCampDatabase(JSON.stringify([{Name:'Synthetic Fixture',Category:'Fixture',SubCategory:'Fixture'}]));}catch(error){facts.currentUnavailable=true;facts.fixtureErrorClass=error.name;}return{unavailable:true};
 }));
 results.push(await scenario('hud-receipt-claim-unknown',async facts=>{
  try{await actual('services/relay/hudSendReceipt.ts').claimHudSend({set:async()=>{facts.receiptAttempted=true;throw unknown();},get:async()=>null},{key:'fixture-opaque-key',fingerprint:'a'.repeat(64)});}catch(error){facts.currentUnavailable=true;}return{unavailable:true};
 }));
 results.push(await scenario('voice-owner-write-own-disposition',async facts=>{
  prisma={voiceChannel:{upsert:async()=>{facts.voiceOwnerAttempted=true;throw unknown();}}};await vmFull('services/voiceService.ts',{},'\nmodule.exports.__persistOwner = persistOwner;').__persistOwner('fixture-voice','fixture-guild','fixture-owner');return{completed:true};
 }));
 results.push(await scenario('migration-sql-dynamic-unknown',async facts=>{
  overrides['../config/database']={query:async()=>{facts.sqlAttempted=true;throw unknown();}};
  await vmFull('controllers/migrationController.ts').runSql({body:{sql:'UPDATE synthetic_table SET synthetic_secret = 1'},ip:'fixture-ip'},response(facts),error=>{facts.currentUnavailable=true;});return{unavailable:true};
 }));
 for(const mode of ['connection','state'])results.push(await scenario('local-export-'+mode+'-unknown',async facts=>{
  const redis={incr:async()=>{facts.connectionAttempted=true;if(mode==='connection')throw unknown();return 1;},expire:async()=>1,set:async()=>{facts.stateAttempted=true;throw unknown();}};overrides['../../config/redis']={getRedisClient:async()=>redis};
  const bridge=new (actual('services/relay/localExportBridge.ts').LocalExportBridge)('fixture-account','synthetic-private-session-token',()=>true);await bridge.connectionOrder;
  if(mode==='state')await bridge.save({active:false,snapshot:null,expiresAt:0,retiredSessions:[],retiredWorlds:[]}).catch(()=>{});return{completed:true};
 }));
 results.push(await scenario('mcp-authorize-session-save-unknown',async facts=>{
  Object.assign(env,{MCP_REMOTE_ENABLED:true,MCP_ISSUER_URL:'https://fixture.invalid',DISCORD_CLIENT_ID:'fixture-client',NODE_ENV:'production'});
  overrides['../config/redis']={getRedisClient:async()=>({set:async()=>{facts.stateCommitted=true;return 'OK';}})};
  const unused={'../services/mcpClientMetadataService':{McpClientMetadataError:class extends Error{},resolveOAuthClient:async()=>({redirectUris:['http://localhost/callback']}),matchesRegisteredRedirectUri:()=>true},'../services/mcpAuthorizationService':{McpOAuthError:class extends Error{},MCP_SCOPES:['fcm:read']},'../services/mcpAuditService':{recordMcpMetric:()=>{}}};
  const req={headers:{},query:{client_id:'fixture-client',redirect_uri:'http://localhost/callback',resource:env.MCP_RESOURCE_URL,code_challenge:'a'.repeat(43),code_challenge_method:'S256',response_type:'code'},sessionID:'fixture-session',session:{save:done=>{facts.sessionAttempted=true;done(unknown());}}};
  await vmFull('controllers/mcpOAuthController.ts',unused).authorize(req,response(facts));return{unavailable:true};
 }));
 for(const mode of ['unknown','invalid-response','not-configured','invalid-input'])results.push(await scenario('managed-github-'+mode,async facts=>{
  Object.assign(env,{GITHUB_PAT:mode==='not-configured'?'':'synthetic-private-github-token',GITHUB_OWNER:'fixture-owner',GITHUB_REPO:'fixture-repo'});
  const fetch=async()=>{facts.requestAttempted=true;if(mode==='unknown')throw unknown();return new Response('',{status:201});};
  try{await vmFull('services/githubService.ts',{'../runtime/nativeFetch':{beginRuntimeFetch:fetch}}).createIssue({title:mode==='invalid-input'?null:'Synthetic fixture',body:'synthetic private github body'});}catch(error){facts.currentUnavailable=true;}return{unavailable:true};
 }));
 results.push(await scenario('release-download-count-optional',async facts=>{
  prisma={release:{updateMany:async()=>{facts.counterAttempted=true;throw unknown();}}};
  await vmFull('controllers/releasesController.ts',{},'\nmodule.exports.incrementDownloadCount = incrementDownloadCount;').incrementDownloadCount('fixture-version');return{completed:true};
 }));
 results.push(await scenario('party-invite-full-known-rollback',async facts=>{
  const userId='10000000-0000-0000-0000-000000000001',partyId='20000000-0000-0000-0000-000000000002',inviteId='30000000-0000-0000-0000-000000000003';
  const invite={id:inviteId,inviteeId:userId,partyId,status:'pending',party:{id:partyId,maxMembers:2}};
  const tx={$queryRaw:async()=>[],partyInvite:{update:async()=>{facts.inviteStatementResolved=true;invite.status='accepted';return invite;}},partyMember:{findFirst:async()=>null,count:async()=>2}};
  prisma={partyInvite:{findUnique:async()=>invite},user:{findUnique:async()=>({isBanned:false,isMuted:false})},partyMember:{findFirst:async()=>null,count:async()=>0},$transaction:async fn=>{try{return await fn(tx);}catch(error){invite.status='pending';facts.rollbackConfirmed=true;throw error;}}};
  await vmFull('controllers/partiesController.ts',{'../config/features':{PARTIES_ENABLED:true}}).acceptInvite({user:{id:userId},params:{id:inviteId}},response(facts),error=>{facts.publicStatus=error.status;});
  facts.inviteRemainsPending=invite.status==='pending';return{status:facts.publicStatus};
 }));
 for(const result of results){result.blockingTask1Finding=result.label!=='shared-image-put';if(!result.blockingTask1Finding)result.classification='Existing optional mirror/source-URL cache fallback; excluded from blocking verdict.';}
 const r={at:new Date().toISOString(),sourceOnly:true,syntheticBoundariesOnly:true,noProductionServicesOrCredentials:true,results};
 process.stdout.write(JSON.stringify(r)+'\n');
})().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;}).finally(()=>{Module._load=original;});
