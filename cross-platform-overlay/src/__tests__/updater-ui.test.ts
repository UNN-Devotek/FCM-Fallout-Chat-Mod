// @vitest-environment jsdom
//
// P1 tests for updater-ui.ts — the informational banner state machine driven by
// updater:result / updater:status events, plus the "Check for updates" footer
// button. Mirrors the Group 2 "updater-ui banner state machine" /
// "mountCheckForUpdatesButton" rows in docs/testing/overlay-test-plan.md.
//
// updater-ui.ts keeps module-level singletons (bannerEl/checkBtnEl/checkStatusEl)
// and injects a <style> tag in an import-time IIFE. To get a clean slate per test
// we reset the DOM, stub a fresh window.relayBridge, then `vi.resetModules()` and
// re-import the module dynamically so the singletons start null again.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UpdaterResult, UpdaterStatus } from '../bridge';

type ResultCb = (r: UpdaterResult) => void;
type StatusCb = (s: UpdaterStatus) => void;

interface FakeBridge {
  _resultCb: ResultCb | null;
  _statusCb: StatusCb | null;
  _lastResult: UpdaterResult | null;
  onUpdaterResult: ReturnType<typeof vi.fn>;
  onUpdaterStatus: ReturnType<typeof vi.fn>;
  getUpdaterLastResult: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  installUpdate: ReturnType<typeof vi.fn>;
}

function makeBridge(lastResult: UpdaterResult | null = null): FakeBridge {
  const b: FakeBridge = {
    _resultCb: null,
    _statusCb: null,
    _lastResult: lastResult,
    onUpdaterResult: vi.fn((cb: ResultCb) => { b._resultCb = cb; }),
    onUpdaterStatus: vi.fn((cb: StatusCb) => { b._statusCb = cb; }),
    getUpdaterLastResult: vi.fn(() => Promise.resolve(b._lastResult)),
    checkForUpdates: vi.fn(() => Promise.resolve({ available: false } as UpdaterResult)),
    installUpdate: vi.fn(),
  };
  return b;
}

let bridge: FakeBridge;

// Fresh document + bridge + module per test.
async function setup(lastResult: UpdaterResult | null = null) {
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="root"><div id="shell-bar"></div></div>';
  bridge = makeBridge(lastResult);
  (window as unknown as { relayBridge: FakeBridge }).relayBridge = bridge;
  vi.resetModules();
  return import('../updater-ui');
}

const banner = () => document.getElementById('shell-update-banner');
const bannerMsg = () => banner()?.querySelector('.upd-msg')?.textContent ?? null;
const bannerVer = () => banner()?.querySelector('.upd-version')?.textContent ?? null;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('initUpdaterUI — banner state machine', () => {
  it('registers all three bridge listeners', async () => {
    const mod = await setup();
    mod.initUpdaterUI();
    expect(bridge.onUpdaterResult).toHaveBeenCalledTimes(1);
    expect(bridge.onUpdaterStatus).toHaveBeenCalledTimes(1);
    expect(bridge.getUpdaterLastResult).toHaveBeenCalledTimes(1);
  });

  it('available result shows a single banner inserted before #shell-bar', async () => {
    const mod = await setup();
    mod.initUpdaterUI();
    bridge._resultCb!({ available: true, version: '2.0.0' });

    const el = banner();
    expect(el).not.toBeNull();
    expect(bannerVer()).toBe('v2.0.0');
    expect(bannerMsg()).toContain('downloading update');
    // Inserted before the shell bar.
    expect(el!.nextElementSibling?.id).toBe('shell-bar');
  });

  it('not-available result does not create a banner', async () => {
    const mod = await setup();
    mod.initUpdaterUI();
    bridge._resultCb!({ available: false });
    expect(banner()).toBeNull();
  });

  it('repeated results update the existing banner in place (never stack)', async () => {
    const mod = await setup();
    mod.initUpdaterUI();
    bridge._resultCb!({ available: true, version: '2.0.0' });
    bridge._resultCb!({ available: true, version: '2.1.0' });

    expect(document.querySelectorAll('.upd-banner')).toHaveLength(1);
    expect(bannerVer()).toBe('v2.1.0');
  });

  it('status: downloading then progress updates the message percent', async () => {
    const mod = await setup();
    mod.initUpdaterUI();
    bridge._statusCb!({ phase: 'downloading', version: '2.0.0' });
    expect(bannerMsg()).toContain('downloading update');

    bridge._statusCb!({ phase: 'progress', percent: 55 });
    expect(bannerMsg()).toContain('55%');
  });

  it('status: restart shows countdown then auto-removes the banner just before restart', async () => {
    vi.useFakeTimers();
    const mod = await setup();
    mod.initUpdaterUI();
    bridge._statusCb!({ phase: 'restart', version: '3.0.0', delayMs: 5000 });

    expect(bannerVer()).toBe('v3.0.0');
    expect(bannerMsg()).toContain('Restarting in 5s');
    expect(banner()).not.toBeNull();

    // Auto-remove is scheduled at delayMs - 500 = 4500ms.
    vi.advanceTimersByTime(4499);
    expect(banner()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(banner()).toBeNull();
  });

  it('restores a pending banner from getUpdaterLastResult on load', async () => {
    const mod = await setup({ available: true, version: '4.2.0' });
    mod.initUpdaterUI();
    // getUpdaterLastResult resolves async — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(banner()).not.toBeNull();
    expect(bannerVer()).toBe('v4.2.0');
    expect(bannerMsg()).toContain('install on restart');
  });

  it('dev fallback: result with downloadUrl renders an Open-download button wired to installUpdate', async () => {
    const mod = await setup();
    mod.initUpdaterUI();
    bridge._resultCb!({ available: true, version: '2.0.0', downloadUrl: 'http://dl/page' });

    const btn = banner()!.querySelector<HTMLButtonElement>('.upd-btn-install');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(bridge.installUpdate).toHaveBeenCalledWith('http://dl/page');
    // Clicking removes the banner.
    expect(banner()).toBeNull();
  });
});

describe('mountCheckForUpdatesButton + showCheckResult', () => {
  function footer(): HTMLElement {
    const f = document.createElement('div');
    f.className = 'ss-footer';
    const reset = document.createElement('button');
    reset.className = 'ss-fbtn';
    reset.textContent = 'RESET DEFAULTS';
    f.appendChild(reset);
    document.body.appendChild(f);
    return f;
  }

  it('mounts the button + status line before RESET DEFAULTS, and is idempotent', async () => {
    const mod = await setup();
    const f = footer();
    mod.mountCheckForUpdatesButton(f);
    mod.mountCheckForUpdatesButton(f); // second call no-ops

    const btns = f.querySelectorAll('button');
    // RESET + the one CHECK button (not two).
    expect([...btns].filter((b) => b.textContent === 'CHECK FOR UPDATES')).toHaveLength(1);
    expect(f.querySelector('.ss-update-status')).not.toBeNull();
  });

  it('available result: shows checking state, then "Update available" + opens banner', async () => {
    const mod = await setup();
    bridge.checkForUpdates.mockResolvedValue({ available: true, version: '9.0.0' });
    const f = footer();
    mod.mountCheckForUpdatesButton(f);

    const btn = [...f.querySelectorAll('button')].find((b) => b.textContent === 'CHECK FOR UPDATES')!;
    btn.click();
    // Synchronously inside the handler the label flips to "Checking…".
    expect(btn.textContent).toBe('Checking…');
    expect(btn.getAttribute('disabled')).toBe('true');

    await Promise.resolve();
    await Promise.resolve();

    const status = f.querySelector('.ss-update-status')!;
    expect(status.textContent).toContain('Update available: v9.0.0');
    // Banner opened.
    expect(banner()).not.toBeNull();
    // Button restored.
    expect(btn.textContent).toBe('CHECK FOR UPDATES');
    expect(btn.hasAttribute('disabled')).toBe(false);
  });

  it('up-to-date result: status reads "Up to date", no banner', async () => {
    const mod = await setup();
    bridge.checkForUpdates.mockResolvedValue({ available: false });
    const f = footer();
    mod.mountCheckForUpdatesButton(f);

    [...f.querySelectorAll('button')].find((b) => b.textContent === 'CHECK FOR UPDATES')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(f.querySelector('.ss-update-status')!.textContent).toBe('Up to date');
    expect(banner()).toBeNull();
  });

  it('check failure: status reads "Check failed", button restored', async () => {
    const mod = await setup();
    bridge.checkForUpdates.mockRejectedValue(new Error('network'));
    const f = footer();
    mod.mountCheckForUpdatesButton(f);

    const btn = [...f.querySelectorAll('button')].find((b) => b.textContent === 'CHECK FOR UPDATES')!;
    btn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(f.querySelector('.ss-update-status')!.textContent).toContain('Check failed');
    expect(btn.textContent).toBe('CHECK FOR UPDATES');
  });
});
