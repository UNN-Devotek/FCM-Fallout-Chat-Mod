import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const main = readFileSync(join(ROOT, 'main.js'), 'utf8');

describe('overlay transmits X-Client-Version', () => {
  it('sets X-Client-Version on the relay WebSocket', () => {
    // The WS headers block (openRelaySocket) must include the version header.
    const wsBlock = main.slice(main.indexOf('function openRelaySocket'), main.indexOf('function flushPendingWsOpens'));
    expect(wsBlock).toMatch(/'X-Client-Version':\s*APP_VERSION/);
  });
  it('sets X-Client-Version on proxied relay HTTP requests', () => {
    expect(main).toMatch(/outHeaders\['X-Client-Version'\]\s*=\s*APP_VERSION/);
  });

  it('times out a stalled proxied request so an Appearance save cannot stay busy forever', () => {
    const proxyBlock = main.slice(
      main.indexOf("ipcMain.handle('proxy:http'"),
      main.indexOf('// ─── WebSocket proxy'),
    );
    expect(proxyBlock).toMatch(/req\.setTimeout\(\s*15_000/);
    expect(proxyBlock).toMatch(/req\.destroy\(/);
  });
});
