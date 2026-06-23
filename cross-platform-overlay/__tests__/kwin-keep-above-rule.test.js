// Unit tests for the KDE KWin rule scripts:
//   • buildKwinKeepAboveScript  — clean stale FCM rules + install the two current rules
//     (keep-above on the overlay, fullscreen-demote on the game) on Plasma 6.
//   • buildKwinRemoveRulesScript — strip ALL FCM rules (for the uninstaller), keeping the
//     user's own rules.
// Verified format on KWin 6.6.5: [General] rules= is the authoritative comma-separated
// group-name list. See docs/overlay/window-management.md. Edge-case behavior (preserve user
// rules, drop stale numbered groups, idempotency) is exercised by a dry-run in the repo.

import core from '../overlay-core.js';

const { buildKwinKeepAboveScript, buildKwinRemoveRulesScript } = core;

describe('buildKwinKeepAboveScript', () => {
  const script = buildKwinKeepAboveScript();                       // default: game-below ON
  const scriptNoBelow = buildKwinKeepAboveScript({ includeBelow: false });

  it('partitions existing rules into FCM (by Description) vs the user\'s own (KEEP)', () => {
    expect(script).toContain('--group General --key rules');
    expect(script).toContain('for g in $(printf \'%s\' "$R" | tr \',\' \' \')');
    // FCM rules are matched by the "Fallout Chat Mod" Description prefix — this catches the
    // numbered-group rules older builds wrote, not just the current named groups.
    expect(script).toContain('"Fallout Chat Mod"*) FCM="$FCM $g"');
    expect(script).toContain('*) KEEP="${KEEP:+$KEEP,}$g"');
  });

  it('awk-strips stale FCM sections before re-writing (kwriteconfig CANNOT delete a section)', () => {
    expect(script).toContain('awk -v drop=" $FCM "');
    expect(script).toContain('> "$RULES.fcmtmp" && mv "$RULES.fcmtmp" "$RULES"');
    // the broken per-key delete must be gone
    expect(script).not.toContain('--key Description --delete');
  });

  it('always writes the overlay keep-above rule', () => {
    expect(script).toContain('--group fcm-keepabove --key above true');
    expect(script).toContain('--group fcm-keepabove --key wmclass "fallout"');
  });

  it('does NOT rely on layer/layerrule (ignored by KWin 6)', () => {
    expect(script).not.toContain('--key layer ');
    expect(script).not.toContain('--key layerrule ');
  });

  it('reconfigures KWin with distro/Qt-tolerant qdbus fallbacks', () => {
    expect(script).toContain('qdbus org.kde.KWin /KWin reconfigure');
    expect(script).toContain('qdbus6 org.kde.KWin /KWin reconfigure');
    expect(script).toContain('qdbus-qt6 org.kde.KWin /KWin reconfigure');
  });

  it('never writes the retired flicker-prone fullscreen-demote rule', () => {
    expect(script).not.toContain('fcm-game-demote');
    expect(scriptNoBelow).not.toContain('fcm-game-demote');
  });

  // ── default: game keep-below ON (the no-flicker fix, issue #272) ───────────────

  describe('default (includeBelow=true)', () => {
    it('writes the game keep-below rule (drops the game to BelowLayer)', () => {
      expect(script).toContain('--group fcm-game-below --key wmclass "steam_app_1151340"');
      expect(script).toContain('--group fcm-game-below --key below true');
      expect(script).toContain('--group fcm-game-below --key belowrule 2');
    });

    it('idempotency expects BOTH rules (N=2, A=1, B=1)', () => {
      expect(script).toContain('if [ "$N" = "2" ] && [ "$A" = "1" ] && [ "$B" = "1" ]; then echo fcm-rule-present; exit 0; fi');
    });

    it('rebuilds rules= as preserved-user-rules + keep-above + game-below', () => {
      expect(script).toContain('NEWR="${KEEP:+$KEEP,}fcm-keepabove,fcm-game-below"');
    });
  });

  // ── opt-out: game keep-below OFF (user turned the option off) ──────────────────

  describe('includeBelow=false', () => {
    it('does NOT write the game keep-below rule', () => {
      expect(scriptNoBelow).not.toContain('--group fcm-game-below --key below true');
    });

    it('idempotency expects keep-above only (N=1, A=1, B=0)', () => {
      expect(scriptNoBelow).toContain('if [ "$N" = "1" ] && [ "$A" = "1" ] && [ "$B" = "0" ]; then echo fcm-rule-present; exit 0; fi');
    });

    it('rebuilds rules= as preserved-user-rules + keep-above only', () => {
      expect(scriptNoBelow).toContain('NEWR="${KEEP:+$KEEP,}fcm-keepabove"');
      expect(scriptNoBelow).not.toContain('fcm-keepabove,fcm-game-below');
    });
  });
});

describe('buildKwinRemoveRulesScript', () => {
  const script = buildKwinRemoveRulesScript();

  it('partitions rules the same way, then no-ops when there are no FCM rules', () => {
    expect(script).toContain('"Fallout Chat Mod"*) FCM="$FCM $g"');
    expect(script).toContain('if [ -z "$FCM" ]; then echo fcm-no-rules; exit 0; fi');
  });

  it('awk-strips the FCM sections entirely — no orphaned cruft, no per-key delete', () => {
    expect(script).toContain('awk -v drop=" $FCM "');
    expect(script).toContain('> "$RULES.fcmtmp" && mv "$RULES.fcmtmp" "$RULES"');
    expect(script).not.toContain('--key "$k" --delete');
  });

  it('rewrites rules= to ONLY the preserved user rules (FCM stripped) + count', () => {
    expect(script).toContain('--group General --key rules "$KEEP"');
    expect(script).toContain('COUNT=$(printf \'%s\' "$KEEP" | tr \',\' \'\\n\' | grep -c .)');
    expect(script).toContain('--group General --key count "$COUNT"');
  });

  it('reconfigures KWin and reports removal', () => {
    expect(script).toContain('reconfigure');
    expect(script).toContain('echo fcm-rules-removed');
  });
});
