const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { cases } = require('./setup/runtime-publication-prerequisites.cjs');
const results = {};
beforeAll(() => {
  for (const variant of ['source', 'compiled']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-sibling-results-'));
    const output = path.join(directory, 'result.json');
    try {
      const child = spawnSync(process.execPath, ['--experimental-vm-modules', path.join(__dirname, 'setup/runtime-publication-prerequisites.cjs'), path.join(__dirname, variant === 'source' ? '../src' : '../dist')], {
        cwd: directory, env: { ...process.env, FCM_DISCOVERY_RESULT: output }, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      });
      process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
      if (child.error || child.status !== 0 || child.signal) throw Error('Sibling fixture failed: ' + child.status + '\n' + child.stderr);
      results[variant] = JSON.parse(fs.readFileSync(output, 'utf8')).results;
      expect(results[variant].map(row => row.label)).toEqual(cases.map(row => row.label));
      if (process.env.FCM_DISCOVERY_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.FCM_DISCOVERY_EVIDENCE_DIR, { recursive: true });
        fs.copyFileSync(output, path.join(process.env.FCM_DISCOVERY_EVIDENCE_DIR, 'publication-' + variant + '.json'));
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}, 65000);
test.each(['source', 'compiled'].flatMap(variant => cases.map(spec => ({ variant, ...spec }))))('$variant $label retains mandatory discovery while preserving explicit fallbacks', ({ variant, label, group, mode, failure }) => {
  const result = results[variant].find(row => row.label === label);
  expect(result.final.phase).toBe(failure ? 'failed' : 'closed');
  expect(result.checkpoint.phase).toBe(result.final.phase);
  expect(result.final.active).toEqual([]);
  expect(result.final.failures.length > 0).toBe(failure);
  expect(result.checkpoint.restartFence.cleared).toBe(!failure);
  if (failure) {
    expect(result.journal.length).toBeGreaterThan(0);
    expect(result.journal).not.toContain('synthetic-private-secret');
  } else expect(result.journal).toBe('');
  if (mode === 'healthy') expect(result.state.errors).toBe(0);
  if (mode === 'no-primary') {
    expect(result.state.writes).toBe(0); expect(result.state.notices).toBe(0);
    expect(result.state.errors).toBe(['history-resync', 'party-send', 'party-edit', 'admin-party-edit'].includes(group) ? 1 : 0);
  }
  if (mode === 'member-fail-held') { expect(result.state.writesAtDiscovery).toBe(0); expect(result.state.writes).toBe(2); }
  if (mode === 'client-fail' && group === 'history-resync') expect(result.state.acks).toBe(1);
});
