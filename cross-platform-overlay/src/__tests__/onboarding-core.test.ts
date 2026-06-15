import { describe, it, expect, vi } from 'vitest';
import {
  TOTAL_STEPS,
  deriveInitialOnboardingState,
  computeNavView,
  nextStepIndex,
  prevStepIndex,
  buildFinishPatch,
  shouldSetIdentityName,
  runFinish,
  notifyComplete,
  reduceFinishResult,
  type OnboardingState,
  type OnboardingSourceSettings,
} from '../onboarding-core';

const baseSettings = (over: Partial<OnboardingSourceSettings> = {}): OnboardingSourceSettings => ({
  playsFo76: false,
  discordLinked: false,
  ...over,
});

const baseState = (over: Partial<OnboardingState> = {}): OnboardingState => ({
  fo76Name: '',
  playsFo76: false,
  themeId: 'fo76-wasteland',
  discordLinked: false,
  discordName: '',
  discordDisplayName: '',
  ...over,
});

describe('deriveInitialOnboardingState', () => {
  it('defaults theme to fo76-wasteland when unset', () => {
    expect(deriveInitialOnboardingState(baseSettings()).themeId).toBe('fo76-wasteland');
    expect(deriveInitialOnboardingState(baseSettings({ themeId: 'amber' })).themeId).toBe('amber');
  });

  it('treats discord:* placeholder fo76Name as empty', () => {
    const st = deriveInitialOnboardingState(baseSettings({ fo76Name: 'discord:12345' }));
    expect(st.fo76Name).toBe('');
  });

  it('treats Overlay* placeholder fo76Name as empty', () => {
    const st = deriveInitialOnboardingState(baseSettings({ fo76Name: 'Overlay1234' }));
    expect(st.fo76Name).toBe('');
  });

  it('keeps a real saved fo76Name', () => {
    const st = deriveInitialOnboardingState(baseSettings({ fo76Name: 'Vault Dweller' }));
    expect(st.fo76Name).toBe('Vault Dweller');
  });

  it('falls back fo76Name to resolved discord display name when no real name saved', () => {
    const st = deriveInitialOnboardingState(
      baseSettings({ fo76Name: 'discord:9', discordDisplayName: 'Devo' }),
    );
    expect(st.fo76Name).toBe('Devo');
  });

  it('display-name precedence: passed > discordDisplayName > discordName > empty', () => {
    expect(
      deriveInitialOnboardingState(
        baseSettings({ discordDisplayName: 'FromSettings', discordName: 'handle' }),
        'Passed',
      ).discordDisplayName,
    ).toBe('Passed');

    expect(
      deriveInitialOnboardingState(
        baseSettings({ discordDisplayName: 'FromSettings', discordName: 'handle' }),
      ).discordDisplayName,
    ).toBe('FromSettings');

    expect(
      deriveInitialOnboardingState(baseSettings({ discordName: 'handle' })).discordDisplayName,
    ).toBe('handle');

    expect(deriveInitialOnboardingState(baseSettings()).discordDisplayName).toBe('');
  });

  it('passes through playsFo76, discordLinked, discordName', () => {
    const st = deriveInitialOnboardingState(
      baseSettings({ playsFo76: true, discordLinked: true, discordName: 'handle' }),
    );
    expect(st.playsFo76).toBe(true);
    expect(st.discordLinked).toBe(true);
    expect(st.discordName).toBe('handle');
  });
});

describe('computeNavView', () => {
  it('first step: 33% pct, back hidden, NEXT label', () => {
    const v = computeNavView(0);
    expect(v.pct).toBeCloseTo((1 / 3) * 100);
    expect(v.backHidden).toBe(true);
    expect(v.nextLabel).toBe('NEXT  ▶');
    expect(v.isLastStep).toBe(false);
    expect(v.stepLabel).toBe('Step 1 of 3');
  });

  it('middle step: back shown, NEXT label', () => {
    const v = computeNavView(1);
    expect(v.backHidden).toBe(false);
    expect(v.pct).toBeCloseTo((2 / 3) * 100);
    expect(v.isLastStep).toBe(false);
  });

  it('last step: 100% pct, GET STARTED label, isLastStep', () => {
    const v = computeNavView(TOTAL_STEPS - 1);
    expect(v.pct).toBe(100);
    expect(v.nextLabel).toBe('GET STARTED  ✓');
    expect(v.isLastStep).toBe(true);
    expect(v.stepLabel).toBe('Step 3 of 3');
  });

  it('clamps out-of-range indices', () => {
    expect(computeNavView(-5).stepLabel).toBe('Step 1 of 3');
    expect(computeNavView(99).stepLabel).toBe('Step 3 of 3');
    expect(computeNavView(99).isLastStep).toBe(true);
  });
});

describe('step index helpers', () => {
  it('next clamps at last step', () => {
    expect(nextStepIndex(0)).toBe(1);
    expect(nextStepIndex(1)).toBe(2);
    expect(nextStepIndex(2)).toBe(2);
  });
  it('prev clamps at 0', () => {
    expect(prevStepIndex(2)).toBe(1);
    expect(prevStepIndex(0)).toBe(0);
  });
});

describe('buildFinishPatch', () => {
  it('builds patch with onboarded true and undefined display name when empty', () => {
    const patch = buildFinishPatch(baseState({ fo76Name: 'X', themeId: 'amber' }));
    expect(patch).toEqual({
      fo76Name: 'X',
      playsFo76: false,
      themeId: 'amber',
      discordLinked: false,
      discordName: '',
      discordDisplayName: undefined,
      onboarded: true,
    });
  });

  it('carries a non-empty discord display name', () => {
    const patch = buildFinishPatch(baseState({ discordDisplayName: 'Devo' }));
    expect(patch.discordDisplayName).toBe('Devo');
  });
});

describe('shouldSetIdentityName', () => {
  it('true only when name + playsFo76 and not skipping', () => {
    expect(shouldSetIdentityName(baseState({ fo76Name: 'A', playsFo76: true }))).toBe(true);
  });
  it('false when no name', () => {
    expect(shouldSetIdentityName(baseState({ fo76Name: '', playsFo76: true }))).toBe(false);
  });
  it('false when not playing FO76', () => {
    expect(shouldSetIdentityName(baseState({ fo76Name: 'A', playsFo76: false }))).toBe(false);
  });
  it('false when skipNameOnNextFinish flagged', () => {
    expect(
      shouldSetIdentityName(baseState({ fo76Name: 'A', playsFo76: true, skipNameOnNextFinish: true })),
    ).toBe(false);
  });
});

describe('runFinish decision tree', () => {
  it('always persists the patch', async () => {
    const applyOnboardingSettings = vi.fn();
    await runFinish(baseState(), { applyOnboardingSettings });
    expect(applyOnboardingSettings).toHaveBeenCalledOnce();
    expect(applyOnboardingSettings.mock.calls[0][0]).toMatchObject({ onboarded: true });
  });

  it('does not call setIdentityName when wantName is false', async () => {
    const setIdentityName = vi.fn();
    await runFinish(baseState({ fo76Name: '', playsFo76: true }), {
      applyOnboardingSettings: vi.fn(),
      setIdentityName,
    });
    expect(setIdentityName).not.toHaveBeenCalled();
  });

  it('calls setIdentityName with the fo76Name when wanted', async () => {
    const setIdentityName = vi.fn().mockResolvedValue({ ok: true });
    const res = await runFinish(baseState({ fo76Name: 'Name', playsFo76: true }), {
      applyOnboardingSettings: vi.fn(),
      setIdentityName,
    });
    expect(setIdentityName).toHaveBeenCalledWith('Name');
    expect(res).toEqual({ nameTaken: false });
  });

  it('returns nameTaken only on ok:false reason:taken — and does NOT notify', async () => {
    const notifyOnboardingComplete = vi.fn();
    const res = await runFinish(baseState({ fo76Name: 'Taken', playsFo76: true }), {
      applyOnboardingSettings: vi.fn(),
      setIdentityName: vi.fn().mockResolvedValue({ ok: false, reason: 'taken' }),
      notifyOnboardingComplete,
    });
    expect(res).toEqual({ nameTaken: true });
    expect(notifyOnboardingComplete).not.toHaveBeenCalled();
  });

  it('non-taken failure is non-fatal — proceeds to notify', async () => {
    const notifyOnboardingComplete = vi.fn();
    const res = await runFinish(baseState({ fo76Name: 'X', playsFo76: true }), {
      applyOnboardingSettings: vi.fn(),
      setIdentityName: vi.fn().mockResolvedValue({ ok: false, reason: 'network' }),
      notifyOnboardingComplete,
    });
    expect(res).toEqual({ nameTaken: false });
    expect(notifyOnboardingComplete).toHaveBeenCalledOnce();
  });

  it('thrown setIdentityName is swallowed and still completes', async () => {
    const notifyOnboardingComplete = vi.fn();
    const res = await runFinish(baseState({ fo76Name: 'X', playsFo76: true }), {
      applyOnboardingSettings: vi.fn(),
      setIdentityName: vi.fn().mockRejectedValue(new Error('boom')),
      notifyOnboardingComplete,
    });
    expect(res).toEqual({ nameTaken: false });
    expect(notifyOnboardingComplete).toHaveBeenCalledOnce();
  });

  it('prefers notifyOnboardingComplete (game-running handoff) over notifyChatActive', async () => {
    const notifyOnboardingComplete = vi.fn();
    const notifyChatActive = vi.fn();
    await runFinish(baseState(), {
      applyOnboardingSettings: vi.fn(),
      notifyOnboardingComplete,
      notifyChatActive,
    });
    expect(notifyOnboardingComplete).toHaveBeenCalledOnce();
    expect(notifyChatActive).not.toHaveBeenCalled();
  });

  it('falls back to notifyChatActive(true) on older main without the new IPC', async () => {
    const notifyChatActive = vi.fn();
    await runFinish(baseState(), {
      applyOnboardingSettings: vi.fn(),
      notifyChatActive,
    });
    expect(notifyChatActive).toHaveBeenCalledWith(true);
  });

  it('swallows notify errors (web overlay context with no bridge)', async () => {
    await expect(
      runFinish(baseState(), {
        applyOnboardingSettings: vi.fn(),
        notifyOnboardingComplete: () => {
          throw new Error('no bridge');
        },
      }),
    ).resolves.toEqual({ nameTaken: false });
  });
});

describe('notifyComplete', () => {
  it('no-ops cleanly when neither notify is present', () => {
    expect(() => notifyComplete({ applyOnboardingSettings: vi.fn() })).not.toThrow();
  });
});

describe('reduceFinishResult name-taken reducer', () => {
  it('first press (nameTaken): warn note, re-enabled, flags skip, no dismiss', () => {
    const d = reduceFinishResult(baseState({ fo76Name: 'Dupe' }), { nameTaken: true });
    expect(d.warn).toBe(true);
    expect(d.note).toContain('Dupe');
    expect(d.disabled).toBe(false);
    expect(d.skipNameOnNextFinish).toBe(true);
    expect(d.dismiss).toBe(false);
  });

  it('success: clears note, dismisses, no skip flag', () => {
    const d = reduceFinishResult(baseState(), { nameTaken: false });
    expect(d.note).toBe('');
    expect(d.warn).toBe(false);
    expect(d.dismiss).toBe(true);
    expect(d.skipNameOnNextFinish).toBe(false);
  });

  it('second press proceeds: with skip flag set, shouldSetIdentityName is false then dismiss', async () => {
    // Simulate the two-press flow end to end at the core level.
    const taken = reduceFinishResult(baseState({ fo76Name: 'Dupe' }), { nameTaken: true });
    expect(taken.skipNameOnNextFinish).toBe(true);

    const stateAfter = baseState({ fo76Name: 'Dupe', playsFo76: true, skipNameOnNextFinish: true });
    const setIdentityName = vi.fn();
    const res = await runFinish(stateAfter, { applyOnboardingSettings: vi.fn(), setIdentityName });
    // Second press must NOT re-attempt the name.
    expect(setIdentityName).not.toHaveBeenCalled();
    expect(reduceFinishResult(stateAfter, res).dismiss).toBe(true);
  });
});
