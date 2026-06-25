import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');

describe('QA build channel plumbing', () => {
  it('vite.config defines __BUILD_CHANNEL__', () => {
    const cfg = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/__BUILD_CHANNEL__/);
  });
  it('env.d.ts declares __BUILD_CHANNEL__', () => {
    const env = readFileSync(join(ROOT, 'src', 'env.d.ts'), 'utf8');
    expect(env).toMatch(/__BUILD_CHANNEL__/);
  });
  it('package.json has a dist:qa script setting fcmChannel=qa', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['dist:qa']).toBeDefined();
    expect(pkg.scripts['dist:qa']).toMatch(/extraMetadata\.fcmChannel=qa/);
  });
});
