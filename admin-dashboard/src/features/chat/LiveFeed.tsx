import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import type { AuthUser } from '../../contexts/AuthContext';

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

interface ChatMessage {
  id: string | number;
  content: string;
  username: string;
  userId?: string;
  channelId?: string;
  channelName?: string;
  source?: string;
  msgType?: 'channel' | 'server';
  timestamp: string;
}

interface Channel {
  id: string;
  name: string;
  color?: string;
  children?: Channel[];
}

interface ReportAlert {
  id: string;
  reason: string;
  createdAt: string;
}

interface ModModalState {
  action: 'delete' | 'mute' | 'kick' | 'ban';
  target: ChatMessage;
}

const MUTE_DURATIONS = [
  { label: '1 hour', value: 60 },
  { label: '6 hours', value: 360 },
  { label: '24 hours', value: 1440 },
  { label: '7 days', value: 10080 },
  { label: 'Permanent', value: 525600 },
];

const MOD_ROLES = ['owner', 'admin', 'moderator'];
const ADMIN_ROLES = ['owner', 'admin'];

// -- Moderation Confirmation Modal --
interface ModerationModalProps {
  action: 'delete' | 'mute' | 'kick' | 'ban';
  target: ChatMessage;
  onConfirm: (body: any) => void;
  onCancel: () => void;
  loading: boolean;
  error: string | null;
}

function ModerationModal({ action, target, onConfirm, onCancel, loading, error }: ModerationModalProps) {
  const [reason, setReason] = useState('');
  const [muteDuration, setMuteDuration] = useState(60);

  // Kick and mute require a reason (server enforces). Ban opens a separate
  // evidence form in a new tab — this modal is not used for it.
  const requiresReason = action === 'mute' || action === 'ban' || action === 'kick';
  const labels: Record<string, { title: string; btn: string; cls: string }> = {
    delete: { title: 'Delete Message', btn: 'Delete', cls: 'danger' },
    mute:   { title: `Mute ${target.username}`, btn: 'Confirm Mute', cls: 'warning' },
    kick:   { title: `Kick ${target.username}`, btn: 'Confirm Kick', cls: '' },
    ban:    { title: `Ban ${target.username}`, btn: 'Confirm Ban', cls: 'danger' },
  };
  const label = labels[action];

  function handleSubmit() {
    if (requiresReason && !reason.trim()) return;
    const body: any = {};
    if (reason.trim()) body.reason = reason.trim();
    if (action === 'mute') body.duration = muteDuration;
    onConfirm(body);
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: 'var(--bg-dark)', border: '1px solid var(--phosphor-color)',
          padding: '24px', minWidth: '400px', maxWidth: '90vw',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginBottom: '16px' }}>{label.title}</h3>

        {action === 'delete' && (
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
            Message: &quot;{target.content?.slice(0, 100)}{(target.content?.length ?? 0) > 100 ? '...' : ''}&quot;
          </div>
        )}

        {action === 'mute' && (
          <>
            <label>Duration</label>
            <select
              value={muteDuration}
              onChange={(e) => setMuteDuration(Number(e.target.value))}
              style={{ width: '100%', marginTop: '8px' }}
            >
              {MUTE_DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </>
        )}

        <label style={{ marginTop: '12px', display: 'block' }}>
          Reason {requiresReason ? '(required)' : '(optional)'}
        </label>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ width: '100%', marginTop: '8px' }}
          placeholder="Enter reason..."
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
        />

        {error && <div className="error-message" style={{ marginTop: '8px' }}>{error}</div>}

        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' }}>
          <button onClick={onCancel}>Cancel</button>
          <button
            className={label.cls}
            disabled={loading || (requiresReason && !reason.trim())}
            onClick={handleSubmit}
          >
            {loading ? 'Processing...' : label.btn}
          </button>
        </div>
      </div>
    </div>
  );
}

// -- Inline Action Buttons (hover-visible) --
interface MessageActionsProps {
  msg: ChatMessage;
  userRole: string | undefined;
  onAction: (action: string, msg: ChatMessage) => void;
}

function MessageActions({ msg, userRole, onAction }: MessageActionsProps) {
  const isMod = MOD_ROLES.includes(userRole || '');
  if (!isMod) return null;

  const btnStyle: React.CSSProperties = {
    padding: '1px 5px', fontSize: '11px', minHeight: '22px', border: '1px solid var(--border-color)',
    background: 'transparent', cursor: 'pointer', lineHeight: 1,
  };

  return (
    <span className="msg-actions" style={{ display: 'inline-flex', gap: '3px', marginLeft: '8px', flexShrink: 0 }}>
      <button
        title="Delete message"
        aria-label={`Delete message from ${msg.username}`}
        style={{ ...btnStyle, color: 'var(--danger)', borderColor: 'var(--danger)' }}
        onClick={() => onAction('delete', msg)}
      >DEL</button>
      <button
        title="Mute user"
        aria-label={`Mute ${msg.username}`}
        style={{ ...btnStyle, color: 'var(--warning)', borderColor: 'var(--warning)' }}
        onClick={() => onAction('mute', msg)}
      >MUTE</button>
      <button
        title="Kick user"
        aria-label={`Kick ${msg.username}`}
        style={btnStyle}
        onClick={() => onAction('kick', msg)}
      >KICK</button>
      <button
        title="Open ban form"
        aria-label={`Ban ${msg.username}`}
        style={{ ...btnStyle, color: 'var(--danger)', borderColor: 'var(--danger)' }}
        onClick={() => onAction('ban', msg)}
      >BAN</button>
    </span>
  );
}

// -- Main LiveFeed Component --
export default function LiveFeed() {
  const outletCtx = useOutletContext<{ user?: AuthUser }>() || {};
  const user = outletCtx.user;

  const [messages, setMessages]         = useState<ChatMessage[]>([]);
  const [reportAlerts, setReportAlerts] = useState<ReportAlert[]>([]);
  const [connected, setConnected]       = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [channels, setChannels]         = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [searchInput, setSearchInput]   = useState('');
  const debouncedSearch = useDebounce(searchInput, 400);

  // Moderation modal
  const [modModal, setModModal]       = useState<ModModalState | null>(null);
  const [modLoading, setModLoading]   = useState(false);
  const [modError, setModError]       = useState<string | null>(null);

  const parentRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom]       = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  // Ref so WS onopen can read the current channel list without a stale closure.
  const channelsRef = useRef<Channel[]>([]);

  // Poll health for fullscreen client count
  const { data: healthData } = useQuery({
    queryKey: ['health-fullscreen'],
    queryFn: () => api.get('/api/health'),
    refetchInterval: 15000,
  });
  const fullscreenCount = healthData?.fullscreenClients ?? 0;

  // Fetch channel list
  const { data: channelsData } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get<Channel[]>('/api/channels'),
  });

  // Search — fires when debouncedSearch is non-empty
  const { data: searchData, isFetching: searchFetching, error: searchError } = useQuery({
    queryKey: ['messages-search', debouncedSearch],
    queryFn: () => api.get<ChatMessage[]>(`/api/messages/search?q=${encodeURIComponent(debouncedSearch)}&limit=100`),
    enabled: debouncedSearch.length > 0,
    staleTime: 10_000,
  });
  const isSearchMode = debouncedSearch.length > 0;

  useEffect(() => {
    const list = channelsData || [];
    setChannels(list);
    // Flatten so history is fetched for every channel including sub-channels.
    const flat = list.flatMap(c => [c, ...(c.children || [])]);
    channelsRef.current = flat;
    // Start in "all channels" view (activeChannelId = null).

    // If WS is already open, request history for each channel.
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && flat.length > 0) {
      for (const ch of flat) {
        ws.send(JSON.stringify({ type: 'chat:history', payload: { channelId: ch.id, limit: 300 } }));
      }
    }
  }, [channelsData, activeChannelId]);

  // WebSocket with exponential-backoff reconnect
  useEffect(() => {
    let ws: WebSocket | undefined;
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout>;

    function connect(attempt = 0) {
      if (cancelled) return;

      fetch('/auth/ws-ticket', { credentials: 'include' })
        .then((r) => {
          if (!r.ok) throw new Error('Not authenticated');
          return r.json();
        })
        .then(({ data }) => {
          if (cancelled) return;
          const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
          ws = new WebSocket(`${protocol}://${window.location.host}/ws?ticket=${data.ticket}`);
          wsRef.current = ws;

          ws.onopen = () => {
            setConnected(true);
            setError(null);
            // Request history for all currently known channels (already flattened)
            const known = channelsRef.current;
            for (const ch of known) {
              ws!.send(JSON.stringify({ type: 'chat:history', payload: { channelId: ch.id, limit: 300 } }));
            }
          };
          ws.onclose = () => {
            setConnected(false);
            if (!cancelled) {
              const delay = Math.random() * Math.min(16000, 1000 * 2 ** attempt);
              retryTimeout = setTimeout(() => connect(attempt + 1), delay);
            }
          };
          ws.onerror = () => setError('WebSocket connection failed — retrying...');

          ws.onmessage = (event) => {
            try {
              const frame = JSON.parse(event.data);
              if (frame.type === 'chat:message') {
                setMessages((prev) => [
                  ...prev.slice(-499),
                  { ...frame.payload, id: frame.payload.id || Date.now() },
                ]);
              } else if (frame.type === 'chat:history') {
                // Merge + dedup so switching channels doesn't wipe live messages.
                const incoming: ChatMessage[] = (frame.payload?.messages || []).map((m: any) => ({
                  id: m.id,
                  content: m.content,
                  username: m.username,
                  userId: m.user_id,
                  channelId: m.channel_id,
                  source: m.source,
                  timestamp: m.created_at || m.timestamp, // DB field is created_at
                }));
                setMessages((prev) => {
                  const seen = new Set(prev.map((m) => String(m.id)));
                  const newOnes = incoming.filter((m) => !seen.has(String(m.id)));
                  const merged = [...prev, ...newOnes];
                  // Keep sorted oldest→newest; cap at 1000.
                  merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                  return merged.slice(-1000);
                });
              } else if (frame.type === 'chat:delete') {
                setMessages((prev) => prev.filter((m) => String(m.id) !== frame.payload?.messageId));
              } else if (frame.type === 'mod:report') {
                setReportAlerts((prev) => [frame.payload, ...prev].slice(0, 10));
              }
            } catch {
              // ignore malformed frames
            }
          };
        })
        .catch((err: Error) => {
          if (cancelled) return;
          if (err.message === 'Not authenticated') {
            setError('Session expired — please log in again');
          } else {
            setError('Connection failed — retrying...');
            const delay = Math.random() * Math.min(16000, 1000 * 2 ** attempt);
            retryTimeout = setTimeout(() => connect(attempt + 1), delay);
          }
        });
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimeout);
      ws?.close();
    };
  }, []);


  // channelId → { name, color } for tag rendering
  const channelInfoMap = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const ch of channels) {
      map.set(ch.id, { name: ch.name, color: ch.color || '' });
      for (const sub of ch.children || []) {
        map.set(sub.id, { name: sub.name, color: sub.color || '' });
      }
    }
    return map;
  }, [channels]);

  const visibleMessages = useMemo(() => {
    if (!activeChannelId) return messages;
    // Include the active channel and all its sub-channels.
    const activeMain = channels.find(c => c.id === activeChannelId);
    const allowedIds = new Set<string>([activeChannelId]);
    if (activeMain?.children) {
      for (const sub of activeMain.children) allowedIds.add(sub.id);
    }
    return messages.filter((m) => !m.channelId || allowedIds.has(m.channelId));
  }, [messages, activeChannelId, channels]);

  // ── Virtualizer ───────────────────────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 20,
  });

  // Track scroll position for auto-scroll
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    setIsAtBottom(atBottom);
    if (atBottom) setHasNewMessages(false);
  }, []);

  // Auto-scroll when new messages arrive and user is already at the bottom
  const prevCountRef = useRef(visibleMessages.length);
  useEffect(() => {
    if (visibleMessages.length > prevCountRef.current) {
      if (isAtBottom) {
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(visibleMessages.length - 1, { align: 'end', behavior: 'smooth' });
        });
      } else {
        setHasNewMessages(true);
      }
    }
    prevCountRef.current = visibleMessages.length;
  }, [visibleMessages.length, isAtBottom, virtualizer]);

  // Scroll to bottom on first history load
  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (visibleMessages.length > 0 && !initialScrollDone.current) {
      initialScrollDone.current = true;
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(visibleMessages.length - 1, { align: 'end' });
      });
    }
  }, [visibleMessages.length, virtualizer]);

  function scrollToBottom() {
    virtualizer.scrollToIndex(visibleMessages.length - 1, { align: 'end', behavior: 'smooth' });
    setHasNewMessages(false);
  }

  // ── Moderation ────────────────────────────────────────────────────────────
  function openModModal(action: string, msg: ChatMessage) {
    if (action === 'ban') {
      // Ban requires evidence form — open in a new tab instead of the inline modal.
      const url = `/moderation/bans/new?userId=${encodeURIComponent(msg.userId ?? '')}&username=${encodeURIComponent(msg.username ?? '')}`;
      window.open(url, '_blank');
      return;
    }
    setModModal({ action: action as ModModalState['action'], target: msg });
    setModError(null);
  }

  async function executeModAction(body: any) {
    if (!modModal) return;
    const { action, target } = modModal;
    setModLoading(true);
    setModError(null);
    try {
      if (action === 'delete') {
        await api.delete(`/api/messages/${target.id}`);
        setMessages((prev) => prev.filter((m) => m.id !== target.id));
      } else if (action === 'mute') {
        // durationMinutes is capped server-side at 30 days.
        await api.post('/api/moderation/mutes', {
          userId: target.userId,
          durationMinutes: body.duration,
          category: body.category || 'Other',
          reason: body.reason || 'muted from feed',
        });
      } else if (action === 'kick') {
        if (!body.reason || !body.reason.trim()) throw new Error('Reason required for kick');
        await api.post('/api/moderation/kicks', { userId: target.userId, reason: body.reason });
      } else if (action === 'ban') {
        // Open the evidence form in a new tab with prefilled query params.
        const url = `/moderation/bans/new?userId=${encodeURIComponent(target.userId ?? '')}&username=${encodeURIComponent(target.username ?? '')}`;
        window.open(url, '_blank');
      }
      setModModal(null);
    } catch (err: any) {
      setModError(err.message);
    } finally {
      setModLoading(false);
    }
  }

  const userRole = user?.role;
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* -- Title + status -- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
        <h1 style={{ margin: 0, fontSize: '18px' }}>◈ LIVE GLOBAL FEED</h1>
        {!isSearchMode && (
          <span style={{
            fontSize: '11px',
            color: connected ? 'var(--phosphor-color)' : 'var(--danger)',
            border: `1px solid ${connected ? 'var(--phosphor-color)' : 'var(--danger)'}`,
            padding: '2px 8px',
          }}>
            {connected ? '● LIVE' : '○ OFFLINE'}
          </span>
        )}
        {isSearchMode && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', letterSpacing: '1px' }}>
            {searchFetching ? 'SEARCHING...' : `${(searchData as any)?.length ?? 0} RESULTS`}
          </span>
        )}
      </div>

      {/* -- Search bar -- */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <span style={{
            position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)',
            color: 'var(--text-muted)', fontSize: '13px', pointerEvents: 'none',
          }}>⌕</span>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search all messages & server chat..."
            aria-label="Search messages"
            style={{ paddingLeft: '28px', width: '100%', fontSize: '13px' }}
          />
        </div>
        {searchInput && (
          <button
            onClick={() => setSearchInput('')}
            aria-label="Clear search"
            style={{ fontSize: '11px', padding: '4px 12px', minHeight: '36px' }}
          >
            CLEAR
          </button>
        )}
      </div>

      {error && !isSearchMode && <div className="error-message" style={{ marginBottom: '8px' }}>{error}</div>}

      {/* -- Search results panel (shown when search is active) -- */}
      {isSearchMode && (
        <div style={{
          flex: 1,
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-color)',
          overflowY: 'auto',
          position: 'relative',
        }}>
          {searchFetching && <div className="loading">Searching...</div>}
          {searchError && <div className="error-message" style={{ padding: '12px' }}>Search failed — {(searchError as Error).message}</div>}
          {!searchFetching && !searchError && (searchData as ChatMessage[] | undefined)?.length === 0 && (
            <div className="loading">No messages matching "{debouncedSearch}"</div>
          )}
          {!searchFetching && (searchData as ChatMessage[] | undefined)?.map((msg) => (
            <div
              key={msg.id}
              className="feed-msg-row"
              style={{
                padding: '4px 8px',
                borderBottom: '1px solid rgba(42,32,16,0.6)',
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
              }}
            >
              <span style={{ color: 'var(--text-muted)', fontSize: '11px', minWidth: '64px', flexShrink: 0 }}>
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
              {(() => {
                const isServer = msg.msgType === 'server' || msg.channelId?.startsWith('server:');
                const isDiscord = msg.source === 'discord';
                const info = msg.channelId ? channelInfoMap.get(msg.channelId) : undefined;
                // Parity with the overlays: Discord-relayed messages get a single
                // purple [Discord] tag in place of the channel/server tag.
                const tagName = isDiscord
                  ? 'Discord'
                  : isServer
                    ? 'Server'
                    : msg.channelName ?? info?.name;
                const tagColor = isDiscord
                  ? '#B57AFF'
                  : isServer
                    ? 'var(--warning)'
                    : info?.color
                      ? info.color
                      : 'var(--text-muted)';
                return tagName ? (
                  <span style={{
                    fontSize: '10px',
                    padding: '1px 5px',
                    border: `1px solid ${tagColor}`,
                    color: tagColor,
                    minWidth: '50px',
                    textAlign: 'center',
                    flexShrink: 0,
                  }}>
                    {tagName}
                  </span>
                ) : null;
              })()}
              <span style={{
                color: 'var(--phosphor-color)',
                minWidth: '110px',
                fontWeight: 'bold',
                flexShrink: 0,
              }}>

                <Link
                  to={`/users?search=${encodeURIComponent(msg.username)}`}
                  className="username-link"
                  style={{ color: 'inherit', textDecoration: 'none' }}
                >
                  {msg.username}
                </Link>
              </span>
              <span style={{ color: 'var(--text-primary)', flex: 1 }}>
                {msg.content}
              </span>
              <MessageActions msg={msg} userRole={userRole} onAction={openModModal} />
            </div>
          ))}
        </div>
      )}

      {/* ── Live feed (hidden when search is active) ── */}
      {!isSearchMode && <>

      {/* -- Report alerts -- */}
      {reportAlerts.length > 0 && (
        <div data-testid="report-alerts" style={{ marginBottom: '8px' }}>
          {reportAlerts.map((r, i) => (
            <div key={`${r.id}-${i}`} style={{
              padding: '6px 10px',
              border: '1px solid var(--danger)',
              color: 'var(--danger)',
              fontSize: '12px',
              marginBottom: '4px',
            }}>
              ⚠ NEW REPORT — {r.reason} [{new Date(r.createdAt).toLocaleTimeString()}]
            </div>
          ))}
        </div>
      )}

      {/* -- Channel tabs -- */}
      {channels.length > 0 && (
        <div style={{
          display: 'flex',
          gap: '4px',
          marginBottom: '0',
          borderBottom: '1px solid var(--border-color)',
          flexWrap: 'wrap',
        }}>
          {/* ALL button */}
          <button
            onClick={() => setActiveChannelId(null)}
            aria-label="Show all channels"
            aria-pressed={activeChannelId === null}
            style={{
              padding: '6px 14px',
              fontSize: '12px',
              background: activeChannelId === null ? 'rgba(200,168,64,0.12)' : 'transparent',
              color: activeChannelId === null ? 'var(--phosphor-color)' : 'var(--text-secondary)',
              border: 'none',
              borderBottom: activeChannelId === null ? '2px solid var(--phosphor-color)' : '2px solid transparent',
              cursor: 'pointer',
              fontFamily: 'Courier New, monospace',
              fontWeight: activeChannelId === null ? 'bold' : 'normal',
            }}
          >
            ALL
          </button>
          {channels.map((ch) => (
            <button
              key={ch.id}
              onClick={() => setActiveChannelId(ch.id)}
              aria-label={`Switch to channel ${ch.name}`}
              aria-pressed={activeChannelId === ch.id}
              style={{
                padding: '6px 14px',
                fontSize: '12px',
                background: activeChannelId === ch.id ? 'rgba(200,168,64,0.12)' : 'transparent',
                color: activeChannelId === ch.id ? 'var(--phosphor-color)' : 'var(--text-secondary)',
                border: 'none',
                borderBottom: activeChannelId === ch.id ? '2px solid var(--phosphor-color)' : '2px solid transparent',
                cursor: 'pointer',
                fontFamily: 'Courier New, monospace',
                fontWeight: activeChannelId === ch.id ? 'bold' : 'normal',
              }}
            >
              {ch.name}
            </button>
          ))}
        </div>
      )}

      {/* -- Fullscreen Warning Banner -- */}
      {fullscreenCount > 0 && (
        <div
          role="alert"
          style={{
            padding: '8px 12px',
            border: '1px solid var(--warning)',
            color: 'var(--warning)',
            fontSize: '12px',
            marginBottom: '8px',
            background: 'rgba(255,170,0,0.08)',
          }}
        >
          ⚠ {fullscreenCount} client{fullscreenCount !== 1 ? 's' : ''} reporting exclusive fullscreen mode — overlay will not be visible
        </div>
      )}

      {/* -- Message feed (virtualized) -- */}
      <div
        ref={parentRef}
        data-testid="live-feed"
        role="log"
        aria-live="polite"
        aria-label="Live chat message feed"
        onScroll={handleScroll}
        style={{
          flex: 1,
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-color)',
          borderTop: channels.length > 0 ? 'none' : '1px solid var(--border-color)',
          overflowY: 'auto',
          position: 'relative',
        }}
      >
        {visibleMessages.length === 0 && (
          <div className="loading">Waiting for messages...</div>
        )}
        {visibleMessages.length > 0 && (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualItems.map((virtualRow) => {
              const msg = visibleMessages[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  data-testid="feed-message"
                  className="feed-msg-row"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                    padding: '3px 8px',
                    borderBottom: '1px solid rgba(26,58,26,0.4)',
                    display: 'flex',
                    gap: '10px',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px', minWidth: '64px', flexShrink: 0 }}>
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </span>
                  {/* Channel tag */}
                  {(() => {
                    const isServer = msg.source === 'server' || msg.channelId?.startsWith('server:');
                    const isDiscord = msg.source === 'discord';
                    const info = msg.channelId ? channelInfoMap.get(msg.channelId) : undefined;
                    const tagName = isDiscord
                      ? 'Discord'
                      : isServer
                        ? 'Server'
                        : info?.name ?? msg.channelName;
                    const tagColor = isDiscord
                      ? '#B57AFF'
                      : isServer
                        ? 'var(--warning)'
                        : info?.color
                          ? info.color
                          : 'var(--text-muted)';
                    return tagName ? (
                      <span style={{
                        fontSize: '10px',
                        padding: '1px 5px',
                        border: `1px solid ${tagColor}`,
                        color: tagColor,
                        minWidth: '50px',
                        textAlign: 'center',
                        flexShrink: 0,
                        fontFamily: 'Courier New, monospace',
                      }}>
                        {tagName}
                      </span>
                    ) : null;
                  })()}
                  <span style={{
                    color: 'var(--phosphor-color)',
                    minWidth: '100px',
                    fontWeight: 'bold',
                    flexShrink: 0,
                  }}>

                    <Link
                      to={`/users?search=${encodeURIComponent(msg.username)}`}
                      aria-label={`View user profile for ${msg.username}`}
                      className="username-link"
                      style={{ color: 'inherit', textDecoration: 'none' }}
                    >
                      {msg.username}
                    </Link>
                  </span>
                  <span style={{ color: 'var(--text-primary)', flex: 1, fontWeight: 'normal' }}>
                    {msg.content}
                  </span>
                  <MessageActions msg={msg} userRole={userRole} onAction={openModModal} />
                </div>
              );
            })}
          </div>
        )}

        {/* -- "New messages" indicator -- */}
        {hasNewMessages && (
          <button
            onClick={scrollToBottom}
            style={{
              position: 'sticky',
              bottom: '8px',
              left: '50%',
              transform: 'translateX(-50%)',
              display: 'block',
              margin: '0 auto',
              padding: '4px 16px',
              fontSize: '11px',
              minHeight: '28px',
              background: 'var(--bg-dark)',
              border: '1px solid var(--phosphor-color)',
              color: 'var(--phosphor-color)',
              cursor: 'pointer',
              zIndex: 10,
              fontFamily: 'var(--font-mono)',
            }}
          >
            New messages ↓
          </button>
        )}
      </div>

      </> /* end !isSearchMode */}


      {/* -- Moderation modal -- */}
      {modModal && (
        <ModerationModal
          action={modModal.action}
          target={modModal.target}
          onConfirm={executeModAction}
          onCancel={() => setModModal(null)}
          loading={modLoading}
          error={modError}
        />
      )}
    </div>
  );
}
