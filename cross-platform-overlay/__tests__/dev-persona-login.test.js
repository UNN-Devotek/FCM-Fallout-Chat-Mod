// Guard tests for the DevAccount login safety and transport contract.

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const mainSource = readFileSync(join(ROOT, 'main.js'), 'utf8');
const handlerStart = mainSource.indexOf("ipcMain.handle('overlay:dev-login-as'");
const handlerSource = mainSource.slice(handlerStart, handlerStart + 5000);

describe('overlay DevAccount login', () => {
  it('uses the direct persona endpoint for hosted DEV as well as local DEV', () => {
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerSource).toContain("'/api/dev/login-as'");
    expect(handlerSource).toContain('overlayCore.isLocalRelay(RELAY_HTTP)');
    expect(handlerSource).toContain('overlayCore.isHostedDevRelay(RELAY_HTTP)');
    expect(handlerSource).not.toContain('startHostedDevPersonaLogin');
    expect(handlerSource).not.toContain('/auth/discord/dev-login');
  });

  it('passes the optional hosted-DEV persona key without putting it in the URL', () => {
    expect(handlerSource).toContain('DEV_PERSONA_LOGIN_SECRET');
    expect(handlerSource).toContain('X-Dev-Persona-Key');
    expect(handlerSource).not.toContain('DEV_PERSONA_LOGIN_SECRET`');
  });

  it('fails closed for packaged builds and unknown relays', () => {
    expect(handlerSource).toContain("if (app.isPackaged) return { ok: false, error: 'Not in dev mode' }");
    expect(handlerSource).toContain('Persona login is only available on the local or hosted DEV relay');
  });
});
