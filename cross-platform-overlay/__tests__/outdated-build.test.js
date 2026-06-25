import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const main = readFileSync(join(ROOT, 'main.js'), 'utf8');

describe('overlay reacts to WS close 4003 (outdated build)', () => {
  it('the WS close handler special-cases code 4003', () => {
    const closeBlock = main.slice(main.indexOf("sock.on('close'"), main.indexOf("sock.on('error'"));
    expect(closeBlock).toMatch(/4003/);
  });
});
