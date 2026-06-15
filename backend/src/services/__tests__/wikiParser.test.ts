import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanWikitextValue,
  filterPageImages,
  inferKind,
  isFo76Content,
  isFo76Infobox,
  isMapImage,
  parseInfobox,
  parseLocationsSection,
  type RawPageImage,
} from '../wikiParser';

// ── cleanWikitextValue ────────────────────────────────────────────────────────

test('cleanWikitextValue: piped link → label', () => {
  assert.equal(cleanWikitextValue('[[.45 round (Fallout 76)|.45 round]]'), '.45 round');
});

test('cleanWikitextValue: bare link → target', () => {
  assert.equal(cleanWikitextValue('[[Tank Killer]]'), 'Tank Killer');
});

test('cleanWikitextValue: {{dot}} becomes a separator', () => {
  assert.equal(cleanWikitextValue('Weapon{{dot}}Ranged{{dot}}Rifle'), 'Weapon · Ranged · Rifle');
});

test('cleanWikitextValue: {{icon|…}} is dropped', () => {
  assert.equal(cleanWikitextValue('{{icon|attack|tooltip=Physical damage}} 50 / 64'), '50 / 64');
});

test('cleanWikitextValue: {{ID|hex}} keeps the id', () => {
  assert.equal(cleanWikitextValue('{{ID|0046D2A1}}'), '0046D2A1');
});

test('cleanWikitextValue: NESTED templates collapse without leaving braces (regression)', () => {
  // The old flat /\{\{[^}]*\}\}/ regex left trailing "}}" garbage here.
  const out = cleanWikitextValue('{{Damage|{{IF|x|50|45}}}} done');
  assert.equal(out, 'done');
  assert.ok(!out.includes('}'), 'no stray braces');
  assert.ok(!out.includes('{'), 'no stray braces');
});

test('cleanWikitextValue: external [url label] → label', () => {
  assert.equal(cleanWikitextValue('[https://nukacrypt.com/x Improved stealth in shadows]'), 'Improved stealth in shadows');
});

test('cleanWikitextValue: strips html, refs, comments, <small>, <br>', () => {
  assert.equal(
    cleanWikitextValue('Sighted<!-- note --><ref>cite</ref> <small>(optional)</small><br />Scoped'),
    'Sighted (optional) Scoped',
  );
});

test('cleanWikitextValue: potential XSS markup reduced to text (no tags survive)', () => {
  const out = cleanWikitextValue('<b onmouseover="alert(1)">hi</b>');
  assert.ok(!out.includes('<'), 'no angle brackets remain');
  assert.ok(!out.includes('>'), 'no angle brackets remain');
});

// ── inferKind (power_armor ordering regression) ───────────────────────────────

test('inferKind: power armor shares the armor template → classified as armor (regression)', () => {
  // FO76 Fandom wiki uses {{Infobox armor FO76}} for BOTH regular armor and
  // power armor — there is no distinct "Infobox power armor FO76" template.
  // So inferKind must map 'Infobox armor FO76' → 'armor' (not 'power_armor').
  assert.equal(inferKind('Infobox armor FO76'), 'armor');
});

test('inferKind: plain armor stays armor', () => {
  assert.equal(inferKind('Infobox armor FO76'), 'armor');
});

test('inferKind: weapon / creature / item / perk', () => {
  assert.equal(inferKind('Infobox weapon FO76'), 'weapon');
  assert.equal(inferKind('Infobox creature FO76'), 'creature');
  assert.equal(inferKind('Infobox consumable FO76'), 'item');
  assert.equal(inferKind('Infobox perk'), 'perk');
  assert.equal(inferKind('Infobox plan'), 'plan');
});

test('inferKind: non-infobox template → null', () => {
  assert.equal(inferKind('For'), null);
});

// ── isFo76Infobox (cross-game scoping) ────────────────────────────────────────

test('isFo76Infobox: FO76 variant recognised, generic rejected', () => {
  assert.equal(isFo76Infobox('Infobox weapon FO76'), true);
  assert.equal(isFo76Infobox('Infobox weapon'), false);
});

// ── parseInfobox: real captured "The Fixer" infobox ───────────────────────────

const FIXER_WIKITEXT = `{{For|the consumable in ''[[Fallout: New Vegas]]''|Fixer}}
{{Infobox weapon FO76
|games       =FO76,FO76WA
|image       =FO76WA The Fixer.png
|type        =Ranged
|class       =Rifle
|keywords    =Weapon{{dot}} Ranged{{dot}} Rifle
|base type   =[[Combat rifle (Fallout 76)|Combat rifle]]
|special     =* [https://nukacrypt.com/database/json/00183312 Improved stealth in shadows]
|level       =20 / 30 / 40 / 50
|damage      ={{icon|attack|tooltip=Physical damage}} 50 / 64 / 81 / 103
|ammo        =[[.45 round (Fallout 76)|.45 round]]{{dot}} [[.45 round (Fallout 76)|(Ultracite)]]
|weight      =13.8
|value       =416
|perk pen    =[[Tank Killer]]
|formid      ={{ID|0046D2A1}}
}}`;

test('parseInfobox: extracts kind + key fields from real Fixer wikitext', () => {
  const r = parseInfobox(FIXER_WIKITEXT);
  assert.equal(r.kind, 'weapon');
  assert.equal(r.templateName, 'Infobox weapon FO76');
  assert.equal(r.isFo76, true);
  assert.equal(r.fields.type, 'Ranged');
  assert.equal(r.fields.class, 'Rifle');
  assert.equal(r.fields.weight, '13.8');
  assert.equal(r.fields.value, '416');
  assert.equal(r.fields.formid, '0046D2A1');
});

test('parseInfobox: level-scaled damage cleaned, icon stripped', () => {
  const r = parseInfobox(FIXER_WIKITEXT);
  assert.equal(r.fields.damage, '50 / 64 / 81 / 103');
});

test('parseInfobox: pipes INSIDE links do not split the field', () => {
  const r = parseInfobox(FIXER_WIKITEXT);
  // ammo had two piped links + a {{dot}} — must stay one coherent value.
  assert.equal(r.fields.ammo, '.45 round · (Ultracite)');
  assert.equal(r.fields['base type'], 'Combat rifle');
});

test('parseInfobox: external link in special field cleaned to label', () => {
  const r = parseInfobox(FIXER_WIKITEXT);
  assert.ok(r.fields.special.includes('Improved stealth in shadows'));
  assert.ok(!r.fields.special.includes('nukacrypt'));
});

test('parseInfobox: the {{For|…}} hatnote before the infobox is ignored', () => {
  const r = parseInfobox(FIXER_WIKITEXT);
  // "Fixer" / "Fallout: New Vegas" from the hatnote must NOT appear as fields.
  assert.ok(!('games' in r.fields) || r.fields.games === 'FO76,FO76WA');
  assert.equal(r.fields.games, 'FO76,FO76WA');
});

// ── parseInfobox: edge cases ──────────────────────────────────────────────────

test('parseInfobox: no infobox → null kind, empty fields', () => {
  const r = parseInfobox('Just some prose with [[a link]] and no template.');
  assert.equal(r.kind, null);
  assert.deepEqual(r.fields, {});
});

test('parseInfobox: unterminated infobox → empty result (no crash)', () => {
  const r = parseInfobox('{{Infobox weapon FO76\n|type=Ranged\n|damage=50');
  assert.equal(r.kind, null);
  assert.deepEqual(r.fields, {});
});

test('parseInfobox: empty values are dropped, not stored as ""', () => {
  const r = parseInfobox('{{Infobox item FO76\n|type=Aid\n|effect=\n|weight=0.1\n}}');
  assert.equal(r.fields.type, 'Aid');
  assert.equal(r.fields.weight, '0.1');
  assert.ok(!('effect' in r.fields), 'empty effect field omitted');
});

test('parseInfobox: cross-game (non-FO76) infobox flagged isFo76=false', () => {
  const r = parseInfobox('{{Infobox weapon\n|type=Ranged\n|damage=20\n}}');
  assert.equal(r.kind, 'weapon');
  assert.equal(r.isFo76, false);
});

// ── isMapImage ────────────────────────────────────────────────────────────────

test('isMapImage: title containing "map" (case-insensitive) is a map', () => {
  // Word-boundary rule: "map" must be preceded/followed by ^, _, -, ., space, or end.
  assert.equal(isMapImage('File:Appalachia_Map.png'), true);   // boundary: _ before Map
  assert.equal(isMapImage('File:SomeLocation_MAP.jpg'), true); // boundary: _ before MAP, . after
  assert.equal(isMapImage('File:fo76_map_full.webp'), true);   // boundary: _ before/after map
  // Embedded mid-token: "map" inside a word without boundaries → not a map image
  assert.equal(isMapImage('File:AppalachiaMap.png'), false);   // no boundary before Map
});

test('isMapImage: title containing "loc_" or "loc-" is a map', () => {
  assert.equal(isMapImage('File:loc_harpers_ferry.jpg'), true);
  assert.equal(isMapImage('File:loc-whitespring.png'), true);
});

test('isMapImage: regular render images are not maps', () => {
  assert.equal(isMapImage('File:TheFixerWeapon.png'), false);
  assert.equal(isMapImage('File:PowerArmorX01.webp'), false);
  assert.equal(isMapImage('File:BoS_Paladin.jpg'), false);
});

// ── filterPageImages ──────────────────────────────────────────────────────────

function makeImg(overrides: Partial<RawPageImage> = {}): RawPageImage {
  return {
    title: 'File:SomeWeapon.png',
    url: 'https://static.wikia.nocookie.net/fallout/SomeWeapon.png',
    width: 512,
    height: 256,
    mime: 'image/png',
    ...overrides,
  };
}

test('filterPageImages: keeps a clean render image', () => {
  const imgs = [makeImg()];
  assert.equal(filterPageImages(imgs).length, 1);
});

test('filterPageImages: drops SVG by mime', () => {
  const imgs = [makeImg({ mime: 'image/svg+xml' })];
  assert.equal(filterPageImages(imgs).length, 0);
});

test('filterPageImages: drops SVG by url extension', () => {
  const imgs = [makeImg({ mime: 'image/png', url: 'https://example.com/icon.svg' })];
  assert.equal(filterPageImages(imgs).length, 0);
});

test('filterPageImages: drops images narrower than 100px', () => {
  const imgs = [makeImg({ width: 99, height: 200 })];
  assert.equal(filterPageImages(imgs).length, 0);
});

test('filterPageImages: drops images shorter than 100px', () => {
  const imgs = [makeImg({ width: 512, height: 99 })];
  assert.equal(filterPageImages(imgs).length, 0);
});

test('filterPageImages: drops exactly 100×100 images (boundary: passes)', () => {
  // width=100, height=100 is the minimum accepted size
  const imgs = [makeImg({ width: 100, height: 100 })];
  assert.equal(filterPageImages(imgs).length, 1);
});

test('filterPageImages: drops "icon" in filename', () => {
  const imgs = [makeImg({ title: 'File:FO76_icon_weapon.png' })];
  assert.equal(filterPageImages(imgs).length, 0);
});

test('filterPageImages: drops "vault boy" variant names', () => {
  assert.equal(filterPageImages([makeImg({ title: 'File:VaultBoy_Agility.png' })]).length, 0);
  assert.equal(filterPageImages([makeImg({ title: 'File:Vault_boy_strength.jpg' })]).length, 0);
});

test('filterPageImages: drops button / marker / emote / logo names', () => {
  const junkTitles = [
    'File:Button_crafting.png',
    'File:MapMarker_camp.png',
    'File:Emote_wave.png',
    'File:FO76Logo.png',
  ];
  for (const title of junkTitles) {
    assert.equal(filterPageImages([makeImg({ title })]).length, 0, `expected drop: ${title}`);
  }
});

test('filterPageImages: drops entry with missing url', () => {
  const imgs = [makeImg({ url: '' })];
  assert.equal(filterPageImages(imgs).length, 0);
});

test('filterPageImages: drops entry with missing mime', () => {
  const imgs = [makeImg({ mime: '' })];
  assert.equal(filterPageImages(imgs).length, 0);
});

test('filterPageImages: mixed list keeps only valid entries', () => {
  const imgs = [
    makeImg(),                                              // keep
    makeImg({ mime: 'image/svg+xml' }),                     // drop svg
    makeImg({ width: 50, height: 50 }),                     // drop too small
    makeImg({ title: 'File:icon_perk.png' }),               // drop icon
    makeImg({ title: 'File:SomeArmor.webp', mime: 'image/webp' }), // keep
  ];
  assert.equal(filterPageImages(imgs).length, 2);
});

// ── parseLocationsSection ─────────────────────────────────────────────────────

test('parseLocationsSection: returns [] for text with no list lines', () => {
  const wikitext = 'This item has no location section.\nJust prose here.';
  assert.deepEqual(parseLocationsSection(wikitext), []);
});

test('parseLocationsSection: returns [] for empty string', () => {
  assert.deepEqual(parseLocationsSection(''), []);
});

test('parseLocationsSection: parses * bullet items as link segments', () => {
  const wikitext = '* [[Whitespring Resort]]\n* [[Vault 76]]';
  assert.deepEqual(parseLocationsSection(wikitext), [
    [{ text: 'Whitespring Resort', title: 'Whitespring Resort' }],
    [{ text: 'Vault 76', title: 'Vault 76' }],
  ]);
});

test('parseLocationsSection: parses # ordered list items', () => {
  assert.deepEqual(parseLocationsSection('# [[Flatwoods]]\n# [[Charleston]]'), [
    [{ text: 'Flatwoods', title: 'Flatwoods' }],
    [{ text: 'Charleston', title: 'Charleston' }],
  ]);
});

test('parseLocationsSection: parses ; definition list items', () => {
  assert.deepEqual(parseLocationsSection('; [[Morgantown]]\n; [[Harpers Ferry]]'), [
    [{ text: 'Morgantown', title: 'Morgantown' }],
    [{ text: 'Harpers Ferry', title: 'Harpers Ferry' }],
  ]);
});

test('parseLocationsSection: strips multiple leading list markers (***, ##)', () => {
  assert.deepEqual(parseLocationsSection('** [[Silo Alpha]]\n### [[Silo Bravo]]'), [
    [{ text: 'Silo Alpha', title: 'Silo Alpha' }],
    [{ text: 'Silo Bravo', title: 'Silo Bravo' }],
  ]);
});

test('parseLocationsSection: piped link uses label as text, target as title', () => {
  assert.deepEqual(parseLocationsSection('* [[Flatwoods|Town of Flatwoods]]\n* {{icon|map}} [[Morgantown Airport]]'), [
    [{ text: 'Town of Flatwoods', title: 'Flatwoods' }],
    [{ text: 'Morgantown Airport', title: 'Morgantown Airport' }],
  ]);
});

test('parseLocationsSection: links ONLY the location name, not surrounding prose', () => {
  const wikitext = '* [[Whitespring Robo Butler Collectron station]] - 13.38% chance to generate one.';
  assert.deepEqual(parseLocationsSection(wikitext), [
    [
      { text: 'Whitespring Robo Butler Collectron station', title: 'Whitespring Robo Butler Collectron station' },
      { text: ' - 13.38% chance to generate one.' },
    ],
  ]);
});

test('parseLocationsSection: mid-sentence link only links the named place', () => {
  const wikitext = '* Found in restrooms all across [[Appalachia]].';
  assert.deepEqual(parseLocationsSection(wikitext), [
    [
      { text: 'Found in restrooms all across ' },
      { text: 'Appalachia', title: 'Appalachia' },
      { text: '.' },
    ],
  ]);
});

test('parseLocationsSection: drops items that are empty after markup cleaning', () => {
  const wikitext = '* {{icon|marker}}\n* [[Whitespring Resort]]';
  assert.deepEqual(parseLocationsSection(wikitext), [
    [{ text: 'Whitespring Resort', title: 'Whitespring Resort' }],
  ]);
});

test('parseLocationsSection: ignores non-list prose lines mixed in', () => {
  const wikitext = 'Found in several locations:\n* [[Vault 51]]\nSee also: something.\n* [[The Rusty Pick]]';
  assert.deepEqual(parseLocationsSection(wikitext), [
    [{ text: 'Vault 51', title: 'Vault 51' }],
    [{ text: 'The Rusty Pick', title: 'The Rusty Pick' }],
  ]);
});

test('parseLocationsSection: handles piped links and templates in same item', () => {
  const wikitext = '* [[Whitespring Resort|The Whitespring]] (south wing)';
  const result = parseLocationsSection(wikitext);
  assert.equal(result.length, 1);
  const row = result[0];
  assert.deepEqual(row[0], { text: 'The Whitespring', title: 'Whitespring Resort' });
  assert.ok(row.some(s => s.text.includes('south wing')), 'trailing text preserved');
});

// ── isFo76Content (ingest gate predicate) ────────────────────────────────────

test('isFo76Content: FO76-specific infobox template accepted', () => {
  const parsed = parseInfobox('{{Infobox weapon FO76\n|type=Ranged\n|damage=50\n}}');
  assert.equal(isFo76Content(parsed), true);
});

test('isFo76Content: cross-game infobox with no FO76 signal rejected', () => {
  const parsed = parseInfobox('{{Infobox weapon\n|type=Ranged\n|damage=20\n}}');
  assert.equal(isFo76Content(parsed), false);
});

test('isFo76Content: no infobox at all rejected (kind=null)', () => {
  const parsed = parseInfobox('Just prose with [[a link]] and no template.');
  assert.equal(isFo76Content(parsed), false);
});

test('isFo76Content: shared-page with games=FO76 accepted', () => {
  const parsed = parseInfobox('{{Infobox item\n|games=FO76\n|type=Aid\n|weight=0.1\n}}');
  assert.equal(isFo76Content(parsed), true);
});

test('isFo76Content: shared-page with games=FO76,FO4 (comma-list) accepted', () => {
  const parsed = parseInfobox('{{Infobox item\n|games=FO4,FO76,FO3\n|type=Aid\n}}');
  assert.equal(isFo76Content(parsed), true);
});

test('isFo76Content: shared-page with games=FO4 only (no FO76 token) rejected', () => {
  const parsed = parseInfobox('{{Infobox item\n|games=FO4\n|type=Aid\n}}');
  assert.equal(isFo76Content(parsed), false);
});

test('isFo76Content: shared-page with no games field and non-FO76 template rejected', () => {
  const parsed = parseInfobox('{{Infobox armor\n|type=Light\n|resist=10\n}}');
  assert.equal(isFo76Content(parsed), false);
});

test('isFo76Content: disambiguation / hatnote-only page rejected (no infobox)', () => {
  const parsed = parseInfobox('{{For|something|something else}}\nSome disambiguation content.');
  assert.equal(isFo76Content(parsed), false);
});

test('isFo76Content: FO76 creature infobox accepted', () => {
  const parsed = parseInfobox('{{Infobox creature FO76\n|type=Animal\n}}');
  assert.equal(isFo76Content(parsed), true);
});

test('isFo76Content: games field with fo76 lowercase accepted (case-insensitive)', () => {
  const parsed = parseInfobox('{{Infobox item\n|games=fo76\n|type=Aid\n}}');
  assert.equal(isFo76Content(parsed), true);
});

test('isFo76Content: games field "FO760" does not falsely match FO76 token boundary', () => {
  // "FO760" should NOT match \bFO76\b because the word boundary fails after "6"
  const parsed = parseInfobox('{{Infobox item\n|games=FO760\n|type=Aid\n}}');
  assert.equal(isFo76Content(parsed), false);
});

// ── parseInfobox: maintenance banner skip (regression) ───────────────────────

test('parseInfobox: skips {{infobox incomplete}} banner and finds real infobox (Fat Man pattern)', () => {
  const wikitext = `{{infobox incomplete|FO76|craft/repair/scrap}}{{For|a cross-game overview|Fat Man}}
{{Infobox weapon FO76
|games=FO76
|damage=858
|weight=20.0
}}`;
  const r = parseInfobox(wikitext);
  assert.equal(r.kind, 'weapon');
  assert.equal(r.templateName, 'Infobox weapon FO76');
  assert.equal(r.isFo76, true);
  assert.equal(r.fields.weight, '20.0');
  assert.equal(isFo76Content(r), true);
});

test('parseInfobox: skips {{infobox needed}} and {{infobox stub}} banners', () => {
  const withNeeded = `{{infobox needed|FO76}}\n{{Infobox creature FO76\n|type=Animal\n}}`;
  const withStub   = `{{infobox stub|FO76}}\n{{Infobox armor FO76\n|type=Light\n}}`;
  const r1 = parseInfobox(withNeeded);
  assert.equal(r1.kind, 'creature');
  assert.equal(r1.isFo76, true);
  const r2 = parseInfobox(withStub);
  assert.equal(r2.kind, 'armor');
  assert.equal(r2.isFo76, true);
});

test('parseInfobox: {{Perks/Infobox}} recognised as perk (Bloody Mess / Adrenaline pattern)', () => {
  const wikitext = `{{For|a cross-game overview|Bloody Mess (perk)}}
{{Perks/Infobox|Bloody Mess}}

'''Bloody Mess''' is a perk.`;
  const r = parseInfobox(wikitext);
  assert.equal(r.kind, 'perk');
  assert.equal(r.templateName, 'Perks/Infobox');
  assert.equal(r.isFo76, true);
  assert.equal(isFo76Content(r), true);
});

test('parseInfobox: {{ArmorPage/Infobox}} recognised as armor (Combat armor pattern)', () => {
  const wikitext = `{{For|a cross-game overview|combat armor}}
{{ArmorPage/Infobox}}

'''Combat armor''' is an armor set.`;
  const r = parseInfobox(wikitext);
  assert.equal(r.kind, 'armor');
  assert.equal(r.templateName, 'ArmorPage/Infobox');
  assert.equal(r.isFo76, true);
  assert.equal(isFo76Content(r), true);
});

test('parseInfobox: The Fixer (control) still parses correctly after banner-skip changes', () => {
  // Re-uses the FIXER_WIKITEXT fixture defined above to confirm no regression.
  const r = parseInfobox(FIXER_WIKITEXT);
  assert.equal(r.kind, 'weapon');
  assert.equal(r.templateName, 'Infobox weapon FO76');
  assert.equal(r.isFo76, true);
  assert.equal(r.fields.weight, '13.8');
  assert.equal(isFo76Content(r), true);
});
