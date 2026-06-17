'use strict';

/**
 * Unit tests for the pure ticketing helpers (no discord.js / prisma / network).
 */

const h = require('../src/services/githubTicketHelpers');

describe('githubTicketHelpers', () => {
  describe('buildCustomId / parseCustomId', () => {
    it('builds namespaced ids with and without an arg', () => {
      expect(h.buildCustomId('open', 'bug')).toBe('ght:open:bug');
      expect(h.buildCustomId('roadmap', '123')).toBe('ght:roadmap:123');
      expect(h.buildCustomId('refresh')).toBe('ght:refresh');
    });

    it('round-trips through parseCustomId', () => {
      expect(h.parseCustomId('ght:open:bug')).toEqual({ isOurs: true, action: 'open', arg: 'bug' });
      expect(h.parseCustomId('ght:roadmap:42')).toEqual({ isOurs: true, action: 'roadmap', arg: '42' });
      expect(h.parseCustomId('ght:refresh')).toEqual({ isOurs: true, action: 'refresh', arg: '' });
    });

    it('rejects foreign / empty custom ids', () => {
      expect(h.parseCustomId('tv:lock').isOurs).toBe(false);
      expect(h.parseCustomId('').isOurs).toBe(false);
      expect(h.parseCustomId(undefined).isOurs).toBe(false);
    });
  });

  describe('buildThreadName', () => {
    it('formats as "#<n> · <title>"', () => {
      expect(h.buildThreadName(7, 'Crash on startup')).toBe('#7 · Crash on startup');
    });

    it('never exceeds Discord 100-char limit and preserves the issue key', () => {
      const long = 'x'.repeat(300);
      const name = h.buildThreadName(123, long);
      expect(name.length).toBeLessThanOrEqual(100);
      expect(name.startsWith('#123 · ')).toBe(true);
      expect(name.endsWith('…')).toBe(true);
    });

    it('collapses whitespace', () => {
      expect(h.buildThreadName(1, '  multiple   spaces here ')).toBe('#1 · multiple spaces here');
    });
  });

  describe('buildIssueBody', () => {
    const base = { reporterTag: 'dweller#0001', reporterId: '999', description: 'It broke' };

    it('includes a Steps section for bugs', () => {
      const body = h.buildIssueBody({ ...base, type: 'bug', steps: 'do X then Y' });
      expect(body).toContain('## Description');
      expect(body).toContain('It broke');
      expect(body).toContain('## Steps to reproduce');
      expect(body).toContain('do X then Y');
      expect(body).toContain('dweller#0001');
    });

    it('omits Steps for suggestions', () => {
      const body = h.buildIssueBody({ ...base, type: 'suggestion' });
      expect(body).not.toContain('Steps to reproduce');
    });

    it('falls back when steps are empty', () => {
      const body = h.buildIssueBody({ ...base, type: 'bug', steps: '' });
      expect(body).toContain('_Not provided._');
    });
  });

  describe('isStaff', () => {
    const staff = { ownerRoleId: 'O', adminRoleId: 'A', moderatorRoleId: 'M', developerRoleId: 'D' };

    it('is true when the member holds any staff role', () => {
      expect(h.isStaff(['X', 'M'], staff)).toBe(true);
      expect(h.isStaff(['D'], staff)).toBe(true);
    });

    it('is false with no matching role', () => {
      expect(h.isStaff(['X', 'Y'], staff)).toBe(false);
    });

    it('is false for empty inputs / empty config', () => {
      expect(h.isStaff([], staff)).toBe(false);
      expect(h.isStaff(['A'], {})).toBe(false);
      expect(h.isStaff(null, staff)).toBe(false);
    });
  });

  describe('type mappings', () => {
    it('isTicketType only accepts known types', () => {
      expect(h.isTicketType('bug')).toBe(true);
      expect(h.isTicketType('suggestion')).toBe(true);
      expect(h.isTicketType('support')).toBe(true);
      expect(h.isTicketType('nope')).toBe(false);
    });

    it('labelForType / displayForType', () => {
      expect(h.labelForType('bug')).toBe('bug');
      expect(h.labelForType('suggestion')).toBe('suggestion');
      expect(h.displayForType('support')).toBe('Support Ticket');
    });

    it('colorForType returns a number per type', () => {
      expect(typeof h.colorForType('bug')).toBe('number');
      expect(h.colorForType('bug')).not.toBe(h.colorForType('suggestion'));
    });
  });

  describe('formatDiscordMessageForGitHub', () => {
    it('prefixes the author and includes content', () => {
      const out = h.formatDiscordMessageForGitHub({ authorName: 'Dweller', content: 'hello' });
      expect(out).toContain('**Dweller** (Discord):');
      expect(out).toContain('hello');
      expect(out).not.toContain('attachment');
    });

    it('notes attachment count without uploading', () => {
      const out = h.formatDiscordMessageForGitHub({ authorName: 'D', content: '', attachmentCount: 2 });
      expect(out).toContain('2 attachments shared in the Discord thread');
    });

    it('uses singular for one attachment', () => {
      const out = h.formatDiscordMessageForGitHub({ authorName: 'D', content: 'x', attachmentCount: 1 });
      expect(out).toContain('1 attachment shared');
    });
  });
});
