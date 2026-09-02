import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();

vi.mock('../../../services/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
}));

vi.mock('../EmojiPicker', () => ({ default: () => null }));
vi.mock('../GifPicker', () => ({ default: () => null }));
vi.mock('../components/ChatEmbedCard', () => ({ ChatEmbedCard: () => null }));

import ChatOverlay from '../ChatOverlay';

type FakeWsFrame = { type: string; payload?: Record<string, unknown> };

const wsInstances: FakeWebSocket[] = [];
let searchResultsForTest: Array<{ userId: string; displayName: string }> = [];

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sentFrames: FakeWsFrame[] = [];

  constructor(_url: string) {
    wsInstances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(raw: string) {
    const frame = JSON.parse(raw) as FakeWsFrame;
    this.sentFrames.push(frame);
    if (frame.type === 'pm:history') {
      const conversationId = String(frame.payload?.conversationId ?? '');
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({
            type: 'pm:history',
            payload: {
              conversationId,
              messages: [
                {
                  id: 'pm-1',
                  conversationId,
                  senderId: 'user-other',
                  senderName: 'Stealthmog',
                  recipientId: 'user-me',
                  content: 'meet at whitespring?',
                  createdAt: '2026-06-25T15:52:00.000Z',
                },
                {
                  id: 'pm-2',
                  conversationId,
                  senderId: 'user-me',
                  senderName: 'LocalDevLT',
                  recipientId: 'user-other',
                  content: 'omw',
                  createdAt: '2026-06-25T15:52:30.000Z',
                },
              ],
            },
          }),
        });
      }, 0);
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  addEventListener() {}
  removeEventListener() {}
}

function emitWs(frame: FakeWsFrame) {
  const ws = wsInstances[wsInstances.length - 1];
  if (!ws) throw new Error('No websocket instance');
  ws.onmessage?.({ data: JSON.stringify(frame) });
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function renderOverlay(user: Record<string, unknown> | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route element={<Outlet context={user ? { user } : {}} />}>
            <Route path="/" element={<ChatOverlay />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChatOverlay private messaging', () => {
  let fetchMock: Mock;
  const realFetch = globalThis.fetch;
  const realWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    wsInstances.length = 0;
    searchResultsForTest = [];
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    } else {
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    }

    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);

    apiGet.mockImplementation((path: string) => {
      if (path === '/api/channels') {
        return Promise.resolve([
          {
            id: 'main-1',
            name: 'Fallout 76',
            color: '#C8A840',
            parentId: null,
            children: [
              { id: 'general', name: 'General', color: '#C8A840', parentId: 'main-1' },
              { id: 'trading', name: 'Trading', color: '#4A9FE0', parentId: 'main-1' },
            ],
          },
        ]);
      }
      if (path === '/api/block') return Promise.resolve({ blocked: [] });
      if (path.startsWith('/api/commands')) return Promise.resolve([]);
      if (path.startsWith('/api/presence/server-messages')) return Promise.resolve([]);
      if (path.startsWith('/api/presence/same-server')) {
        return Promise.resolve({ serverEndpoint: null, users: [], totalChatMod: 0, allPlayers: null });
      }
      if (path.startsWith('/api/parties/invites')) return Promise.resolve({ invites: [] });
      if (path.startsWith('/api/parties')) return Promise.resolve({ parties: [] });
      if (path.startsWith('/api/block/search')) {
        return Promise.resolve({ results: searchResultsForTest });
      }
      return Promise.resolve([]);
    });
    apiPost.mockResolvedValue({});
    apiDelete.mockResolvedValue({});

    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/ws-ticket')) {
        return Promise.resolve(jsonResponse({ data: { ticket: 'ticket-1' } }));
      }
      if (url.includes('/api/giveaways')) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWebSocket;
  });

  it('renders sender-aware PM inbox previews without avatars', async () => {
    const { container } = renderOverlay({ id: 'user-me', username: 'You', role: 'user' });
    await screen.findByText('PM');

    await act(async () => {
      emitWs({
        type: 'pm:list',
        payload: {
          conversations: [
            {
              conversationId: 'conv-1',
              otherUserId: 'user-other',
              otherDisplayName: 'Stealthmog',
              lastMessagePreview: 'meet at whitespring?',
              lastMessageSenderId: 'user-other',
              lastMessageAt: '2026-06-25T15:53:00.000Z',
              unreadCount: 2,
            },
            {
              conversationId: 'conv-2',
              otherUserId: 'user-friend',
              otherDisplayName: 'LocalDevLT',
              lastMessagePreview: 'omw',
              lastMessageSenderId: 'user-me',
              lastMessageAt: '2026-06-25T15:54:00.000Z',
              unreadCount: 0,
            },
          ],
        },
      });
    });

    fireEvent.click(screen.getByText('PM'));
    expect(await screen.findByPlaceholderText('Type to search...')).toBeTruthy();
    // The PM tab no longer renders a sub-tab row (no redundant INBOX sub-tab) —
    // inbox is the default view and the back-to-inbox affordance lives in the
    // open-conversation header instead.
    expect(container.querySelector('[data-fcm-subtab-row="pm"]')).toBeNull();
    expect(screen.queryByText('INBOX')).toBeNull();
    expect(screen.getByText('Stealthmog')).toBeTruthy();
    expect(screen.getByText('Stealthmog: meet at whitespring?')).toBeTruthy();
    expect(screen.getByText('You: omw')).toBeTruthy();
    expect(container.querySelector('[data-pm-inbox="true"] img')).toBeNull();
  });

  it('filters PM inbox conversations by name and sender-aware preview text', async () => {
    renderOverlay({ id: 'user-me', username: 'You', role: 'user' });
    await screen.findByText('PM');

    await act(async () => {
      emitWs({
        type: 'pm:list',
        payload: {
          conversations: [
            {
              conversationId: 'conv-1',
              otherUserId: 'user-other',
              otherDisplayName: 'Stealthmog',
              lastMessagePreview: 'meet at whitespring?',
              lastMessageSenderId: 'user-other',
              lastMessageAt: '2026-06-25T15:53:00.000Z',
              unreadCount: 2,
            },
            {
              conversationId: 'conv-2',
              otherUserId: 'user-friend',
              otherDisplayName: 'LocalDevLT',
              lastMessagePreview: 'omw',
              lastMessageSenderId: 'user-me',
              lastMessageAt: '2026-06-25T15:54:00.000Z',
              unreadCount: 0,
            },
          ],
        },
      });
    });

    fireEvent.click(screen.getByText('PM'));
    const search = await screen.findByPlaceholderText('Type to search...');

    fireEvent.change(search, { target: { value: 'LocalDevLT' } });
    expect(screen.getByText('LocalDevLT')).toBeTruthy();
    expect(screen.getByText('You: omw')).toBeTruthy();
    expect(screen.queryByText('Stealthmog')).toBeNull();

    fireEvent.change(search, { target: { value: 'omw' } });
    expect(screen.getByText('LocalDevLT')).toBeTruthy();
    expect(screen.getByText('You: omw')).toBeTruthy();
    expect(screen.queryByText('Stealthmog')).toBeNull();

    fireEvent.change(search, { target: { value: 'You' } });
    expect(screen.getByText('LocalDevLT')).toBeTruthy();
    expect(screen.getByText('You: omw')).toBeTruthy();
    expect(screen.queryByText('Stealthmog')).toBeNull();

    fireEvent.change(search, { target: { value: 'unrelated text' } });
    expect(screen.queryByText('LocalDevLT')).toBeNull();
    expect(screen.queryByText('You: omw')).toBeNull();
    expect(screen.queryByText('Stealthmog')).toBeNull();
  });

  it('opens a private conversation and returns to inbox', async () => {
    renderOverlay({ id: 'user-me', username: 'LocalDevLT', role: 'user' });
    await screen.findByText('PM');

    await act(async () => {
      emitWs({
        type: 'pm:list',
        payload: {
          conversations: [
            {
              conversationId: 'conv-1',
              otherUserId: 'user-other',
              otherDisplayName: 'Stealthmog',
              lastMessagePreview: 'meet at whitespring?',
              lastMessageSenderId: 'user-other',
              lastMessageAt: '2026-06-25T15:53:00.000Z',
              unreadCount: 2,
            },
          ],
        },
      });
    });

    fireEvent.click(screen.getByText('PM'));
    fireEvent.click(await screen.findByText('Stealthmog'));

    expect(await screen.findByText('< BACK TO INBOX')).toBeTruthy();
    expect(screen.getByText('Stealthmog')).toBeTruthy();
    expect(screen.queryByText('PRIVATE - Only you and Stealthmog can see this conversation.')).toBeNull();
    expect(screen.getByPlaceholderText('Type a message...')).toBeTruthy();
    expect(await screen.findByText('meet at whitespring?')).toBeTruthy();
    expect(screen.getByText('omw')).toBeTruthy();
    expect(screen.getByText(/Stealthmog:/)).toBeTruthy();
    expect(screen.getByText(/You:/)).toBeTruthy();
    expect(screen.queryByText(/LocalDevLT:/)).toBeNull();

    fireEvent.click(screen.getByText('< BACK TO INBOX'));
    expect(await screen.findByPlaceholderText('Type to search...')).toBeTruthy();
  });

  it('shows an exact Message item in the username context menu', async () => {
    renderOverlay({ id: 'user-me', username: 'You', role: 'user' });
    await screen.findByText('PM');

    await act(async () => {
      emitWs({
        type: 'pm:list',
        payload: {
          conversations: [
            {
              conversationId: 'conv-1',
              otherUserId: 'user-other',
              otherDisplayName: 'Stealthmog',
              lastMessagePreview: 'meet at whitespring?',
              lastMessageSenderId: 'user-other',
              lastMessageAt: '2026-06-25T15:53:00.000Z',
              unreadCount: 2,
            },
          ],
        },
      });
    });
    fireEvent.click(screen.getByText('PM'));
    fireEvent.click(await screen.findByText('Stealthmog'));

    fireEvent.contextMenu(await screen.findByText(/Stealthmog:/));

    expect(await screen.findByText('Message')).toBeTruthy();
    expect(screen.queryByText(/Message Stealthmog/i)).toBeNull();
    expect(screen.queryByText(/Message .*privately/i)).toBeNull();

    fireEvent.mouseDown(screen.getByText('Message'));
    expect(wsInstances[wsInstances.length - 1]?.sentFrames.some((frame: FakeWsFrame) =>
      frame.type === 'pm:open' && frame.payload?.targetUserId === 'user-other',
    )).toBe(true);
  });

  it('opens a searched user through the PM socket action', async () => {
    const targetUserId = '11111111-1111-4111-8111-111111111111';
    searchResultsForTest = [{ userId: targetUserId, displayName: 'NewFriend' }];
    renderOverlay({ id: '22222222-2222-4222-8222-222222222222', username: 'You', role: 'user' });
    await screen.findByText('PM');

    // Let the initial channel query settle before selecting PM. This mirrors
    // the real overlay's first-open sequence and avoids racing its default
    // channel selection effect.
    await screen.findByText('Fallout 76');
    fireEvent.click(screen.getByText('PM'));
    const search = await screen.findByPlaceholderText('Type to search...');
    fireEvent.change(search, { target: { value: 'NewFriend' } });

    fireEvent.click(await screen.findByText('NewFriend'));
    expect(wsInstances[wsInstances.length - 1]?.sentFrames.some((frame: FakeWsFrame) =>
      frame.type === 'pm:open' && frame.payload?.targetUserId === targetUserId,
    )).toBe(true);
    expect(screen.queryByDisplayValue('NewFriend')).toBeNull();
  });

  it('keeps background PM hydration failures out of the startup toast', async () => {
    renderOverlay({ id: 'user-me', username: 'You', role: 'user' });
    await screen.findByText('PM');

    await act(async () => {
      emitWs({ type: 'error', payload: { message: 'Could not load private messages.' } });
    });

    expect(screen.queryByText('Could not load private messages.')).toBeNull();
    fireEvent.click(screen.getByText('PM'));
    expect(await screen.findByText('Private messages are temporarily unavailable.')).toBeTruthy();
  });

  it('does not expose PM controls in public mode', async () => {
    renderOverlay(null);
    await waitFor(() => {
      expect(screen.queryByText('PM')).toBeNull();
    });
  });
});
