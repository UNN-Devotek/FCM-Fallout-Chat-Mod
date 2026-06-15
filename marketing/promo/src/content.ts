/**
 * Sample data for Remotion marketing compositions.
 * Weapon / location data mirrors the real API responses from the live backend.
 */

// ── Weapon entry — The Fixer ──────────────────────────────────────────────────

export interface WikiWeaponEntry {
  name: string;
  kind: 'weapon';
  imageUrl: string;
  imageAspect: 'ultrawide' | 'wide' | 'square';
  articleUrl: string;
  fields: Record<string, string>;
  attribution: string;
}

// page_id 592410; locations are factual but not yet parsed by the ingestor.
export const FIXER_ENTRY: WikiWeaponEntry = {
  name: 'The Fixer',
  kind: 'weapon',
  imageUrl: 'https://static.wikia.nocookie.net/fallout/images/1/19/FO76WA_The_Fixer.png/revision/latest?cb=20190412024059',
  imageAspect: 'ultrawide',
  articleUrl: 'https://fallout.fandom.com/wiki/The_Fixer',
  fields: {
    type: 'Ranged',
    class: 'Rifle',
    'base type': 'Combat rifle',
    level: '20 / 30 / 40 / 50',
    damage: '50 / 64 / 81 / 103',
    'ap used': '20',
    range: '158',
    accuracy: '70',
    'fire rate': '36',
    'clip size': '20',
    'reload time': '3.20',
    crit: '+100%',
    ammo: '.45 round · (Ultracite)',
    weight: '13.8',
    value: '416',
    formid: '0046D2A1',
    plan: 'Plan: The Fixer (Encryptid)',
    special: '* Improved stealth in shadows · Faster movespeed while sneaking',
  },
  attribution: 'Fallout Wiki · CC-BY-SA 3.0',
};

// ── Location entry — Blackwater Mine ─────────────────────────────────────────

export interface WikiLocationEntry {
  name: string;
  kind: 'location';
  imageUrl: string;
  imageAspect: 'wide' | 'square' | 'ultrawide';
  mapImageUrl?: string;
  articleUrl: string;
  fields: Record<string, string>;
  attribution: string;
}

export const BLACKWATER_MINE_ENTRY: WikiLocationEntry = {
  name: 'Blackwater Mine',
  kind: 'location',
  imageUrl: 'https://static.wikia.nocookie.net/fallout/images/thumb/5/5c/Fo76_Blackwater_mine.png/600px-Fo76_Blackwater_mine.png',
  imageAspect: 'wide',
  mapImageUrl: 'https://static.wikia.nocookie.net/fallout/images/thumb/5/5c/Fo76_Blackwater_mine_loc.png/600px-Fo76_Blackwater_mine_loc.png',
  articleUrl: 'https://fallout.fandom.com/wiki/Blackwater_Mine',
  fields: {
    type: 'quarry',
    'part of': 'Savage Divide, Appalachia',
    factions: 'Blackwater Bandits (formerly)',
    creatures: 'Feral ghouls · Mole miners · Radrats · Freddie Lang',
    quests: 'Key to the Past · Lost and Found · Uranium Fever',
    owners: 'Department of Energy (pre-War)',
    refid: '00262453',
  },
  attribution: 'Fallout Wiki · CC-BY-SA 3.0',
};

// ── Nuke codes (sample / faked) ───────────────────────────────────────────────

export interface NukeCodes {
  alpha: string;
  bravo: string;
  charlie: string;
  validUntil: string; // ISO date string
}

export const SAMPLE_NUKE_CODES: NukeCodes = {
  alpha: '38472915',
  bravo: '72814630',
  charlie: '15936284',
  validUntil: '2026-06-09T00:00:00Z',
};

// ── Server status ─────────────────────────────────────────────────────────────

export const SERVER_STATUS: 'UP' | 'DOWN' | 'UNKNOWN' = 'UP';

// ── Sample chat messages ──────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  user: string;
  tag: 'General' | 'Trading' | 'Events' | 'Raids' | 'Discord';
  text: string;
  timestamp: string;
}

export const SAMPLE_MESSAGES: ChatMessage[] = [
  {
    id: '1',
    user: 'VaultHunter76',
    tag: 'General',
    text: 'Anyone know where to find a The Fixer plan? Need it for my stealth build',
    timestamp: '14:32',
  },
  {
    id: '2',
    user: 'AtomicAnnie',
    tag: 'General',
    text: '/wiki The Fixer',
    timestamp: '14:32',
  },
  {
    id: '3',
    user: 'WastelandWarden',
    tag: 'General',
    text: 'Encryptid event drops it! Check the wiki — plan is listed under Plan: The Fixer (Encryptid)',
    timestamp: '14:33',
  },
  {
    id: '4',
    user: 'NukaColaCapper',
    tag: 'Trading',
    text: 'WTS The Fixer (AA/50vhc/25) 5k caps or best offer',
    timestamp: '14:35',
  },
  {
    id: '5',
    user: 'GhoulSlayer',
    tag: 'Events',
    text: 'Uranium Fever starting in 10 mins at Blackwater Mine — anyone want to join?',
    timestamp: '14:38',
  },
  {
    id: '6',
    user: 'RadScorpQueen',
    tag: 'Raids',
    text: 'Need 2 more for Earle Williams raid. Must have level 50+ build',
    timestamp: '14:40',
  },
  {
    id: '7',
    user: 'Devotek',
    tag: 'Discord',
    text: 'server just came back up',
    timestamp: '14:41',
  },
];

// ── Party invite sample ───────────────────────────────────────────────────────

export interface PartyInvite {
  from: string;
  partyName: string;
  memberCount: number;
  maxMembers: number;
}

export const SAMPLE_PARTY_INVITE: PartyInvite = {
  from: 'GhoulSlayer',
  partyName: 'Uranium Fever Squad',
  memberCount: 2,
  maxMembers: 4,
};

// ── Real channel colors (channels table) ─────────────────────────────────────
// Discord / Server / Infests are hardcoded in ChatOverlay, not in the DB.

export const CHANNEL_COLORS: Record<string, string> = {
  General: '#1abaff',
  Trade:   '#008f37',
  Trading: '#008f37', // same channel; the overlay renames "Trading" → "Trade" in the tag
  Events:  '#c88a51',
  Raids:   '#ce0909',
  Discord: '#B57AFF', // hardcoded in ChatOverlay (source === 'discord')
  Infests: '#44EE55', // BUILTIN_RELAYS fallback (not yet seeded in local DB)
  Server:  '#FFB000', // hardcoded in ChatOverlay (source === 'server')
};

// ── Infest channel messages ───────────────────────────────────────────────────
// Curated from production data — full infestation hunt lifecycle.

export interface InfestMessage {
  id: string;
  user: string;
  text: string;
  timestamp: string;
  source: 'game' | 'discord';
}

export const INFEST_MESSAGES: InfestMessage[] = [
  { id: 'i01', user: 'RadScorpQueen',   text: 'new inf in toxic valley — near station',       timestamp: '20:14', source: 'game' },
  { id: 'i02', user: 'AtomicAnnie',     text: 'Inf at grafton station too',                   timestamp: '20:14', source: 'game' },
  { id: 'i03', user: 'VaultHunter76',   text: 'two zones up, which first?',                   timestamp: '20:15', source: 'game' },
  { id: 'i04', user: 'GhoulSlayer',     text: 'weak one first lol',                           timestamp: '20:15', source: 'game' },
  { id: 'i05', user: 'WastelandWarden', text: 'on my way to toxic',                           timestamp: '20:15', source: 'game' },
  { id: 'i06', user: 'Devotek',         text: 'inf spotted cranberry bog — routing now',      timestamp: '20:16', source: 'discord' },
  { id: 'i07', user: 'NukaColaCapper',  text: 'hurry, boss at defiance is up',                timestamp: '20:17', source: 'game' },
  { id: 'i08', user: 'RadScorpQueen',   text: 'toxic one down — 4 star drop 🎉',             timestamp: '20:18', source: 'game' },
  { id: 'i09', user: 'AtomicAnnie',     text: 'antique store one died somehow lol',           timestamp: '20:19', source: 'game' },
  { id: 'i10', user: 'GhoulSlayer',     text: 'nah someone killed it accidentally',           timestamp: '20:19', source: 'game' },
  { id: 'i11', user: 'VaultHunter76',   text: 'rip lol',                                      timestamp: '20:20', source: 'game' },
  { id: 'i12', user: 'NukaColaCapper',  text: 'helvetia one still up — move fast',            timestamp: '20:21', source: 'game' },
  { id: 'i13', user: 'WastelandWarden', text: 'ash heap inf — heading there',                timestamp: '20:22', source: 'game' },
  { id: 'i14', user: 'RadScorpQueen',   text: 'got it! that was close',                       timestamp: '20:23', source: 'game' },
];

// ── Autocomplete suggestions — real wiki_entries, query "/wiki the fix" ───────

export interface AcSuggestion {
  name: string;
  kind: 'weapon' | 'location' | 'creature' | 'npc' | 'item' | 'plan' | 'armor' | 'ammo';
  /** Local public/ asset path (staticFile key), or null for glyph fallback. */
  thumbAsset: string | null;
}

export const AC_QUERY = '/wiki the fix';

export const AC_SUGGESTIONS: AcSuggestion[] = [
  { name: 'The Fixer',       kind: 'weapon', thumbAsset: 'ac-fixer.webp' },    // page_id 592410
  { name: 'Plan: The Fixer', kind: 'plan',   thumbAsset: 'ac-fixer.webp' },    // page_id 593211
  { name: '"The Fix"',       kind: 'item',   thumbAsset: 'ac-the-fix.webp' },  // page_id 841641
];
