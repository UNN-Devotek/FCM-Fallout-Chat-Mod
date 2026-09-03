import { describe, expect, it } from 'vitest';
import { isDevPersonaUiEnabled } from '../devPersonaAccess';

describe('isDevPersonaUiEnabled', () => {
  it('enables persona controls for an explicit Dev build flag', () => {
    expect(isDevPersonaUiEnabled({ VITE_DEV_PERSONAS: 'true' })).toBe(true);
  });

  it.each([
    {},
    { VITE_DEV_PERSONAS: 'false' },
    { VITE_DEV_PERSONAS: 'TRUE' },
    { VITE_DEV_PERSONAS: '1' },
  ])('keeps persona controls disabled for %j', (config) => {
    expect(isDevPersonaUiEnabled(config)).toBe(false);
  });
});
