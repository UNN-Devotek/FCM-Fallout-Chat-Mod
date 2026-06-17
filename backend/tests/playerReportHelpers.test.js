'use strict';

const h = require('../src/services/playerReportHelpers');

describe('playerReportHelpers', () => {
  describe('sanitizeInvolvedPlayers', () => {
    it('strips HTML/quote chars and trims', () => {
      expect(h.sanitizeInvolvedPlayers('  <b>Raider</b> & "Bob"  ')).toBe('bRaider/b  Bob');
    });
    it('caps at 500 chars', () => {
      expect(h.sanitizeInvolvedPlayers('x'.repeat(800)).length).toBe(500);
    });
    it('returns null for empty / non-strings', () => {
      expect(h.sanitizeInvolvedPlayers('   ')).toBeNull();
      expect(h.sanitizeInvolvedPlayers(undefined)).toBeNull();
      expect(h.sanitizeInvolvedPlayers(42)).toBeNull();
    });
  });

  describe('clampReportContent', () => {
    it('trims and caps at 2000', () => {
      expect(h.clampReportContent('  hi  ')).toBe('hi');
      expect(h.clampReportContent('y'.repeat(2500)).length).toBe(2000);
    });
  });

  describe('capImageUrls', () => {
    it('accepts up to the max and reports drops', () => {
      const r = h.capImageUrls(['a'], ['b', 'c', 'd'], 3);
      expect(r.merged).toEqual(['a', 'b', 'c']);
      expect(r.accepted).toBe(2);
      expect(r.dropped).toBe(1);
    });
    it('accepts none when already full', () => {
      const r = h.capImageUrls(['a', 'b', 'c'], ['d'], 3);
      expect(r.merged).toEqual(['a', 'b', 'c']);
      expect(r.accepted).toBe(0);
      expect(r.dropped).toBe(1);
    });
  });

  describe('remainingImageSlots', () => {
    it('computes remaining slots, never negative', () => {
      expect(h.remainingImageSlots(0)).toBe(3);
      expect(h.remainingImageSlots(2)).toBe(1);
      expect(h.remainingImageSlots(5)).toBe(0);
    });
  });

  describe('buildPlayerReportThreadName', () => {
    it('prefixes and stays within 100 chars', () => {
      expect(h.buildPlayerReportThreadName('Dweller')).toBe('🚩 Report · Dweller');
      const long = h.buildPlayerReportThreadName('z'.repeat(200));
      expect(long.length).toBeLessThanOrEqual(100);
      expect(long.startsWith('🚩 Report · ')).toBe(true);
    });
    it('falls back when name is empty', () => {
      expect(h.buildPlayerReportThreadName('')).toBe('🚩 Report · player');
    });
  });
});
