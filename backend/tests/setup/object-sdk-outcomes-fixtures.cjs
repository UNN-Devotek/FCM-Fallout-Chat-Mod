const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),Module=require('node:module'),crypto=require('node:crypto');
const project=path.resolve(__dirname,'../../..'),br=Module.createRequire(path.join(project,'backend/package.json')),esbuild=br('esbuild');
Module._extensions['.ts']=(module,file)=>module._compile(esbuild.transformSync(fs.readFileSync(file,'utf8'),{loader:'ts',format:'cjs',target:'node22',sourcefile:file}).code,file);
const {RuntimeCoordinator}=require(path.join(project,'backend/src/runtime/coordinator.ts'));
const client=process.argv[2],mode=process.argv[3];
const sourceBase=path.resolve(process.argv[4]||path.join(project,'backend/src'));
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fcm-object-outcome-')),runtime=new RuntimeCoordinator(dir),requests=[];
 const bytes=Buffer.alloc(3*1024*1024,0);Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(bytes);
 const digest=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
 let attempts=0,namespaceAttempts=0,storedHash=null,release,seen;const putSeen=new Promise(resolve=>seen=resolve);
 const server=http.createServer((req,res)=>{
  const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
   const body=Buffer.concat(chunks);requests.push({method:req.method,bodyBytes:body.length,expect:req.headers.expect||null,key:req.url});
   if(req.method==='HEAD'){res.writeHead(mode.startsWith('bucket-owned')?404:200);res.end();return;}
   if(mode.startsWith('bucket-owned')&&body.length===0){
    namespaceAttempts++;
    if(mode==='bucket-owned-after-loss'&&namespaceAttempts===1){req.socket.destroy();return;}
    res.writeHead(409,{'content-type':'application/xml'});res.end('<Error><Code>BucketAlreadyOwnedByYou</Code><Message>Fixture namespace owned</Message></Error>');return;
   }
   attempts++;
   const denied=mode==='first-403'||mode==='stored-loss-then-403'&&attempts>1;
   if(denied){res.writeHead(403,{'content-type':'application/xml'});res.end('<Error><Code>AccessDenied</Code><Message>Fixture permission refusal</Message></Error>');return;}
   storedHash=digest(body);
   if(mode==='stored-loss'||mode==='optional-avatar-loss'||mode==='stored-loss-then-403'){req.socket.destroy();return;}
   const complete=()=>{res.writeHead(200,{'ETag':'"fixture-etag"'});res.end();};
   if(mode==='held'){release=complete;seen();}else complete();
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint='http://127.0.0.1:'+server.address().port,original=Module._load;
 Module._load=function(request,parent,main){
  if(parent?.filename.startsWith(sourceBase+path.sep)){
   if(request.endsWith('/runtime'))return{runtime};
   if(request.endsWith('/environment')||request==='./environment')return{__esModule:true,default:{NODE_ENV:'test',MINIO_ENDPOINT:endpoint,MINIO_BUCKET:'fixture',MINIO_ROOT_USER:'fixture-key',MINIO_ROOT_PASSWORD:'fixture-secret'}};
   if(request.endsWith('/logger')||request==='./logger')return{__esModule:true,default:{info(){},warn(){},error(){},debug(){}}};
   if(!request.startsWith('.')&&!path.isAbsolute(request))return original.call(this,br.resolve(request),parent,main);
  }
  return original.call(this,request,parent,main);
 };
 try{
  const service=require(path.join(sourceBase,client==='evidence'?'services/banEvidenceStorage.ts':'config/storage.ts'));
  let rejected=false,errorMetadata;
  const operation=(async()=>{
   if(client==='shared'&&mode.startsWith('bucket-owned'))await service.ensureBucket(true);
   return client==='evidence'?service.uploadEvidence(mode==='invalid-before-write'?Buffer.from('invalid fixture'):bytes,'image/png')
    :mode==='optional-avatar-loss'?service.uploadAvatar('100000000000000001',bytes,'image/png')
     :service.uploadPartyImage('10000000-0000-0000-0000-000000000001','png',bytes,'image/png');
  })().catch(error=>{rejected=true;errorMetadata={name:error.name,status:error.$metadata?.httpStatusCode,attempts:error.$metadata?.attempts};});
  let heldActive;
  if(mode==='held'){
   await putSeen;const pendingDrain=runtime.drain({timeoutMs:3000});await new Promise(resolve=>setTimeout(resolve,30));
   heldActive=runtime.snapshot().active.map(value=>value.label);release();await operation;
   const result=await pendingDrain;process.stdout.write(JSON.stringify({client,mode,attempts,requests,storedHash,expectedHash:digest(bytes),rejected,errorMetadata,heldActive,...result})+'\n');
  }else{
   await operation;const result=await runtime.drain({timeoutMs:1000});
   process.stdout.write(JSON.stringify({client,mode,attempts,namespaceAttempts,requests,storedHash,expectedHash:digest(bytes),rejected,errorMetadata,...result})+'\n');
  }
 }finally{
  Module._load=original;runtime.disposeForTests();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
