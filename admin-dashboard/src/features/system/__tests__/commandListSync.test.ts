/**
 * Guards the four hand-maintained command lists against drift.
 *
 * Backend `commandService.ts` is the source of truth; these three frontend lists are
 * user-facing documentation and autocomplete data:
 *   - ChatOverlay  BUILTIN_RELAYS / BUILTIN_FORMS   (autocomplete + input tinting)
 *   - HelpContent  BUILTIN_COMMANDS                 (/help page, dashboard + public)
 *   - PublicCommandsKeybindsPage CHANNEL/PARTY/...  (landing page reference)
 *
 * They had drifted badly. The worst case was a PRIVACY bug: HelpContent documented `/r`
 * as "your most recent party", but `/r` maps to the public Raids channel and relays to
 * Discord (commandService.ts CHANNEL_SHORTCUTS). A user following the published help
 * would have broadcast a private party message to a public channel and into Discord.
 *
 * The invariant these tests encode: a PUBLIC channel shortcut must never be described as
 * a party command, and a PRIVATE party shortcut must never be described as a channel.
 */
import { describe, it, expect } from 'vitest';

import { BUILTIN_COMMANDS } from '../HelpContent';
import {
  CHANNEL_CMDS,
  PARTY_CMDS,
  FO76_CMDS,
  GIVEAWAY_CMDS,
  UTILITY_CMDS,
} from '../../auth/PublicCommandsKeybindsPage';
import { BUILTIN_RELAYS, BUILTIN_FORMS } from '../../chat/ChatOverlay';

/**
 * Mirrors `commandService.ts` CHANNEL_SHORTCUTS. These are PUBLIC channels that relay to
 * Discord. If a shortcut is added/removed there, update this and the lists will be checked.
 */
const PUBLIC_CHANNEL_TRIGGERS = ['/g', '/t', '/e', '/r', '/raid', '/i'] as const;

/** Private party shortcuts — resolved client-side in ChatOverlay, never relayed. */
const PARTY_TRIGGERS = ['/recent', '/rp', '/p1', '/p2', '/p3'] as const;

const PARTY_WORDS = /\bpart(y|ies)\b/i;

describe('command list drift guards', () => {
  describe('public channel shortcuts are never described as party commands', () => {
    for (const trigger of PUBLIC_CHANNEL_TRIGGERS) {
      it(`${trigger} is not documented as a party command`, () => {
        const help = BUILTIN_COMMANDS.find(c => c.trigger === trigger);
        if (help) {
          expect(
            PARTY_WORDS.test(help.description),
            `HelpContent describes the public channel ${trigger} as a party command: "${help.description}"`,
          ).toBe(false);
        }

        const publicRow = CHANNEL_CMDS.find(c => c.trigger === trigger);
        if (publicRow) {
          expect(PARTY_WORDS.test(publicRow.description)).toBe(false);
        }

        const relay = BUILTIN_RELAYS.find(r => r.cmd.trigger === trigger);
        if (relay) {
          expect(PARTY_WORDS.test(relay.cmd.description)).toBe(false);
        }
      });
    }
  });

  describe('party shortcuts are described as party commands', () => {
    for (const trigger of PARTY_TRIGGERS) {
      it(`${trigger} is documented as a party command wherever it appears`, () => {
        for (const desc of [
          BUILTIN_COMMANDS.find(c => c.trigger === trigger)?.description,
          PARTY_CMDS.find(c => c.trigger === trigger)?.description,
          BUILTIN_FORMS.find(c => c.trigger === trigger)?.description,
        ]) {
          if (desc !== undefined) expect(PARTY_WORDS.test(desc)).toBe(true);
        }
      });
    }
  });

  it('no trigger is classified as both a public channel and a party shortcut', () => {
    const overlap = PUBLIC_CHANNEL_TRIGGERS.filter(t =>
      (PARTY_TRIGGERS as readonly string[]).includes(t),
    );
    expect(overlap).toEqual([]);
  });

  it('every public channel shortcut is offered by ChatOverlay autocomplete', () => {
    const relayTriggers = BUILTIN_RELAYS.map(r => r.cmd.trigger);
    for (const trigger of PUBLIC_CHANNEL_TRIGGERS) {
      expect(relayTriggers, `${trigger} missing from BUILTIN_RELAYS`).toContain(trigger);
    }
  });

  it('every party shortcut is offered by ChatOverlay autocomplete', () => {
    const formTriggers = BUILTIN_FORMS.map(c => c.trigger);
    for (const trigger of PARTY_TRIGGERS) {
      expect(formTriggers, `${trigger} missing from BUILTIN_FORMS`).toContain(trigger);
    }
  });

  it('the landing-page reference documents every party shortcut family', () => {
    const documented = new Set(
      PARTY_CMDS.flatMap(c => [c.trigger, ...(c.note?.match(/\/[a-z0-9]+/gi) ?? [])]),
    );
    for (const trigger of PARTY_TRIGGERS) {
      expect(documented, `${trigger} missing from PublicCommandsKeybindsPage`).toContain(trigger);
    }
  });

  it('aliases noted in one list resolve to a real trigger in another', () => {
    // e.g. CHANNEL_CMDS documents "alias: /raid" on /r — /raid must exist in BUILTIN_RELAYS.
    const allKnown = new Set<string>([
      ...BUILTIN_RELAYS.map(r => r.cmd.trigger),
      ...BUILTIN_FORMS.map(c => c.trigger),
      ...BUILTIN_COMMANDS.map(c => c.trigger),
    ]);
    const rows = [...CHANNEL_CMDS, ...PARTY_CMDS, ...FO76_CMDS, ...GIVEAWAY_CMDS, ...UTILITY_CMDS];
    for (const row of rows) {
      for (const alias of row.note?.match(/alias(?:es)?:\s*(\/[^\s,]+)/gi) ?? []) {
        const trigger = alias.replace(/alias(?:es)?:\s*/i, '');
        // /server-status and /codes are backend-only aliases with no autocomplete entry.
        if (['/server-status', '/codes'].includes(trigger)) continue;
        expect(allKnown, `alias ${trigger} has no corresponding command`).toContain(trigger);
      }
    }
  });
});
