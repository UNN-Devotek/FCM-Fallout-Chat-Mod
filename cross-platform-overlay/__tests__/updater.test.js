// P1 unit tests for updater.js — the electron-updater event -> IPC/quitAndInstall
// mapping. Mirrors the Group 1 "Updater event->IPC mapping" row in
// docs/testing/overlay-test-plan.md.
//
// updater.js captures autoUpdater at module load time. Rather than reloading the
// module per test (which requires deprecated vi.isolateModules), we pass a fake
// autoUpdater via the `_autoUpdater` constructor option that replaces the
// module-level variable. null simulates electron-updater being unavailable.
//
// describe, it, expect, vi, beforeEach, afterEach are Vitest globals (globals:true).

import { EventEmitter } from 'events';
import updaterModule from '../updater.js';

const { Updater } = updaterModule;

// RESTART_DELAY_MS is a module-local const in updater.js (not exported). Keep in
// sync with updater.js:51.
const RESTART_DELAY_MS = 5000;

// Build a fresh fake autoUpdater (EventEmitter) for each test.
function makeFakeAutoUpdater() {
  const au = new EventEmitter();
  au.autoDownload = undefined;
  au.autoInstallOnAppQuit = undefined;
  au.logger = undefined;
  au.checkForUpdates = vi.fn().mockResolvedValue({ updateInfo: {} });
  au.quitAndInstall = vi.fn();
  return au;
}

function makeOpts(au) {
  return {
    appVersion: '1.0.0',
    relayHttp: 'https://relay.test',
    sendToRenderer: vi.fn(),
    openExternal: vi.fn(),
    _autoUpdater: au,   // injected — overrides the module-level autoUpdater
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Updater — configure + event -> IPC mapping', () => {
  let au;
  let opts;
  let updater;

  beforeEach(() => {
    au = makeFakeAutoUpdater();
    opts = makeOpts(au);
    updater = new Updater(opts);
    vi.useFakeTimers();
    updater.start();
  });

  it('sets autoDownload + autoInstallOnAppQuit + disables logger on configure', () => {
    expect(au.autoDownload).toBe(true);
    expect(au.autoInstallOnAppQuit).toBe(true);
    expect(au.logger).toBeNull();
  });

  it('checking-for-update produces no IPC payload', () => {
    au.emit('checking-for-update');
    expect(opts.sendToRenderer).not.toHaveBeenCalled();
  });

  it('update-available -> result + downloading status payloads', () => {
    au.emit('update-available', { version: '2.3.4', releaseNotes: 'notes' });

    expect(opts.sendToRenderer).toHaveBeenCalledWith('updater:result', {
      available: true,
      version: '2.3.4',
      releaseNotes: 'notes',
    });
    expect(opts.sendToRenderer).toHaveBeenCalledWith('updater:status', {
      phase: 'downloading',
      version: '2.3.4',
    });
    expect(updater.getLastResult()).toEqual({
      available: true,
      version: '2.3.4',
      releaseNotes: 'notes',
    });
  });

  it('update-available defaults releaseNotes to empty string when absent', () => {
    au.emit('update-available', { version: '2.3.4' });
    expect(opts.sendToRenderer).toHaveBeenCalledWith('updater:result', {
      available: true,
      version: '2.3.4',
      releaseNotes: '',
    });
  });

  it('update-not-available -> single not-available result', () => {
    au.emit('update-not-available');
    expect(opts.sendToRenderer).toHaveBeenCalledTimes(1);
    expect(opts.sendToRenderer).toHaveBeenCalledWith('updater:result', {
      available: false,
    });
    expect(updater.getLastResult()).toEqual({ available: false });
  });

  it('download-progress -> rounded percent status payload', () => {
    au.emit('download-progress', { percent: 42.7 });
    expect(opts.sendToRenderer).toHaveBeenCalledWith('updater:status', {
      phase: 'progress',
      percent: 43,
    });
  });

  it('update-downloaded -> result + restart status, then quitAndInstall after RESTART_DELAY_MS', () => {
    au.emit('update-downloaded', { version: '2.3.4', releaseNotes: 'rn' });

    expect(opts.sendToRenderer).toHaveBeenCalledWith('updater:result', {
      available: true,
      version: '2.3.4',
      releaseNotes: 'rn',
    });
    expect(opts.sendToRenderer).toHaveBeenCalledWith('updater:status', {
      phase: 'restart',
      version: '2.3.4',
      delayMs: RESTART_DELAY_MS,
    });

    expect(au.quitAndInstall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(RESTART_DELAY_MS - 1);
    expect(au.quitAndInstall).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(au.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(au.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('update-downloaded swallows a quitAndInstall throw (logs, no crash)', () => {
    au.quitAndInstall.mockImplementation(() => { throw new Error('install boom'); });
    au.emit('update-downloaded', { version: '9.9.9' });
    expect(() => vi.advanceTimersByTime(RESTART_DELAY_MS)).not.toThrow();
    expect(au.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('error event surfaces nothing to the renderer (no IPC)', () => {
    au.emit('error', new Error('network blip'));
    expect(opts.sendToRenderer).not.toHaveBeenCalled();
  });
});

describe('Updater — check / safeCheck behaviour', () => {
  let au;
  let opts;
  let updater;

  beforeEach(() => {
    au = makeFakeAutoUpdater();
    opts = makeOpts(au);
    updater = new Updater(opts);
    vi.useFakeTimers();
    updater.start();
  });

  afterEach(() => {
    updater.stop();
  });

  it('check() calls autoUpdater.checkForUpdates and returns last result', async () => {
    au.checkForUpdates.mockImplementation(async () => {
      au.emit('update-available', { version: '5.0.0' });
      return {};
    });
    const result = await updater.check();
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ available: true, version: '5.0.0', releaseNotes: '' });
  });

  it('check() returns {available:false} when no result was recorded', async () => {
    const result = await updater.check();
    expect(result).toEqual({ available: false });
  });

  it('dev/unpackaged throw is swallowed -> {available:false}', async () => {
    au.checkForUpdates.mockRejectedValue(new Error('Dev mode: skip checking for updates'));
    expect(await updater.check()).toEqual({ available: false });
  });

  it('non-dev checkForUpdates error is swallowed -> {available:false}', async () => {
    au.checkForUpdates.mockRejectedValue(new Error('ECONNREFUSED relay down'));
    expect(await updater.check()).toEqual({ available: false });
  });

  it('onRelasePublished triggers a check', async () => {
    updater.onRelasePublished();
    await Promise.resolve();
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('notifyFakeUpdate sends a synthetic available result to the renderer', () => {
    updater.notifyFakeUpdate({ version: '7.7.7', downloadUrl: 'http://dl' });
    expect(opts.sendToRenderer).toHaveBeenCalledWith('updater:result', {
      available: true,
      version: '7.7.7',
      downloadUrl: 'http://dl',
    });
    expect(updater.getLastResult()).toEqual({
      available: true,
      version: '7.7.7',
      downloadUrl: 'http://dl',
    });
  });

  it('stop() clears the periodic interval (no throw, idempotent)', () => {
    expect(() => updater.stop()).not.toThrow();
    expect(() => updater.stop()).not.toThrow();
  });
});

describe('Updater — require-failure / dev-guard no-op path (autoUpdater === null)', () => {
  let opts;
  let updater;

  beforeEach(() => {
    opts = makeOpts(null);  // null simulates electron-updater unavailable
    updater = new Updater(opts);
  });

  it('start() is a no-op (no configure, no timers, no renderer traffic)', () => {
    expect(() => updater.start()).not.toThrow();
    expect(opts.sendToRenderer).not.toHaveBeenCalled();
  });

  it('check()/_safeCheck returns {available:false} without throwing', async () => {
    expect(await updater.check()).toEqual({ available: false });
    expect(opts.sendToRenderer).not.toHaveBeenCalled();
  });

  it('onRelasePublished is a safe no-op', async () => {
    expect(() => updater.onRelasePublished()).not.toThrow();
    await Promise.resolve();
    expect(opts.sendToRenderer).not.toHaveBeenCalled();
  });
});
