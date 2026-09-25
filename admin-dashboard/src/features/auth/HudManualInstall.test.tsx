import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import HudManualInstall from './HudManualInstall';

afterEach(cleanup);

describe('manual HUD setup', () => {
  it.each(['falloutchatmod.com', 'dev.falloutchatmod.com'])('keeps %s instructions and linking on the same environment', (host) => {
    render(<HudManualInstall linkUrl={`https://${host}/link`} bodyStyle={{}} stepStyle={{}} noteStyle={{}} />);
    expect(screen.getByRole('link', { name: 'the account-link page' })).toHaveAttribute('href', `https://${host}/link`);
    expect(screen.getByText(`[Chat]\nenabled=true\nrelayEndpoint=wss://${host}/relay`, { collapseWhitespace: false })).toBeInTheDocument();
    expect(screen.getByText(`[TextChat]\nEndpoint=wss://${host}/relay`, { collapseWhitespace: false })).toBeInTheDocument();
    const text = screen.getByRole('region', { name: 'Manual HUD installation' }).textContent!;
    expect(text).toContain('the latest ZFE or the latest xScal');
    const otherHost = host.startsWith('dev.') ? 'wss://falloutchatmod.com' : 'wss://dev.falloutchatmod.com';
    expect(text).not.toContain(otherHost);
    expect(text).toContain('If the file or section is missing');
    expect(text).toContain('temporary folder outside the Fallout 76 installation');
    expect(text).toContain('Open only ZFE (Install for ZFE only)/ or xScal (Install for xScal only)/');
    expect(text).toContain('Data (drag the contents into data folder)/ folder and drag the contents');
    expect(text).toContain('do not copy the labeled folder itself');
    expect(text).toContain('On a manual update, replace only Data/FCMChatWidget.ba2');
    expect(text).toContain('Keep edited INIs');
    expect(text).toContain('Quick Configuration 2 or NukaMods');
    expect(text).toContain('Do not import the combined ZIP');
    expect(text).toContain('Let the manager deploy the BA2 and maintain its archive-list entry');
    expect(text).toContain('Copy only missing INIs or the ZFE fragment');
    expect(text).toContain('For a manual install, add FCMChatWidget.ba2 once');
    expect(text).toContain('xScal ships with chat disabled');
    expect(text).toContain('The selected ZFE (Install for ZFE only)/Data (drag the contents into data folder)/ folder already contains the complete fragment');
    expect(text).toContain('No separate zfe.ini is included or required');
    expect(text).toContain('sign in with Steam or Discord');
    expect(text).toContain('Codes expire after 10 minutes');
  });
});
