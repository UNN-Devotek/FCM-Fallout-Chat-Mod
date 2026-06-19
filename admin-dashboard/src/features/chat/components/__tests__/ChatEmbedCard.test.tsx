// ChatEmbedCard — unit tests (Vitest + RTL)
//
// Focused on the `singleColumn` prop added for the giveaway list/history cards:
// it must force the fields grid into the single-column modifier class, and the
// default (multi-column) behavior must be unaffected.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { ChatEmbedCard } from '../ChatEmbedCard';

afterEach(cleanup);

const baseProps = {
  accent: '#50C878',
  tag: 'GIVEAWAY',
  title: 'Test card',
  hexAlpha: (hex: string, _a: number) => hex,
  fontFamily: 'monospace',
  fontSize: 13,
  fields: [
    { label: 'PRIZE', value: 'Ultracite Flux' },
    { label: 'ID', value: 'A1B2C3' },
  ],
};

describe('ChatEmbedCard singleColumn', () => {
  it('applies the single-column modifier class when singleColumn is set', () => {
    const { container } = render(<ChatEmbedCard {...baseProps} singleColumn />);
    const grid = container.querySelector('.fcm-embed__grid');
    expect(grid).not.toBeNull();
    expect(grid?.classList.contains('fcm-embed__grid--single')).toBe(true);
  });

  it('omits the single-column modifier by default', () => {
    const { container } = render(<ChatEmbedCard {...baseProps} />);
    const grid = container.querySelector('.fcm-embed__grid');
    expect(grid).not.toBeNull();
    expect(grid?.classList.contains('fcm-embed__grid--single')).toBe(false);
  });

  it('renders one field cell per field', () => {
    const { container } = render(<ChatEmbedCard {...baseProps} singleColumn />);
    expect(container.querySelectorAll('.fcm-embed__field')).toHaveLength(2);
  });
});
