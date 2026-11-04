const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const esbuild = require('esbuild');
const { RuntimeCoordinator } = require('../src/runtime/coordinator');
let directory, runtime;
const logger = { warn() {} };
const userId = '10000000-0000-0000-0000-000000000001';
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fcm-presentation-effects-')); runtime = new RuntimeCoordinator(directory); });
afterEach(() => { runtime.disposeForTests(); fs.rmSync(directory, { recursive: true, force: true }); });
function actualFunction(filename, declaration, scope) {
  const source = fs.readFileSync(path.join(__dirname, '../src', filename), 'utf8');
  const start = source.indexOf(declaration), end = source.indexOf('\n/**', start + declaration.length);
  const body = source.slice(start, end).replace(/^export /, '');
  const code = esbuild.transformSync(`const actual=${body}; actual;`, { loader: 'ts', format: 'cjs', target: 'node22' }).code;
  return vm.runInNewContext(code, scope);
}
test.each(['identity-broadcast', 'presentation-dispatch'])('%s cannot hide a failed required presentation behind its nonfatal catch', async stage => {
  const throwingRefresh = () => { throw new Error('fixture-secret presentation payload'); };
  const handler = stage === 'identity-broadcast'
    ? actualFunction('websocket/handlers.ts', 'export function refreshClientCosmetics(', { runtime, logger, broadcast: throwingRefresh })
    : actualFunction('services/cosmetics/cosmeticsService.ts', 'export async function pushCosmeticsUpdate(', {
      runtime, logger, require: () => ({ refreshClientCosmetics: throwingRefresh }),
    });
  await runtime.run('fixture:presentation', () => handler(userId, { nameColor: '#F1C40F' }));
  const result = await runtime.drain({ timeoutMs: 1000 }); expect(result.phase).toBe('failed');
  expect(result.failures).toContainEqual(expect.objectContaining({ evidence: { userId, stage: 'presentation-refresh-unconfirmed' } }));
  expect(JSON.stringify(result.failures)).not.toContain('fixture-secret presentation payload');
});
test('no registered broadcast is an expected absent presentation target without failure', async () => {
  const handler = actualFunction('websocket/handlers.ts', 'export function refreshClientCosmetics(', { runtime, logger, broadcast: null });
  await runtime.run('fixture:presentation', () => handler(userId, {}));
  expect((await runtime.drain({ timeoutMs: 1000 })).phase).toBe('drained');
});
