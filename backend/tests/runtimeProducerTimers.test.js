const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { execFileSync } = require('node:child_process');
const parser = require('@babel/parser'), traverse = require('@babel/traverse').default;
let proof;
beforeAll(() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-timer-ci-')), output = path.join(directory, 'results.json');
  try {
    // Read an explicit fixture artifact; keep ordinary real-config diagnostics
    // intact in child stdout. No global quiet setting or JSON-line filtering.
    execFileSync(process.execPath, [path.join(__dirname, 'setup/runtime-producer-timers.cjs'), '--all', output], { cwd: directory, encoding: 'utf8', timeout: 30000 });
    proof = JSON.parse(fs.readFileSync(output, 'utf8')); expect(proof.results).toHaveLength(11);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 35000);
test.each(['natural-timeout', 'cancel-before-fire', 'repeated-cancel', 'teardown-interval', 'connection-churn', 'mixed-freeze', 'held-timeout', 'held-interval', 'detached-callback', 'frozen-registration', 'native-handle'])('actual runtime/native timer %s retains the correct lifecycle', mode => {
  const value = proof.results.find(item => item.mode === mode), { facts, final } = value;
  expect(final.phase).toBe('closed'); expect(final.ingressClosed).toBe(true); expect(final.active).toEqual([]); expect(final.failures).toEqual([]); expect(final.producers).toEqual([]);
  if (mode === 'mixed-freeze') {
    expect(facts.beforeFreeze.producers.map(item => item.label)).toEqual(['live-interval', 'live-timeout']);
    expect(facts.afterFreeze.stoppedProducers).toHaveLength(2); expect(final.stoppedProducers.map(item => item.label)).toEqual(['live-interval', 'live-timeout']);
    expect(final.stoppedProducers[0].schedule).toEqual(expect.objectContaining({ kind: 'interval', intervalMs: 30000, nextDueAt: expect.any(String) }));
    expect(final.stoppedProducers[1].schedule).toEqual(expect.objectContaining({ kind: 'timeout', dueAt: expect.any(String) }));
  } else expect(final.stoppedProducers).toEqual([]);
  if (mode === 'connection-churn') {
    expect(facts.samples.map(item => item.canceledPairs)).toEqual([1, 100, 1000, 5000]);
    expect(facts.samples.map(item => item.registered)).toEqual([facts.baseline, facts.baseline, facts.baseline, facts.baseline]);
    expect(new Set(facts.samples.map(item => item.snapshotBytes)).size).toBe(1); expect(value.checkpointBytes).toBeLessThan(2000);
  }
  if (mode.startsWith('held-') || mode === 'detached-callback') {
    expect(facts.afterCancel.producers).toEqual([]); expect(facts.held.phase).toBe('failed'); expect(facts.held.active.length).toBeGreaterThan(0);
    expect(facts.completedAtCheckpoint).toBe(false); expect(facts.completed).toBe(true); expect(facts.invoked).toBe(1);
  } else if (mode === 'teardown-interval') { expect(facts.invokedAtCancel).toBeGreaterThan(0); expect(facts.invoked).toBe(facts.invokedAtCancel); }
  else if (mode === 'natural-timeout') { expect(facts.invoked).toBe(1); expect(facts.afterFire.producers).toEqual([]); }
  else expect(facts.invoked).toBe(0);
  if (mode === 'native-handle') expect(facts.handles).toEqual(Array(2).fill({ before: true, sameUnref: true, unref: false, sameRef: true, ref: true }));
});

const callers = [
  ['server.ts', ['wsHeartbeat']], ['jobs/partyReap.ts', ['interval']], ['websocket/bridgeConnection.ts', ['this.nativeTimer', 'this.nativeTimer']],
  ['routes/simUsers.ts', ['timer']], ['websocket/handlers.ts', ['pd.timer', 'heartbeat', 'heartbeat', 'heartbeat', 'prior.timer', 'heartbeat']],
  ['routes/mcp.ts', ['timer']], ['services/relay/localExportBridge.ts', ['this.softLeaveTimer']], ['services/relay/relayHandler.ts', ['pingTimer']],
  ['services/giveawayService.ts', ['reminderTimer', 'timer', 'reminderTimer']], ['services/supporterSyncService.ts', ['intervalHandle', 'firstRunHandle']],
  ['services/roleVerificationService.ts', ['intervalHandle']], ['services/discordEventService.ts', ['runtime.reconcileTimer']],
];
function sourceCalls(relative) {
  const filename = path.join(__dirname, '../src', relative), source = fs.readFileSync(filename, 'utf8');
  const ast = parser.parse(source, { sourceType: 'module', plugins: ['typescript'] }); let cancelName;
  for (const node of ast.program.body) if (node.type === 'ImportDeclaration') {
    for (const specifier of node.specifiers) if (specifier.imported?.name === 'cancelProducerTimer') {
      expect(path.resolve(path.dirname(filename), node.source.value)).toBe(path.resolve(__dirname, '../src/runtime')); cancelName = specifier.local.name;
    }
  }
  expect(cancelName).toBeDefined(); const calls = [], nativeClears = [];
  traverse(ast, { CallExpression(cursor) {
    const { node } = cursor, callee = node.callee;
    const argument = node.arguments[0] && source.slice(node.arguments[0].start, node.arguments[0].end);
    if (callee.type === 'Identifier' && callee.name === cancelName) calls.push({ file: relative, callee: cancelName, argument, expression: source.slice(node.start, node.end) });
    if (callee.type === 'Identifier' && ['clearInterval', 'clearTimeout'].includes(callee.name)) nativeClears.push(argument);
  } });
  return { calls, nativeClears };
}
test.each(callers)('actual %s producer cancellation expressions use the bound owned helper', (relative, argumentsExpected) => {
  const value = sourceCalls(relative); expect(value.calls.map(call => call.argument)).toEqual(argumentsExpected);
  for (const argument of argumentsExpected) expect(value.nativeClears).not.toContain(argument);
});
test('all 21 actual cancellation expressions and field aliases dispose both native timer kinds', () => {
  const records = callers.flatMap(([relative]) => sourceCalls(relative).calls); expect(records).toHaveLength(21);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-timer-alias-')), input = path.join(directory, 'calls.json'), output = path.join(directory, 'result.json');
  try {
    fs.writeFileSync(input, JSON.stringify(records));
    execFileSync(process.execPath, [path.join(__dirname, 'setup/runtime-producer-timers.cjs'), 'caller-aliases', output, input], { cwd: directory, encoding: 'utf8', timeout: 10000 });
    const value = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(value.facts.calls).toHaveLength(42); expect(value.facts.invoked).toBe(0); expect(value.final.phase).toBe('closed');
    expect(value.final.producers).toEqual([]); expect(value.final.stoppedProducers).toEqual([]); expect(value.final.active).toEqual([]); expect(value.final.failures).toEqual([]);
    for (const call of value.facts.calls) { expect(call.registeredBefore).toBe(value.facts.baseline + 1); expect(call.registeredAfter).toBe(value.facts.baseline); }
    expect(value.facts.calls.filter(call => call.kind === 'interval')).toHaveLength(21); expect(value.facts.calls.filter(call => call.kind === 'timeout')).toHaveLength(21);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
