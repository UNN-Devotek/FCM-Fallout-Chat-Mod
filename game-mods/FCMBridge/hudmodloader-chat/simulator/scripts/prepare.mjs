import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const simulator = resolve(here, '..');
const widget = resolve(simulator, '..');
const publicDir = resolve(simulator, 'public');
const run = promisify(execFile);
const source = await readFile(resolve(widget, 'FCMChatWidget.hx'), 'utf8');
const mockSource = await readFile(resolve(simulator, 'haxe/MockXscal.hx'), 'utf8');
const installedFixturePath = resolve(simulator, 'fixtures/installed-xscal-0.2.16.json');
const installedFixture = JSON.parse(await readFile(installedFixturePath, 'utf8'));
for (const method of [...installedFixture.chatMethods, ...installedFixture.inputCallbacks]) {
  if (!mockSource.includes(`"${method}"`)) throw new Error(`MockXscal is missing installed 0.2.16 method ${method}`);
}
const match = source.match(/VERSION:String\s*=\s*"([^"]+)"/);
if (!match) throw new Error('FCMChatWidget version marker not found');
const swf = await readFile(resolve(widget, 'FCMChatWidget.swf'));
if (swf.subarray(0, 3).toString('ascii') !== 'FWS' || swf[3] !== 32) {
  throw new Error('Simulator requires the normalized production FWS v32 artifact');
}
await mkdir(publicDir, { recursive: true });
// Build via the real packager, then test its exact decoded BA2 payload. The host
// compiles without any production class path; temporary package inputs are owned here.
const bridgeTemp = await mkdtemp(resolve(tmpdir(), 'fcm-packaged-bridge-'));
try {
  const bridge = resolve(widget, '../hudmodloader-bridge');
  const zip = resolve(bridgeTemp, 'bridge.zip');
  await run('python3', [resolve(bridge, 'package.py'), '--target', 'dev', '--output', zip]);
  await run('python3', ['-m', 'zipfile', '-e', zip, bridgeTemp]);
  const manifest = JSON.parse(await readFile(resolve(bridgeTemp, 'BUILD.json'), 'utf8'));
  await run('python3', [resolve(widget, '../hudmenu-chat/ba2tool.py'), 'extract',
    resolve(bridgeTemp, 'Data/FCMServerBridge.ba2'), 'Interface/FCMServerBridge.swf',
    resolve(publicDir, 'FCMServerBridge.swf')]);
  const bridgeSwf = await readFile(resolve(publicDir, 'FCMServerBridge.swf'));
  if (createHash('sha256').update(bridgeSwf).digest('hex') !== manifest.swfSha256) {
    throw new Error('Packaged bridge payload differs from BUILD.json');
  }
  await writeFile(resolve(publicDir, 'bridge-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const perfZip = resolve(bridgeTemp, 'perf.zip');
  const perfExtract = resolve(bridgeTemp, 'perf');
  await mkdir(perfExtract);
  await run('python3', [resolve(bridge, 'package.py'), '--target', 'dev', '--diagnostic', '--output', perfZip]);
  await run('python3', ['-m', 'zipfile', '-e', perfZip, perfExtract]);
  const perfManifest = JSON.parse(await readFile(resolve(perfExtract, 'BUILD.json'), 'utf8'));
  if (!perfManifest.diagnostic) throw new Error('Bridge performance fixture must be marked diagnostic');
  await run('python3', [resolve(widget, '../hudmenu-chat/ba2tool.py'), 'extract',
    resolve(perfExtract, 'Data/FCMServerBridge.ba2'), 'Interface/FCMServerBridge.swf',
    resolve(publicDir, 'FCMServerBridgePerf.swf')]);
  const perfSwf = await readFile(resolve(publicDir, 'FCMServerBridgePerf.swf'));
  if (createHash('sha256').update(perfSwf).digest('hex') !== perfManifest.swfSha256) {
    throw new Error('Diagnostic bridge payload differs from BUILD.json');
  }
  await writeFile(resolve(publicDir, 'bridge-perf-manifest.json'), JSON.stringify(perfManifest, null, 2) + '\n');
  const nativeZip = resolve(bridgeTemp, 'native.zip');
  const nativeExtract = resolve(bridgeTemp, 'native');
  await mkdir(nativeExtract);
  await run('python3', [resolve(bridge, 'package.py'), '--target', 'dev', '--native-prototype', '--output', nativeZip]);
  await run('python3', ['-m', 'zipfile', '-e', nativeZip, nativeExtract]);
  await run('python3', [resolve(widget, '../hudmenu-chat/ba2tool.py'), 'extract',
    resolve(nativeExtract, 'Data/FCMServerBridge.ba2'), 'Interface/FCMServerBridge.swf',
    resolve(publicDir, 'FCMServerBridgeNative.swf')]);
  const nativeManifest = JSON.parse(await readFile(resolve(nativeExtract, 'BUILD.json'), 'utf8'));
  if (!nativeManifest.nativePrototype || createHash('sha256').update(await readFile(resolve(publicDir, 'FCMServerBridgeNative.swf'))).digest('hex') !== nativeManifest.swfSha256) {
    throw new Error('Native prototype bytes differ from package');
  }
  await run('haxe', ['packaged-bridge.hxml'], { cwd: simulator });
  await run('python3', [resolve(widget, 'normalize_swf.py'), resolve(publicDir, 'PackagedBridgeHost.swf')]);
} finally {
  await rm(bridgeTemp, { recursive: true, force: true });
}
const ruffleSource = resolve(simulator, 'node_modules/@ruffle-rs/ruffle');
const rufflePublic = resolve(publicDir, 'ruffle');
await mkdir(rufflePublic, { recursive: true });
for (const name of await readdir(ruffleSource)) {
  if (name === 'ruffle.js' || name.endsWith('.wasm') || /^core\.ruffle\..+\.js$/.test(name)) {
    await copyFile(resolve(ruffleSource, name), resolve(rufflePublic, name));
  }
}
await copyFile(resolve(widget, 'FCMChatWidget.swf'), resolve(publicDir, 'FCMChatWidget.swf'));
// Use the locally installed game's own font library when it is available. Nothing from the game
// is checked into or distributed with FCM; the generated public file is ignored and ephemeral.
const gameDataCandidates = [
  process.env.FCM_FALLOUT76_DATA,
  '/mnt/ExtraStorage/SteamLibrary/steamapps/common/Fallout76/Data',
].filter(Boolean);
let gameFontSource = false;
for (const dataDir of gameDataCandidates) {
  const archive = resolve(dataDir, 'SeventySix - Interface.ba2');
  try {
    await access(archive);
    await run('python3', [resolve(widget, '../hudmenu-chat/ba2tool.py'), 'extract', archive,
      'programs/fonts_programs.swf', resolve(publicDir, 'fonts_programs.swf')]);
    gameFontSource = true;
    break;
  } catch { /* The simulator remains usable with Ruffle's fallback font. */ }
}
const productionConfig = await readFile(resolve(widget, 'FCMChat.ini'), 'utf8');
if (!productionConfig.includes('autoHideEnabled=true')) {
  throw new Error('Production FCMChat.ini no longer contains the expected auto-hide setting');
}
// The game defaults to hiding an inactive HUD after 60 seconds. In the laboratory that
// looks exactly like a crashed/blank Ruffle movie, so keep only the generated simulator
// copy visible. The production config and packaged widget behavior remain unchanged.
await writeFile(resolve(publicDir, 'FCMChat.ini'), productionConfig.replace(
  'autoHideEnabled=true',
  '; Simulator-only: keep the preview observable during long test runs.\nautoHideEnabled=false',
));
await copyFile(installedFixturePath, resolve(publicDir, 'installed-xscal-0.2.16.json'));
await writeFile(resolve(publicDir, 'sim-manifest.json'), JSON.stringify({
  kind: 'fcm-hud-simulator',
  warning: 'SIMULATED HOST — NOT FALLOUT 76 OR A NATIVE PROVIDER',
  widgetVersion: match[1],
  swfSha256: createHash('sha256').update(swf).digest('hex'),
  gameFontSource,
}, null, 2) + '\n');
