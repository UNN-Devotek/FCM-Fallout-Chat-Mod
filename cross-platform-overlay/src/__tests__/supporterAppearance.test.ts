import { describe, expect, it } from 'vitest';
import { createAppearanceRequestGate, isLocked, problemText, tierAtLeast } from '../supporterAppearance';

describe('supporter appearance tier gates', () => {
  it('keeps free options available while locking paid options by their exact tier', () => {
    expect(tierAtLeast('none', 'none')).toBe(true);
    expect(isLocked('none', 'supporter')).toBe(true);
    expect(isLocked('supporter', 'supporter')).toBe(false);
    expect(isLocked('supporter', 'overseer')).toBe(true);
    expect(isLocked('overseer', 'overseer')).toBe(false);
  });

  it('uses the server problem detail instead of hiding a rejected choice', () => {
    expect(problemText({ detail: 'Supporter is required for that colour.' }))
      .toBe('Supporter is required for that colour.');
    expect(problemText({})).toBe('Could not save that change. Please try again.');
  });
});

describe('supporter appearance request gate', () => {
  it('permits one picker request at a time, then releases after completion', () => {
    const gate = createAppearanceRequestGate();
    expect(gate.busy).toBe(false);
    expect(gate.tryStart()).toBe(true);
    expect(gate.busy).toBe(true);
    expect(gate.tryStart()).toBe(false);
    gate.finish();
    expect(gate.busy).toBe(false);
    expect(gate.tryStart()).toBe(true);
  });
});
