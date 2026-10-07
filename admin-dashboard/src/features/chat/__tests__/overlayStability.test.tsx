import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.hoisted(() => vi.fn());
vi.mock('../../../services/api', () => ({ api: { get, post: vi.fn(), delete: vi.fn() } }));
vi.mock('../EmojiPicker', () => ({ default: () => null, extractEmojiTokens: () => [] }));
vi.mock('../GifPicker', () => ({ default: () => null }));
vi.mock('../components/ChatEmbedCard', () => ({ ChatEmbedCard: () => null }));
import ChatOverlay, { resetRememberedChatSelection } from '../ChatOverlay';
import { OVERLAY_SETTINGS_EVENT } from '../overlayFonts';
import { tabPreferenceScope } from '../subtabPreferences';

type Frame = { type: string; payload: Record<string, unknown> };
const sockets: TestSocket[] = [];
class TestSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: Frame[] = [];
  constructor() { sockets.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  emit(frame: Frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  addEventListener() {}
  removeEventListener() {}
}

let visibility: (visible: boolean) => void;
let gameState: (running: boolean) => void;
let command: (command: string) => void;
let client: QueryClient;
const channels = [{ id: 'fo76', name: 'Fallout 76', parentId: null, children: [
  { id: 'general', name: 'General', parentId: 'fo76' },
  { id: 'trading', name: 'Trading', parentId: 'fo76' },
  { id: 'events', name: 'Events', parentId: 'fo76' },
] }];

beforeEach(() => {
  sockets.length = 0;
  resetRememberedChatSelection();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('__FCM_OVERLAY_SHELL__', { title: 'Fallout Chat Mod', relayBase: 'http://localhost' });
  vi.stubGlobal('relayBridge', {
    onVisibility: (cb: typeof visibility) => { visibility = cb; return () => {}; },
    onGameState: (cb: typeof gameState) => { gameState = cb; return () => {}; },
    onCommand: (cb: typeof command) => { command = cb; return () => {}; },
    logDiag: vi.fn(), notifyChatActive: vi.fn(), notifyInputFocusState: vi.fn(),
  });
  vi.stubGlobal('WebSocket', TestSocket);
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify({
    data: url.includes('ws-ticket') ? { ticket: 'local-test-ticket' } : [],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))));
  get.mockImplementation((path: string) => Promise.resolve(path === '/api/channels' ? channels
    : path === '/api/block' ? { blocked: [] }
    : path.startsWith('/api/parties/invites') ? { invites: [] }
    : path.startsWith('/api/parties') ? { parties: [] } : []));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(role = 'user') {
  const result = render(<QueryClientProvider client={client}><MemoryRouter><Routes>
    <Route element={<Outlet context={{ user: { id: 'alice', username: 'Alice', role } }} />}>
      <Route path="/" element={<ChatOverlay />} />
    </Route>
  </Routes></MemoryRouter></QueryClientProvider>);
  await waitFor(() => expect(sockets).toHaveLength(1));
  await screen.findByText('Trading');
  return result;
}

function history(socket: TestSocket, id = 'message-1', content = 'Existing chat stays here') {
  socket.emit({ type: 'chat:history', payload: { messages: [{ id, content, username: 'Bob', user_id: 'bob',
    channel_id: 'general', created_at: '2026-09-16T12:00:00Z' }] } });
}

describe('overlay lifecycle and navigation', () => {
  it('removes only confirmed expired room mutes and persists cleanup', async () => {
    await mount('admin');
    act(() => sockets[0].open());
    act(() => {
      sockets[0].emit({ type: 'server:moderation:state', payload: { status: 'ready' } });
      sockets[0].emit({ type: 'server:moderation:messages', payload: { historyReplay: false, messages: ['gone', 'quiet'].map((id, i) => ({
        id, channelId: `server:r:${id}`, serverDisplayId: String(i + 1), username: 'Bob', source: 'server', timestamp: '2026-09-18T12:00:00Z', content: id,
      })) } });
    });
    for (const id of ['1', '2']) {
      fireEvent.contextMenu(screen.getByText(`[Server · ${id}]`));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Mute this server' }));
    }
    const key = `fcm-server-mutes:${tabPreferenceScope('http://localhost', 'alice')}`;
    expect(JSON.parse(localStorage.getItem(key)!).ids).toHaveLength(2);
    act(() => sockets[0].emit({ type: 'server:moderation:expired', payload: { channelIds: ['server:r:gone'] } }));
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ ids: ['server:r:quiet'], labels: { 'server:r:quiet': '2' } });
    expect(screen.queryByText('gone')).toBeNull();
    act(() => sockets[0].emit({ type: 'server:moderation:state', payload: { status: 'unavailable' } }));
    act(() => sockets[0].emit({ type: 'server:moderation:expired', payload: { channelIds: ['server:r:quiet'] } }));
    expect(JSON.parse(localStorage.getItem(key)!).ids).toEqual(['server:r:quiet']);
  });
  it('exempts only the selected tab, clears on keyboard navigation, and supports disabling dots', async () => {
    await mount();
    act(() => sockets[0].open());
    const send = (id: string, channelId: string) => act(() => sockets[0].emit({ type: 'chat:message', payload: {
      id, channelId, userId: 'bob', username: 'Bob', content: id, source: 'game',
    } }));
    fireEvent.click(screen.getByRole('button', { name: 'General channel' }));
    send('general-open', 'general');
    send('trading-unseen', 'trading');
    expect(screen.queryByRole('img', { name: 'Unread messages in General' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Unread messages in Trading' })).toBeTruthy();
    act(() => command('channel:next'));
    expect(screen.queryByRole('img', { name: 'Unread messages in Trading' })).toBeNull();
    act(() => { gameState(true); visibility(false); });
    send('trading-hidden-selected', 'trading');
    expect(screen.queryByRole('img', { name: 'Unread messages in Trading' })).toBeNull();
    send('events-unseen', 'events');
    expect(screen.getByRole('img', { name: 'Unread messages in Events' })).toBeTruthy();
    const setDots = (showUnreadDots: boolean) => act(() => {
      localStorage.setItem('fcm_web_overlay_settings', JSON.stringify({ showUnreadDots }));
      window.dispatchEvent(new Event(OVERLAY_SETTINGS_EVENT));
    });
    setDots(false);
    expect(screen.queryByRole('img', { name: 'Unread messages in Events' })).toBeNull();
    send('events-disabled', 'events');
    setDots(true);
    expect(screen.queryByRole('img', { name: 'Unread messages in Events' })).toBeNull();
    send('events-enabled', 'events');
    expect(screen.getByRole('img', { name: 'Unread messages in Events' })).toBeTruthy();
    act(() => command('channel:next'));
    expect(screen.queryByRole('img', { name: 'Unread messages in Events' })).toBeNull();
  });
  it('shows a nearby unread dot for new unseen messages and clears it on click', async () => {
    await mount();
    act(() => sockets[0].open());
    fireEvent.click(screen.getByRole('button', { name: 'Trading channel' }));
    act(() => sockets[0].emit({ type: 'chat:message', payload: { id: 'replayed-event', userId: 'bob', username: 'Bob', channelId: 'events', content: 'Replayed event', historyReplay: true } }));
    expect(screen.queryByRole('img', { name: 'Unread messages in Events' })).toBeNull();
    act(() => sockets[0].emit({ type: 'chat:history', payload: { messages: [{ id: 'history-event', user_id: 'bob', username: 'Bob', channel_id: 'events', content: 'History event' }] } }));
    act(() => sockets[0].emit({ type: 'chat:message', payload: { id: 'history-event', userId: 'bob', username: 'Bob', channelId: 'events', content: 'History event' } }));
    expect(screen.queryByRole('img', { name: 'Unread messages in Events' })).toBeNull();
    act(() => sockets[0].emit({ type: 'chat:message', payload: { id: 'unread-1', userId: 'bob', username: 'Bob', channelId: 'events', content: 'New event', source: 'game' } }));
    expect(screen.getByRole('img', { name: 'Unread messages in Events' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Events channel' }));
    expect(screen.queryByRole('img', { name: 'Unread messages in Events' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Trading channel' }));
    act(() => sockets[0].emit({ type: 'chat:message', payload: { id: 'unread-1', userId: 'bob', username: 'Bob', channelId: 'events', content: 'New event', source: 'game' } }));
    expect(screen.queryByRole('img', { name: 'Unread messages in Events' })).toBeNull();
  });

  it('gates cross-room messages to staff, supports muting, and purges on denial', async () => {
    await mount('moderator');
    act(() => sockets[0].open());
    await waitFor(() => expect(sockets[0].sent.some(frame => frame.type === 'server:moderation:subscribe' && frame.payload.enabled)).toBe(true));
    act(() => {
      sockets[0].emit({ type: 'server:moderation:state', payload: { status: 'ready' } });
      sockets[0].emit({ type: 'server:moderation:messages', payload: { historyReplay: false, messages: [{ id: 'server:r:other:1', channelId: 'server:r:other', serverDisplayId: '123', userId: 'bob', username: 'Bob', source: 'server', timestamp: '2026-09-18T12:00:00Z', content: 'Other room fixture' }] } });
    });
    expect(await screen.findByText('[Server · 123]')).toBeTruthy();
    fireEvent.contextMenu(screen.getByText('[Server · 123]'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mute this server' }));
    expect(screen.queryByText('Other room fixture')).toBeNull();
    act(() => window.dispatchEvent(new Event('fcm-subtab-settings')));
    fireEvent.click(screen.getByRole('button', { name: /^Unmute$/ }));
    expect(screen.getByText('Other room fixture')).toBeTruthy();
    act(() => sockets[0].emit({ type: 'server:moderation:state', payload: { status: 'denied' } }));
    expect(screen.queryByText('Other room fixture')).toBeNull();
  });

  it('ignores privileged rows for regular users even if a malformed server sends them', async () => {
    await mount();
    act(() => { sockets[0].open();
      sockets[0].emit({ type: 'server:moderation:state', payload: { status: 'ready' } });
      sockets[0].emit({ type: 'server:moderation:messages', payload: { messages: [{ id: 'server:r:other:1', channelId: 'server:r:other', serverDisplayId: '123', username: 'Bob', source: 'server', timestamp: '2026-09-18', content: 'Unauthorized fixture' }] } });
    });
    expect(screen.queryByText('Unauthorized fixture')).toBeNull();
  });

  it('keeps an older Server history page visible even when the live buffer is full', async () => {
    await mount('admin');
    act(() => { sockets[0].open(); sockets[0].emit({ type: 'server:moderation:state', payload: { status: 'ready' } });
      sockets[0].emit({ type: 'server:moderation:messages', payload: { historyReplay: false, messages: Array.from({ length: 500 }, (_, i) => ({
        id: `server:r:live:${i}`, channelId: 'server:r:live', serverDisplayId: '1', username: 'Bob', source: 'server', timestamp: '2026-09-18T12:00:00Z', content: `Live ${i}`,
      })) } });
      sockets[0].emit({ type: 'server:moderation:messages', payload: { historyReplay: true, hasMore: false, nextCursor: null, messages: [{
        id: 'server:r:old:1', channelId: 'server:r:old', serverDisplayId: '2', username: 'Bob', source: 'server', timestamp: '2026-09-17T12:00:00Z', content: 'Older room page is visible',
      }] } });
    });
    const newest = await screen.findByText('Live 499');
    expect(document.querySelectorAll('[data-fcm-message-line]')).toHaveLength(100);
    expect(screen.queryByText('Older room page is visible')).toBeNull();
    const list = newest.closest('.fcm-scrollbar')!;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 10000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    fireEvent.wheel(list, { deltaY: -100 });
    for (let page = 0; page < 5; page++) { list.scrollTop = 0; fireEvent.scroll(list); }
    expect(await screen.findByText('Older room page is visible')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refresh Server history' })).toBeNull();
  });

  it('automatically merges Server history pages and cancels paging on denial', async () => {
    await mount('admin');
    act(() => sockets[0].open());
    vi.useFakeTimers();
    try {
      const page = (id: string, nextCursor: string | null) => act(() => sockets[0].emit({
        type: 'server:moderation:messages', payload: { historyReplay: true, hasMore: !!nextCursor, nextCursor,
          messages: [{ id, channelId: `server:r:${id}`, serverDisplayId: '2', username: 'Bob', source: 'server', timestamp: '2026-09-18T12:00:00Z', content: `Room ${id}` }] },
      }));
      const requests = () => sockets[0].sent.filter(frame => frame.type === 'server:moderation:history');
      act(() => sockets[0].emit({ type: 'server:moderation:state', payload: { status: 'ready' } }));
      page('first', 'r:a');
      expect(screen.queryByRole('button', { name: 'Next Server rooms' })).toBeNull();
      act(() => vi.advanceTimersByTime(5499));
      expect(requests()).toHaveLength(0);
      act(() => vi.advanceTimersByTime(1));
      expect(requests()).toHaveLength(1);
      page('second', 'r:b');
      expect(screen.getByText('Room first')).toBeTruthy();
      expect(screen.getByText('Room second')).toBeTruthy();
      act(() => vi.advanceTimersByTime(5500));
      expect(requests()).toHaveLength(2);
      page('second', 'r:a'); // Repeated/regressing cursors must not loop.
      act(() => vi.advanceTimersByTime(5500));
      expect(requests()).toHaveLength(2);
      page('third', 'r:c');
      act(() => sockets[0].emit({ type: 'server:moderation:state', payload: { status: 'denied' } }));
      act(() => vi.advanceTimersByTime(5500));
      expect(requests()).toHaveLength(2);
      expect(screen.queryByText('Room first')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('renders Discord emojis and retries the media host before a readable label', async () => {
    await mount();
    act(() => { sockets[0].open(); history(sockets[0], 'emoji-message', '<a:Confused:1509625415726006313> <:Birthdaycake:1509631843207614626>'); });
    const animated = await screen.findByAltText(':Confused:');
    const birthday = screen.getByAltText(':Birthdaycake:');
    expect(animated.getAttribute('src')).toBe('https://cdn.discordapp.com/emojis/1509625415726006313.webp?animated=true');
    expect(birthday.getAttribute('src')).toBe('https://cdn.discordapp.com/emojis/1509631843207614626.png');
    fireEvent.error(animated);
    expect(animated.getAttribute('src')).toBe('https://media.discordapp.net/emojis/1509625415726006313.webp?animated=true');
    fireEvent.error(animated);
    expect(screen.getByText(':Confused:').tagName).toBe('SPAN');
    expect(screen.queryByText(/<a:Confused:/)).toBeNull();
  });

  it('does not restart a handshake for repeated visibility notifications', async () => {
    await mount();
    act(() => gameState(true));
    for (let i = 0; i < 5; i++) {
      await act(async () => visibility(true));
    }
    expect(sockets).toHaveLength(1);
  });

  it('updates fonts in place, retaining the composer and existing messages', async () => {
    const { container } = await mount();
    act(() => { sockets[0].open(); history(sockets[0]); });
    await screen.findByText('Existing chat stays here');
    const composer = container.querySelector<HTMLElement>('[contenteditable="true"]')!;
    expect(composer).not.toBeNull();
    composer.textContent = 'unsent draft';
    fireEvent.input(composer);
    act(() => {
      localStorage.setItem('fcm_web_overlay_settings', JSON.stringify({ fontId: 'verdana', themeId: 'amber' }));
      window.dispatchEvent(new Event(OVERLAY_SETTINGS_EVENT));
    });
    expect(container.querySelector('[contenteditable="true"]')).toBe(composer);
    expect(composer.textContent).toBe('unsent draft');
    expect(screen.getByText('Existing chat stays here')).toBeInTheDocument();
    expect(sockets).toHaveLength(1);
    expect(getComputedStyle(composer).fontFamily).toContain('Verdana');
  });

  it('ignores stale close and message callbacks after ten reconnects', async () => {
    await mount();
    act(() => { sockets[0].open(); history(sockets[0]); });
    await screen.findByText('Existing chat stays here');
    for (let i = 0; i < 10; i++) {
      const old = sockets[i];
      act(() => old.close());
      await waitFor(() => expect(sockets).toHaveLength(i + 2));
      act(() => {
        sockets[i + 1].open();
        history(sockets[i + 1]);
        old.close();
        history(old, `stale-${i}`, 'Stale connection content');
      });
      expect(screen.queryByText('Stale connection content')).not.toBeInTheDocument();
      expect(screen.getAllByText('Existing chat stays here')).toHaveLength(1);
    }
    expect(sockets).toHaveLength(11);
  });

  it('cycles exactly once and skips hidden channels', async () => {
    localStorage.setItem('fcm_web_overlay_settings', JSON.stringify({ channelFilters: ['Trading'] }));
    // Trading is deliberately absent in this case.
    render(<QueryClientProvider client={client}><MemoryRouter><Routes><Route element={<Outlet context={{ user: { id: 'alice', role: 'user' } }} />}>
      <Route path="/" element={<ChatOverlay />} />
    </Route></Routes></MemoryRouter></QueryClientProvider>);
    await screen.findByText('Events');
    act(() => command('channel:next'));
    expect(document.title).toContain('Events');
    act(() => command('channel:prev'));
    expect(document.title).toContain('General');
  });

  it('does not reload known channel history when channel metadata changes', async () => {
    await mount();
    act(() => { sockets[0].open(); history(sockets[0]); });
    await screen.findByText('Existing chat stays here');
    const before = sockets[0].sent.filter(frame => frame.type === 'chat:history').length;
    act(() => client.setQueryData(['channels'], [{ ...channels[0], color: '#00ffff' }]));
    await act(async () => {});
    expect(sockets[0].sent.filter(frame => frame.type === 'chat:history')).toHaveLength(before);
    expect(screen.getByText('Existing chat stays here')).toBeInTheDocument();
  });

  it('back-applies cosmetics from a HUD-origin live message to retained overlay rows', async () => {
    const { container } = await mount();
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'chat:history', payload: { messages: [{
        id: 'old-hud-message', content: 'Old HUD message', username: 'Devotek', user_id: 'devotek-user',
        channel_id: 'general', source: 'relay', created_at: '2026-09-16T12:00:00Z',
      }] } });
    });
    await screen.findByText('Old HUD message');
    expect(container.querySelectorAll('[data-fcm-supporter-star="true"]')).toHaveLength(0);

    act(() => socket.emit({ type: 'chat:message', payload: {
      id: 'new-hud-message', content: 'New HUD message', username: 'Devotek', userId: 'devotek-user',
      channelId: 'general', source: 'relay', timestamp: '2026-09-16T12:01:00Z',
      effectId: 'shimmer', badges: ['supporter'], starColor: '#70F835',
    } }));

    await screen.findByText('New HUD message');
    expect(container.querySelectorAll('[data-fcm-supporter-star="true"]')).toHaveLength(2);
    expect(container.querySelectorAll('.fcm-name-fx--shimmer')).toHaveLength(2);
  });

  it('limits restored Server backlog in General but keeps the complete Server subtab', async () => {
    await mount();
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'chat:history', payload: { messages: [
        { id: 'general-start', content: 'General horizon start', username: 'Bob', user_id: 'bob', channel_id: 'general', created_at: '2026-09-16T12:00:00Z' },
        { id: 'general-end', content: 'General horizon end', username: 'Bob', user_id: 'bob', channel_id: 'general', created_at: '2026-09-16T12:10:00Z' },
      ] } });
      socket.emit({ type: 'bridge:state', payload: { status: 'ready', channelId: 'server:r:room', bindingId: 'alice/nonce/r:room' } });
      socket.emit({ type: 'bridge:history', payload: {
        channelId: 'server:r:room', bindingId: 'alice/nonce/r:room', historyReplay: true,
        messages: [
          { id: 'server:r:room:1', channelId: 'server:r:room', username: 'Old', content: 'Prior Server backlog', source: 'server', timestamp: '2026-09-16T11:00:00Z' },
          { id: 'server:r:room:2', channelId: 'server:r:room', username: 'Recent', content: 'Server row inside General horizon', source: 'server', timestamp: '2026-09-16T12:05:00Z' },
        ],
      } });
    });

    await screen.findByText('Server row inside General horizon');
    expect(screen.queryByText('Prior Server backlog')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Server channel' }));
    expect(await screen.findByText('Prior Server backlog')).toBeInTheDocument();
    expect(screen.getByText('Server row inside General horizon')).toBeInTheDocument();
  });

  it.each(['user', 'admin'])('keeps the selected Server transcript during travel and fresh room hops (%s)', async role => {
    await mount(role);
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'bridge:state', payload: { status: 'ready', channelId: 'server:r:one', bindingId: 'alice/one/r:one' } });
      socket.emit({ type: 'bridge:history', payload: { channelId: 'server:r:one', bindingId: 'alice/one/r:one', historyReplay: true,
        messages: [{ id: 'server:r:one:1', channelId: 'server:r:one', username: 'Bob', content: 'Retained travel transcript', source: 'server', timestamp: '2026-09-16T11:00:00Z' }] } });
      socket.emit({ type: 'chat:history', payload: { messages: [{ id: 'general-new', channel_id: 'general', username: 'Bob', content: 'General only', created_at: '2026-09-16T12:00:00Z' }] } });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Server channel' }));
    for (const status of ['inactive', 'ambiguous', 'unavailable']) {
      act(() => socket.emit({ type: 'bridge:state', payload: { status } }));
      expect(screen.getByRole('button', { name: 'Server channel' })).toBeInTheDocument();
      expect(screen.getByText('Retained travel transcript')).toBeInTheDocument();
      expect(screen.queryByText('General only')).toBeNull();
      act(() => socket.emit({ type: 'presence:update', payload: {} }));
      expect(screen.queryByText('No players detected')).toBeNull();
      expect(get.mock.calls.some(([path]) => path === '/api/presence/same-server'
        || path.startsWith('/api/presence/server-messages'))).toBe(false);
    }
    act(() => socket.emit({ type: 'bridge:message', payload: { channelId: 'server:r:one', bindingId: 'alice/one/r:one',
      messages: [{ id: 'server:r:one:2', channelId: 'server:r:one', username: 'Bob', content: 'Stale travel message', source: 'server' }] } }));
    expect(screen.queryByText('Stale travel message')).toBeNull();
    act(() => socket.emit({ type: 'bridge:state', payload: { status: 'ready', channelId: 'server:r:two', bindingId: 'alice/two/r:two' } }));
    expect(get.mock.calls.some(([path]) => path === '/api/presence/same-server'
        || path.startsWith('/api/presence/server-messages'))).toBe(false);
    expect(screen.queryByText('No players detected')).toBeNull();
    expect(screen.getByText('Retained travel transcript')).toBeInTheDocument();
    expect(screen.queryByText('General only')).toBeNull();
    act(() => gameState(false));
    expect(screen.queryByRole('button', { name: 'Server channel' })).toBeNull();
    expect(screen.queryByText('Retained travel transcript')).toBeNull();
  });

  it('alerts once for fresh Server keywords, excluding replay, own messages and stale bindings', async () => {
    await mount();
    act(() => {
      localStorage.setItem('fcm_web_overlay_settings', JSON.stringify({ notifyKeywords: ['fixer'] }));
      window.dispatchEvent(new Event(OVERLAY_SETTINGS_EVENT));
    });
    const appear = vi.fn();
    window.addEventListener('fcm-mention-appear', appear);
    try {
      const socket = sockets[0];
      act(() => {
        socket.open();
        socket.emit({ type: 'bridge:state', payload: { status: 'ready', channelId: 'server:r:one', bindingId: 'alice/one/r:one' } });
      });
      const emit = (id: number, userId = 'bob', bindingId = 'alice/one/r:one', historyReplay = false) => act(() => socket.emit({
        type: historyReplay ? 'bridge:history' : 'bridge:message', payload: { channelId: 'server:r:one', bindingId, historyReplay,
          messages: [{ id: `server:r:one:${id}`, channelId: 'server:r:one', userId, username: 'Bob', content: 'Selling a fixer', source: 'server' }] },
      }));
      emit(1, 'bob', 'alice/one/r:one', true);
      emit(2, 'alice');
      emit(3, 'bob', 'stale');
      expect(appear).not.toHaveBeenCalled();
      emit(4);
      expect(appear).toHaveBeenCalledTimes(1);
      emit(4);
      expect(appear).toHaveBeenCalledTimes(1);
      emit(1);
      expect(appear).toHaveBeenCalledTimes(1);
      emit(5);
      expect(appear).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener('fcm-mention-appear', appear);
    }
  });

  it('retains accepted Server rows across room changes for the current overlay session', async () => {
    await mount();
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'bridge:state', payload: { status: 'ready', channelId: 'server:r:one', bindingId: 'alice/one/r:one' } });
      socket.emit({ type: 'bridge:message', payload: {
        channelId: 'server:r:one', bindingId: 'alice/one/r:one', historyReplay: false,
        messages: [{ id: 'server:r:one:1', channelId: 'server:r:one', username: 'Old', content: 'First room transcript', source: 'server', timestamp: '2026-09-16T12:00:00Z' }],
      } });
    });
    expect(await screen.findByText('First room transcript')).toBeInTheDocument();
    act(() => {
      socket.emit({ type: 'bridge:state', payload: { status: 'ready', channelId: 'server:r:two', bindingId: 'alice/two/r:two' } });
      socket.emit({ type: 'bridge:message', payload: {
        channelId: 'server:r:two', bindingId: 'alice/two/r:two', historyReplay: false,
        messages: [{ id: 'server:r:two:1', channelId: 'server:r:two', username: 'New', content: 'Second room transcript', source: 'server', timestamp: '2026-09-16T12:01:00Z' }],
      } });
    });

    expect(screen.getByText('First room transcript')).toBeInTheDocument();
    expect(screen.getByText('Second room transcript')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Server channel' }));
    expect(screen.getByText('First room transcript')).toBeInTheDocument();
    expect(screen.getByText('Second room transcript')).toBeInTheDocument();
    act(() => gameState(false));
    expect(screen.queryByText('First room transcript')).toBeNull();
    expect(screen.queryByText('Second room transcript')).toBeNull();
  });

  it('keeps the reading boundary on live append, then resets to 100 on return to latest', async () => {
    await mount();
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'chat:history', payload: { messages: Array.from({ length: 1500 }, (_, i) => ({
        id: `window-${i}`, content: `Window row ${i}`, username: 'Bob', user_id: 'bob', channel_id: 'general',
        created_at: new Date(Date.UTC(2026, 8, 16, 12, 0, i)).toISOString(),
      })) } });
    });
    const last = await screen.findByText('Window row 1499');
    expect(document.querySelectorAll('[data-fcm-message-line]')).toHaveLength(100);
    const list = last.closest('.fcm-scrollbar')!;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 10000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    list.scrollTop = 500;
    fireEvent.wheel(list, { deltaY: -100 });
    act(() => socket.emit({ type: 'chat:message', payload: {
      id: 'window-live', content: 'Latest live row', username: 'Bob', userId: 'bob', channelId: 'general',
      timestamp: '2026-09-17T12:00:00Z', source: 'game',
    } }));
    expect(screen.getByText('Window row 1400')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-fcm-message-line]')).toHaveLength(101);
    act(() => window.dispatchEvent(new Event('fcm-scroll-bottom')));
    expect(document.querySelectorAll('[data-fcm-message-line]')).toHaveLength(100);
    expect(screen.queryByText('Window row 1400')).toBeNull();
    expect(screen.getByText('Latest live row')).toBeInTheDocument();
  });

  it('keeps a pending older-page request when an unrelated history reply arrives', async () => {
    const { container } = await mount();
    const socket = sockets[0];
    act(() => {
      socket.open();
      socket.emit({ type: 'chat:history', payload: { messages: Array.from({ length: 300 }, (_, i) => ({
        id: `general-${i}`, content: `Current message ${i}`, username: 'Bob', user_id: 'bob', channel_id: 'general',
        created_at: new Date(Date.UTC(2026, 8, 16, 12, i)).toISOString(),
      })) } });
    });
    const last = await screen.findByText('Current message 299');
    const list = last.closest('.fcm-scrollbar')!;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 500 });
    // A resize/programmatic scroll must not request older history by itself.
    fireEvent.scroll(list);
    expect(socket.sent.filter(frame => frame.type === 'chat:history' && frame.payload.offset === 300)).toHaveLength(0);
    fireEvent.wheel(list, { deltaY: -100 });
    fireEvent.scroll(list);
    const lazyRequests = () => socket.sent.filter(frame => frame.type === 'chat:history' && frame.payload.offset === 300);
    expect(lazyRequests()).toHaveLength(0);
    expect(document.querySelectorAll('[data-fcm-message-line]')).toHaveLength(200);
    fireEvent.scroll(list);
    expect(lazyRequests()).toHaveLength(0);
    expect(document.querySelectorAll('[data-fcm-message-line]')).toHaveLength(300);
    fireEvent.scroll(list);
    expect(lazyRequests()).toHaveLength(1);
    act(() => socket.emit({ type: 'chat:history', payload: { messages: [{
      id: 'trading-late', channel_id: 'trading', content: 'Delayed Trading history', username: 'Bob', created_at: '2026-09-15T12:00:00Z',
    }] } }));
    fireEvent.scroll(list);
    expect(lazyRequests()).toHaveLength(1);
    act(() => history(socket, 'general-older', 'Older General page'));
    // This page's timestamp is at the captured boundary, so it belongs to General.
    await screen.findByText('Older General page');
    act(() => command('channel:next'));
    await screen.findByText('Delayed Trading history');
    expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
  });
});
