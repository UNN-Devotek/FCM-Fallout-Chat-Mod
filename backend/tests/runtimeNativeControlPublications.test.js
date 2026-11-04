const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { cases } = require('./setup/runtime-native-control-publications.cjs');
const results = {};
beforeAll(() => {
  for (const variant of ['source', 'compiled']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-sibling-results-'));
    const output = path.join(directory, 'result.json');
    try {
      const child = spawnSync(process.execPath, ['--experimental-vm-modules', path.join(__dirname, 'setup/runtime-native-control-publications.cjs'), path.join(__dirname, variant === 'source' ? '../src' : '../dist')], {
        cwd: directory, env: { ...process.env, FCM_DISCOVERY_RESULT: output }, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      });
      process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
      if (child.error || child.status !== 0 || child.signal) throw Error('Sibling fixture failed: ' + child.status + '\n' + child.stderr);
      results[variant] = JSON.parse(fs.readFileSync(output, 'utf8')).results;
      expect(results[variant].map(row => row.label)).toEqual(cases.map(row => row.label));
      if (process.env.FCM_DISCOVERY_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.FCM_DISCOVERY_EVIDENCE_DIR, { recursive: true });
        fs.copyFileSync(output, path.join(process.env.FCM_DISCOVERY_EVIDENCE_DIR, 'native-control-' + variant + '.json'));
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
    expect(result.journal).not.toMatch(/synthetic-private-(?:publication|recovery)-secret/);
  } else expect(result.journal).toBe('');
  if (mode === 'healthy') expect(result.state.publications).toBe(1);
  if (mode === 'client-fail') {
    expect(result.state.publications).toBe(0);
    if (group === 'layout') { expect(result.state.writes).toBe(1); expect(result.state.local).toBe(1); }
    if (group === 'nameplate') expect(result.state.local).toBe(1);
    if (group === 'link-recovery') { expect(result.state.writes).toBe(0); expect(result.state.codeReads).toBe(1); }
    if (group === 'receipt-replay') {
      expect(result.state.writes).toBe(0); expect(result.state.claimAttempts).toBe(1); expect(result.state.claimReads).toBe(1);
      expect(result.state.responses[0].success).toBe(true);
    }
  }
  if (['local-client-fail', 'cursor-fail', 'new-code-local-client-fail'].includes(mode)) {
    expect(result.state.publications).toBe(0); expect(result.state.local).toBe(0);
    if (group === 'layout-set') expect(result.state.writes).toBe(1);
    if (group === 'layout-get' || group === 'nameplate' || mode === 'cursor-fail') expect(result.state.writes).toBe(0);
  }
  if (mode === 'zero-row') expect(result.state.writes).toBe(0);
  if (mode === 'initial-client-fail') { expect(result.state.writes).toBe(0); expect(result.state.publications).toBe(1); }
});
