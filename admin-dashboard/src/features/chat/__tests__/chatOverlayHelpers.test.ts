import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  findTheme,
  getOverlayShell,
  resolveAvatarUrl,
  resolveMediaUrl,
  hexToRgba,
  hexAlpha,
  menuBgColor,
  loadSettings,
  saveSettings,
  truncateUrl,
  classifyMedia,
  splitParts,
  splitMentions,
  contentMentionsName,
  backoffDelay,
  nextTicketRetryDelay,
  isAuthTerminal,
  channelTag,
  isPrivilegedRole,
  shouldShowInMainFeed,
  formatMessageTimestamp,
  hiddenChannelIdSet,
  mergeHistoryMessages,
  computeMainTabCutout,
  shouldForceReconnectOnVisible,
} from '../ChatOverlay';

// ── findTheme ───────────────────────────────────────────────────────────────
describe('findTheme', () => {
  it('returns the matching theme by id', () => {
    expect(findTheme('vault-tec-green').displayName).toBe('Vault-Tec Green');
    expect(findTheme('amber').id).toBe('amber');
  });

  it('falls back to the first theme for an unknown id', () => {
    expect(findTheme('does-not-exist').id).toBe('fo76-wasteland');
    expect(findTheme('').id).toBe('fo76-wasteland');
  });
});

// ── getOverlayShell ─────────────────────────────────────────────────────────
describe('getOverlayShell', () => {
  afterEach(() => {
    delete (window as unknown as { __FCM_OVERLAY_SHELL__?: unknown }).__FCM_OVERLAY_SHELL__;
  });

  it('returns null when the global is not set', () => {
    expect(getOverlayShell()).toBeNull();
  });

  it('returns the shell object when present', () => {
    const shell = { title: 'X', relayBase: 'https://relay.example.com' };
    (window as unknown as { __FCM_OVERLAY_SHELL__?: unknown }).__FCM_OVERLAY_SHELL__ = shell;
    expect(getOverlayShell()).toBe(shell);
  });
});

// ── resolveAvatarUrl ────────────────────────────────────────────────────────
describe('resolveAvatarUrl', () => {
  afterEach(() => {
    delete (window as unknown as { __FCM_OVERLAY_SHELL__?: unknown }).__FCM_OVERLAY_SHELL__;
  });

  it('returns null for null/undefined/empty', () => {
    expect(resolveAvatarUrl(null)).toBeNull();
    expect(resolveAvatarUrl(undefined)).toBeNull();
    expect(resolveAvatarUrl('')).toBeNull();
  });

  it('returns absolute URLs unchanged', () => {
    expect(resolveAvatarUrl('https://cdn.discord.com/a.png')).toBe('https://cdn.discord.com/a.png');
    expect(resolveAvatarUrl('HTTP://x.com/a.png')).toBe('HTTP://x.com/a.png');
  });

  it('returns relative path as-is on the website (no shell)', () => {
    expect(resolveAvatarUrl('/avatars/123')).toBe('/avatars/123');
  });

  it('prefixes relayBase without doubling the slash when shell present', () => {
    (window as unknown as { __FCM_OVERLAY_SHELL__?: unknown }).__FCM_OVERLAY_SHELL__ = {
      title: 'x', relayBase: 'https://relay.example.com/',
    };
    expect(resolveAvatarUrl('/avatars/123')).toBe('https://relay.example.com/avatars/123');
  });

  it('inserts a slash when path does not start with one', () => {
    (window as unknown as { __FCM_OVERLAY_SHELL__?: unknown }).__FCM_OVERLAY_SHELL__ = {
      title: 'x', relayBase: 'https://relay.example.com',
    };
    expect(resolveAvatarUrl('avatars/123')).toBe('https://relay.example.com/avatars/123');
  });

  it('returns relative as-is when shell present but no relayBase', () => {
    (window as unknown as { __FCM_OVERLAY_SHELL__?: unknown }).__FCM_OVERLAY_SHELL__ = { title: 'x' };
    expect(resolveAvatarUrl('/avatars/123')).toBe('/avatars/123');
  });
});

// ── resolveMediaUrl ─────────────────────────────────────────────────────────
describe('resolveMediaUrl', () => {
  afterEach(() => {
    delete (window as unknown as { __FCM_OVERLAY_SHELL__?: unknown }).__FCM_OVERLAY_SHELL__;
  });

  it('returns empty/absolute unchanged', () => {
    expect(resolveMediaUrl('')).toBe('');
    expect(resolveMediaUrl('https://x.com/p.png')).toBe('https://x.com/p.png');
  });

  it('returns relative path as-is without shell', () => {
    expect(resolveMediaUrl('/party-images/9')).toBe('/party-images/9');
  });

  it('prefixes relayBase when shell present', () => {
    (window as unknown as { __FCM_OVERLAY_SHELL__?: unknown }).__FCM_OVERLAY_SHELL__ = {
      title: 'x', relayBase: 'https://relay.example.com/',
    };
    expect(resolveMediaUrl('/party-images/9')).toBe('https://relay.example.com/party-images/9');
  });
});

// ── hexToRgba / hexAlpha ────────────────────────────────────────────────────
describe('hexToRgba', () => {
  it('parses #RRGGBB and applies alpha', () => {
    expect(hexToRgba('#FF8000', 0.5)).toBe('rgba(255, 128, 0, 0.5)');
    expect(hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)');
  });

  it('tolerates hex without a leading #', () => {
    expect(hexToRgba('18FF62', 0.25)).toBe('rgba(24, 255, 98, 0.25)');
  });

  it('rounds alpha to 3 decimal places', () => {
    expect(hexToRgba('#000000', 0.9411)).toBe('rgba(0, 0, 0, 0.941)');
    expect(hexToRgba('#000000', 0.3145)).toBe('rgba(0, 0, 0, 0.315)');
    expect(hexToRgba('#000000', 1 / 3)).toBe('rgba(0, 0, 0, 0.333)');
  });

  it('hexAlpha delegates to hexToRgba', () => {
    expect(hexAlpha('#FF8000', 0.5)).toBe(hexToRgba('#FF8000', 0.5));
  });
});

// ── menuBgColor ─────────────────────────────────────────────────────────────
describe('menuBgColor', () => {
  const theme = findTheme('fo76-wasteland'); // chromeColor #0C0A08, chromeAlpha 0.98

  it('floors the alpha at 0.9 when computed value would be lower', () => {
    // 0.98 * 1.4 * 0.1 = 0.1372 → floored to 0.9
    expect(menuBgColor(theme, 0.1)).toBe('rgba(12, 10, 8, 0.9)');
  });

  it('caps the alpha at 1 when computed value would exceed it', () => {
    // 0.98 * 1.4 * 1 = 1.372 → capped to 1
    expect(menuBgColor(theme, 1)).toBe('rgba(12, 10, 8, 1)');
  });

  it('uses the computed alpha when between 0.9 and 1', () => {
    // 0.98 * 1.4 * 0.7 = 0.9604 → kept
    expect(menuBgColor(theme, 0.7)).toBe('rgba(12, 10, 8, 0.96)');
  });

  it('honors a custom multiplier', () => {
    // 0.98 * 1 * 1 = 0.98 (between floor and cap)
    expect(menuBgColor(theme, 1, 1)).toBe('rgba(12, 10, 8, 0.98)');
  });
});

// ── loadSettings / saveSettings ─────────────────────────────────────────────
describe('loadSettings / saveSettings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns defaults when nothing stored', () => {
    const s = loadSettings();
    expect(s).toEqual({
      themeId: 'fo76-wasteland',
      windowOpacity: 0.9,
      textOpacity: 1.0,
      showHints: true,
      fontSize: 14,
      showTimestamps: false,
      timestampFormat: '12h',
      channelFilters: [],
    });
  });

  it('round-trips saved settings', () => {
    const custom = {
      themeId: 'amber',
      windowOpacity: 0.5,
      textOpacity: 0.8,
      showHints: false,
      fontSize: 18,
      showTimestamps: true,
      timestampFormat: '24h' as const,
      channelFilters: ['Trading'],
    };
    saveSettings(custom);
    expect(loadSettings()).toEqual(custom);
  });

  it('merges partial stored settings over defaults', () => {
    localStorage.setItem('fcm_web_overlay_settings', JSON.stringify({ themeId: 'amber' }));
    const s = loadSettings();
    expect(s.themeId).toBe('amber');
    expect(s.fontSize).toBe(14); // default preserved
    expect(s.showHints).toBe(true);
  });

  it('falls back to defaults on corrupt JSON', () => {
    localStorage.setItem('fcm_web_overlay_settings', '{not valid json');
    expect(loadSettings().themeId).toBe('fo76-wasteland');
  });
});

// ── truncateUrl ─────────────────────────────────────────────────────────────
describe('truncateUrl', () => {
  it('strips www and shows host only when there is no path', () => {
    expect(truncateUrl('https://www.youtube.com')).toBe('youtube.com');
    expect(truncateUrl('https://example.com/')).toBe('example.com');
  });

  it('appends an ellipsis path marker when a path/query/hash exists', () => {
    expect(truncateUrl('https://youtube.com/watch?v=abc')).toBe('youtube.com/…');
    expect(truncateUrl('https://example.com/page')).toBe('example.com/…');
    expect(truncateUrl('https://example.com/?q=1')).toBe('example.com/…');
  });

  it('strips trailing punctuation before parsing', () => {
    expect(truncateUrl('https://example.com).')).toBe('example.com');
  });

  it('truncates display strings longer than 32 chars', () => {
    const r = truncateUrl('https://averyveryveryveryverylonghostname.example.com/path');
    expect(r.length).toBe(32);
    expect(r.endsWith('…')).toBe(true);
  });

  it('falls back to the raw (trimmed) string when not a valid URL', () => {
    expect(truncateUrl('not a url')).toBe('not a url');
    const long = 'x'.repeat(50);
    expect(truncateUrl(long)).toBe('x'.repeat(31) + '…');
  });
});

// ── classifyMedia ───────────────────────────────────────────────────────────
describe('classifyMedia', () => {
  it('classifies direct image extensions', () => {
    for (const ext of ['gif', 'png', 'jpg', 'jpeg', 'webp', 'apng', 'avif', 'bmp']) {
      expect(classifyMedia(`https://x.com/a.${ext}`)).toBe('image');
    }
  });

  it('classifies video extensions', () => {
    for (const ext of ['mp4', 'webm', 'mov']) {
      expect(classifyMedia(`https://x.com/a.${ext}`)).toBe('video');
    }
  });

  it('matches extensions with query/hash suffixes', () => {
    expect(classifyMedia('https://x.com/a.png?width=100')).toBe('image');
    expect(classifyMedia('https://x.com/a.mp4#t=1')).toBe('video');
  });

  it('host-based fallback for Tenor/Discord CDN with a path', () => {
    expect(classifyMedia('https://media.tenor.com/abc/view')).toBe('image');
    expect(classifyMedia('https://media1.tenor.com/abc/view')).toBe('image');
    expect(classifyMedia('https://c.tenor.com/abc/view')).toBe('image');
    expect(classifyMedia('https://media.discordapp.net/attachments/1/2')).toBe('image');
  });

  it('host fallback requires a path longer than "/"', () => {
    expect(classifyMedia('https://media.tenor.com/')).toBeNull();
    expect(classifyMedia('https://media.tenor.com')).toBeNull();
  });

  it('returns null for plain non-media links', () => {
    expect(classifyMedia('https://example.com/page')).toBeNull();
    expect(classifyMedia('not a url at all')).toBeNull();
  });
});

// ── splitParts / splitMentions ──────────────────────────────────────────────
describe('splitParts', () => {
  it('returns a single plain part for plain text', () => {
    expect(splitParts('hello world')).toEqual([{ text: 'hello world', kind: 'plain' }]);
  });

  it('splits a mention out of surrounding text', () => {
    const parts = splitParts('hi @bob there');
    // Span parts carry url/emojiName (undefined for mentions).
    expect(parts).toEqual([
      { text: 'hi ', kind: 'plain' },
      { text: '@bob', kind: 'mention', url: undefined, emojiName: undefined },
      { text: ' there', kind: 'plain' },
    ]);
  });

  it('extracts urls with the url kind and href', () => {
    const parts = splitParts('see https://x.com/y now');
    const url = parts.find(p => p.kind === 'url');
    expect(url?.text).toBe('https://x.com/y');
    expect(url?.url).toBe('https://x.com/y');
  });

  it('parses static and animated custom emoji', () => {
    const parts = splitParts('<:smile:1234567890123456> <a:wave:6543210987654321>');
    const emojis = parts.filter(p => p.kind === 'emoji');
    expect(emojis).toHaveLength(2);
    expect(emojis[0].emojiName).toBe('smile');
    expect(emojis[0].url).toBe('https://cdn.discordapp.com/emojis/1234567890123456.png');
    expect(emojis[1].emojiName).toBe('wave');
    expect(emojis[1].url).toBe('https://cdn.discordapp.com/emojis/6543210987654321.webp?animated=true');
  });

  it('orders multiple spans by start position', () => {
    const parts = splitParts('@ab then https://x.com/z end');
    expect(parts.map(p => p.kind)).toEqual(['mention', 'plain', 'url', 'plain']);
  });

  it('splitMentions maps to {text, mention} shape', () => {
    expect(splitMentions('hi @bob')).toEqual([
      { text: 'hi ', mention: false },
      { text: '@bob', mention: true },
    ]);
  });
});

// ── contentMentionsName ─────────────────────────────────────────────────────
describe('contentMentionsName', () => {
  it('matches an @mention case-insensitively', () => {
    expect(contentMentionsName('hey @Bob', 'bob')).toBe(true);
    expect(contentMentionsName('hey @bob', 'BOB')).toBe(true);
  });

  it('respects word boundaries (no match on a longer name)', () => {
    expect(contentMentionsName('hey @bobby', 'bob')).toBe(false);
  });

  it('matches at end of string', () => {
    expect(contentMentionsName('ping @bob', 'bob')).toBe(true);
  });

  it('matches when followed by punctuation', () => {
    expect(contentMentionsName('ping @bob!', 'bob')).toBe(true);
    expect(contentMentionsName('ping @bob, you there', 'bob')).toBe(true);
  });

  it('returns false for empty content or short names', () => {
    expect(contentMentionsName('', 'bob')).toBe(false);
    expect(contentMentionsName('@a hi', 'a')).toBe(false); // name length < 2
  });

  it('returns false when the name appears without the @', () => {
    expect(contentMentionsName('bob says hi', 'bob')).toBe(false);
  });
});

// ── backoffDelay ────────────────────────────────────────────────────────────
describe('backoffDelay', () => {
  it('applies full jitter: delay = rand × window', () => {
    expect(backoffDelay(0, () => 1)).toBe(1000); // 1 * min(16000, 1000)
    expect(backoffDelay(3, () => 1)).toBe(8000); // 1 * min(16000, 8000)
    expect(backoffDelay(0, () => 0)).toBe(0);
  });

  it('caps the window at 16000ms for large attempts', () => {
    expect(backoffDelay(10, () => 1)).toBe(16000); // 1000*2^10 = 1024000 → capped
    expect(backoffDelay(100, () => 1)).toBe(16000);
  });

  it('scales by the injected RNG value', () => {
    expect(backoffDelay(2, () => 0.5)).toBe(2000); // 0.5 * 4000
  });

  it('defaults to Math.random producing a value within [0, window)', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(2);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(4000);
    }
  });
});

// ── channelTag ──────────────────────────────────────────────────────────────
describe('channelTag', () => {
  const channels = [
    { id: 'c-gen', name: 'General', color: '#C8A840' },
    { id: 'c-trade', name: 'Trading', color: '#4A9FE0' },
    { id: 'c-nocolor', name: 'Events', color: '   ' },
  ];
  const parties = [
    { id: 'p-1', name: 'Raid Squad', color: '#33CC99' },
    { id: 'p-2', name: 'No Color', color: '' },
  ];
  const DEF = '#deadbe';

  it('returns no label for system (bot) messages', () => {
    expect(channelTag({ source: 'bot', channelId: 'c-gen' }, channels, parties, DEF))
      .toEqual({ label: null, color: DEF });
  });

  it('renames Trading to Trade and uses the channel color', () => {
    expect(channelTag({ source: 'game', channelId: 'c-trade' }, channels, parties, DEF))
      .toEqual({ label: 'Trade', color: '#4A9FE0' });
  });

  it('uses the channel name verbatim for non-Trading channels', () => {
    expect(channelTag({ source: 'game', channelId: 'c-gen' }, channels, parties, DEF))
      .toEqual({ label: 'General', color: '#C8A840' });
  });

  it('keeps the default color when channel color is blank', () => {
    expect(channelTag({ source: 'game', channelId: 'c-nocolor' }, channels, parties, DEF))
      .toEqual({ label: 'Events', color: DEF });
  });

  it('tags discord-relayed messages purple when viewed in their own channel', () => {
    expect(channelTag({ source: 'discord', channelId: 'c-gen' }, channels, parties, DEF, 'c-gen'))
      .toEqual({ label: 'Discord', color: '#B57AFF' });
  });

  it('tags discord-relayed messages purple when no activeChannelId is provided', () => {
    expect(channelTag({ source: 'discord', channelId: 'c-gen' }, channels, parties, DEF))
      .toEqual({ label: 'Discord', color: '#B57AFF' });
  });

  it('shows source channel tag in feed view when message is from a different channel', () => {
    // Viewing the main feed (activeChannelId = main), but message is from Trading sub-channel
    expect(channelTag({ source: 'discord', channelId: 'c-trade' }, channels, parties, DEF, 'c-gen'))
      .toEqual({ label: 'Trade', color: '#4A9FE0' });
  });

  it('shows source channel name with fallback color when that channel has no color (feed view)', () => {
    expect(channelTag({ source: 'discord', channelId: 'c-nocolor' }, channels, parties, DEF, 'c-gen'))
      .toEqual({ label: 'Events', color: DEF });
  });

  it('tags server messages by source', () => {
    expect(channelTag({ source: 'server', channelId: 'c-gen' }, channels, parties, DEF))
      .toEqual({ label: 'Server', color: '#FFB000' });
  });

  it('tags server messages by server: channelId prefix', () => {
    expect(channelTag({ source: 'game', channelId: 'server:east' }, channels, parties, DEF))
      .toEqual({ label: 'Server', color: '#FFB000' });
  });

  it('tags party messages with the party name and color', () => {
    expect(channelTag({ source: 'party', channelId: 'p-1' }, channels, parties, DEF))
      .toEqual({ label: 'Raid Squad', color: '#33CC99' });
  });

  it('keeps default color when party color is blank', () => {
    expect(channelTag({ source: 'party', channelId: 'p-2' }, channels, parties, DEF))
      .toEqual({ label: 'No Color', color: DEF });
  });

  it('falls back to "Party" when no party matches', () => {
    expect(channelTag({ source: 'party', channelId: 'p-unknown' }, channels, parties, DEF))
      .toEqual({ label: 'Party', color: DEF });
  });

  it('returns null label when no channel matches', () => {
    expect(channelTag({ source: 'game', channelId: 'c-unknown' }, channels, parties, DEF))
      .toEqual({ label: null, color: DEF });
  });
});

// ── isPrivilegedRole ────────────────────────────────────────────────────────
describe('isPrivilegedRole', () => {
  it('returns true for owner', () => {
    expect(isPrivilegedRole('owner')).toBe(true);
  });

  it('returns true for admin', () => {
    expect(isPrivilegedRole('admin')).toBe(true);
  });

  it('returns true for moderator', () => {
    expect(isPrivilegedRole('moderator')).toBe(true);
  });

  it('returns false for supporter', () => {
    expect(isPrivilegedRole('supporter')).toBe(false);
  });

  it('returns false for user', () => {
    expect(isPrivilegedRole('user')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isPrivilegedRole('')).toBe(false);
  });

  it('returns false for garbage values', () => {
    expect(isPrivilegedRole('ADMIN')).toBe(false);
    expect(isPrivilegedRole('supermod')).toBe(false);
  });
});

// ── shouldShowInMainFeed ─────────────────────────────────────────────────────
describe('shouldShowInMainFeed', () => {
  const baseCtx = {
    feedParentId: 'ch-main',
    childIds: ['ch-trading', 'ch-events'],
    feedPartyIds: ['p-joined'],
    isMod: false,
    isPublicMode: false,
  };

  it('includes feedParent id regardless of role', () => {
    expect(shouldShowInMainFeed({ channelId: 'ch-main' }, baseCtx)).toBe(true);
  });

  it('includes child channel id regardless of role', () => {
    expect(shouldShowInMainFeed({ channelId: 'ch-trading' }, baseCtx)).toBe(true);
    expect(shouldShowInMainFeed({ channelId: 'ch-events' }, baseCtx)).toBe(true);
  });

  it('includes feedParty id regardless of role', () => {
    expect(shouldShowInMainFeed({ channelId: 'p-joined', source: 'party' }, baseCtx)).toBe(true);
  });

  it('excludes unrelated non-party channel for non-mod', () => {
    expect(shouldShowInMainFeed({ channelId: 'ch-foreign', source: 'game' }, baseCtx)).toBe(false);
  });

  it('includes foreign party message for isMod && !isPublicMode', () => {
    const ctx = { ...baseCtx, isMod: true, isPublicMode: false };
    expect(shouldShowInMainFeed({ channelId: 'p-foreign', source: 'party' }, ctx)).toBe(true);
  });

  it('excludes foreign party message for isMod && isPublicMode', () => {
    const ctx = { ...baseCtx, isMod: true, isPublicMode: true };
    expect(shouldShowInMainFeed({ channelId: 'p-foreign', source: 'party' }, ctx)).toBe(false);
  });

  it('excludes foreign party message for !isMod', () => {
    const ctx = { ...baseCtx, isMod: false, isPublicMode: false };
    expect(shouldShowInMainFeed({ channelId: 'p-foreign', source: 'party' }, ctx)).toBe(false);
  });

  it('excludes foreign non-party channel message for mod', () => {
    const ctx = { ...baseCtx, isMod: true, isPublicMode: false };
    expect(shouldShowInMainFeed({ channelId: 'ch-foreign', source: 'game' }, ctx)).toBe(false);
  });

  it('excludes foreign non-party channel message with undefined source for mod', () => {
    const ctx = { ...baseCtx, isMod: true, isPublicMode: false };
    expect(shouldShowInMainFeed({ channelId: 'ch-foreign' }, ctx)).toBe(false);
  });
});

// ── nextTicketRetryDelay ─────────────────────────────────────────────────────
describe('nextTicketRetryDelay', () => {
  it('delegates to the full-jitter backoff (same formula as backoffDelay)', () => {
    // With rand=()=>1, delay = 1 * min(16000, 1000 * 2^attempt)
    expect(nextTicketRetryDelay(0, () => 1)).toBe(1000);
    expect(nextTicketRetryDelay(3, () => 1)).toBe(8000);
    expect(nextTicketRetryDelay(10, () => 1)).toBe(16000);
  });

  it('returns 0 when rand returns 0', () => {
    expect(nextTicketRetryDelay(5, () => 0)).toBe(0);
  });

  it('produces a value in [0, min(16000, 1000*2^attempt)) with Math.random', () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const d = nextTicketRetryDelay(attempt);
      const cap = Math.min(16000, 1000 * 2 ** attempt);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(cap + 1); // +1 tolerance for float rounding at rand=1
    }
  });
});

// ── isAuthTerminal ───────────────────────────────────────────────────────────
describe('isAuthTerminal', () => {
  it('returns false for 0, 1, 2 consecutive auth failures', () => {
    expect(isAuthTerminal(0)).toBe(false);
    expect(isAuthTerminal(1)).toBe(false);
    expect(isAuthTerminal(2)).toBe(false);
  });

  it('returns true at exactly 3 consecutive auth failures', () => {
    expect(isAuthTerminal(3)).toBe(true);
  });

  it('returns true for counts above 3', () => {
    expect(isAuthTerminal(4)).toBe(true);
    expect(isAuthTerminal(100)).toBe(true);
  });
});

describe('formatMessageTimestamp', () => {
  // Pin locale + timeZone so output is deterministic across machines;
  // production omits both → viewer-local time.
  const iso = '2026-06-12T19:07:00.000Z';
  const opts = { locale: 'en-US', timeZone: 'UTC' } as const;

  it('formats 12-hour with AM/PM', () => {
    expect(formatMessageTimestamp(iso, '12h', opts)).toBe('7:07 PM');
  });

  it('formats 24-hour zero-padded', () => {
    expect(formatMessageTimestamp(iso, '24h', opts)).toBe('19:07');
  });

  it('renders the SAME instant in different zones as different local times', () => {
    const ny = formatMessageTimestamp(iso, '24h', { locale: 'en-US', timeZone: 'America/New_York' });
    const utc = formatMessageTimestamp(iso, '24h', opts);
    expect(ny).not.toBe(utc);          // proves it's viewer-local, not fixed
    expect(ny).toBe('15:07');          // EDT = UTC-4
  });

  it('returns empty string for missing / unparseable input', () => {
    expect(formatMessageTimestamp(null, '12h', opts)).toBe('');
    expect(formatMessageTimestamp(undefined, '12h', opts)).toBe('');
    expect(formatMessageTimestamp('', '12h', opts)).toBe('');
    expect(formatMessageTimestamp('not-a-date', '12h', opts)).toBe('');
  });

  it('accepts epoch millis and Date instances', () => {
    expect(formatMessageTimestamp(Date.parse(iso), '24h', opts)).toBe('19:07');
    expect(formatMessageTimestamp(new Date(iso), '24h', opts)).toBe('19:07');
  });
});

describe('hiddenChannelIdSet', () => {
  const channels = [
    { id: 'c-gen', name: 'General' },
    { id: 'c-trade', name: 'Trading' },
    { id: 'c-events', name: 'Events' },
  ];

  it('maps hidden channel NAMES to their ids (case-insensitive)', () => {
    const s = hiddenChannelIdSet(['Trading', 'events'], channels);
    expect([...s].sort()).toEqual(['c-events', 'c-trade']);
  });

  it('returns an empty set for no filters', () => {
    expect(hiddenChannelIdSet([], channels).size).toBe(0);
    expect(hiddenChannelIdSet(undefined, channels).size).toBe(0);
  });

  it('ignores names that match no channel', () => {
    expect([...hiddenChannelIdSet(['Nope', 'Trading'], channels)]).toEqual(['c-trade']);
  });

  it('trims and skips blank filter entries', () => {
    expect([...hiddenChannelIdSet(['  Trading  ', '   '], channels)]).toEqual(['c-trade']);
  });
});

// ── mergeHistoryMessages (refocus flash fix) ─────────────────────────────────
describe('mergeHistoryMessages', () => {
  const m = (id: string, ts: string) => ({ id, timestamp: ts });

  it('returns the SAME array ref when nothing is new (the flash fix)', () => {
    const prev = [m('a', '2026-01-01T00:00:00Z'), m('b', '2026-01-01T00:00:01Z')];
    const incoming = [m('a', '2026-01-01T00:00:00Z'), m('b', '2026-01-01T00:00:01Z')];
    const out = mergeHistoryMessages(prev, incoming, 300);
    expect(out).toBe(prev); // reference identity — no re-render / scroll-jump
  });

  it('returns the same ref when incoming is empty', () => {
    const prev = [m('a', '2026-01-01T00:00:00Z')];
    expect(mergeHistoryMessages(prev, [], 300)).toBe(prev);
  });

  it('merges and de-dupes new messages, sorted ascending by timestamp', () => {
    const prev = [m('b', '2026-01-01T00:00:02Z')];
    const incoming = [m('a', '2026-01-01T00:00:01Z'), m('b', '2026-01-01T00:00:02Z'), m('c', '2026-01-01T00:00:03Z')];
    const out = mergeHistoryMessages(prev, incoming, 300);
    expect(out).not.toBe(prev);
    expect(out.map(x => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('caps to the last N by keeping the most recent', () => {
    const prev: { id: string; timestamp: string }[] = [];
    const incoming = [m('a', '2026-01-01T00:00:01Z'), m('b', '2026-01-01T00:00:02Z'), m('c', '2026-01-01T00:00:03Z')];
    const out = mergeHistoryMessages(prev, incoming, 2);
    expect(out.map(x => x.id)).toEqual(['b', 'c']);
  });
});

// ── computeMainTabCutout (tab underline / zoom fix) ──────────────────────────
describe('computeMainTabCutout', () => {
  it('returns layout-px span [offsetLeft, offsetLeft+offsetWidth]', () => {
    expect(computeMainTabCutout(8, 104)).toEqual({ left: 8, right: 112 });
  });
  it('clamps negatives to 0', () => {
    expect(computeMainTabCutout(-5, 100)).toEqual({ left: 0, right: 95 });
    expect(computeMainTabCutout(-50, 10)).toEqual({ left: 0, right: 0 });
  });
  it('is zoom-agnostic: same layout offsets regardless of any ancestor zoom', () => {
    // offsetLeft/offsetWidth are layout px (unscaled), so the cutout span is the
    // same whatever the CSS zoom — which is the whole point of the fix.
    expect(computeMainTabCutout(8, 104)).toEqual({ left: 8, right: 112 });
  });
});

// ── shouldForceReconnectOnVisible (becoming-visible bump guard) ──────────────
describe('shouldForceReconnectOnVisible', () => {
  it('kicks when visible + disconnected + game running (gate stayed true)', () => {
    expect(shouldForceReconnectOnVisible({ isVisible: true, connected: false, wsGameActive: true })).toBe(true);
  });
  it('does NOT kick when game is NOT running (gate flips and re-runs the effect itself)', () => {
    expect(shouldForceReconnectOnVisible({ isVisible: true, connected: false, wsGameActive: false })).toBe(false);
  });
  it('does NOT kick when already connected', () => {
    expect(shouldForceReconnectOnVisible({ isVisible: true, connected: true, wsGameActive: true })).toBe(false);
  });
  it('does NOT kick on becoming hidden', () => {
    expect(shouldForceReconnectOnVisible({ isVisible: false, connected: false, wsGameActive: true })).toBe(false);
  });
});
