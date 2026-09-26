import './style.css';
import { InstalledXscalHost } from './xscalFixtureHost';
import { browserKey, defaultKeybinds, keybindFields, supportedKeys, type KeybindField, type KeybindProfile } from './keybinds';

const startedAt = performance.now();
const logEl = document.querySelector<HTMLPreElement>('#log')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const playerHost = document.querySelector<HTMLElement>('#player')!;
const requestedMode = new URLSearchParams(location.search).get('mode');
const mode = requestedMode === 'packaged-bridge' ? 'packaged-bridge' : requestedMode === 'harness' ? 'harness' : 'artifact';
const provider = new URLSearchParams(location.search).get('provider') === 'zfe' ? 'zfe' : 'xscal';
const swfUrl = mode === 'packaged-bridge' ? '/PackagedBridgeHost.swf' : mode === 'harness' ? '/FCMHarness.swf' : '/FCMChatWidget.swf';
let longTasks = 0;
let player: RuffleElement | undefined;
let keybinds: KeybindProfile = { ...defaultKeybinds };

function log(kind: string, message: string): void {
  const elapsed = Math.round(performance.now() - startedAt);
  logEl.textContent += `${elapsed.toString().padStart(6)}ms ${kind.padEnd(10)} ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

window.fcmSimLog = message => log('SIM-XSCAL', String(message));
window.fcmHostedDevSend = (channel, body) => {
  void fetch('/__fcm/hosted-dev/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, body }),
  }).then(async response => {
    const result = await response.json().catch(() => ({}));
    log(response.ok ? 'HOSTED-ACK' : 'HOSTED-ERR', response.ok ? String(result.messageId || 'sent') : String(result.error || response.status));
  }).catch(error => log('HOSTED-ERR', String(error)));
  return true;
};
window.addEventListener('error', event => log('ERROR', event.message));
window.addEventListener('unhandledrejection', event => log('REJECT', String(event.reason)));
window.addEventListener('keydown', event => log('KEYDOWN', `${event.code} key=${JSON.stringify(event.key)} repeat=${event.repeat}`));
window.addEventListener('keyup', event => log('KEYUP', `${event.code} key=${JSON.stringify(event.key)}`));

if ('PerformanceObserver' in window) {
  try {
    new PerformanceObserver(list => {
      longTasks += list.getEntries().length;
      document.querySelector('#long-tasks')!.textContent = String(longTasks);
    }).observe({ type: 'longtask', buffered: true });
  } catch { log('PERF', 'Long-task observer unavailable'); }
}

const elapsedTimer = setInterval(() => {
  document.querySelector('#elapsed')!.textContent = `${Math.round(performance.now() - startedAt)} ms`;
}, 100);

async function sha256(url: string): Promise<string> {
  const bytes = await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function external(name: string, ...args: unknown[]): unknown {
  if (!player) throw new Error('Ruffle player is not ready');
  return player.ruffle().callExternalInterface(name, args);
}

async function dispatch(bindingOrKey: string): Promise<void> {
  const token = keybindFields.includes(bindingOrKey as KeybindField)
    ? keybinds[bindingOrKey as KeybindField] : bindingOrKey;
  log('ACTION', `${bindingOrKey}=${token || '<unbound>'} provider=${provider}`);
  const key = browserKey(token);
  const target = player;
  if (!target || !key) return;
  const emit = (type: 'keydown' | 'keyup') => {
    if (!target.isConnected) return;
    const event = new KeyboardEvent(type, { code: key.code, key: key.key, bubbles: true, cancelable: true });
    Object.defineProperties(event, { keyCode: { value: key.keyCode }, which: { value: key.keyCode } });
    target.dispatchEvent(event);
  };
  target.focus();
  emit('keydown');
  await new Promise(resolve => setTimeout(resolve, 120));
  emit('keyup');
  log('ACTION', `${bindingOrKey}=${token || '<unbound>'} up`);
}

async function boot(): Promise<void> {
  const keybindResponse = await fetch('/__fcm/keybinds', { cache: 'no-store' });
  if (keybindResponse.ok) keybinds = (await keybindResponse.json()).profile;
  renderKeybindEditor();
  log('BOOT', `Creating isolated Ruffle player (${mode})`);
  const ruffle = window.RufflePlayer!.newest();
  player = ruffle.createPlayer();
  player.id = 'ruffle-player';
  player.style.width = '100%';
  player.style.height = '100%';
  playerHost.appendChild(player);
  const gameFontSource = (await fetch('/fonts_programs.swf', { method: 'HEAD', cache: 'no-store' })).ok;
  await player.ruffle().load({
    url: swfUrl, autoplay: 'on', backgroundColor: '#090806', letterbox: 'on',
    logLevel: 'info', warnOnUnsupportedContent: true, unmuteOverlay: 'hidden',
    // Ruffle's "internal" blocks ExternalInterface. Only our isolated local test
    // host needs that driver; URL opening remains denied and tests block nonlocal requests.
    openUrlMode: 'deny', allowNetworking: mode === 'packaged-bridge' ? 'all' : mode === 'harness' ? 'internal' : 'none', allowScriptAccess: mode !== 'artifact',
    parameters: { provider, scenario: new URLSearchParams(location.search).get('scenario') ?? '' },
    ...(gameFontSource ? { fontSources: ['/fonts_programs.swf'] } : {}),
  });
  // Ruffle 0.6.0 ignores this setter until load creates its instance. Scenario results use
  // Flash trace (not Haxe's on-stage debug field) after the widget's asynchronous startup.
  player.ruffle().traceObserver = line => log('AVM2', line);
  document.querySelector('#swf-hash')!.textContent = await sha256(swfUrl);
  const manifest = await (await fetch('/sim-manifest.json', { cache: 'no-store' })).json();
  const installedFixture = await (await fetch('/installed-xscal-0.2.16.json', { cache: 'no-store' })).json();
  window.__INSTALLED_XSCAL__ = new InstalledXscalHost(installedFixture);
  document.querySelector('#widget-version')!.textContent = manifest.widgetVersion;
  document.querySelector('#host-mode')!.textContent = mode;
  document.querySelector('#provider-mode')!.textContent = mode !== 'artifact' ? provider : 'none';
  const hostedDevEl = document.querySelector('#hosted-dev-mode')!;
  try {
    const hosted = await fetch('/__fcm/hosted-dev/status', { cache: 'no-store' });
    const state = await hosted.json();
    hostedDevEl.textContent = state.authenticated ? `LIVE (${state.channels} channels)` : 'local mock only';
  } catch { hostedDevEl.textContent = 'local mock only'; }
  statusEl.textContent = 'SWF loaded'; statusEl.dataset.state = 'ready';
  log('READY', `Widget ${manifest.widgetVersion}; host=${mode}; gameFonts=${gameFontSource ? 'loaded' : 'fallback'}`);
  window.dispatchEvent(new CustomEvent('fcm-simulator-ready'));
}

document.querySelector('#clear-log')!.addEventListener('click', () => { logEl.textContent = ''; });
document.querySelector<HTMLSelectElement>('#provider-select')!.value = provider;
document.querySelector<HTMLSelectElement>('#provider-select')!.addEventListener('change', event => {
  const selected = (event.currentTarget as HTMLSelectElement).value === 'zfe' ? 'zfe' : 'xscal';
  const url = new URL(location.href);
  url.searchParams.set('mode', 'harness');
  url.searchParams.set('provider', selected);
  location.assign(url);
});
document.querySelectorAll<HTMLButtonElement>('[data-binding]').forEach(button => {
  button.addEventListener('click', () => void dispatch(button.dataset.binding!));
});

const fieldLabels: Record<KeybindField, string> = {
  openKey: 'Open chat', channelNextKey: 'Next channel', channelPrevKey: 'Previous channel',
  scrollUpKey: 'Scroll up', scrollDownKey: 'Scroll down', scrollBottomKey: 'Newest message',
  activateLinkKey: 'Open selected link', hideKey: 'Hide HUD',
};
function renderKeybindEditor(): void {
  const host = document.querySelector('#keybind-fields')!;
  host.replaceChildren();
  const suggestions = document.createElement('datalist'); suggestions.id = 'keybind-suggestions';
  for (const token of supportedKeys.filter(Boolean)) {
    const option = document.createElement('option'); option.value = token; suggestions.append(option);
  }
  for (const field of keybindFields) {
    const label = document.createElement('label'); label.htmlFor = `bind-${field}`; label.textContent = fieldLabels[field];
    const input = document.createElement('input'); input.id = `bind-${field}`; input.dataset.keybind = field;
    input.setAttribute('list', suggestions.id); input.value = keybinds[field];
    input.placeholder = field === 'scrollBottomKey' || field === 'hideKey' ? 'Unbound' : 'Key or VK_###';
    host.append(label, input);
  }
  host.append(suggestions);
  document.querySelectorAll<HTMLButtonElement>('[data-binding]').forEach(button => {
    const token = keybinds[button.dataset.binding as KeybindField];
    button.disabled = !token; button.title = token || 'Unbound';
  });
}

async function saveKeybinds(reset = false): Promise<void> {
  const error = document.querySelector<HTMLElement>('#keybind-error')!; error.textContent = '';
  const profile = Object.fromEntries(keybindFields.map(field => [field,
    document.querySelector<HTMLInputElement>(`#bind-${field}`)?.value ?? '']));
  const response = await fetch(reset ? '/__fcm/keybinds/reset' : '/__fcm/keybinds', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: reset ? '{}' : JSON.stringify(profile),
  });
  const result = await response.json();
  if (!response.ok) { error.textContent = result.error || 'Invalid keybind profile'; return; }
  location.reload();
}
document.querySelector('#apply-keybinds')!.addEventListener('click', () => void saveKeybinds());
document.querySelector('#reset-keybinds')!.addEventListener('click', () => void saveKeybinds(true));

window.__FCM_SIM__ = { dispatch, packaged: command => {
  const value = external('simPackaged', command);
  return value == null ? null : JSON.parse(String(value)) as unknown;
}, submit: text => external('simSubmit', text), setHudMode: mode => external('simSetHudMode', mode),
unload: () => external('simUnload'), snapshot: () => {
  const value = external('simSnapshot');
  return value == null ? null : JSON.parse(String(value));
} };
window.__FCM_SIM_TEARDOWN__ = () => {
  clearInterval(elapsedTimer);
  if (mode === 'packaged-bridge') { try { external('simPackaged', 'unload'); } catch { /* Failed boot still removes the player. */ } }
  player?.remove(); player = undefined;
  statusEl.textContent = 'Torn down'; statusEl.dataset.state = 'stopped';
};

boot().catch(error => {
  statusEl.textContent = 'Boot failed'; statusEl.dataset.state = 'error';
  log('FATAL', error instanceof Error ? error.stack ?? error.message : String(error));
});

type RuffleController = {
  load(config: Record<string, unknown>): Promise<void>;
  callExternalInterface(name: string, args: unknown[]): unknown;
  traceObserver?: (line: string) => void;
};
type RuffleElement = HTMLElement & { ruffle(): RuffleController };
declare global {
  interface Window {
    RufflePlayer?: { newest(): { createPlayer(): RuffleElement } };
    fcmSimLog: (message: unknown) => void;
    fcmHostedDevSend: (channel: unknown, body: unknown) => boolean;
    __FCM_SIM__?: { dispatch(action: string): Promise<void>; packaged(command: string): unknown; submit(text: string): unknown; setHudMode(mode: string): unknown; unload(): unknown; snapshot(): Record<string, unknown> | null };
    __FCM_SIM_TEARDOWN__?: () => void;
    __INSTALLED_XSCAL__?: InstalledXscalHost;
  }
}
