import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { ChatInlineEmbed } from '../ChatInlineEmbed';

afterEach(cleanup);

const baseProps = {
  accent: '#50C878',
  fontSize: 13,
  dimText: '#999999',
};

describe('ChatInlineEmbed interactive targets', () => {
  it('uses a native button for a shared-card title and stops row bubbling', () => {
    const onTitleClick = vi.fn();
    const rowClick = vi.fn();
    const { getByRole } = render(
      <div onClick={rowClick}>
        <ChatInlineEmbed {...baseProps} title="Blue 9 Ball Table" onTitleClick={onTitleClick} />
      </div>,
    );

    fireEvent.click(getByRole('button', { name: 'Blue 9 Ball Table' }));

    expect(onTitleClick).toHaveBeenCalledTimes(1);
    expect(rowClick).not.toHaveBeenCalled();
  });

  it('uses a native button for a source link and stops row bubbling', () => {
    const onMetaClick = vi.fn();
    const rowClick = vi.fn();
    const { getByRole } = render(
      <div onClick={rowClick}>
        <ChatInlineEmbed
          {...baseProps}
          title="Blue 9 Ball Table"
          meta={{ label: '76 CAMP Database ↗', onClick: onMetaClick }}
        />
      </div>,
    );

    fireEvent.click(getByRole('button', { name: '76 CAMP Database ↗' }));

    expect(onMetaClick).toHaveBeenCalledTimes(1);
    expect(rowClick).not.toHaveBeenCalled();
  });
});
