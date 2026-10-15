const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-entrypoint-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture(marker) {
  fs.mkdirSync(path.join(dir, 'control'), { mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'dist', 'runtime'), { recursive: true });
  fs.copyFileSync(path.resolve('dist/runtime/bootstrap.js'), path.join(dir, 'dist', 'runtime', 'bootstrap.js'));
  fs.copyFileSync(path.resolve('dist/runtime/discordRelayJournal.js'), path.join(dir, 'dist', 'runtime', 'discordRelayJournal.js'));
  if (marker) fs.writeFileSync(path.join(dir, 'control', marker), marker === 'failures.jsonl' ? '{"id":"unresolved"}\n' : '{}');
  fs.writeFileSync(path.join(dir, 'baseline-migrations.sh'), '#!/bin/sh\nprintf migrated > migration-ran\n', { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'bin', 'node'), `#!/bin/sh\nif [ "$1" = dist/runtime/bootstrap.js ]; then exec '${process.execPath.replace(/'/g, "'\\''")}' "$@"; fi\nprintf node-started\n`, { mode: 0o700 });
  return { ...process.env, FCM_RUNTIME_CONTROL_DIR: path.join(dir, 'control'), PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` };
}

test.each(['maintenance.json', 'failures.jsonl', 'restart-unknown.json'])('the container startup skips schema writers under a durable %s', marker => {
  const env = fixture(marker);
  const child = spawnSync('sh', [path.resolve('runtime-start.sh')], { cwd: dir, env, encoding: 'utf8' });
  expect(child.status).toBe(0);
  expect(child.stdout).toContain('node-started');
  expect(fs.existsSync(path.join(dir, 'migration-ran'))).toBe(false);
});

test('ordinary startup claims a persistent process fence before migrations and then execs Node', () => {
  const env = fixture();
  fs.writeFileSync(path.join(dir, 'baseline-migrations.sh'), '#!/bin/sh\ntest -s "$FCM_RUNTIME_CONTROL_DIR/restart-active.json"\nprintf migrated > migration-ran\n', { mode: 0o700 });
  const child = spawnSync('sh', [path.resolve('runtime-start.sh')], { cwd: dir, env, encoding: 'utf8' });
  expect(child.status).toBe(0);
  expect(fs.existsSync(path.join(dir, 'migration-ran'))).toBe(true);
  expect(child.stdout).toBe('node-started');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'control', 'restart-active.json'), 'utf8')).format).toBe('fcm-restart-fence-v1');
});

test('a failed baseline leaves the claim intact and the next startup cannot run schema writers', () => {
  const env = fixture();
  fs.writeFileSync(path.join(dir, 'baseline-migrations.sh'), '#!/bin/sh\nexit 9\n', { mode: 0o700 });
  const first = spawnSync('sh', [path.resolve('runtime-start.sh')], { cwd: dir, env, encoding: 'utf8' });
  expect(first.status).toBe(9); expect(first.stdout).not.toContain('node-started');
  const second = spawnSync('sh', [path.resolve('runtime-start.sh')], { cwd: dir, env, encoding: 'utf8' });
  expect(second.status).toBe(0); expect(second.stdout).toContain('Frozen startup');
  expect(second.stdout).toContain('node-started');
  expect(fs.existsSync(path.join(dir, 'control', 'restart-active.json'))).toBe(true);
});

test('the actual entrypoint passes only its fresh claim to Node with the same PID', () => {
  const env = { ...fixture(), FCM_RUNTIME_BOOT_NONCE: 'stale-config-nonce' };
  fs.rmSync(path.join(dir, 'bin', 'node'));
  fs.writeFileSync(path.join(dir, 'dist', 'server.js'), `const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.env.FCM_RUNTIME_CONTROL_DIR+'/restart-active.json'));process.stdout.write(JSON.stringify({samePid:m.pid===process.pid,fresh:m.owner===process.env.FCM_RUNTIME_BOOT_NONCE&&m.owner!=='stale-config-nonce'}));`);
  const child = spawnSync('sh', [path.resolve('runtime-start.sh')], { cwd: dir, env, encoding: 'utf8' });
  expect(child.status).toBe(0); expect(JSON.parse(child.stdout)).toEqual({ samePid: true, fresh: true });
});

test('a forced kill before Node starts leaves the migration claim fenced for the next startup', async () => {
  const env = fixture();
  fs.writeFileSync(path.join(dir, 'baseline-migrations.sh'), '#!/bin/sh\nprintf baseline-paused\\n\nkill -STOP "$PPID"\n', { mode: 0o700 });
  const child = spawn('sh', [path.resolve('runtime-start.sh')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Baseline fixture did not start')), 3000);
      child.stdout.on('data', value => { if (value.toString().includes('baseline-paused')) { clearTimeout(timeout); resolve(); } });
      child.once('error', reject);
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGKILL'); expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
    const next = spawnSync('sh', [path.resolve('runtime-start.sh')], { cwd: dir, env, encoding: 'utf8' });
    expect(next.status).toBe(0); expect(next.stdout).toContain('Frozen startup'); expect(next.stdout).toContain('node-started');
    expect(fs.existsSync(path.join(dir, 'control', 'restart-active.json'))).toBe(true);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('SIGTERM reaches the final Node PID through the actual packaged entrypoint', async () => {
  const env = fixture('maintenance.json');
  fs.rmSync(path.join(dir, 'bin', 'node'));
  fs.writeFileSync(path.join(dir, 'dist', 'server.js'), `process.on('SIGTERM',()=>{process.stdout.write('signal:'+process.pid+'\\n');process.exit(0)});process.stdout.write('ready:'+process.pid+'\\n');setInterval(()=>{},1000);`);
  const child = spawn('sh', [path.resolve('runtime-start.sh')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Node fixture did not start')), 3000);
      child.stdout.on('data', value => { output += value.toString(); if (output.includes(`ready:${child.pid}`)) { clearTimeout(timeout); resolve(); } });
      child.once('error', reject);
    });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(output).toContain(`signal:${child.pid}`);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});
