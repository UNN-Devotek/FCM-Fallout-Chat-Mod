const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { cases } = require('./setup/runtime-required-discovery.cjs');
const results = {};
beforeAll(() => {
  for (const variant of ['source', 'compiled']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-discovery-result-')), output = path.join(directory, 'result.json');
    try {
      const child = spawnSync(process.execPath, [path.join(__dirname, 'setup/runtime-required-discovery.cjs'), path.join(__dirname, variant === 'source' ? '../src' : '../dist')], { cwd: directory, env: { ...process.env, FCM_DISCOVERY_RESULT: output }, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
      if (child.error || child.status !== 0 || child.signal) throw Error('Discovery fixture failed: ' + child.status + '\n' + child.stderr);
      results[variant] = JSON.parse(fs.readFileSync(output, 'utf8')).results;
      if (process.env.FCM_DISCOVERY_EVIDENCE_DIR) { fs.mkdirSync(process.env.FCM_DISCOVERY_EVIDENCE_DIR, { recursive: true }); fs.copyFileSync(output, path.join(process.env.FCM_DISCOVERY_EVIDENCE_DIR, variant + '.json')); }
      expect(results[variant].map(row => row.label)).toEqual(cases.map(row => row.label));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}, 65000);
test.each(['source', 'compiled'].flatMap(variant => cases.map(spec => ({ variant, ...spec }))))('$variant $label preserves required outcomes before HTTP/log error consumption', ({ variant, label, failure }) => {
  const result = results[variant].find(row => row.label === label);
  expect(result.final.active).toEqual([]);
  expect(result.final.phase).toBe(failure ? 'failed' : 'closed');
  expect(result.final.failures.length > 0).toBe(failure);
  expect(result.persisted.restartFence.cleared).toBe(!failure);
  if (failure) {
    expect(result.journal.length).toBeGreaterThan(0);
    expect(result.final.failures.some(value => value.evidence.stage)).toBe(true);
    for (const secret of ['synthetic-token', 'synthetic-secret', 'raw-query', 'synthetic chat']) expect(result.journal).not.toContain(secret);
  } else { expect(result.journal).toBe(''); expect(result.final.ingressClosed).toBe(true); expect(result.final.accountingEpoch).toBe(result.final.inspectionEpoch); }
  if (label === 'ban:redis-discovery' || label === 'ban:row-discovery') { expect(result.state.primary).toBe(true); expect(result.state.sessions).toBe(1); expect(result.state.audits).toBe(0); expect(result.forwarded).toHaveLength(1); expect(result.response).toBeUndefined(); }
  if (label === 'unmute:redis-discovery') { expect(result.state.primary).toBe(true); expect(result.state.immunity).toBe(false); expect(result.state.audits).toBe(0); expect(result.forwarded).toHaveLength(1); }
  if (label === 'register:redis-discovery') { expect(result.state.primary).toBe(true); expect(result.state.sessionCreated).toBeUndefined(); expect(result.forwarded).toHaveLength(1); expect(result.response).toBeUndefined(); }
  if (label === 'party:count') { expect(result.state.member).toBe(false); expect(result.state.partyDeleted).toBe(false); expect(result.state.audits).toBe(1); }
  if (label.startsWith('party:owner-')) { expect(result.state.member).toBe(false); expect(result.state.owner).toBe('old'); }
  if (/^(discord|steam):(redis|no-token)-discovery$/.test(label)) { expect(result.state.identity).toBe(false); expect(result.state.cache).toBe(1); expect(result.response.data).toEqual({ success: true, loggedOut: true }); expect(result.logs).toContain('warn'); }
  if (label === 'ban:held') { expect(result.checkpoint.phase).toBe('failed'); expect(result.checkpoint.active.length).toBeGreaterThan(0); expect(result.checkpoint.operatorRequested).toBe(false); expect(result.checkpoint.restartFence.cleared).toBe(false); expect(result.state.audits).toBe(1); }
});
