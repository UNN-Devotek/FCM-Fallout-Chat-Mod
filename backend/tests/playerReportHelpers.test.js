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

  describe('isAllowedDiscordAttachmentUrl (SSRF guard)', () => {
    it('accepts https Discord CDN URLs', () => {
      expect(h.isAllowedDiscordAttachmentUrl('https://cdn.discordapp.com/attachments/1/2/a.png')).toBe(true);
      expect(h.isAllowedDiscordAttachmentUrl('https://media.discordapp.net/x.jpg')).toBe(true);
    });
    it('rejects non-Discord hosts, http, internal IPs, and junk', () => {
      expect(h.isAllowedDiscordAttachmentUrl('https://evil.example/x.png')).toBe(false);
      expect(h.isAllowedDiscordAttachmentUrl('http://cdn.discordapp.com/x.png')).toBe(false);
      expect(h.isAllowedDiscordAttachmentUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
      expect(h.isAllowedDiscordAttachmentUrl('file:///etc/passwd')).toBe(false);
      expect(h.isAllowedDiscordAttachmentUrl('not a url')).toBe(false);
      expect(h.isAllowedDiscordAttachmentUrl(null)).toBe(false);
    });
  });

  describe('buildPlayerReportThreadName', () => {
    it('formats as "Player Report · #<num> · <involved> · <reporter>" (no emoji)', () => {
      expect(h.buildPlayerReportThreadName('Dweller', 'Griefer123', 42)).toBe('Player Report · #42 · Griefer123 · Dweller');
    });
    it('omits the involved segment when blank', () => {
      expect(h.buildPlayerReportThreadName('Dweller', '', 7)).toBe('Player Report · #7 · Dweller');
      expect(h.buildPlayerReportThreadName('Dweller', null, 7)).toBe('Player Report · #7 · Dweller');
    });
    it('always keeps the "Player Report · #<num>" head and stays within 100 chars', () => {
      const n = h.buildPlayerReportThreadName('z'.repeat(200), 'y'.repeat(200), 123);
      expect(n.length).toBeLessThanOrEqual(100);
      expect(n.startsWith('Player Report · #123')).toBe(true);
    });
    it('falls back when reporter is empty', () => {
      expect(h.buildPlayerReportThreadName('', '', 5)).toBe('Player Report · #5 · player');
    });
  });
});
