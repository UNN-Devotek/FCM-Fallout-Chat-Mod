/**
 * Pure + installable helpers extracted from bridge.ts so they can be unit-tested
 * without import-time global patching. bridge.ts now imports these and performs
 * the actual install at module load (its original behavior).
 *
 * Nothing here patches a global on import — every patch is behind an explicit
 * install function that returns a teardown, so tests can install then restore
 * the jsdom globals per-test and never leave the shared env polluted.
 */

// ── Minimal bridge surface these helpers depend on ───────────────────────────
export interface BridgeHttp {
  http(req: {
    method: string;
    path: string;
    body: string | null;
    headers: Record<string, string>;
  }): Promise<{ status: number; body: string }>;
}

export interface BridgeWs {
  wsOpen(id: string): void;
  wsSend(id: string, data: string): void;
  wsClose(id: string): void;
  onWsOpen(cb: (m: { id: string }) => void): void;
  onWsMessage(cb: (m: { id: string; data: string }) => void): void;
  onWsClose(cb: (m: { id: string; code: number; reason: string }) => void): void;
  onWsError(cb: (m: { id: string; message: string }) => void): void;
}

export interface ShellHookBridge {
  minimizeWindow(): void;
  closeWindow(): void;
  /** Re-check Discord link and supporter-role state before remounting the chat. */
  refreshDiscordStatus?(): void;
  /** Re-check the Steam link state before remounting the chat. */
  refreshSteamStatus?(): void;
}

export interface OverlayShellHook {
  title: string;
  onRefresh?: () => void;
  onSettings?: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
  relayBase?: string;
}

// ── relayBase derivation ──────────────────────────────────────────────────────

/** True for loopback hosts (localhost / 127.0.0.1 / ::1), with optional :port. */
export function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/i.test(host);
}

function relayHostname(relayHostOrBase: string): string | null {
  const raw = relayHostOrBase.trim();
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

/** True only for the known isolated hosted development relay. */
export function isHostedDevRelay(relayHostOrBase: string): boolean {
  return relayHostname(relayHostOrBase) === 'dev.falloutchatmod.com';
}

/**
 * Persona login is available only in unpackaged builds pointed at a known
 * development relay. Both local and hosted DEV use the direct synthetic-session
 * endpoint; production and unknown relays never expose the controls.
 */
export function shouldShowDevPersonaLogins(isDevBuild: boolean, relayHostOrBase: string): boolean {
  if (!isDevBuild || !relayHostOrBase) return false;
  const hostname = relayHostname(relayHostOrBase);
  return !!hostname && (isLoopbackHost(hostname) || isHostedDevRelay(relayHostOrBase));
}

/** Derive the absolute HTTP base for a relay host. loopback→http, else https. */
export function relayBaseFor(host: string): string {
  return `${isLoopbackHost(host) ? 'http' : 'https'}://${host}`;
}

/**
 * Apply the derived relayBase onto the shell hook in place. No-op when the host
 * is empty/falsy or the hook is absent (matching bridge.ts's guards).
 */
export function applyRelayBase(hook: OverlayShellHook | undefined, host: string): void {
  if (!host || !hook) return;
  hook.relayBase = relayBaseFor(host);
}

// ── shell hook ────────────────────────────────────────────────────────────────

/**
 * Build the __FCM_OVERLAY_SHELL__ hook object. Refresh/settings dispatch
 * CustomEvents on the supplied event target (window in prod); refresh also polls
 * Discord status so the backend can repair supporter-role state before the chat
 * remounts. Minimize/close go straight to the bridge IPC.
 */
export function buildShellHook(
  bridge: ShellHookBridge,
  eventTarget: Pick<EventTarget, 'dispatchEvent'>,
): OverlayShellHook {
  return {
    title: 'FALLOUT 76',
    onRefresh: () => {
      bridge.refreshDiscordStatus?.();
      bridge.refreshSteamStatus?.();
      eventTarget.dispatchEvent(new CustomEvent('fcm-shell-refresh'));
    },
    onSettings: () => eventTarget.dispatchEvent(new CustomEvent('fcm-shell-settings')),
    onMinimize: () => bridge.minimizeWindow(),
    onClose: () => bridge.closeWindow(),
  };
}

// ── fetch shim ────────────────────────────────────────────────────────────────

/** Whether a URL targets the relay (and thus should be proxied via bridge.http). */
export function isRelayPath(url: string): boolean {
  return (
    url.startsWith('/api') ||
    url.startsWith('/auth') ||
    url.includes('falloutchatmod.com/api') ||
    url.includes('falloutchatmod.com/auth')
  );
}

/** Normalize a full or relative URL down to the path+search the proxy expects. */
export function pathFromUrl(url: string): string {
  try {
    const u = new URL(url, 'http://x');
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Extract the request URL string from fetch's (input, init) overloads. */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

/**
 * Build a fetch replacement that proxies relay paths through bridge.http and
 * passes everything else to nativeFetch unchanged. Returned standalone so tests
 * can call it without touching window.fetch.
 */
export function makePatchedFetch(
  bridge: BridgeHttp,
  nativeFetch: typeof fetch,
): typeof fetch {
  return async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = urlOf(input);
    if (!isRelayPath(url)) return nativeFetch(input as any, init);

    const pathOnly = pathFromUrl(url);
    const method = (
      init?.method ||
      (input instanceof Request ? input.method : 'GET') ||
      'GET'
    ).toUpperCase();

    let body: string | null = null;
    if (init?.body != null) {
      body = typeof init.body === 'string' ? init.body : String(init.body);
    } else if (input instanceof Request && method !== 'GET' && method !== 'HEAD') {
      try {
        body = await input.clone().text();
      } catch {
        body = null;
      }
    }

    const headers: Record<string, string> = {};
    const h = init?.headers || (input instanceof Request ? input.headers : undefined);
    if (h) new Headers(h).forEach((v, k) => { headers[k] = v; });

    const { status, body: respBody } = await bridge.http({ method, path: pathOnly, body, headers });
    return new Response(respBody, {
      status,
      statusText: status === 200 || status === 201 ? 'OK' : 'Error',
      headers: { 'Content-Type': 'application/json' },
    });
  } as typeof fetch;
}

/**
 * Install the fetch shim on a target (window). Returns a teardown that restores
 * the original fetch so tests never leave the global polluted.
 */
export function installFetchShim(
  target: { fetch: typeof fetch },
  bridge: BridgeHttp,
): () => void {
  const original = target.fetch;
  target.fetch = makePatchedFetch(bridge, original);
  return () => { target.fetch = original; };
}

// ── WebSocket shim ─────────────────────────────────────────────────────────────

/**
 * Factory for the ProxiedWebSocket class + its bridge wiring, bound to a fresh
 * registry. Returns the class and the teardown is implicit (caller restores the
 * global). The component only uses: new WebSocket(url), .onopen/.onclose/
 * .onmessage/.onerror, .readyState, .send(), .close(), and WebSocket.OPEN.
 */
export function createWebSocketShim(bridge: BridgeWs) {
  let wsSeq = 0;
  const liveSockets = new Map<string, ProxiedWebSocket>();

  class ProxiedWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    url: string;
    readyState = 0;
    private _id: string;
    onopen: ((ev: any) => void) | null = null;
    onclose: ((ev: any) => void) | null = null;
    onmessage: ((ev: any) => void) | null = null;
    onerror: ((ev: any) => void) | null = null;

    constructor(url: string) {
      this.url = url;
      this._id = `ws${++wsSeq}`;
      liveSockets.set(this._id, this);
      bridge.wsOpen(this._id);
    }
    get id(): string { return this._id; }
    send(data: string) { bridge.wsSend(this._id, data); }
    close() { this.readyState = this.CLOSING; bridge.wsClose(this._id); }
    addEventListener() { /* not used by ChatOverlay */ }
    removeEventListener() { /* not used by ChatOverlay */ }

    _fireOpen() { this.readyState = this.OPEN; this.onopen?.({ type: 'open' }); }
    _fireMessage(data: string) { this.onmessage?.({ data }); }
    _fireClose(code: number, reason: string) {
      this.readyState = this.CLOSED;
      liveSockets.delete(this._id);
      this.onclose?.({ code, reason });
    }
    _fireError(message: string) { this.onerror?.({ message }); }
  }

  bridge.onWsOpen((m) => liveSockets.get(m.id)?._fireOpen());
  bridge.onWsMessage((m) => liveSockets.get(m.id)?._fireMessage(m.data));
  bridge.onWsClose((m) => liveSockets.get(m.id)?._fireClose(m.code, m.reason));
  bridge.onWsError((m) => liveSockets.get(m.id)?._fireError(m.message));

  return { ProxiedWebSocket, liveSockets };
}

/**
 * Install the WebSocket shim on a target (window), keeping the native class
 * accessible via __NativeWebSocket. Returns a teardown restoring the original.
 */
export function installWebSocketShim(
  target: { WebSocket: typeof WebSocket; __NativeWebSocket?: typeof WebSocket },
  bridge: BridgeWs,
) {
  const Native = target.WebSocket;
  const { ProxiedWebSocket, liveSockets } = createWebSocketShim(bridge);
  target.__NativeWebSocket = Native;
  target.WebSocket = ProxiedWebSocket as unknown as typeof WebSocket;
  return {
    ProxiedWebSocket,
    liveSockets,
    teardown: () => {
      target.WebSocket = Native;
      delete target.__NativeWebSocket;
    },
  };
}
