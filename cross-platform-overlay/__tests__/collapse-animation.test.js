import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { afterHideTransition } from '../src/hide-transition';

const source = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
function harness() {
  let bounds = { x: 20, y: 30, width: 520, height: 500 };
  let min = 280, max = 100000;
  const frames = [];
  const context = vm.createContext({
    Date, setInterval, clearInterval, diag() {}, movingActive: false,
    collapsed: false, collapseAnim: null, collapseAnimTarget: null,
    expandedBounds: null, expandedHeight: 500,
    MIN_WIDTH: 300, MIN_HEIGHT: 280, DEFAULT_HEIGHT: 500, FULL_AUTO_HIDE_HEIGHT: 1,
    dispatchFocusInput() {},
    mainWindow: {
      isDestroyed: () => false, isFocused: () => false, focus() {},
      getBounds: () => ({ ...bounds }),
      setMinimumSize: (_w, h) => { min = h; bounds.height = Math.max(min, bounds.height); },
      setMaximumSize: (_w, h) => { max = h; bounds.height = Math.min(max, bounds.height); },
    },
    setWindowBoundsGuarded: b => { bounds = { ...b, height: Math.max(min, Math.min(max, b.height)) }; frames.push(bounds.height); },
  });
  vm.runInContext(source.slice(source.indexOf('function animateHeightTo('), source.indexOf('// ─── Tray menu rebuild')), context);
  return { call: code => vm.runInContext(code, context), bounds: () => bounds, frames };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('native collapse animation', () => {
  it('waits for the actual hide transition when painting starts after the old deadline', async () => {
    vi.useFakeTimers();
    let paint;
    vi.stubGlobal('requestAnimationFrame', callback => { paint = callback; return 1; });
    let finishTransition;
    const finished = new Promise(resolve => { finishTransition = resolve; });
    const body = { getAnimations: () => [
      { transitionProperty: 'clip-path', finished },
      { transitionProperty: 'opacity', finished: new Promise(() => {}) },
      { finished: new Promise(() => {}) }, // Decorative animations must not block hiding.
    ] };
    const finish = vi.fn();
    afterHideTransition(body, 'clip-path', finish);
    await vi.advanceTimersByTimeAsync(500);
    expect(finish).not.toHaveBeenCalled();
    paint();
    await vi.advanceTimersByTimeAsync(1000);
    expect(finish).not.toHaveBeenCalled();
    finishTransition();
    await vi.advanceTimersByTimeAsync(0);
    expect(finish).toHaveBeenCalledOnce();
  });
  it.each([false, true])('cancels an obsolete hide (transition observed: %s)', async observed => {
    vi.useFakeTimers();
    let paint;
    vi.stubGlobal('requestAnimationFrame', callback => { paint = callback; return 7; });
    const cancelFrame = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    let finishTransition;
    let cancelTransition;
    const finished = new Promise((resolve, reject) => { finishTransition = resolve; cancelTransition = reject; });
    const body = { getAnimations: vi.fn(() => [{ transitionProperty: 'opacity', finished }]) };
    const finish = vi.fn();
    const cancel = afterHideTransition(body, 'opacity', finish);
    if (observed) paint();
    cancel();
    if (observed) cancelTransition(new Error('CSS transition reversed by wake'));
    else finishTransition();
    await vi.advanceTimersByTimeAsync(0);
    expect(finish).not.toHaveBeenCalled();
    if (!observed) {
      expect(cancelFrame).toHaveBeenCalledWith(7);
      expect(body.getAnimations).not.toHaveBeenCalled();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('completes without a deadline when no transition is generated', async () => {
    vi.stubGlobal('requestAnimationFrame', callback => { queueMicrotask(callback); return 1; });
    const finish = vi.fn();
    afterHideTransition({ getAnimations: () => [] }, 'opacity', finish);
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
  });
  it.each([47, 1])('does not snap to final height %s before animating', target => {
    vi.useFakeTimers();
    const h = harness();
    h.call(`collapseToHeader(${target}, ${target === 1})`);
    expect(h.bounds().height).toBe(500);
    vi.advanceTimersByTime(96);
    expect(h.bounds().height).toBeGreaterThan(target);
    expect(h.bounds().height).toBeLessThan(500);
    vi.advanceTimersByTime(200);
    expect(h.bounds().height).toBe(target);
    h.call('expandFromHeader(false)');
    expect(h.bounds().height).toBe(target);
    vi.advanceTimersByTime(300);
    expect(h.bounds()).toEqual({ x: 20, y: 30, width: 520, height: 500 });
  });
  it('cancels an interrupted collapse without pinning the expanded window', () => {
    vi.useFakeTimers();
    const h = harness();
    h.call('collapseToHeader(47)');
    vi.advanceTimersByTime(60);
    h.call('expandFromHeader(false)');
    vi.advanceTimersByTime(300);
    expect(h.bounds().height).toBe(500);
    expect(vi.getTimerCount()).toBe(0);
  });
});
