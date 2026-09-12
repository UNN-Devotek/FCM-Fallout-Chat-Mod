import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import HudKeybindGuide, {
  XSCAL_INPUT_ARTICLE_URL,
  ZFE_MODDER_GUIDE_URL,
} from './HudKeybindGuide';

describe('HUD keybind guide', () => {
  it.each(['public', 'dashboard'] as const)('documents ZFE and xScal references in %s mode', variant => {
    render(<HudKeybindGuide variant={variant} />);
    const guide = screen.getByTestId('hud-keybind-guide');

    expect(within(guide).getByText('ZFE OPEN-CHAT KEY')).toBeInTheDocument();
    expect(within(guide).getByText('xSCAL OPEN-CHAT KEY')).toBeInTheDocument();
    expect(guide).toHaveTextContent('OpenChatKey=DELETE');
    expect(guide).toHaveTextContent('Data/configuration/zfe.ini');
    expect(guide).toHaveTextContent('Input.RegisterKey');
    expect(guide).toHaveTextContent('does not suppress keyboard input');
    expect(guide).toHaveTextContent('scrollUpKey=Up / scrollDownKey=Down');
    expect(guide).toHaveTextContent('scrollBottomKey= (unset)');
    expect(guide).toHaveTextContent('packaged default is unbound');
    expect(guide).toHaveTextContent('Scroll to newest');
    expect(within(guide).getByRole('link', { name: 'ZFE Modder Guide' })).toHaveAttribute('href', ZFE_MODDER_GUIDE_URL);
    expect(within(guide).getByRole('link', { name: 'xScal Input interface (Nexus article 268)' })).toHaveAttribute('href', XSCAL_INPUT_ARTICLE_URL);
  });
});
