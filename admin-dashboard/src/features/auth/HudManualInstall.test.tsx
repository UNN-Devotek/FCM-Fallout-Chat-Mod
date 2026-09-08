import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import HudManualInstall from './HudManualInstall';

afterEach(cleanup);

describe('manual HUD setup', () => {
  it.each(['falloutchatmod.com', 'dev.falloutchatmod.com'])('keeps %s instructions and linking on the same environment', (host) => {
    render(<HudManualInstall linkUrl={`https://${host}/link`} bodyStyle={{}} stepStyle={{}} noteStyle={{}} />);
    expect(screen.getByRole('link', { name: 'the account-link page' })).toHaveAttribute('href', `https://${host}/link`);
    expect(screen.getByText(`[Chat]\nenabled=true\nrelayEndpoint=wss://${host}/relay`, { collapseWhitespace: false })).toBeInTheDocument();
    expect(screen.getByText(`Endpoint=wss://${host}/relay`)).toBeInTheDocument();
    const text = screen.getByRole('region', { name: 'Manual HUD installation' }).textContent!;
    const otherHost = host.startsWith('dev.') ? 'wss://falloutchatmod.com' : 'wss://dev.falloutchatmod.com';
    expect(text).not.toContain(otherHost);
    expect(text).toContain('If the file is missing');
    expect(text).toContain('New users must apply these settings too');
    expect(text).toContain('Copy the complete');
    expect(text).toContain('sign in with Steam or Discord');
    expect(text).toContain('Steam display name');
  });
});
