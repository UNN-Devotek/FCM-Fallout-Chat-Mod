import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ServerBridgeInstall from './ServerBridgeInstall';

afterEach(cleanup);

describe('optional Server Bridge installation', () => {
  it('separates bridge setup from visible HUD provider configuration', () => {
    render(<ServerBridgeInstall bodyStyle={{}} stepStyle={{}} noteStyle={{}} />);
    const text = screen.getByRole('region', { name: 'Optional Server Bridge installation' }).textContent!;
    expect(text).toContain('the latest ZFE or the latest xScal');
    expect(text).not.toContain('0.2.17');
    expect(text).toContain('Do not edit xscal.ini');
    expect(text).toContain('[Chat]');
    expect(text).toContain('for the visible in-game HUD, not the Server Bridge');
    expect(text).toContain('Do not add a TextChat fragment');
    expect(text).toContain('FCMServerBridge.ba2');
    expect(text).toContain('Never install both');
  });
});
