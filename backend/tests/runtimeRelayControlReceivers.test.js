const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { cases } = require('./setup/runtime-relay-control-receivers.cjs');
const results = {};
beforeAll(() => {
  for (const variant of ['source', 'compiled']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-receiver-results-'));
    const output = path.join(directory, 'result.json');
    const root = variant === 'source' ? process.env.FCM_RUNTIME_RECEIVER_SOURCE_ROOT || path.join(__dirname, '../src')
      : process.env.FCM_RUNTIME_RECEIVER_COMPILED_ROOT || path.join(__dirname, '../dist');
    try {
      const child = spawnSync(process.execPath, ['--experimental-vm-modules', path.join(__dirname, 'setup/runtime-relay-control-receivers.cjs'), root], {
        cwd: directory, env: { ...process.env, FCM_DISCOVERY_RESULT: output }, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
      });
      process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
      if (child.error || child.status !== 0 || child.signal) throw Error('Receiver fixture failed: ' + child.status + '\n' + child.stderr);
      const artifact = JSON.parse(fs.readFileSync(output, 'utf8'));
      expect(artifact.syntheticOnly).toBe(true);
      expect(artifact.node).toBe(process.version);
      results[variant] = artifact.results;
      expect(results[variant].map(row => row.label)).toEqual(cases.map(row => row.label));
      if (process.env.FCM_DISCOVERY_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.FCM_DISCOVERY_EVIDENCE_DIR, { recursive: true });
        fs.copyFileSync(output, path.join(process.env.FCM_DISCOVERY_EVIDENCE_DIR, 'receivers-' + variant + '.json'));
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}, 65000);

test.each(['source', 'compiled'].flatMap(variant => cases.map(spec => ({ variant, ...spec }))))('$variant $label owns required receive completion before callback catches', ({ variant, label, group, mode, failure }) => {
  const result = results[variant].find(row => row.label === label);
  expect(result.final.phase).toBe(failure ? 'failed' : 'closed');
  expect(result.checkpoint.phase).toBe(result.final.phase);
  expect(result.final.active).toEqual([]);
  expect(result.final.failures.length > 0).toBe(failure);
  expect(result.checkpoint.restartFence.cleared).toBe(!failure);
  expect(result.state.publications).toBe(0);
  expect(result.journal).not.toContain('synthetic-private-receiver-secret');
  if (failure) {
    expect(result.journal.length).toBeGreaterThan(0);
    expect(result.state.delivered).toBe(0);
    expect(result.state.warnings).toBe(1);
  } else expect(result.journal).toBe('');
  if (mode === 'healthy') {
    expect(result.state.delivered).toBe(1); expect(result.state.cursorValue).toBe(1);
    expect(result.state.warnings).toBe(0);
    expect(result.state.frames[0]).toMatchObject({ op: 'event', cursor: 1, event: { id: 1, kind: 'chat.message', channel: 'system' } });
  }
  if (['self-origin', 'frozen', 'no-target-client-fail'].includes(mode)) {
    expect(result.state.clientConnectAttempts).toBe(0); expect(result.state.cursorAttempts).toBe(0);
    expect(result.state.delivered).toBe(0); expect(result.state.warnings).toBe(0);
  }
  if (mode === 'no-target') {
    expect(result.state.delivered).toBe(0); expect(result.state.warnings).toBe(0);
    expect(result.state.cursorAttempts).toBe(['link-required', 'hud-send-receipt'].includes(group) ? 0 : 1);
  }
  if (['client-fail', 'cursor-response-lost', 'delivery-throw'].includes(mode)) {
    expect(result.state.clientConnectAttempts).toBe(1);
    expect(result.state.cursorValue).toBe(mode === 'client-fail' ? 0 : 1);
    expect(result.state.deliveryAttempts).toBe(mode === 'delivery-throw' ? 1 : 0);
  }
  if (mode === 'pairing-lookup-fail') {
    expect(result.state.pairingLookups).toBe(1); expect(result.state.clientConnectAttempts).toBe(0);
  }
});
