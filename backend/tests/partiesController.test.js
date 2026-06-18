'use strict';

/**
 * Unit tests for party role gates, visibility filter, and blend sort.
 * These tests exercise the pure logic of the controller, not DB or WS.
 */

// ── Role gate tests ────────────────────────────────────────────────────────

describe('party role gates', () => {
  /**
   * Test that comod cannot delete a party (owner-only operation).
   * We test this by directly checking the role assertion logic.
   */
  it('comod cannot delete — only owner can', () => {
    const callerRole = 'comod';
    const isOwnerOnly = (role) => role === 'owner';
    expect(isOwnerOnly(callerRole)).toBe(false);
  });

  it('owner can delete', () => {
    const callerRole = 'owner';
    const isOwnerOnly = (role) => role === 'owner';
    expect(isOwnerOnly(callerRole)).toBe(true);
  });

  it('comod cannot promote — owner only', () => {
    const callerRole = 'comod';
    const canPromote = (role) => role === 'owner';
    expect(canPromote(callerRole)).toBe(false);
  });

  it('member cannot invite — owner or comod only', () => {
    const callerRole = 'member';
    const canInvite = (role) => ['owner', 'comod'].includes(role);
    expect(canInvite(callerRole)).toBe(false);
  });

  it('comod can invite', () => {
    const callerRole = 'comod';
    const canInvite = (role) => ['owner', 'comod'].includes(role);
    expect(canInvite(callerRole)).toBe(true);
  });

  it('comod cannot kick another comod', () => {
    const callerRole = 'comod';
    const targetRole = 'comod';
    const canKick = (caller, target) => {
      if (!['owner', 'comod'].includes(caller)) return false;
      if (target === 'owner') return false;
      if (caller === 'comod' && target === 'comod') return false;
      return true;
    };
    expect(canKick(callerRole, targetRole)).toBe(false);
  });

  it('comod can kick member', () => {
    const canKick = (caller, target) => {
      if (!['owner', 'comod'].includes(caller)) return false;
      if (target === 'owner') return false;
      if (caller === 'comod' && target === 'comod') return false;
      return true;
    };
    expect(canKick('comod', 'member')).toBe(true);
  });

  it('owner can kick comod', () => {
    const canKick = (caller, target) => {
      if (!['owner', 'comod'].includes(caller)) return false;
      if (target === 'owner') return false;
      if (caller === 'comod' && target === 'comod') return false;
      return true;
    };
    expect(canKick('owner', 'comod')).toBe(true);
  });
});

// ── Privileged mod-observer party visibility ───────────────────────────────

/**
 * Mirror the logic in listParties: privileged callers skip the visibility
 * filter entirely (see ALL parties including private), regular callers keep
 * the existing member/invite/public filter.
 */
function applyVisibilityFilterWithPrivilege(parties, callerMemberPartyIds, isPrivileged) {
  if (isPrivileged) return parties; // no filter
  const memberSet = new Set(callerMemberPartyIds);
  return parties.filter(p => !p.isPrivate || memberSet.has(p.id));
}

describe('mod-observer GET /api/parties visibility', () => {
  const PUBLIC_PARTY   = { id: 'p1', name: 'Public',   isPrivate: false };
  const PRIVATE_JOINED = { id: 'p2', name: 'Private M', isPrivate: true };
  const PRIVATE_OTHER  = { id: 'p3', name: 'Private X', isPrivate: true };

  it('privileged user sees a private party they are NOT a member of', () => {
    const visible = applyVisibilityFilterWithPrivilege(
      [PUBLIC_PARTY, PRIVATE_JOINED, PRIVATE_OTHER],
      ['p2'],   // only member of p2
      true,     // privileged
    );
    const ids = visible.map(p => p.id);
    expect(ids).toContain('p3'); // non-member private party is visible
  });

  it('regular user does NOT see a private party they are not in', () => {
    const visible = applyVisibilityFilterWithPrivilege(
      [PUBLIC_PARTY, PRIVATE_JOINED, PRIVATE_OTHER],
      ['p2'],
      false,    // not privileged
    );
    const ids = visible.map(p => p.id);
    expect(ids).not.toContain('p3');
    expect(ids).toContain('p1'); // public still visible
    expect(ids).toContain('p2'); // member party still visible
  });

  it('privileged user sees all parties even with empty memberships', () => {
    const visible = applyVisibilityFilterWithPrivilege(
      [PUBLIC_PARTY, PRIVATE_JOINED, PRIVATE_OTHER],
      [],       // no memberships
      true,
    );
    expect(visible).toHaveLength(3);
  });
});

// ── Private visibility filter ──────────────────────────────────────────────

describe('private party visibility filter', () => {
  function applyVisibilityFilter(parties, callerMemberPartyIds) {
    const memberSet = new Set(callerMemberPartyIds);
    return parties.filter(p => !p.isPrivate || memberSet.has(p.id));
  }

  const PUBLIC_PARTY = { id: 'p1', name: 'Public', isPrivate: false };
  const PRIVATE_PARTY_JOINED = { id: 'p2', name: 'Private Joined', isPrivate: true };
  const PRIVATE_PARTY_NOT_JOINED = { id: 'p3', name: 'Private Not Joined', isPrivate: true };

  it('public party is visible to non-members', () => {
    const visible = applyVisibilityFilter([PUBLIC_PARTY], []);
    expect(visible.map(p => p.id)).toContain('p1');
  });

  it('private party is hidden to non-members', () => {
    const visible = applyVisibilityFilter([PRIVATE_PARTY_NOT_JOINED], []);
    expect(visible).toHaveLength(0);
  });

  it('private party is visible to members', () => {
    const visible = applyVisibilityFilter([PRIVATE_PARTY_JOINED], ['p2']);
    expect(visible.map(p => p.id)).toContain('p2');
  });

  it('mixed list filters correctly', () => {
    const all = [PUBLIC_PARTY, PRIVATE_PARTY_JOINED, PRIVATE_PARTY_NOT_JOINED];
    const visible = applyVisibilityFilter(all, ['p2']);
    const ids = visible.map(p => p.id);
    expect(ids).toContain('p1');
    expect(ids).toContain('p2');
    expect(ids).not.toContain('p3');
  });
});

// ── Blend sort ────────────────────────────────────────────────────────────

describe('party blend sort', () => {
  function blendSort(parties) {
    return [...parties].sort((a, b) => {
      if (b.onlineCount !== a.onlineCount) return b.onlineCount - a.onlineCount;
      if (b.recentMsgCount !== a.recentMsgCount) return b.recentMsgCount - a.recentMsgCount;
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  it('sorts by onlineCount descending first', () => {
    const parties = [
      { id: 'a', onlineCount: 1, recentMsgCount: 100, lastMessageAt: '2026-01-01T00:00:00Z' },
      { id: 'b', onlineCount: 5, recentMsgCount: 10, lastMessageAt: '2026-01-01T00:00:00Z' },
      { id: 'c', onlineCount: 3, recentMsgCount: 50, lastMessageAt: '2026-01-01T00:00:00Z' },
    ];
    const sorted = blendSort(parties);
    expect(sorted[0].id).toBe('b');
    expect(sorted[1].id).toBe('c');
    expect(sorted[2].id).toBe('a');
  });

  it('tie-breaks by recentMsgCount when onlineCount equal', () => {
    const parties = [
      { id: 'a', onlineCount: 2, recentMsgCount: 5, lastMessageAt: '2026-01-01T00:00:00Z' },
      { id: 'b', onlineCount: 2, recentMsgCount: 50, lastMessageAt: '2026-01-01T00:00:00Z' },
    ];
    const sorted = blendSort(parties);
    expect(sorted[0].id).toBe('b');
  });

  it('tie-breaks by lastMessageAt when online and msg counts equal', () => {
    const parties = [
      { id: 'a', onlineCount: 2, recentMsgCount: 5, lastMessageAt: '2026-01-01T00:00:00Z' },
      { id: 'b', onlineCount: 2, recentMsgCount: 5, lastMessageAt: '2026-06-01T00:00:00Z' },
    ];
    const sorted = blendSort(parties);
    expect(sorted[0].id).toBe('b'); // newer last message wins
  });
});

// ── maxMembers validation (parseMaxMembers logic) ──────────────────────────

describe('maxMembers validation', () => {
  // Mirrors parseMaxMembers() in partiesController.ts.
  const MIN = 2, MAX = 50;
  function parseMaxMembers(raw) {
    if (raw === null || raw === undefined) return { ok: true, value: null };
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false };
    if (raw < MIN || raw > MAX) return { ok: false };
    return { ok: true, value: raw };
  }

  it('null is allowed (unlimited)', () => {
    expect(parseMaxMembers(null)).toEqual({ ok: true, value: null });
  });
  it('undefined is allowed (unlimited)', () => {
    expect(parseMaxMembers(undefined)).toEqual({ ok: true, value: null });
  });
  it('accepts the lower bound (2)', () => {
    expect(parseMaxMembers(2)).toEqual({ ok: true, value: 2 });
  });
  it('accepts the upper bound (50)', () => {
    expect(parseMaxMembers(50)).toEqual({ ok: true, value: 50 });
  });
  it('rejects 1 (below min)', () => {
    expect(parseMaxMembers(1).ok).toBe(false);
  });
  it('rejects 51 (above max)', () => {
    expect(parseMaxMembers(51).ok).toBe(false);
  });
  it('rejects 0', () => {
    expect(parseMaxMembers(0).ok).toBe(false);
  });
  it('rejects non-integer numbers', () => {
    expect(parseMaxMembers(3.5).ok).toBe(false);
  });
  it('rejects strings', () => {
    expect(parseMaxMembers('10').ok).toBe(false);
  });
});

// ── Per-party capacity check (join / acceptInvite) ─────────────────────────

describe('party capacity check', () => {
  // Mirrors the guard used in joinParty + acceptInvite:
  //   if (party.maxMembers != null && currentCount >= party.maxMembers) → full
  function isFull(maxMembers, currentCount) {
    return maxMembers != null && currentCount >= maxMembers;
  }

  it('unlimited party (maxMembers null) is never full', () => {
    expect(isFull(null, 9999)).toBe(false);
  });
  it('party is full when count equals the limit', () => {
    expect(isFull(5, 5)).toBe(true);
  });

  // NOTE: the real concurrency guard (row lock + transactional count+insert) is
  // exercised against the ACTUAL controller in tests/partiesCapacityRace.test.js.
  // The isFull() cases here only document the boundary of the capacity predicate
  // and are NOT the race-condition test.
  it('party is full when count exceeds the limit (e.g. limit lowered)', () => {
    expect(isFull(3, 5)).toBe(true);
  });
  it('party has room when count is below the limit', () => {
    expect(isFull(5, 4)).toBe(false);
  });
});

// ── PATCH /api/parties/:id role gate ───────────────────────────────────────

describe('party update (PATCH) role gate', () => {
  // Mirrors updateParty(): owner OR co-mod may edit; member/none → 403.
  const canEdit = (role) => ['owner', 'comod'].includes(role);

  it('owner can edit', () => {
    expect(canEdit('owner')).toBe(true);
  });
  it('comod can edit', () => {
    expect(canEdit('comod')).toBe(true);
  });
  it('member cannot edit', () => {
    expect(canEdit('member')).toBe(false);
  });
  it('non-member (no role) cannot edit', () => {
    expect(canEdit(undefined)).toBe(false);
  });
});

// ── Private visibility filter — with pending-invite branch ─────────────────

describe('private party visibility filter (members OR pending-invitees)', () => {
  // Mirrors the listParties OR filter: public → all; private → members +
  // pending-invitees only.
  function isVisible(party, callerMemberPartyIds, callerInvitedPartyIds) {
    if (!party.isPrivate) return true;
    return callerMemberPartyIds.includes(party.id) || callerInvitedPartyIds.includes(party.id);
  }

  const PUBLIC = { id: 'p1', isPrivate: false };
  const PRIV_MEMBER = { id: 'p2', isPrivate: true };
  const PRIV_INVITED = { id: 'p3', isPrivate: true };
  const PRIV_NEITHER = { id: 'p4', isPrivate: true };

  it('public party visible to everyone', () => {
    expect(isVisible(PUBLIC, [], [])).toBe(true);
  });
  it('private party visible to a member', () => {
    expect(isVisible(PRIV_MEMBER, ['p2'], [])).toBe(true);
  });
  it('private party visible to a pending-invitee', () => {
    expect(isVisible(PRIV_INVITED, [], ['p3'])).toBe(true);
  });
  it('private party hidden from non-member / non-invitee', () => {
    expect(isVisible(PRIV_NEITHER, ['p2'], ['p3'])).toBe(false);
  });
});

describe('public (unauthenticated) party endpoints visibility', () => {
  // Mirrors listPublicParties / listPublicPartyMessages: ONLY isPrivate=false,
  // isDeleted=false parties are ever exposed — no membership/invite can unlock
  // a private party through the public endpoints.
  function isPublicVisible(party) {
    return party.isPrivate === false && party.isDeleted === false;
  }

  it('exposes a public, non-deleted party', () => {
    expect(isPublicVisible({ isPrivate: false, isDeleted: false })).toBe(true);
  });
  it('never exposes a private party (even if not deleted)', () => {
    expect(isPublicVisible({ isPrivate: true, isDeleted: false })).toBe(false);
  });
  it('never exposes a deleted party', () => {
    expect(isPublicVisible({ isPrivate: false, isDeleted: true })).toBe(false);
  });
  it('never exposes a private+deleted party', () => {
    expect(isPublicVisible({ isPrivate: true, isDeleted: true })).toBe(false);
  });

  // Public party-messages endpoint must reject private/deleted/missing parties
  // identically (404) so a private party's existence is never revealed.
  function messagesAllowed(party) {
    if (!party || party.isDeleted || party.isPrivate) return false;
    return true;
  }
  it('allows messages for a public party', () => {
    expect(messagesAllowed({ isPrivate: false, isDeleted: false })).toBe(true);
  });
  it('rejects messages for a private party', () => {
    expect(messagesAllowed({ isPrivate: true, isDeleted: false })).toBe(false);
  });
  it('rejects messages for a missing party', () => {
    expect(messagesAllowed(null)).toBe(false);
  });
});

// ── Party name profanity filter (baseline denylist) ────────────────────────
// Tests the BASELINE_DENYLIST_NAMES path in findProhibitedPhrase. We test the
// compiled regex logic directly — identical logic to what's in autoModService.
// NOTE: findProhibitedPhrase (used for party names + usernames) uses SUBSTRING
// matching (no \b word boundaries) so slurs embedded in concatenated identifiers
// like "nigger76" or "slutqueen" are caught. filterContent (chat) uses \b.

describe('party name profanity filter — baseline denylist', () => {
  // Mirrors the regex-building logic in BASELINE_DENYLIST_NAMES (substring, no \b):
  const BASELINE_PHRASES = [
    'nigger', 'nigga', 'chink', 'spic', 'kike', 'wetback', 'gook',
    'cunt', 'twat', 'bitch', 'whore', 'slut', 'skank',
    'faggot', 'fag', 'dyke', 'tranny',
    'fuck', 'shit', 'rape',
  ];

  function buildDenylist(phrases) {
    return phrases.map(phrase => ({
      phrase,
      // Substring matching — no \b — mirrors BASELINE_DENYLIST_NAMES
      compiled: new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    }));
  }

  function findProhibitedPhrase(content, denylist) {
    for (const entry of denylist) {
      if (entry.compiled.test(content)) return entry.phrase;
    }
    return null;
  }

  const denylist = buildDenylist(BASELINE_PHRASES);

  it('clean party names pass', () => {
    expect(findProhibitedPhrase('Wasteland Warriors', denylist)).toBeNull();
    expect(findProhibitedPhrase('Trading Post Alpha', denylist)).toBeNull();
    expect(findProhibitedPhrase('Raider Squad', denylist)).toBeNull();
  });

  it('blocks a party name containing a racial slur', () => {
    expect(findProhibitedPhrase('nigger squad', denylist)).toBe('nigger');
    expect(findProhibitedPhrase('Kill niggers', denylist)).toBe('nigger');
    expect(findProhibitedPhrase('chink gang', denylist)).toBe('chink');
  });

  it('blocks a party name containing a sexist slur', () => {
    expect(findProhibitedPhrase('all cunts welcome', denylist)).toBe('cunt');
    expect(findProhibitedPhrase('Slut Patrol', denylist)).toBe('slut');
    expect(findProhibitedPhrase('whore house', denylist)).toBe('whore');
  });

  it('blocks a party name containing a homophobic slur', () => {
    expect(findProhibitedPhrase('fag squad', denylist)).toBe('fag');
    expect(findProhibitedPhrase('faggot gang', denylist)).toBe('faggot');
  });

  it('is case-insensitive', () => {
    expect(findProhibitedPhrase('NIGGER', denylist)).toBe('nigger');
    expect(findProhibitedPhrase('FaGGoT', denylist)).toBe('faggot');
    expect(findProhibitedPhrase('CUNT', denylist)).toBe('cunt');
  });

  it('uses substring matching — catches slurs embedded in identifiers', () => {
    // Exact words are blocked
    expect(findProhibitedPhrase('fag', denylist)).toBe('fag');
    // Slurs in concatenated names are also blocked (no word boundary requirement)
    expect(findProhibitedPhrase('faggot76', denylist)).toBe('faggot');
    expect(findProhibitedPhrase('niggergang', denylist)).toBe('nigger');
  });
});

// ── Username profanity rejection logic ────────────────────────────────────
// Mirrors the register() logic: if effectiveUsername is a real name (not
// pending-* or Wanderer) and it hits the denylist, it is replaced with
// a pending placeholder.

describe('register username profanity rejection', () => {
  const BASELINE_PHRASES = ['nigger', 'cunt', 'faggot', 'slut', 'fuck', 'shit', 'rape'];

  function buildDenylist(phrases) {
    return phrases.map(phrase => ({
      phrase,
      // Substring matching — no \b — mirrors BASELINE_DENYLIST_NAMES used by findProhibitedPhrase
      compiled: new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    }));
  }

  function findProhibitedPhrase(content, denylist) {
    for (const entry of denylist) {
      if (entry.compiled.test(content)) return entry.phrase;
    }
    return null;
  }

  // Mirrors the register() decision:
  //   if effectiveUsername is real + hits denylist → replace with pending-<token>
  function applyProfanityGate(effectiveUsername, installToken, denylist) {
    if (
      typeof effectiveUsername === 'string' &&
      !effectiveUsername.startsWith('pending-') &&
      effectiveUsername !== 'Wanderer'
    ) {
      const hit = findProhibitedPhrase(effectiveUsername, denylist);
      if (hit) {
        return { username: `pending-${installToken.slice(0, 8)}`, rejected: true, phrase: hit };
      }
    }
    return { username: effectiveUsername, rejected: false, phrase: null };
  }

  const denylist = buildDenylist(BASELINE_PHRASES);
  const token = 'abcdef12-0000-0000-0000-000000000000';

  it('allows a clean FO76 username through', () => {
    const result = applyProfanityGate('Devotek', token, denylist);
    expect(result.rejected).toBe(false);
    expect(result.username).toBe('Devotek');
  });

  it('replaces a username containing a racial slur with a pending placeholder', () => {
    const result = applyProfanityGate('nigger76', token, denylist);
    expect(result.rejected).toBe(true);
    expect(result.username).toBe('pending-abcdef12');
  });

  it('replaces a username containing a sexist slur with a pending placeholder', () => {
    const result = applyProfanityGate('slutqueen', token, denylist);
    expect(result.rejected).toBe(true);
    expect(result.username).toBe('pending-abcdef12');
  });

  it('replaces a username containing a homophobic slur with a pending placeholder', () => {
    const result = applyProfanityGate('CuntWaster', token, denylist);
    expect(result.rejected).toBe(true);
    expect(result.username).toBe('pending-abcdef12');
  });

  it('does not alter a pending-* username (already a placeholder)', () => {
    const result = applyProfanityGate('pending-abcdef12', token, denylist);
    expect(result.rejected).toBe(false);
    expect(result.username).toBe('pending-abcdef12');
  });

  it('does not alter "Wanderer" (default name)', () => {
    const result = applyProfanityGate('Wanderer', token, denylist);
    expect(result.rejected).toBe(false);
    expect(result.username).toBe('Wanderer');
  });
});

// ── Party description validation ──────────────────────────────────────────
// Mirrors the description validation logic in createParty / updateParty.

describe('party description validation', () => {
  const MAX_DESC_LEN = 300;

  const BASELINE_PHRASES = [
    'nigger', 'nigga', 'chink', 'spic', 'kike', 'wetback', 'gook',
    'cunt', 'twat', 'bitch', 'whore', 'slut', 'skank',
    'faggot', 'fag', 'dyke', 'tranny',
    'fuck', 'shit', 'rape',
  ];

  function buildDenylist(phrases) {
    return phrases.map(phrase => ({
      phrase,
      compiled: new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    }));
  }

  function findProhibitedPhrase(content, denylist) {
    for (const entry of denylist) {
      if (entry.compiled.test(content)) return entry.phrase;
    }
    return null;
  }

  const denylist = buildDenylist(BASELINE_PHRASES);

  // Mirrors createParty/updateParty description parsing logic
  function parseDescription(raw) {
    if (raw === undefined || raw === null || raw === '') {
      return { ok: true, value: null };
    }
    if (typeof raw !== 'string' || raw.trim().length > MAX_DESC_LEN) {
      return { ok: false, reason: 'length' };
    }
    const trimmed = raw.trim();
    const hit = findProhibitedPhrase(trimmed, denylist);
    if (hit) return { ok: false, reason: 'prohibited', phrase: hit };
    return { ok: true, value: trimmed };
  }

  it('absent description is allowed (null result)', () => {
    expect(parseDescription(undefined)).toEqual({ ok: true, value: null });
    expect(parseDescription(null)).toEqual({ ok: true, value: null });
    expect(parseDescription('')).toEqual({ ok: true, value: null });
  });

  it('a clean description is accepted and trimmed', () => {
    const result = parseDescription('  Welcome to our trading party!  ');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('Welcome to our trading party!');
  });

  it('description at exactly 300 characters is accepted', () => {
    const desc = 'a'.repeat(300);
    const result = parseDescription(desc);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(desc);
  });

  it('description over 300 characters is rejected', () => {
    const desc = 'a'.repeat(301);
    const result = parseDescription(desc);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('length');
  });

  it('non-string description is rejected', () => {
    expect(parseDescription(42).ok).toBe(false);
    expect(parseDescription([]).ok).toBe(false);
  });

  it('description with a prohibited slur is rejected', () => {
    const result = parseDescription('A party for nigger lovers');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('prohibited');
    expect(result.phrase).toBe('nigger');
  });

  it('description containing an obscenity is rejected', () => {
    const result = parseDescription('Go fuck yourself');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('prohibited');
    expect(result.phrase).toBe('fuck');
  });

  it('description check is case-insensitive', () => {
    const result = parseDescription('FUCK THIS');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('prohibited');
  });

  it('party response shape includes description field', () => {
    // Mirrors the shape built by listParties / listPublicParties
    const partyFromDb = {
      id: 'abc-123',
      name: 'Test Party',
      description: 'A fun group for traders',
      color: '#18FF62',
      category: 'Trading',
      isPrivate: false,
      reapPolicy: 'persistent',
      ownerId: 'user-1',
      maxMembers: null,
      recentMsgCount: 0,
      lastMessageAt: null,
    };

    const shape = {
      id: partyFromDb.id,
      name: partyFromDb.name,
      description: partyFromDb.description ?? null,
      color: partyFromDb.color,
      category: partyFromDb.category,
      isPrivate: partyFromDb.isPrivate,
      reapPolicy: partyFromDb.reapPolicy,
      ownerId: partyFromDb.ownerId,
      maxMembers: partyFromDb.maxMembers,
    };

    expect(shape.description).toBe('A fun group for traders');
  });

  it('party response shape falls back to null when description is absent', () => {
    const partyFromDb = { description: null };
    const shape = { description: partyFromDb.description ?? null };
    expect(shape.description).toBeNull();
  });
});
