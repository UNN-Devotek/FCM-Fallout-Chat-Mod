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
  });
});
