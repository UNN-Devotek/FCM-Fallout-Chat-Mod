import { afterEach, describe, expect, it, vi } from 'vitest';
import { canStaffDelete, moderationErrorText, staffDeletePath, submitKick, submitMute, submitUnmute } from '../staffModeration';

const MOD = { isMod: true, isAdmin: false };
const ADMIN = { isMod: true, isAdmin: true };

describe('staff message delete routing', () => {
  it('sends channel messages to the messages route with an optional reason', () => {
    expect(staffDeletePath({ id: 'm1', source: 'overlay', channelId: 'c1' })).toBe('/api/messages/m1');
    expect(staffDeletePath({ id: 'm1', source: 'discord', channelId: 'c1' }, ' spam & scam ')).toBe('/api/messages/m1?reason=spam%20%26%20scam');
  });

  it('sends party messages to the admin party route, not the channel route', () => {
    expect(staffDeletePath({ id: 'm2', source: 'party', channelId: 'p9' })).toBe('/api/admin/parties/p9/messages/m2');
  });

  it('offers no delete for private messages or Server-room messages', () => {
    expect(staffDeletePath({ id: 'm3', source: 'pm', channelId: 'conv1' })).toBeNull();
    expect(staffDeletePath({ id: 'm4', source: 'server', channelId: 'server:r:abc' })).toBeNull();
    expect(staffDeletePath({ id: 'm5', source: 'game', channelId: 'server:r:abc' })).toBeNull();
    expect(canStaffDelete({ id: 'm3', source: 'pm', channelId: 'conv1' }, ADMIN)).toBe(false);
  });

  it('matches the backend thresholds: moderators delete channel messages, admins delete party messages', () => {
    expect(canStaffDelete({ id: 'm1', source: 'overlay', channelId: 'c1' }, MOD)).toBe(true);
    expect(canStaffDelete({ id: 'm2', source: 'party', channelId: 'p9' }, MOD)).toBe(false);
    expect(canStaffDelete({ id: 'm2', source: 'party', channelId: 'p9' }, ADMIN)).toBe(true);
    expect(canStaffDelete({ id: 'm1', source: 'overlay', channelId: 'c1' }, { isMod: false, isAdmin: false })).toBe(false);
  });
});

describe('moderation result text', () => {
  it('surfaces the server detail, including the protected-staff refusal', () => {
    expect(moderationErrorText(409, { code: 'ProtectedTarget', detail: 'target holds protected role "admin"' }))
      .toBe('Cannot moderate staff: target holds protected role "admin"');
    expect(moderationErrorText(400, { detail: 'reason is required' })).toBe('reason is required');
    expect(moderationErrorText(503, { code: 'ProtectionCheckFailed' })).toBe('ProtectionCheckFailed (HTTP 503)');
    expect(moderationErrorText(403, {})).toBe('Your role cannot perform this action.');
  });
});

describe('moderation submit helpers', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reports a confirmed kick as success', async () => {
    const fetchMock = stubFetch(200, { data: { kicked: true } });
    const result = await submitKick({ userId: 'u1', username: 'Raider' }, 'spam');
    expect(result).toEqual({ ok: true, message: 'Kicked Raider for 5 minutes' });
    expect(fetchMock).toHaveBeenCalledWith('/api/moderation/kicks', expect.objectContaining({ method: 'POST', body: JSON.stringify({ userId: 'u1', reason: 'spam' }) }));
  });

  it('returns the server error for a refused mute instead of closing silently', async () => {
    stubFetch(409, { code: 'ProtectedTarget', detail: 'target holds protected role "moderator"' });
    const result = await submitMute({ userId: 'u1', username: 'Raider' }, 60, 'Spam', 'spam');
    expect(result).toEqual({ ok: false, error: 'Cannot moderate staff: target holds protected role "moderator"' });
  });

  it('unmutes through the REST unmute route', async () => {
    const fetchMock = stubFetch(200, { data: { unmuted: true } });
    const result = await submitUnmute({ userId: 'u1', username: 'Raider' });
    expect(result).toEqual({ ok: true, message: 'Mute cleared for Raider' });
    expect(fetchMock).toHaveBeenCalledWith('/api/moderation/mutes/u1', expect.objectContaining({ method: 'DELETE' }));
  });
});
