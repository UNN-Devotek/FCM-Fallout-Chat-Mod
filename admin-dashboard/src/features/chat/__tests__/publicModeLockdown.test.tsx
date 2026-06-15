// Two concerns covered here:
//   1. computePickerAnchor — pure anchor math (viewport edges, zoom flip/clamp).
//   2. Public-mode lockdown — isPublicMode = !user && !getOverlayShell().
//      Must never open the authed WebSocket or expose private party/account data.
//
// Mock seams: api module (no network), globalThis.fetch (party browser + ws-ticket),
// globalThis.WebSocket (spy — must never be constructed in public mode),
// EmojiPicker/GifPicker/ChatEmbedCard (cheap stubs, network-free).
//
// If component seams move, update this file accordingly.

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

// ── Mock seams ─────────────────────────────────────────────────────────────────

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();
vi.mock('../../services/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
    delete: (...a: unknown[]) => apiDelete(...a),
  },
}));

// Stub heavy/network children so the tree mounts cheaply.
vi.mock('../EmojiPicker', () => ({ default: () => null }));
vi.mock('../GifPicker', () => ({ default: () => null }));
vi.mock('../components/ChatEmbedCard', () => ({ ChatEmbedCard: () => null }));

import ChatOverlay, { computePickerAnchor } from '../ChatOverlay';

// ── computePickerAnchor (pure anchor math) ─────────────────────────────────────

describe('computePickerAnchor', () => {
  const origInnerW = window.innerWidth;
  const origInnerH = window.innerHeight;

  function setViewport(w: number, h: number) {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
  }
  function rect(partial: Partial<DOMRect>): DOMRect {
    return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {}, ...partial } as DOMRect;
  }
  // jsdom returns '' for an unset zoom → parseFloat('') is NaN → treated as zoom=1.
  function setRootZoom(zoom: string | null) {
    document.getElementById('root')?.remove();
    if (zoom !== null) {
      const root = document.createElement('div');
      root.id = 'root';
      root.style.zoom = zoom;
      document.body.appendChild(root);
    }
  }

  beforeEach(() => setViewport(1000, 800));
  afterEach(() => {
    document.getElementById('root')?.remove();
    Object.defineProperty(window, 'innerWidth', { value: origInnerW, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: origInnerH, configurable: true });
  });

  it('caps maxHeight/maxWidth to the picker size when the viewport is large', () => {
    setRootZoom(null);
    const r = computePickerAnchor(rect({ top: 400, right: 500 }), 320, 360, 8);
    // Picker fits comfortably → max dims equal the requested picker dims.
    expect(r.maxHeight).toBe(360);
    expect(r.maxWidth).toBe(320);
  });

  it('caps maxHeight/maxWidth to the viewport (minus 2*gap) when picker is oversized', () => {
    setRootZoom(null);
    const r = computePickerAnchor(rect({ top: 400, right: 500 }), 5000, 5000, 8);
    expect(r.maxHeight).toBe(800 - 16); // vh - gap*2
    expect(r.maxWidth).toBe(1000 - 16); // vw - gap*2
  });

  it('anchors bottom/right to the trigger top/right edges (zoom 1, no clamp needed)', () => {
    setRootZoom('1');
    const r = computePickerAnchor(rect({ top: 400, right: 600 }), 200, 200, 8);
    // bottom = vh − top = 800 − 400 = 400; right = vw − right = 1000 − 600 = 400
    expect(r.bottom).toBe(400);
    expect(r.right).toBe(400);
  });

  it('treats unset/NaN zoom as 1 (no-op)', () => {
    setRootZoom(null); // no #root at all
    const r = computePickerAnchor(rect({ top: 300, right: 700 }), 200, 200, 8);
    expect(r.bottom).toBe(800 - 300);
    expect(r.right).toBe(1000 - 700);
  });

  it('applies the overlay zoom factor to the trigger rect (1.14 scale flip fix)', () => {
    setRootZoom('1.14');
    const r = computePickerAnchor(rect({ top: 438, right: 500 }), 200, 200, 8);
    // Reported top 438 renders at 438*1.14 ≈ 499.32 → bottom = 800 - 499.32.
    expect(r.bottom).toBeCloseTo(800 - 438 * 1.14, 4);
    expect(r.right).toBeCloseTo(1000 - 500 * 1.14, 4);
  });

  it('clamps so the picker never overflows the bottom/right edges', () => {
    setRootZoom('1');
    // Trigger near top-left → clamp pins to (vh − maxHeight − gap) / (vw − maxWidth − gap).
    const r = computePickerAnchor(rect({ top: 10, right: 20 }), 200, 200, 8);
    expect(r.bottom).toBe(800 - 200 - 8);
    expect(r.right).toBe(1000 - 200 - 8);
  });

  it('clamps so the picker never crosses the top/left edges (floor of gap)', () => {
    setRootZoom('1');
    // Trigger at bottom-right → naive values would be ~0/negative; clamp floors at gap.
    const r = computePickerAnchor(rect({ top: 800, right: 1000 }), 200, 200, 8);
    expect(r.bottom).toBe(8);
    expect(r.right).toBe(8);
  });
});

// ── Public-mode lockdown (RTL) ─────────────────────────────────────────────────

describe('ChatOverlay — public-mode lockdown', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wsCtor: Mock<(url: string) => void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchMock: Mock<(...args: any[]) => Promise<Response>>;
  const realWebSocket = globalThis.WebSocket;
  const realFetch = globalThis.fetch;

  function jsonResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
  }

  beforeEach(() => {
    delete (window as unknown as { __FCM_OVERLAY_SHELL__?: unknown }).__FCM_OVERLAY_SHELL__;

    // jsdom does not implement scrollIntoView; stub so auto-scroll effects don't throw.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    } else {
      vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    }

    apiPost.mockRejectedValue(new Error('api.post MUST NOT be called in public mode'));
    apiDelete.mockRejectedValue(new Error('api.delete MUST NOT be called in public mode'));

    apiGet.mockImplementation((path: string) => {
      if (path === '/api/channels') {
        return Promise.resolve([
          { id: 'general', name: 'General', color: '' },
          { id: 'trading', name: 'Trading', color: '' },
        ]);
      }
      if (path.startsWith('/api/commands')) return Promise.resolve([]);
      if (path.startsWith('/api/messages')) return Promise.resolve([]);
      if (path.startsWith('/api/presence/server-messages')) return Promise.resolve([]);
      if (path.startsWith('/api/presence/same-server')) {
        return Promise.resolve({ serverEndpoint: null, users: [], totalChatMod: 0, allPlayers: null });
      }
      return Promise.resolve([]);
    });

    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/parties/public')) {
        return Promise.resolve(jsonResponse({ data: { parties: [] } }));
      }
      if (url.includes('/ws-ticket')) {
        // Reaching this in public mode means the WS gate was breached.
        return Promise.resolve(jsonResponse({ data: { ticket: 'SHOULD-NOT-HAPPEN' } }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    wsCtor = vi.fn();
    class FakeWS {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) { wsCtor(url); }
      send() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    }
    globalThis.WebSocket = FakeWS as unknown as typeof WebSocket;
  });

  afterEach(() => {
    cleanup();
    globalThis.WebSocket = realWebSocket;
    globalThis.fetch = realFetch;
    vi.clearAllMocks();
  });

  function renderPublic() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // No user in Outlet context → isPublicMode = !user && !shell = true.
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Routes>
            <Route element={<Outlet context={{}} />}>
              <Route path="/" element={<ChatOverlay />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('mounts in public mode without opening the authed WebSocket', async () => {
    renderPublic();
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));
    expect(wsCtor).not.toHaveBeenCalled();
  });

  it('never requests a ws-ticket in public mode (WS gate short-circuits)', async () => {
    renderPublic();
    await new Promise(r => setTimeout(r, 0));
    const ticketCalls = fetchMock.mock.calls.filter(
      ([u]) => typeof u === 'string' && u.includes('/ws-ticket'),
    );
    expect(ticketCalls).toHaveLength(0);
  });

  it('never attempts any write (api.post / api.delete) in public mode', async () => {
    renderPublic();
    await new Promise(r => setTimeout(r, 0));
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it('does not query private party invites / members in public mode', async () => {
    renderPublic();
    await new Promise(r => setTimeout(r, 0));
    const getPaths = apiGet.mock.calls.map(([p]) => String(p));
    // Auth-only endpoints must never be hit in public mode.
    expect(getPaths.some(p => p.includes('/api/parties/invites'))).toBe(false);
    expect(getPaths.some(p => /\/api\/parties\/[^/]+\/members/.test(p))).toBe(false);
    // Public read-only listing uses raw fetch, not api.get.
    expect(getPaths.some(p => p.startsWith('/api/parties?'))).toBe(false);
  });

  it('renders NO message composer / send input in public mode', async () => {
    const { container } = renderPublic();
    await new Promise(r => setTimeout(r, 0));
    // The composer is gated behind !isPublicMode and must be absent.
    expect(container.querySelector('[contenteditable="true"]')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });
});
