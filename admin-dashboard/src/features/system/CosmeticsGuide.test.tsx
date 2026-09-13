import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CosmeticsGuide from './CosmeticsGuide';

vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: undefined }) }));

describe('HUD customization guide', () => {
  it.each(['public', 'dashboard'] as const)('documents the allowed controls in %s mode', variant => {
    render(<CosmeticsGuide variant={variant} />);
    const section = screen.getByRole('region', { name: 'In-game HUD customization' });
    expect(within(section).getByText('inputBgColor')).toBeInTheDocument();
    expect(within(section).getByText('inputTextColor')).toBeInTheDocument();
    expect(within(section).getByText('autoHideEnabled=false')).toBeInTheDocument();
    expect(section).toHaveTextContent('Input width and alignment stay fixed');
    expect(section).toHaveTextContent('including the ZFE editor');
    expect(section).toHaveTextContent('Badges, channel tags and their visibility/colors, emojis, the default channel');
    expect(section).toHaveTextContent('They have no appearance controls');
    expect(section).toHaveTextContent('independently of its remembered delay');
    expect(section).toHaveTextContent('not available in older HUD packages');
    expect(section).toHaveTextContent('openKey=DELETE');
    expect(section).toHaveTextContent('OpenChatKey=DELETE');
    expect(section).toHaveTextContent('Data/configuration/zfe.ini');
    expect(section).toHaveTextContent('Delete is the recommended alternative');
    expect(section).toHaveTextContent('scrollUpKey=Up');
    expect(section).toHaveTextContent('scrollDownKey=Down');
    expect(section).toHaveTextContent('scrollBottomKey=');
    expect(section).toHaveTextContent('Scroll to newest');
    expect(section).toHaveTextContent('xScal is different');
    expect(section).toHaveTextContent('it has no OpenChatKey setting in xscal.ini');
    expect(section).toHaveTextContent("openKey to xScal's documented physical input polling");
    expect(section).toHaveTextContent('does not suppress the key from gameplay');
    expect(section).toHaveTextContent('suppression calls are for gamepad buttons');
  });
});
