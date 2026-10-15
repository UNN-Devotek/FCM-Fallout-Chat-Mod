const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const http = require('node:http');

test('a real backend module load and startup inherit freeze before stores, workers, seeds or file producers run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-frozen-boot-'));
  let dbConnections = 0, redisConnections = 0;
  const db = net.createServer(socket => { dbConnections++; socket.destroy(); });
  const redis = net.createServer(socket => { redisConnections++; socket.destroy(); });
  let child;
  try {
    await Promise.all([new Promise(resolve => db.listen(0, '127.0.0.1', resolve)), new Promise(resolve => redis.listen(0, '127.0.0.1', resolve))]);
    const control = path.join(dir, 'control'); fs.mkdirSync(control, { mode: 0o700 }); fs.writeFileSync(path.join(control, 'maintenance.json'), '{}');
    const driver = path.join(dir, 'driver.cjs');
    fs.writeFileSync(driver, `
      const fs=require('node:fs'); const copied=[];
      const copy=fs.copyFileSync; fs.copyFileSync=function(source,dest,...rest){copied.push(dest);return copy.call(this,source,dest,...rest)};
      const app=require(${JSON.stringify(path.resolve('dist/server.js'))});
      app.start().then(()=>{const ready=()=>process.send({port:app.server.address().port,copied});if(app.server.listening)ready();else app.server.once('listening',ready)}).catch(error=>{process.send({error:error.message});process.exit(1)});
    `);
    child = fork(driver, [], { cwd: dir, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, NODE_ENV: 'test', PORT: '0', SESSION_SECRET: 'synthetic-frozen-boot-secret',
        DISCORD_TOKEN: '', FCM_RUNTIME_CONTROL_DIR: control, DB_HOST: '127.0.0.1', DB_PORT: String(db.address().port),
        DATABASE_URL: `postgresql://fixture:fixture@127.0.0.1:${db.address().port}/fixture`, REDIS_HOST: '127.0.0.1',
        REDIS_PORT: String(redis.address().port), REDIS_URL: `redis://127.0.0.1:${redis.address().port}`, LOG_LEVEL: 'silent' } });
    let errors = ''; child.stderr.on('data', value => { errors += value.toString(); });
    const started = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Frozen backend did not start: ${errors}`)), 4000);
      child.once('message', value => { clearTimeout(timer); value.error ? reject(new Error(value.error)) : resolve(value); });
      child.once('error', reject);
    });
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: started.port, path: '/mcp', method: 'POST' }, res => {
        let body = ''; res.on('data', value => { body += value.toString(); }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }); req.on('error', error => reject(new Error(`HTTP probe ${error.message}; childExit=${child.exitCode}; db=${dbConnections}; redis=${redisConnections}; stderr=${errors}`))); req.end('{}');
    });
    expect(result.status).toBe(503); expect(result.body.code).toBe('maintenance');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(dbConnections).toBe(0); expect(redisConnections).toBe(0);
    expect(started.copied).toEqual([]);
    expect(fs.existsSync(path.join(control, 'messages.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(control, 'maintenance.json'))).toBe(true);
  } finally {
    if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited; }
    await Promise.all([new Promise(resolve => db.close(resolve)), new Promise(resolve => redis.close(resolve))]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 8000);
