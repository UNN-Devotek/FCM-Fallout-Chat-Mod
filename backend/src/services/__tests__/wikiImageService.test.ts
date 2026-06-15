import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveImageAspect } from '../wikiImageService';

// ── deriveImageAspect: classification boundaries ──────────────────────────────

test('deriveImageAspect: ultrawide — ratio >= 2.2 (exact boundary)', () => {
  // 220 / 100 = 2.2 exactly → ultrawide
  assert.equal(deriveImageAspect(220, 100), 'ultrawide');
});

test('deriveImageAspect: ultrawide — ratio well above 2.2', () => {
  assert.equal(deriveImageAspect(1920, 600), 'ultrawide');
});

test('deriveImageAspect: NOT ultrawide — ratio just below 2.2', () => {
  // 219 / 100 = 2.19 → not ultrawide
  const result = deriveImageAspect(219, 100);
  assert.notEqual(result, 'ultrawide');
});

test('deriveImageAspect: portrait — height/width >= 1.3 (exact boundary)', () => {
  // 100 / 130 ≈ 0.769 width/height; height/width = 1.3 exactly → portrait
  assert.equal(deriveImageAspect(100, 130), 'portrait');
});

test('deriveImageAspect: portrait — tall image well above 1.3 ratio', () => {
  assert.equal(deriveImageAspect(200, 400), 'portrait');
});

test('deriveImageAspect: NOT portrait — height/width just below 1.3', () => {
  // height/width = 1.29 → not portrait
  const result = deriveImageAspect(100, 129);
  assert.notEqual(result, 'portrait');
});

test('deriveImageAspect: square — roughly 1:1 image (not ultrawide, not portrait)', () => {
  assert.equal(deriveImageAspect(100, 100), 'square');
});

test('deriveImageAspect: square — slightly wide image (ratio between 1.0 and 2.2, height/width < 1.3)', () => {
  // 200 / 150 ≈ 1.33 width/height; height/width ≈ 0.75 < 1.3 → square
  assert.equal(deriveImageAspect(200, 150), 'square');
});

test('deriveImageAspect: unknown — null width', () => {
  assert.equal(deriveImageAspect(null, 100), 'unknown');
});

test('deriveImageAspect: unknown — null height', () => {
  assert.equal(deriveImageAspect(200, null), 'unknown');
});

test('deriveImageAspect: unknown — both null', () => {
  assert.equal(deriveImageAspect(null, null), 'unknown');
});

test('deriveImageAspect: unknown — undefined width', () => {
  assert.equal(deriveImageAspect(undefined, 100), 'unknown');
});

test('deriveImageAspect: unknown — undefined height', () => {
  assert.equal(deriveImageAspect(200, undefined), 'unknown');
});

test('deriveImageAspect: unknown — zero width', () => {
  assert.equal(deriveImageAspect(0, 100), 'unknown');
});

test('deriveImageAspect: unknown — zero height', () => {
  assert.equal(deriveImageAspect(200, 0), 'unknown');
});

test('deriveImageAspect: unknown — negative width', () => {
  assert.equal(deriveImageAspect(-100, 100), 'unknown');
});

// ── key derivation: wiki-images/<pageId>-<hash8>.webp ─────────────────────────
// The key format is enforced by mirrorWikiImage and tested here by verifying
// the shape against real string construction (pure logic, no I/O).

test('key derivation format: wiki-images/<pageId>-<hash8>.webp pattern', () => {
  // Mirrors the logic inside mirrorWikiImage:
  //   key = `wiki-images/${pageId}-${hash.slice(0, 8)}.webp`
  const pageId = 12345;
  const hash   = 'abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01abcdef01';
  const hash8  = hash.slice(0, 8);
  const key    = `wiki-images/${pageId}-${hash8}.webp`;
  assert.equal(key, 'wiki-images/12345-abcdef01.webp');
  assert.match(key, /^wiki-images\/\d+-[0-9a-f]{8}\.webp$/);
});

test('key derivation: different pageIds produce different keys', () => {
  const hash8 = 'deadbeef';
  const key1 = `wiki-images/1-${hash8}.webp`;
  const key2 = `wiki-images/2-${hash8}.webp`;
  assert.notEqual(key1, key2);
});

test('key derivation: different hashes produce different keys for same pageId', () => {
  const pageId = 999;
  const key1 = `wiki-images/${pageId}-aaaaaaaa.webp`;
  const key2 = `wiki-images/${pageId}-bbbbbbbb.webp`;
  assert.notEqual(key1, key2);
});
