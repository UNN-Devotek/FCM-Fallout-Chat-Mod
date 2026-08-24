// Unit tests for the KDE KWin rule scripts:
//   • buildKwinKeepAboveScript  — clean stale FCM rules + install the one current rule
//     (keep-above + force-Layer combined, on the OVERLAY) on Plasma 6.
//   • buildKwinRemoveRulesScript — strip ALL FCM rules (for the uninstaller), keeping the
//     user's own rules.
// Verified format on KWin 6.6.5: [General] rules= is the authoritative comma-separated
// group-name list. See docs/overlay/window-management.md. Edge-case behavior (preserve user
// rules, drop stale numbered groups, idempotency) is exercised by a dry-run in the repo.

import core from '../overlay-core.js';

const { buildKwinKeepAboveScript, buildKwinRemoveRulesScript, shouldInstallKeepAboveRule } = core;

describe('shouldInstallKeepAboveRule', () => {
  it('{gameRunning:true, sameOutput:true} → true', () => {
    expect(shouldInstallKeepAboveRule({ gameRunning: true, sameOutput: true })).toBe(true);
  });

  it('{gameRunning:true, sameOutput:false} → false (explicit false blocks)', () => {
    expect(shouldInstallKeepAboveRule({ gameRunning: true, sameOutput: false })).toBe(false);
  });

  it('{gameRunning:false, sameOutput:true} → false', () => {
    expect(shouldInstallKeepAboveRule({ gameRunning: false, sameOutput: true })).toBe(false);
  });

  it('{gameRunning:true} (sameOutput omitted) → false (display unknown fails closed)', () => {
    expect(shouldInstallKeepAboveRule({ gameRunning: true })).toBe(false);
  });

  it('{gameRunning:false} (sameOutput omitted) → false', () => {
    expect(shouldInstallKeepAboveRule({ gameRunning: false })).toBe(false);
  });

  it('{gameRunning:true, sameOutput:"unknown"} → false', () => {
    expect(shouldInstallKeepAboveRule({ gameRunning: true, sameOutput: 'unknown' })).toBe(false);
  });
});

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

  it('awk-strips stale FCM sections before re-writing (kwriteconfig CANNOT delete a section)', () => {
    expect(script).toContain('awk -v drop=" $FCM "');
    expect(script).toContain('> "$RULES.fcmtmp" && mv "$RULES.fcmtmp" "$RULES"');
    // the broken per-key delete must be gone
    expect(script).not.toContain('--key Description --delete');
  });

  it('always writes the overlay keep-above property', () => {
    expect(script).toContain('--group fcm-keepabove --key above true');
    expect(script).toContain('--group fcm-keepabove --key wmclass "fallout-chat-mod"');
  });

  it('always writes the overlay force-Layer=Overlay property on the SAME rule (KWin 6 — above fullscreen, no demotion)', () => {
    expect(script).toContain('--group fcm-keepabove --key layer overlay');
    expect(script).toContain('--group fcm-keepabove --key layerrule 2');
  });

  it('supports a custom overlay layer (e.g. critical-notification)', () => {
    const s = buildKwinKeepAboveScript({ overlayLayer: 'critical-notification' });
    expect(s).toContain('--group fcm-keepabove --key layer critical-notification');
  });

  it('reconfigures KWin with distro/Qt-tolerant qdbus fallbacks', () => {
    expect(script).toContain('qdbus org.kde.KWin /KWin reconfigure');
    expect(script).toContain('qdbus6 org.kde.KWin /KWin reconfigure');
    expect(script).toContain('qdbus-qt6 org.kde.KWin /KWin reconfigure');
  });

  it('never writes the retired flicker-prone fullscreen-demote rule', () => {
    expect(script).not.toContain('fcm-game-demote');
  });

  // ── game demotion is fully removed: force-Layer only, never a game keep-below rule ──

  it('never writes the removed game keep-below rule', () => {
    expect(script).not.toContain('--group fcm-game-below --key below true');
    expect(script).not.toContain('belowrule');
  });

  it('strips a STALE fcm-game-below or pre-merge fcm-overlay-layer from old installs (idempotency requires exactly the one combined rule)', () => {
    // The partition/strip logic clears any FCM-authored group (matched by Description),
    // including a leftover fcm-game-below or a pre-merge fcm-overlay-layer — and the
    // idempotency guard only short-circuits when EXACTLY the one combined rule is present,
    // so a stale second/third rule forces the strip + rewrite path.
    expect(script).toContain('if [ "$N" = "1" ] && [ "$A" = "1" ]; then echo fcm-rule-present; exit 0; fi');
    expect(script).toContain('awk -v drop=" $FCM "');
  });

  it('rebuilds rules= as preserved-user-rules + the one combined keep-above rule', () => {
    expect(script).toContain('NEWR="${KEEP:+$KEEP,}fcm-keepabove"');
    // must NOT add fcm-game-below or a separate fcm-overlay-layer to the active rules= list:
    expect(script).not.toContain(',fcm-game-below"');
    expect(script).not.toContain('fcm-overlay-layer');
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
