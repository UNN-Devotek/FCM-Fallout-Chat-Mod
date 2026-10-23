import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const main = readFileSync(join(ROOT, 'main.js'), 'utf8');

function qaLoginHarness() {
  const requests = [];
  const statuses = [];
  const state = { installToken: 'test-install' };
  const context = vm.createContext({
    URL, setTimeout, clearTimeout,
    RELAY_HTTP: 'https://dev.falloutchatmod.com', APP_VERSION: '1.4.3', authGeneration: 0,
    loadState: () => state,
    saveState: patch => Object.assign(state, patch),
    shell: { openExternal: () => Promise.resolve() },
    httpModule: () => ({ request(_options, callback) {
      const request = new EventEmitter();
      Object.assign(request, { setTimeout() {}, end() {}, destroy() {} });
      requests.push({ request, callback });
      return request;
    } }),
    sendToRenderer: (event, payload) => { if (event === 'relay:status') statuses.push(payload); },
    setSessionToken: vi.fn(), flushPendingWsOpens() {}, rebuildTray() {}, diag() {}, showUpdateNotification() {},
    ipcMain: { handle() {} },
  });
  const start = main.indexOf('// ─── QA login (golden dev build)');
  const end = main.indexOf('// Discord link/supporter-role status refresh:', start);
  vm.runInContext(main.slice(start, end), context);
  return {
    requests, statuses, context,
    login: () => vm.runInContext('startQaLogin()', context),
    respond(index, body, statusCode = 200) {
      const response = new EventEmitter();
      Object.assign(response, { statusCode, headers: {}, resume() {} });
      requests[index].callback(response);
      response.emit('data', JSON.stringify({ data: body }));
      response.emit('end');
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('QA login session handoff', () => {
  it('does not let an older pending poll time out after a newer login succeeds', async () => {
    vi.useFakeTimers();
    const login = qaLoginHarness();
    login.login();
    login.respond(0, { authorized: false });
    login.login();
    login.respond(1, { authorized: true, token: 'session', role: 'user' });
    const signedInRequests = login.requests.length;
    for (let i = 0; i < 201; i++) {
      await vi.advanceTimersByTimeAsync(1500);
      if (login.requests.length > signedInRequests) login.respond(login.requests.length - 1, { authorized: false });
    }
    expect(login.statuses.at(-1)?.state).toBe('authenticated');
    expect(login.requests).toHaveLength(signedInRequests);
    expect(login.context.setSessionToken).toHaveBeenCalledExactlyOnceWith('session');
  });

  it('ignores a late failure from the poll superseded by a new login', () => {
    const login = qaLoginHarness();
    login.login();
    login.login();
    login.respond(1, { authorized: true, token: 'session' });
    login.respond(0, {}, 426);
    expect(login.statuses.at(-1)?.state).toBe('authenticated');
  });

  it('does not restore a session after the user has logged out', () => {
    const login = qaLoginHarness();
    login.login();
    login.context.authGeneration += 1;
    login.respond(0, { authorized: true, token: 'old-session' });
    expect(login.context.setSessionToken).not.toHaveBeenCalled();
  });
});

describe('overlay QA login flow', () => {
  it('opens the QA OAuth start URL', () => {
    expect(main).toMatch(/\/auth\/discord\/qa\/start\?installToken=/);
  });
  it('polls the qa-status endpoint with the client version header', () => {
    expect(main).toMatch(/\/api\/auth\/qa-status\//);
    const pollRegion = main.slice(main.indexOf('qa-status/'), main.indexOf('qa-status/') + 800);
    expect(pollRegion).toMatch(/X-Client-Version/);
  });
  it('handles a 426 outdated-build response from the poll', () => {
    expect(main).toMatch(/426/);
  });
  it('auto-starts QA login on the qa channel', () => {
    expect(main).toMatch(/BUILD_CHANNEL === 'qa' && !IS_PORTABLE/);
  });
  it('portable QA restores its linked install identity before requiring OAuth', () => {
    const fallback = main.slice(main.indexOf("if (BUILD_CHANNEL === 'qa' && IS_PORTABLE"), main.indexOf("if (BUILD_CHANNEL === 'qa' && IS_PORTABLE") + 300);
    expect(fallback).toMatch(/startQaLogin\(\);/);
    expect(main).toMatch(/BUILD_CHANNEL === 'qa' && !IS_PORTABLE/);
  });
  it('starts the normal token-registration path for portable QA on startup', () => {
    const startup = main.slice(main.indexOf("if (BUILD_CHANNEL === 'qa' && !IS_PORTABLE"), main.indexOf("if (BUILD_CHANNEL === 'qa' && !IS_PORTABLE") + 180);
    expect(startup).toMatch(/else \{\s*startRelay\(\);/);
  });
  it('registers an overlay:qa-login IPC handler', () => {
    expect(main).toMatch(/ipcMain\.(on|handle)\('overlay:qa-login'/);
  });
});
