/**
 * FO76 name-candidate blacklist and leak-detection predicates.
 *
 * These are extracted into a standalone utility so they can be unit-tested
 * without initialising the Express server or opening database connections.
 *
 * Canonical false-positive: "Data" — confirmed live incident 2026-05-01.
 * User "Devotek-" broadcast under "Data" for ~90 s because the old predicate
 * did not recognise short PascalCase engine strings as bad candidates.
 */

// Common FO76/engine/UI words that are never real player names.
export const SHORT_ALPHA_BLACKLIST = new Set<string>([
  'Data', 'Player', 'User', 'Wanderer', 'Body', 'Head', 'Stash',
  'Inventory', 'Stats', 'Perks', 'Map', 'Menu', 'Main', 'World',
  'Server', 'Guest', 'Admin', 'Name', 'Save', 'Load', 'Exit', 'Quit',
  'Host', 'None', 'Null', 'True', 'False', 'Root', 'Base', 'Core',
  'Info', 'Text', 'Icon', 'Node', 'Item', 'List', 'Array', 'Index',
  'Count', 'Size', 'Type', 'Mode', 'State', 'Flag', 'Zone', 'Area',
  'Buff', 'Perk', 'Rank', 'Tier', 'Mark', 'Star', 'Race', 'Clan',
  'Team', 'Camp', 'Home', 'Land', 'Wild', 'Spec', 'Slot',
]);

// Scaleform/Bethesda engine identifier: PascalCase + known suffix.
export const LOOKS_LIKE_PROVIDER = /^[A-Z][A-Za-z0-9]{3,}(Data|Buffer|Graphic|Array|Provider|Container|Info|List|Menu|Texture|Widget|Component|Element|Shuttle|Service)$/;

// camelCase method/property name: lowercase start, inner capital, no separators.
export const LOOKS_LIKE_CAMELCASE_METHOD = /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/;

/**
 * Returns `true` if `username` looks like a leaked FO76 engine identifier
 * rather than a real player name. The register controller uses this to keep
 * a previously-known good name instead of overwriting it with a misread.
 */
export function isProviderLeakUsername(username: string): boolean {
  return (
    LOOKS_LIKE_PROVIDER.test(username)
    || LOOKS_LIKE_CAMELCASE_METHOD.test(username)
    || username.startsWith('m_')
    || username === 'characterName'
    || username === 'accountId'
    || username === 'avatarId'
    || SHORT_ALPHA_BLACKLIST.has(username)
  );
}
