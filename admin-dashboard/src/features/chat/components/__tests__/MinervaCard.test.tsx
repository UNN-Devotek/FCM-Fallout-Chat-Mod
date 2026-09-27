import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MinervaCard, type MinervaMetadata } from '../MinervaCard';

const sale: MinervaMetadata = {
  type: 'minerva', location: 'Fort Atlas', listNumber: 3, isActive: false, isSuperSale: false,
  startUtc: '2026-09-28T17:00:00Z', endUtc: '2026-09-30T17:00:00Z',
  nextLocation: null, nextListNumber: null, nextIsSuperSale: null, nextStartUtc: null,
  inventory: ['Plan: Chicken coop — 563 Gold', 'Plan: Chinese stealth armor — 3000 Gold'],
};

function renderCard(overrides: Partial<MinervaMetadata> = {}, shareDisabled = false) {
  const onOpenSource = vi.fn();
  const onShareToChat = vi.fn();
  const view = render(<MinervaCard
    sale={{ ...sale, ...overrides }} sourceName="Fallout Builds" onOpenSource={onOpenSource}
    onShareToChat={onShareToChat} shareDisabled={shareDisabled}
    hexAlpha={(hex) => hex} fontFamily="monospace" fontSize={16}
  />);
  return { ...view, onOpenSource, onShareToChat };
}

function inventoryCells() {
  return screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-27T18:47:00Z'));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('MinervaCard', () => {
  it('groups the upcoming location/countdown and both local dates before inventory', () => {
    renderCard();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    const visit = screen.getByText('Fort Atlas').parentElement!;
    expect(within(visit).getByText('Arrives in 22h 13m')).toBeInTheDocument();
    for (const iso of [sale.startUtc, sale.endUtc]) {
      expect(visit).toHaveTextContent(new Date(iso).toLocaleString(undefined, {
        day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      }));
    }
    expect(visit.compareDocumentPosition(screen.getByRole('table')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sorts numerically descending, keeps ties stable, and does not mutate the input', () => {
    const inventory = [
      'Plan: Cheap — 90 Gold', 'Plan: First tie — 1500 Gold', 'Plan: Expensive — 3000 Gold',
      'Plan: Second tie — 1500 Gold', 'Plan: Midrange — 563 Gold',
    ];
    Object.freeze(inventory);
    renderCard({ inventory });
    expect(inventoryCells()).toEqual([
      ['Plan: Expensive', (3000).toLocaleString()], ['Plan: First tie', (1500).toLocaleString()],
      ['Plan: Second tie', (1500).toLocaleString()], ['Plan: Midrange', '563'], ['Plan: Cheap', '90'],
    ]);
    expect(inventory[0]).toBe('Plan: Cheap — 90 Gold');
  });

  it('keeps unknown prices last, accepts grouped numbers and zero, and preserves name dashes', () => {
    renderCard({ inventory: [
      'Plan: Unknown', 'Plan: Free — 0 Gold', 'Plan: Secret Service — jet pack — 1,500 Gold',
      'Plan: Invalid — -5 Gold', 'Plan: Bad grouping — 1,5 Gold',
    ] });
    expect(inventoryCells()).toEqual([
      ['Plan: Secret Service — jet pack', (1500).toLocaleString()], ['Plan: Free', '0'],
      ['Plan: Unknown', 'Unknown'], ['Plan: Invalid — -5 Gold', 'Unknown'], ['Plan: Bad grouping — 1,5 Gold', 'Unknown'],
    ]);
  });

  it('shows the entire inventory, including entries after ten, with accessible column headings', () => {
    renderCard({ inventory: Array.from({ length: 35 }, (_, i) => `Plan: Item ${i} — ${i} Gold`) });
    expect(screen.getAllByRole('row')).toHaveLength(36);
    expect(screen.getByRole('columnheader', { name: 'Item' })).toHaveAttribute('scope', 'col');
    expect(screen.getByRole('columnheader', { name: 'Gold bullion' })).toHaveAttribute('scope', 'col');
    expect(inventoryCells()[0]).toEqual(['Plan: Item 34', '34']);
    expect(inventoryCells()[34]).toEqual(['Plan: Item 0', '0']);
  });

  it.each([undefined, [], ['  ']])('retains visit details and explains unavailable inventory: %j', (inventory) => {
    renderCard({ inventory });
    expect(screen.getByText('Fort Atlas')).toBeInTheDocument();
    expect(screen.getByText(/Inventory unavailable/)).toHaveTextContent('Run /minerva again to retry.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows active/Super Sale state and places the next visit after inventory', () => {
    const { container } = renderCard({
      isActive: true, isSuperSale: true, location: 'The Whitespring Resort',
      nextLocation: 'Foundation', nextListNumber: 5, nextStartUtc: '2026-10-05T17:00:00Z', nextIsSuperSale: false,
    });
    expect(screen.getByText('Here now')).toBeInTheDocument();
    expect(screen.getByText('SUPER SALE')).toBeInTheDocument();
    expect(screen.getByText('Leaves in 2d 22h 13m')).toBeInTheDocument();
    const next = screen.getByText(/Next visit: Foundation/);
    expect(next).toHaveTextContent('List #5');
    expect(screen.getByRole('table').compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.fcm-embed__grid')).not.toBeInTheDocument();
  });

  it('handles unknown timestamps without displaying Invalid Date', () => {
    renderCard({ startUtc: 'invalid', endUtc: 'invalid' });
    expect(screen.getByText('Arrives at an unknown time')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  it.each([
    [false, 'Arrival time reached. Run /minerva to refresh.'],
    [true, 'Visit ended. Run /minerva to refresh.'],
  ])('gives refresh guidance for a stale snapshot, active=%s', (isActive, message) => {
    renderCard({ isActive, startUtc: '2026-09-20T17:00:00Z', endUtc: '2026-09-22T17:00:00Z' });
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('supports keyboard source/share activation and preserves the share cooldown', async () => {
    const user = userEvent.setup();
    const { onOpenSource, onShareToChat, unmount } = renderCard();
    await user.tab();
    expect(screen.getByRole('button', { name: 'via Fallout Builds ↗' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onOpenSource).toHaveBeenCalledOnce();
    await user.tab();
    await user.keyboard(' ');
    expect(onShareToChat).toHaveBeenCalledOnce();
    unmount();
    const disabled = renderCard({}, true);
    const share = screen.getByRole('button', { name: /Shared/ });
    expect(share).toBeDisabled();
    await user.click(share);
    expect(disabled.onShareToChat).not.toHaveBeenCalled();
  });
});
