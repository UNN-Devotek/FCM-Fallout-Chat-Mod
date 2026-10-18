const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const fixture = path.join(__dirname, 'required-effects-fixtures.cjs');
function readRequiredEffectsArtifact(output, expectedLabels) {
  if (!fs.existsSync(output)) throw new Error('Required fixture result artifact missing');
  const data = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Required fixture result is not an object');
  if (expectedLabels) {
    const labels = Array.isArray(data.results) ? data.results.map(result => result?.label) : [];
    if (labels.length !== expectedLabels.length || new Set(labels).size !== labels.length
      || labels.some(label => !expectedLabels.includes(label))) throw new Error('Required fixture result set is incomplete or unexpected');
  }
  return data;
}
function runRequiredEffectsFixture({ args = [], environment = {}, expectedLabels, removedBinding = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-required-result-'));
  const output = path.join(directory, 'result.json');
  const command = removedBinding ? ['-e', `const fs=require('node:fs'),Module=require('node:module');const file=process.argv[1];const original=fs.readFileSync(file,'utf8');
    const needle="if(parent?.filename===actualPath('runtime/nativeFetch.ts')&&request==='../runtime')return runtimeBinding;";
    if(!original.includes(needle))throw Error('Exact native runtime binding missing');
    const child=new Module(file);child.filename=file;child.paths=Module._nodeModulePaths(require('node:path').dirname(file));child._compile(original.replace(needle,''),file);`, '--', fixture, ...args] : [fixture, ...args];
  try {
    const child = spawnSync(process.execPath, command, { cwd: directory, env: { ...process.env, NODE_ENV: 'test', ...environment, FCM_RUNTIME_CONTROL_DIR: path.join(directory, 'unintended-control'), FCM_REQUIRED_EFFECTS_OUTPUT: output }, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    fs.writeFileSync(path.join(directory, 'stdout.log'), child.stdout || ''); fs.writeFileSync(path.join(directory, 'stderr.log'), child.stderr || '');
    // Ordinary child diagnostics remain visible. They are never the result channel.
    process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
    if (child.error || child.status !== 0 || child.signal) throw new Error(`Required fixture process failed: status=${child.status} signal=${child.signal} error=${child.error?.code}\n${child.stderr}`);
    const data = readRequiredEffectsArtifact(output, expectedLabels);
    return { data, stdout: child.stdout, stderr: child.stderr, exitCode: child.status, pid: child.pid };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { runRequiredEffectsFixture, readRequiredEffectsArtifact };
