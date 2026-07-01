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
  const script = buildKwinKeepAboveScript();                                 // default: force-Layer, NO game-below
  const scriptWithBelow = buildKwinKeepAboveScript({ includeBelow: true });  // opt-in fallback

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
    expect(script).toContain('--group fcm-keepabove --key wmclass "fallout-chat-mod"');
  });

  it('always writes the overlay force-Layer=Overlay rule (KWin 6 — above fullscreen, no demotion)', () => {
    expect(script).toContain('--group fcm-overlay-layer --key wmclass "fallout-chat-mod"');
    expect(script).toContain('--group fcm-overlay-layer --key layer overlay');
    expect(script).toContain('--group fcm-overlay-layer --key layerrule 2');
  });

  it('supports a custom overlay layer (e.g. critical-notification)', () => {
    const s = buildKwinKeepAboveScript({ overlayLayer: 'critical-notification' });
    expect(s).toContain('--group fcm-overlay-layer --key layer critical-notification');
  });

  it('reconfigures KWin with distro/Qt-tolerant qdbus fallbacks', () => {
    expect(script).toContain('qdbus org.kde.KWin /KWin reconfigure');
    expect(script).toContain('qdbus6 org.kde.KWin /KWin reconfigure');
    expect(script).toContain('qdbus-qt6 org.kde.KWin /KWin reconfigure');
  });

  it('never writes the retired flicker-prone fullscreen-demote rule', () => {
    expect(script).not.toContain('fcm-game-demote');
    expect(scriptWithBelow).not.toContain('fcm-game-demote');
  });

  // ── default: force-Layer only, NO game-below (game keeps normal fullscreen above the panel) ──

  describe('default (includeBelow=false)', () => {
    it('does NOT write the game keep-below rule', () => {
      expect(script).not.toContain('--group fcm-game-below --key below true');
    });

    it('idempotency expects keep-above + overlay-layer (N=2, A=1, L=1, B=0)', () => {
      expect(script).toContain('if [ "$N" = "2" ] && [ "$A" = "1" ] && [ "$L" = "1" ] && [ "$B" = "0" ]; then echo fcm-rule-present; exit 0; fi');
    });

    it('rebuilds rules= as preserved-user-rules + keep-above + overlay-layer', () => {
      expect(script).toContain('NEWR="${KEEP:+$KEEP,}fcm-keepabove,fcm-overlay-layer"');
      // it still references fcm-game-below in the detect/strip logic (to clear a stale one),
      // but must NOT add it to the active rules= list:
      expect(script).not.toContain(',fcm-game-below"');
    });
  });

  // ── opt-in fallback: game keep-below ON (drops the game below the panel too) ──────────────

  describe('includeBelow=true (opt-in fallback)', () => {
    it('also writes the game keep-below rule (drops the game to BelowLayer)', () => {
      expect(scriptWithBelow).toContain('--group fcm-game-below --key wmclass "steam_app_1151340"');
      expect(scriptWithBelow).toContain('--group fcm-game-below --key below true');
      expect(scriptWithBelow).toContain('--group fcm-game-below --key belowrule 2');
    });

    it('idempotency expects all three (N=3, A=1, L=1, B=1)', () => {
      expect(scriptWithBelow).toContain('if [ "$N" = "3" ] && [ "$A" = "1" ] && [ "$L" = "1" ] && [ "$B" = "1" ]; then echo fcm-rule-present; exit 0; fi');
    });

    it('rebuilds rules= as preserved-user-rules + keep-above + overlay-layer + game-below', () => {
      expect(scriptWithBelow).toContain('NEWR="${KEEP:+$KEEP,}fcm-keepabove,fcm-overlay-layer,fcm-game-below"');
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
