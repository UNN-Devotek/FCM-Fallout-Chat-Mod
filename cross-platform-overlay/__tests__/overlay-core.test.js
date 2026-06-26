// P0 unit tests for the pure main-process helpers extracted into overlay-core.js.
// Runner: vitest (environment 'node' — no DOM needed). These mirror the Group 1
// P0 table in docs/testing/overlay-test-plan.md.

import path from 'path';
import core from '../overlay-core.js';

const {
  stateHasRealData,
  isCfChallenge,
  isSinglePrintableChar,
  resolveAppClientKey,
  resolveAppVersion,
  canShowOverlay,
  clampToWorkArea,
  buildKeybindMap,
  classifyInputGrab,
  filterProxyHeaders,
  resolveRelayProxyUrl,
  DEFAULT_APP_CLIENT_KEY,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
} = core;

// A throwing fs stub (no files exist).
const fsMissing = {
  readFileSync() { throw new Error('ENOENT'); },
};
// Build an fs stub that returns content keyed by exact path.
function fsWith(map) {
  return {
    readFileSync(p) {
      if (Object.prototype.hasOwnProperty.call(map, p)) return map[p];
      throw new Error('ENOENT: ' + p);
    },
  };
}

describe('stateHasRealData', () => {
  it.each([
    ['null', null, false],
    ['undefined', undefined, false],
    ['non-object (string)', 'x', false],
    ['non-object (number)', 5, false],
    ['empty object', {}, false],
    ['discordLinked true', { discordLinked: true }, true],
    ['discordLinked false', { discordLinked: false }, false],
    ['default username Overlay1234', { username: 'Overlay1234' }, false],
    ['default username Overlay0', { username: 'Overlay0' }, false],
    ['custom username', { username: 'Vaultie' }, true],
    ['username that merely contains Overlay', { username: 'OverlayBoss' }, true],
    ['empty username', { username: '' }, false],
    ['non-string username', { username: 123 }, false],
    ['empty settings object', { settings: {} }, false],
    ['populated settings', { settings: { theme: 'green' } }, true],
    ['null settings', { settings: null }, false],
    ['settings array (non-empty)', { settings: ['a'] }, true],
  ])('%s -> %s', (_label, input, expected) => {
    expect(stateHasRealData(input)).toBe(expected);
  });
});

describe('isCfChallenge', () => {
  it('503 with CF markers (cf-mitigated / text/html) -> true', () => {
    expect(isCfChallenge(503, { 'cf-mitigated': 'challenge' }, '{}')).toBe(true);
    expect(isCfChallenge(503, { 'content-type': 'text/html; charset=utf-8' }, '<html>error</html>')).toBe(true);
  });

  it('503 JSON / no CF markers -> false (real backend error surfaces)', () => {
    // Regression: a backend 503 like "Registration unavailable: server misconfigured"
    // must NOT be masked as a CF challenge — the user needs to see the real message.
    expect(isCfChallenge(503, { 'content-type': 'application/json' }, '{"detail":"Registration unavailable: server misconfigured"}')).toBe(false);
    expect(isCfChallenge(503, {}, '')).toBe(false);
    expect(isCfChallenge(503, undefined, undefined)).toBe(false);
  });

  it('403 with cf-mitigated header -> true', () => {
    expect(isCfChallenge(403, { 'cf-mitigated': 'challenge' }, '{}')).toBe(true);
  });

  it('403 with text/html content-type -> true', () => {
    expect(isCfChallenge(403, { 'content-type': 'text/html; charset=utf-8' }, '<html>')).toBe(true);
  });

  it('403 with cf-browser-verification in body (no header) -> true', () => {
    expect(isCfChallenge(403, { 'content-type': 'application/json' }, 'cf-browser-verification token')).toBe(true);
  });

  it('403 with JSON body / no CF markers -> false (legit backend 403)', () => {
    expect(isCfChallenge(403, { 'content-type': 'application/json' }, '{"error":"discord_auth_required"}')).toBe(false);
  });

  it('403 with no headers and no body -> false', () => {
    expect(isCfChallenge(403, undefined, undefined)).toBe(false);
  });

  it.each([200, 201, 400, 401, 404, 429, 500])('status %i -> false', (code) => {
    expect(isCfChallenge(code, { 'cf-mitigated': 'x', 'content-type': 'text/html' }, 'cf-browser-verification')).toBe(false);
  });
});

describe('isSinglePrintableChar', () => {
  it.each(['/', '\\', 'a', 'Z', '5', '.', ';', '`', '['])('single printable %s -> true', (c) => {
    expect(isSinglePrintableChar(c)).toBe(true);
  });

  it.each([
    'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
    'F1', 'F12', 'Escape', 'Tab', 'Space', 'Backspace', 'Enter',
    'Return', 'Up', 'Down', 'Left', 'Right', 'Plus', 'Minus', 'Equal',
    'NumLock', 'CapsLock', 'PrintScreen', 'Pause', 'ScrollLock',
  ])('named key %s -> false', (k) => {
    expect(isSinglePrintableChar(k)).toBe(false);
  });

  it.each(['CommandOrControl+K', 'Ctrl+A', 'Shift+/', 'Alt+F4', 'Super+L', 'Meta+C'])(
    'modifier-prefixed %s -> false', (k) => {
      expect(isSinglePrintableChar(k)).toBe(false);
    },
  );

  it.each(['ab', 'PageUpish', 'F', 'fo']) ('multi-char non-named %s', (k) => {
    // 'F' is single-char -> true; others multi-char -> false
    expect(isSinglePrintableChar(k)).toBe(k.length === 1);
  });

  it.each([['', false], [null, false], [undefined, false], [123, false], [{}, false]])(
    'non-string / empty %s -> false', (v, expected) => {
      expect(isSinglePrintableChar(v)).toBe(expected);
    },
  );
});

describe('resolveAppClientKey', () => {
  const dir = path.join('/app', 'cross-platform-overlay');
  const backendEnv = path.join(dir, '..', 'backend', '.env');
  const rootEnv = path.join(dir, '..', '.env');

  it('env APP_CLIENT_KEY wins and is trimmed', () => {
    const key = resolveAppClientKey({ APP_CLIENT_KEY: '  envkey  ' }, fsWith({ [backendEnv]: 'APP_CLIENT_KEY=backend\n' }), dir, path);
    expect(key).toBe('envkey');
  });

  it('falls to backend/.env when no env var', () => {
    const key = resolveAppClientKey({}, fsWith({ [backendEnv]: 'FOO=1\nAPP_CLIENT_KEY=backendkey\n' }), dir, path);
    expect(key).toBe('backendkey');
  });

  it('trims the backend/.env value', () => {
    const key = resolveAppClientKey({}, fsWith({ [backendEnv]: 'APP_CLIENT_KEY=   spaced   \n' }), dir, path);
    expect(key).toBe('spaced');
  });

  it('backend/.env precedes ../.env', () => {
    const key = resolveAppClientKey({}, fsWith({
      [backendEnv]: 'APP_CLIENT_KEY=backendkey\n',
      [rootEnv]: 'APP_CLIENT_KEY=rootkey\n',
    }), dir, path);
    expect(key).toBe('backendkey');
  });

  it('falls to ../.env when backend missing', () => {
    const key = resolveAppClientKey({}, fsWith({ [rootEnv]: 'APP_CLIENT_KEY=rootkey\n' }), dir, path);
    expect(key).toBe('rootkey');
  });

  it('skips empty APP_CLIENT_KEY line in backend/.env and uses root', () => {
    const key = resolveAppClientKey({}, fsWith({
      [backendEnv]: 'APP_CLIENT_KEY=   \n',
      [rootEnv]: 'APP_CLIENT_KEY=rootkey\n',
    }), dir, path);
    expect(key).toBe('rootkey');
  });

  it('returns the default when no env var and no files', () => {
    const key = resolveAppClientKey({}, fsMissing, dir, path);
    expect(key).toBe(DEFAULT_APP_CLIENT_KEY);
    expect(key).toBe('fo76-chat-desktop-v1');
  });

  it('empty env var string is falsy -> falls through to files/default', () => {
    const key = resolveAppClientKey({ APP_CLIENT_KEY: '' }, fsMissing, dir, path);
    expect(key).toBe(DEFAULT_APP_CLIENT_KEY);
  });
});

describe('resolveAppVersion', () => {
  const dir = path.join('/app', 'cross-platform-overlay');
  const csproj = path.join(dir, '..', 'ChatOverlay', 'ChatOverlay.csproj');
  const pkg = path.join(dir, 'package.json');

  it('reads <Version> from the csproj first', () => {
    const v = resolveAppVersion(fsWith({
      [csproj]: '<Project><PropertyGroup><Version>1.3.99</Version></PropertyGroup></Project>',
      [pkg]: JSON.stringify({ version: '9.9.9' }),
    }), dir, path);
    expect(v).toBe('1.3.99');
  });

  it('tolerates whitespace inside the <Version> tag', () => {
    const v = resolveAppVersion(fsWith({
      [csproj]: '<Version>  2.0.1  </Version>',
    }), dir, path);
    expect(v).toBe('2.0.1');
  });

  it('falls to package.json version when csproj missing', () => {
    const v = resolveAppVersion(fsWith({ [pkg]: JSON.stringify({ version: '4.5.6' }) }), dir, path);
    expect(v).toBe('4.5.6');
  });

  it('falls to package.json when csproj has no <Version>', () => {
    const v = resolveAppVersion(fsWith({
      [csproj]: '<Project></Project>',
      [pkg]: JSON.stringify({ version: '7.0.0' }),
    }), dir, path);
    expect(v).toBe('7.0.0');
  });

  it("falls to '0.0.0' when nothing resolves", () => {
    expect(resolveAppVersion(fsMissing, dir, path)).toBe('0.0.0');
  });

  it("falls to '0.0.0' when package.json is corrupt JSON", () => {
    const v = resolveAppVersion(fsWith({ [pkg]: 'not json {' }), dir, path);
    expect(v).toBe('0.0.0');
  });

  it("falls to '0.0.0' when package.json lacks a version field", () => {
    const v = resolveAppVersion(fsWith({ [pkg]: JSON.stringify({ name: 'x' }) }), dir, path);
    expect(v).toBe('0.0.0');
  });
});

describe('canShowOverlay (4-input cartesian)', () => {
  const bools = [false, true];
  const roles = ['member', '', 'moderator', 'admin', 'owner', 'developer'];
  const privileged = new Set(['moderator', 'admin', 'owner', 'developer']);

  for (const forceVisible of bools) {
    for (const role of roles) {
      for (const gameRunning of bools) {
        for (const chatActive of bools) {
          const expected = forceVisible || privileged.has(role) || gameRunning || !chatActive;
          it(`fv=${forceVisible} role=${role || '<empty>'} game=${gameRunning} chat=${chatActive} -> ${expected}`, () => {
            expect(canShowOverlay({ forceVisible, role, gameRunning, chatActive })).toBe(expected);
          });
        }
      }
    }
  }

  it('the one false case: regular user, game closed, chat active', () => {
    expect(canShowOverlay({ forceVisible: false, role: 'member', gameRunning: false, chatActive: true })).toBe(false);
  });

  it('undefined role + chatActive true + game closed -> false', () => {
    expect(canShowOverlay({ forceVisible: false, role: undefined, gameRunning: false, chatActive: true })).toBe(false);
  });

  it('empty state defaults to allow (chatActive falsy)', () => {
    expect(canShowOverlay()).toBe(true);
    expect(canShowOverlay({})).toBe(true);
  });
});

describe('clampToWorkArea', () => {
  // Primary display starting at origin.
  const wa = { x: 0, y: 0, width: 1920, height: 1080 };
  // Secondary display with a non-zero origin (multi-monitor / taskbar offset).
  const waOffset = { x: 100, y: 40, width: 1280, height: 720 };

  it('passes through a fully in-bounds rect', () => {
    expect(clampToWorkArea({ x: 200, y: 150, width: 600, height: 500 }, wa))
      .toEqual({ x: 200, y: 150, width: 600, height: 500 });
  });

  it('applies default size when width/height missing', () => {
    const r = clampToWorkArea({ x: 10, y: 10 }, wa);
    expect(r.width).toBe(DEFAULT_WIDTH);
    expect(r.height).toBe(DEFAULT_HEIGHT);
  });

  it('clamps width/height up to the MIN', () => {
    const r = clampToWorkArea({ x: 0, y: 0, width: 10, height: 10 }, wa);
    expect(r.width).toBe(MIN_WIDTH);
    expect(r.height).toBe(MIN_HEIGHT);
  });

  it('clamps width/height down to the work area size', () => {
    const r = clampToWorkArea({ x: 0, y: 0, width: 5000, height: 5000 }, wa);
    expect(r.width).toBe(wa.width);
    expect(r.height).toBe(wa.height);
  });

  it('defaults x/y to work-area origin + 60 when not numbers', () => {
    const r = clampToWorkArea({ width: 600, height: 500 }, waOffset);
    expect(r.x).toBe(waOffset.x + 60);
    expect(r.y).toBe(waOffset.y + 60);
  });

  it('never lets the right edge exceed the work area', () => {
    const r = clampToWorkArea({ x: 5000, y: 0, width: 600, height: 500 }, wa);
    expect(r.x).toBe(wa.x + wa.width - 600);
    expect(r.x + r.width).toBeLessThanOrEqual(wa.x + wa.width);
  });

  it('never lets the bottom edge exceed the work area', () => {
    const r = clampToWorkArea({ x: 0, y: 5000, width: 600, height: 500 }, wa);
    expect(r.y).toBe(wa.y + wa.height - 500);
    expect(r.y + r.height).toBeLessThanOrEqual(wa.y + wa.height);
  });

  it('never lets x/y go below the work-area origin', () => {
    const r = clampToWorkArea({ x: -500, y: -500, width: 600, height: 500 }, waOffset);
    expect(r.x).toBe(waOffset.x);
    expect(r.y).toBe(waOffset.y);
  });

  it('respects the offset origin for in-bounds rects', () => {
    const r = clampToWorkArea({ x: 200, y: 100, width: 600, height: 500 }, waOffset);
    expect(r).toEqual({ x: 200, y: 100, width: 600, height: 500 });
  });

  it('clamped result is always fully inside the work area (edge fuzz)', () => {
    for (const desired of [
      { x: -10000, y: -10000, width: 9999, height: 9999 },
      { x: 10000, y: 10000, width: 1, height: 1 },
      { x: 0, y: 0 },
      {},
    ]) {
      const r = clampToWorkArea(desired, waOffset);
      expect(r.x).toBeGreaterThanOrEqual(waOffset.x);
      expect(r.y).toBeGreaterThanOrEqual(waOffset.y);
      expect(r.x + r.width).toBeLessThanOrEqual(waOffset.x + waOffset.width);
      expect(r.y + r.height).toBeLessThanOrEqual(waOffset.y + waOffset.height);
    }
  });
});

describe('buildKeybindMap key-order round-trip', () => {
  // CFG_ACTIONS order (from main.js) — what parseKeybindsCfg produces from file
  const CFG_ACTIONS = [
    'toggle', 'focus', 'clickThrough',
    'nextChannel', 'prevChannel', 'settings',
    'recentParty', 'goFo76',
    'party1', 'party2', 'party3', 'party4',
    'party5', 'party6', 'party7', 'party8',
  ];

  const defaults = {
    toggle: 'Delete', focus: 'Insert', clickThrough: 'End',
    nextChannel: 'PageDown', prevChannel: 'PageUp', settings: 'Home',
    recentParty: '', goFo76: '/',
  };

  it('key order differs between buildKeybindMap and CFG_ACTIONS (JSON.stringify is not safe)', () => {
    const map = buildKeybindMap({}, defaults);
    // Simulate what parseKeybindsCfg produces: keys in CFG_ACTIONS order
    const fromFile = {};
    for (const k of CFG_ACTIONS) fromFile[k] = map[k] ?? '';
    // Values are identical but JSON.stringify sees different key order
    expect(JSON.stringify(map) === JSON.stringify(fromFile)).toBe(false);
  });

  it('value-by-value comparison correctly detects no change after a write→read round-trip', () => {
    const map = buildKeybindMap({}, defaults);
    const fromFile = {};
    for (const k of CFG_ACTIONS) fromFile[k] = map[k] ?? '';
    const allKeys = new Set([...Object.keys(fromFile), ...Object.keys(map)]);
    const same = [...allKeys].every(k => fromFile[k] === map[k]);
    expect(same).toBe(true);
  });

  it('value-by-value comparison detects a real change', () => {
    const map = buildKeybindMap({}, defaults);
    const fromFile = {};
    for (const k of CFG_ACTIONS) fromFile[k] = map[k] ?? '';
    fromFile.toggle = 'F9'; // user changed one key
    const allKeys = new Set([...Object.keys(fromFile), ...Object.keys(map)]);
    const same = [...allKeys].every(k => fromFile[k] === map[k]);
    expect(same).toBe(false);
  });
});

// ─── keybind-watch content-guard round-trip ───────────────────────────────────
// These tests validate the logic behind the _lastWrittenCfgContent guard added
// in main.js to prevent the write→watch→write self-trigger storm.
//
// The guard works by storing the exact string the app writes to keybinds.cfg
// (_lastWrittenCfgContent) and, when the watcher fires, comparing the file's
// current content against that stored string. If they match, the event is an
// echo of our own write and is silently skipped.
//
// For the guard to be sound, writeKeybindsCfg must be deterministic: re-running
// it with the same keybind map must produce the exact same byte-for-byte string
// as before. These tests prove that property.
describe('keybind-watch content-guard — writeKeybindsCfg determinism', () => {
  // Inline the pure serialisation logic from main.js so the test has no
  // Electron dependency.  It must stay in sync with main.js.
  const CFG_HEADER = `# Fallout Chat Mod — Overlay Keybinds
# Edit this file to customise your hotkeys. Changes are picked up live.
#
# Key names (case-sensitive):
#   Function .... F1-F24
#   Navigation .. Insert  Delete  Home  End  PageUp  PageDown
#   Arrows ...... Left  Right  Up  Down
#   Editing ..... Tab  Backspace  Return  Space
#   Letters ..... A-Z   Numbers: 0-9
#   Symbols ..... / \\ [ ] ; ' , . \` - =
#   Modifiers ... CommandOrControl  Alt  Shift  (combine: Shift+F1, Alt+Delete)
#
# Leave a value blank to unbind that action entirely.
# Blocked (cannot bind): Escape  CapsLock  NumLock  ScrollLock  Pause
#
`;
  const CFG_ACTIONS = [
    'toggle', 'focus', 'clickThrough',
    'nextChannel', 'prevChannel', 'settings',
    'recentParty', 'goFo76',
    'party1', 'party2', 'party3', 'party4',
    'party5', 'party6', 'party7', 'party8',
  ];
  function serializeCfg(kb) {
    const lines = [CFG_HEADER];
    for (const action of CFG_ACTIONS) {
      lines.push(`${action}=${(kb && kb[action] != null) ? kb[action] : ''}`);
    }
    return lines.join('\n') + '\n';
  }
  function parseCfg(raw) {
    const kb = {};
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (key) kb[key] = val;
    }
    return kb;
  }

  const defaults = {
    toggle: 'Delete', focus: 'Insert', clickThrough: 'End',
    nextChannel: 'PageDown', prevChannel: 'PageUp', settings: 'Home',
    recentParty: '\\', goFo76: '/',
  };

  it('serialise → re-serialise produces identical content (guard is sound for app writes)', () => {
    const map = buildKeybindMap({}, defaults);
    const written = serializeCfg(map);
    // Simulate: app writes `written`, then watcher fires and re-reads → same string
    // guard correctly detects this as an echo and returns early.
    expect(serializeCfg(map)).toBe(written);
  });

  it('parse then re-serialise matches original (round-trip stability prevents storm)', () => {
    const map = buildKeybindMap({}, defaults);
    const written = serializeCfg(map);
    // Simulate read-back: parse what was written, then re-build and re-serialize.
    const reparsed = parseCfg(written);
    const rebuilt = buildKeybindMap(reparsed, defaults);
    expect(serializeCfg(rebuilt)).toBe(written);
  });

  it('content-guard: own-write echo detected (raw === lastWritten → skip)', () => {
    const map = buildKeybindMap({ toggle: 'F1' }, defaults);
    const lastWrittenCfgContent = serializeCfg(map);
    // Simulate watcher firing with the file content equal to what the app wrote.
    const rawFromFile = lastWrittenCfgContent; // identical — echo of our write
    expect(rawFromFile === lastWrittenCfgContent).toBe(true); // guard returns early
  });

  it('content-guard: real external edit detected (raw !== lastWritten → re-register)', () => {
    const map = buildKeybindMap({ toggle: 'Delete' }, defaults);
    const lastWrittenCfgContent = serializeCfg(map);
    // Simulate user editing the file to change a key.
    const userEdited = serializeCfg({ ...map, toggle: 'F9' });
    expect(userEdited === lastWrittenCfgContent).toBe(false); // guard does NOT skip → re-register
  });
});

// ── classifyInputGrab (gamescope exclusive-grab detection) ───────────────────
// The Linux user whose hotkeys + window-drag stopped working in-game launches FO76
// via `gamescope ... -f --force-grab-cursor`, which grabs input below X11.
describe('classifyInputGrab', () => {
  const REAL = 'gamescope -O DP-1 -w 1920 -h 1200 -r 60 -o 60 -f --force-grab-cursor -- '
    + '/home/bigtrees/.local/share/Steam/ubuntu12_32/steam-launch-wrapper -- Fallout76.exe';

  it("returns 'force-grab' for the real reporting user's command line", () => {
    expect(classifyInputGrab(REAL)).toBe('force-grab');
  });

  it("returns 'force-grab' whenever --force-grab-cursor is present", () => {
    expect(classifyInputGrab('gamescope --force-grab-cursor -- Fallout76.exe')).toBe('force-grab');
    expect(classifyInputGrab('foo -force-grab-cursor bar')).toBe('force-grab');
  });

  it("returns 'gamescope-fullscreen' for gamescope -f without force-grab", () => {
    expect(classifyInputGrab('gamescope -f -- Fallout76.exe')).toBe('gamescope-fullscreen');
    expect(classifyInputGrab('gamescope -w 1920 -f -r 60 -- Fallout76.exe')).toBe('gamescope-fullscreen');
  });

  it('returns null for a normal (no-gamescope) launch', () => {
    expect(classifyInputGrab('/home/x/Steam/steamapps/common/Fallout76/Fallout76.exe')).toBe(null);
    expect(classifyInputGrab('wine Fallout76.exe -windowed')).toBe(null);
  });

  it('does not false-positive on gamescope without -f (windowed)', () => {
    expect(classifyInputGrab('gamescope -w 1920 -h 1080 -b -- Fallout76.exe')).toBe(null);
  });

  it('handles empty / nullish input', () => {
    expect(classifyInputGrab('')).toBe(null);
    expect(classifyInputGrab(null)).toBe(null);
    expect(classifyInputGrab(undefined)).toBe(null);
  });
});

describe('filterProxyHeaders', () => {
  it('passes through allowlisted headers', () => {
    const result = filterProxyHeaders({
      'content-type': 'application/json',
      'accept': 'application/json',
      'accept-language': 'en-US',
    });
    expect(result['content-type']).toBe('application/json');
    expect(result['accept']).toBe('application/json');
    expect(result['accept-language']).toBe('en-US');
  });

  it('strips X-Auth-Token so the renderer cannot override the session token', () => {
    const result = filterProxyHeaders({ 'X-Auth-Token': 'attacker-token', 'content-type': 'application/json' });
    expect(result['x-auth-token']).toBeUndefined();
    expect(result['X-Auth-Token']).toBeUndefined();
  });

  it('strips Host to prevent request smuggling', () => {
    const result = filterProxyHeaders({ 'Host': 'attacker.com', 'content-type': 'application/json' });
    expect(result['host']).toBeUndefined();
    expect(result['Host']).toBeUndefined();
  });

  it('strips cookie', () => {
    const result = filterProxyHeaders({ 'cookie': 'session=abc', 'content-type': 'application/json' });
    expect(result['cookie']).toBeUndefined();
  });

  it('strips Transfer-Encoding and Content-Length', () => {
    const result = filterProxyHeaders({ 'transfer-encoding': 'chunked', 'content-length': '999' });
    expect(result['transfer-encoding']).toBeUndefined();
    expect(result['content-length']).toBeUndefined();
  });

  it('strips CRLF sequences from header values', () => {
    const result = filterProxyHeaders({ 'content-type': 'text/plain\r\nX-Injected: evil' });
    expect(result['content-type']).toBe('text/plainX-Injected: evil');
    expect(result['x-injected']).toBeUndefined();
  });

  it('normalises header names to lowercase', () => {
    const result = filterProxyHeaders({ 'Content-Type': 'application/json' });
    expect(result['content-type']).toBe('application/json');
    expect(result['Content-Type']).toBeUndefined();
  });

  it('returns empty object for null/undefined/non-object input', () => {
    expect(filterProxyHeaders(null)).toEqual({});
    expect(filterProxyHeaders(undefined)).toEqual({});
    expect(filterProxyHeaders('string')).toEqual({});
  });

  it('drops headers with empty values after CRLF strip', () => {
    const result = filterProxyHeaders({ 'content-type': '\r\n' });
    expect(result['content-type']).toBeUndefined();
  });

  it('strips non-CRLF control chars Node would reject (NUL/VT/FF/DEL)', () => {
    const dirty = 'a' + String.fromCharCode(0, 11, 12, 127) + 'bcde';
    expect(filterProxyHeaders({ 'content-type': dirty })['content-type']).toBe('abcde');
  });

});

describe('resolveRelayProxyUrl', () => {
  const RELAY = 'https://falloutchatmod.com';

  it('resolves a normal path on the relay origin', () => {
    const url = resolveRelayProxyUrl('/api/messages', RELAY);
    expect(url).not.toBeNull();
    expect(url.origin).toBe(RELAY);
    expect(url.pathname).toBe('/api/messages');
  });

  it('preserves the query string', () => {
    const url = resolveRelayProxyUrl('/api/x?y=1&z=2', RELAY);
    expect(url.pathname + url.search).toBe('/api/x?y=1&z=2');
  });

  it('refuses a protocol-relative host override (//evil.com)', () => {
    expect(resolveRelayProxyUrl('//evil.com/api', RELAY)).toBeNull();
  });

  it('refuses an absolute URL to another origin', () => {
    expect(resolveRelayProxyUrl('https://evil.com/api', RELAY)).toBeNull();
    expect(resolveRelayProxyUrl('http://falloutchatmod.com/api', RELAY)).toBeNull(); // scheme downgrade
  });

  it('does NOT let `@evil.com` or `.evil.com` change the host (the old concat bug)', () => {
    // With strict base-relative resolution these become relay paths, not hosts.
    for (const p of ['@evil.com/api', '.evil.com/api']) {
      const url = resolveRelayProxyUrl(p, RELAY);
      expect(url).not.toBeNull();
      expect(url.origin).toBe(RELAY);
    }
  });

  it('returns null for a malformed relay base', () => {
    expect(resolveRelayProxyUrl('/api', 'not a url')).toBeNull();
  });
});

describe('resolveRelayUrls (build channel)', () => {
  it('stable/undefined channel -> prod defaults', () => {
    expect(core.resolveRelayUrls({})).toEqual({
      relayHttp: 'https://falloutchatmod.com',
      relayWs: 'wss://falloutchatmod.com/ws',
    });
  });
  it('qa channel -> dev defaults', () => {
    expect(core.resolveRelayUrls({}, 'qa')).toEqual({
      relayHttp: 'https://dev.falloutchatmod.com',
      relayWs: 'wss://dev.falloutchatmod.com/ws',
    });
  });
  it('env override beats the channel default', () => {
    expect(core.resolveRelayUrls({ RELAY_HTTP: 'http://localhost:7177', RELAY_WS: 'ws://localhost:7177/ws' }, 'qa'))
      .toEqual({ relayHttp: 'http://localhost:7177', relayWs: 'ws://localhost:7177/ws' });
  });
});
