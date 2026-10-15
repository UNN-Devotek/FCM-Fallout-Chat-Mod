const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const http = require('node:http'); const vm = require('node:vm');
const express = require('express'); const esbuild = require('esbuild');
let mockRuntime, dir, callback, redirects, server, clients;
jest.mock('../src/runtime', () => ({ get runtime() { return mockRuntime; } }));
const { RuntimeCoordinator } = require('../src/runtime/coordinator'); const { accountHttpIngress, instrumentHttpHandlers } = require('../src/runtime/ingress');
const effects = require('../src/lib/requiredEffects');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let i=0;i<150;i++) { if(predicate()) return; await pause(2); } throw new Error('Synthetic callback boundary was not reached'); }
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-browser-callback-')); mockRuntime = new RuntimeCoordinator(dir); callback = undefined; redirects = 0; clients = []; });
afterEach(async () => { callback?.(); for (const client of clients) client.destroy(); if(server) {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));server=undefined;} mockRuntime.disposeForTests(); fs.rmSync(dir,{recursive:true,force:true}); });
async function start() {
  const source = fs.readFileSync(path.resolve(__dirname,'../src/server.ts'),'utf8'); const prefix = "app.get('/auth/logout', apiLimiter, "; const start = source.indexOf(prefix) + prefix.length;
  const handler = vm.runInNewContext(esbuild.transformSync('const handler='+source.slice(start,source.indexOf('\n});',start)+2)+';handler;', {loader:'ts',target:'node22'}).code,{...effects,logger:{warn(){}}});
  const app = express(); app.use(accountHttpIngress(mockRuntime));
  app.use((req,res,next) => { req.session={destroy:done=>{callback=done;}}; const redirect=res.redirect.bind(res);res.redirect=(...args)=>{redirects++;return redirect(...args);};next(); });
  app.get('/',handler); instrumentHttpHandlers(app,mockRuntime); server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  let resolve; const response=new Promise(done=>resolve=done); const client=http.get({host:'127.0.0.1',port:server.address().port,path:'/'},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode,location:res.headers.location}));});clients.push(client);client.on('error',()=>{});await until(()=>callback);return{client,response};
}
test.each([false,true])('actual logout callback after disconnect retains the write and settles its handler (failure=%s)',async failing=>{
  const {client}=await start();client.destroy(); await pause(10); expect((await mockRuntime.drain({timeoutMs:40})).phase).toBe('failed');expect(mockRuntime.snapshot().active).not.toEqual([]);
  callback(failing?new Error('synthetic-private-session-key'):null);callback(new Error('duplicate callback'));
  const result=await mockRuntime.drain({timeoutMs:500}); expect(result.active).toEqual([]);expect(result.phase).toBe(failing?'failed':'drained');expect(result.failures).toHaveLength(failing?1:0);expect(redirects).toBe(0);
});
test.each([false,true])('actual logout preserves its redirect once when the session callback failure=%s',async failing=>{
  const {response}=await start(); callback(failing?new Error('synthetic-private-session-key'):null);callback();expect(await response).toEqual({status:302,location:'/'});expect(redirects).toBe(1);
  const result=await mockRuntime.drain({timeoutMs:500});expect(result.phase).toBe(failing?'failed':'drained');expect(result.active).toEqual([]);expect(JSON.stringify(result)).not.toContain('synthetic-private');
});
