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
  const script = buildKwinKeepAboveScript();

  it('partitions existing rules into FCM (by Description) vs the user\'s own (KEEP)', () => {
    expect(script).toContain('--group General --key rules');
    expect(script).toContain('for g in $(printf \'%s\' "$R" | tr \',\' \' \')');
    // FCM rules are matched by the "Fallout Chat Mod" Description prefix — this catches the
    // numbered-group rules older builds wrote, not just the current named groups.
    expect(script).toContain('"Fallout Chat Mod"*) FCM="$FCM $g"');
    expect(script).toContain('*) KEEP="${KEEP:+$KEEP,}$g"');
  });

  it('is idempotent only when the active FCM rules are EXACTLY our two named groups', () => {
    expect(script).toContain('case " $FCM " in *" fcm-keepabove "*) A=1');
    expect(script).toContain('case " $FCM " in *" fcm-game-demote "*) D=1');
    expect(script).toContain('if [ "$N" = "2" ] && [ "$A" = "1" ] && [ "$D" = "1" ]; then echo fcm-rule-present; exit 0; fi');
  });

  it('awk-strips stale FCM sections before re-writing (kwriteconfig CANNOT delete a section)', () => {
    expect(script).toContain('awk -v drop=" $FCM "');
    expect(script).toContain('> "$RULES.fcmtmp" && mv "$RULES.fcmtmp" "$RULES"');
    // the broken per-key delete must be gone
    expect(script).not.toContain('--key Description --delete');
  });

  it('writes the overlay keep-above rule and the game fullscreen-demote rule', () => {
    expect(script).toContain('--group fcm-keepabove --key above true');
    expect(script).toContain('--group fcm-keepabove --key wmclass "fallout"');
    expect(script).toContain('--group fcm-game-demote --key wmclass "steam_app_1151340"');
    expect(script).toContain('--group fcm-game-demote --key fullscreen false');
    expect(script).toContain('--group fcm-game-demote --key fullscreenrule 2');
  });

  it('does NOT rely on layer/layerrule (ignored by KWin 6)', () => {
    expect(script).not.toContain('--key layer ');
    expect(script).not.toContain('--key layerrule ');
  });

  it('rebuilds rules= as preserved-user-rules + our two, and sets count to its length', () => {
    expect(script).toContain('NEWR="${KEEP:+$KEEP,}fcm-keepabove,fcm-game-demote"');
    expect(script).toContain('--group General --key rules "$NEWR"');
    expect(script).toContain('--group General --key count "$COUNT"');
  });

  it('reconfigures KWin with distro/Qt-tolerant qdbus fallbacks', () => {
    expect(script).toContain('qdbus org.kde.KWin /KWin reconfigure');
    expect(script).toContain('qdbus6 org.kde.KWin /KWin reconfigure');
    expect(script).toContain('qdbus-qt6 org.kde.KWin /KWin reconfigure');
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
