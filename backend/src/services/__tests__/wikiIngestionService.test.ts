import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAliases } from '../wikiIngestionService';
import { parseInfobox } from '../wikiParser';

// ── generateAliases: alias auto-generation ────────────────────────────────────

test('generateAliases: strips "(Fallout 76)" suffix and returns it as alias', () => {
  const aliases = generateAliases('Combat Rifle (Fallout 76)');
  assert.ok(aliases.includes('Combat Rifle'), `expected 'Combat Rifle' in ${JSON.stringify(aliases)}`);
});

test('generateAliases: case-insensitive strip of "(Fallout 76)"', () => {
  const aliases = generateAliases('Stimpak (fallout 76)');
  assert.ok(aliases.includes('Stimpak'), `expected 'Stimpak' in ${JSON.stringify(aliases)}`);
});

test('generateAliases: adds plural when name does not end in s', () => {
  const aliases = generateAliases('Stimpak');
  assert.ok(aliases.includes('Stimpaks'), `expected 'Stimpaks' in ${JSON.stringify(aliases)}`);
});

test('generateAliases: adds singular guess when name ends in s', () => {
  const aliases = generateAliases('Stimulants');
  assert.ok(aliases.includes('Stimulant'), `expected 'Stimulant' in ${JSON.stringify(aliases)}`);
});

test('generateAliases: never aliases to itself (name excluded)', () => {
  const name = 'Stimpak';
  const aliases = generateAliases(name);
  assert.ok(!aliases.includes(name), `name '${name}' should not appear in its own alias list`);
});

test('generateAliases: "(Fallout 76)" stripped form also gets plural alias', () => {
  const aliases = generateAliases('Combat Rifle (Fallout 76)');
  // stripped → 'Combat Rifle'; plural of that → 'Combat Rifles'
  assert.ok(aliases.includes('Combat Rifles'), `expected 'Combat Rifles' in ${JSON.stringify(aliases)}`);
});

test('generateAliases: name without "(Fallout 76)" produces no redundant stripped alias', () => {
  const aliases = generateAliases('Stimpak');
  // No "(Fallout 76)" → no stripped form, just the plurals
  // Should not contain an empty string or the name itself
  assert.ok(!aliases.includes(''), 'no empty alias');
  assert.ok(!aliases.includes('Stimpak'), 'no self-alias');
});

test('generateAliases: returns unique strings (no duplicates)', () => {
  const aliases = generateAliases('Caps (Fallout 76)');
  const set = new Set(aliases);
  assert.equal(aliases.length, set.size, `duplicate aliases found: ${JSON.stringify(aliases)}`);
});

test('generateAliases: all returned strings are non-empty', () => {
  const aliases = generateAliases('Fusion Core (Fallout 76)');
  assert.ok(aliases.every(a => a.length > 0), `empty alias in: ${JSON.stringify(aliases)}`);
});

test('generateAliases: plain short name (no suffix, no s)', () => {
  const aliases = generateAliases('Perk');
  assert.ok(aliases.includes('Perks'));
  assert.ok(!aliases.includes('Perk'));
});

// ── FO76 / disambiguation filter logic ───────────────────────────────────────
//
// The ingestion pipeline rejects entries where isFo76=false OR kind===null.
// This logic calls parseInfobox() (from wikiParser) — we test the filter
// predicate using real wikitext snippets so there's no DB or network involved.

function shouldIngest(wikitext: string): boolean {
  const { kind, isFo76 } = parseInfobox(wikitext);
  return isFo76 === true && kind !== null;
}

test('filter: FO76 weapon infobox passes', () => {
  const wikitext = '{{Infobox weapon FO76\n|type=Ranged\n|damage=50\n}}';
  assert.equal(shouldIngest(wikitext), true);
});

test('filter: cross-game (generic) infobox is rejected (isFo76=false)', () => {
  // No "FO76" suffix on the template → isFo76Infobox returns false
  const wikitext = '{{Infobox weapon\n|type=Ranged\n|damage=20\n}}';
  assert.equal(shouldIngest(wikitext), false);
});

test('filter: page with no infobox is rejected (kind=null, isFo76=false)', () => {
  const wikitext = 'Just a prose page with [[a link]] and no template.';
  assert.equal(shouldIngest(wikitext), false);
});

test('filter: disambiguation / non-infobox template is rejected', () => {
  // "For" hatnote template only — no FO76 infobox
  const wikitext = '{{For|something|something else}}\nSome disambiguation content.';
  assert.equal(shouldIngest(wikitext), false);
});

test('filter: FO76 armor infobox passes', () => {
  const wikitext = '{{Infobox armor FO76\n|type=Light\n|resist=10\n}}';
  assert.equal(shouldIngest(wikitext), true);
});

test('filter: FO76 power armor infobox passes (not misclassified)', () => {
  const wikitext = '{{Infobox power armor FO76\n|type=T-60\n}}';
  assert.equal(shouldIngest(wikitext), true);
});

test('filter: FO76 creature infobox passes', () => {
  const wikitext = '{{Infobox creature FO76\n|type=Animal\n}}';
  assert.equal(shouldIngest(wikitext), true);
});

test('filter: cross-game power armor (no FO76 suffix) is rejected', () => {
  const wikitext = '{{Infobox power armor\n|type=T-45\n}}';
  assert.equal(shouldIngest(wikitext), false);
});

test('filter: unterminated infobox is rejected (parse returns null kind)', () => {
  const wikitext = '{{Infobox weapon FO76\n|type=Ranged\n|damage=50';
  assert.equal(shouldIngest(wikitext), false);
});

test('filter: FO76 item/consumable infobox passes', () => {
  const wikitext = '{{Infobox consumable FO76\n|type=Aid\n|weight=0.1\n}}';
  assert.equal(shouldIngest(wikitext), true);
});
