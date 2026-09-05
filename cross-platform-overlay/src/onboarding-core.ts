/**
 * Pure decision logic for the first-run onboarding flow, extracted from
 * onboarding.ts so it can be unit-tested without a DOM or the Electron bridge.
 *
 * Nothing here touches the DOM, window.relayBridge, or ./shell directly — the
 * stateful helpers take their dependencies as plain arguments so the caller in
 * onboarding.ts wires them to the real implementations.
 */

export const TOTAL_STEPS = 3;

export interface OnboardingState {
  fo76Name: string;
  playsFo76: boolean;
  themeId: string;
  discordLinked: boolean;
  discordName: string;
  discordDisplayName: string;
  steamLinked: boolean;
  skipNameOnNextFinish?: boolean;
  discordAvatarUrl?: string;
}

/** Minimal shape of the persisted shell settings this module reads. */
export interface OnboardingSourceSettings {
  fo76Name?: string;
  playsFo76: boolean;
  themeId?: string;
  discordLinked: boolean;
  discordName?: string;
  discordDisplayName?: string;
  steamLinked: boolean;
}

/**
 * Derive the initial OnboardingState from persisted settings + an optionally
 * passed-in Discord display name (from the relay:discord-status payload).
 *
 * - `discord:<id>` and `Overlay…` placeholder usernames are treated as empty,
 *   so the user is prompted for a real name rather than seeing the placeholder.
 * - Display-name precedence: explicit passed-in name → settings.discordDisplayName
 *   → settings.discordName → ''.
 * - fo76Name fallback chain: a real saved fo76Name → the resolved Discord
 *   display name.
 * - Theme defaults to 'fo76-wasteland' when unset.
 */
export function deriveInitialOnboardingState(
  s: OnboardingSourceSettings,
  passedDiscordDisplayName = '',
): OnboardingState {
  const resolvedDiscordDisplayName =
    passedDiscordDisplayName || s.discordDisplayName || s.discordName || '';

  const savedFo76Name =
    s.fo76Name && !s.fo76Name.startsWith('discord:') && !s.fo76Name.startsWith('Overlay')
      ? s.fo76Name
      : '';

  return {
    fo76Name: savedFo76Name || resolvedDiscordDisplayName,
    playsFo76: s.playsFo76,
    themeId: s.themeId || 'fo76-wasteland',
    discordLinked: s.discordLinked,
    discordName: s.discordName || '',
    discordDisplayName: resolvedDiscordDisplayName,
    steamLinked: s.steamLinked,
  };
}

/** View model for the footer/progress nav at a given step index. */
export interface NavView {
  pct: number;
  stepLabel: string;
  backHidden: boolean;
  nextLabel: string;
  isLastStep: boolean;
}

/**
 * Pure step → nav view. Clamps idx into [0, TOTAL_STEPS-1].
 * pct = ((idx+1)/TOTAL_STEPS)*100; back hidden at step 0; last step shows the
 * GET STARTED affordance.
 */
export function computeNavView(idx: number, totalSteps = TOTAL_STEPS): NavView {
  const clamped = Math.min(Math.max(idx, 0), totalSteps - 1);
  const isLastStep = clamped === totalSteps - 1;
  return {
    pct: ((clamped + 1) / totalSteps) * 100,
    stepLabel: `Step ${clamped + 1} of ${totalSteps}`,
    backHidden: clamped === 0,
    nextLabel: isLastStep ? 'GET STARTED  ✓' : 'NEXT  ▶',
    isLastStep,
  };
}

/** Result of pressing NEXT/BACK — the next step index to show. */
export function nextStepIndex(current: number, totalSteps = TOTAL_STEPS): number {
  return Math.min(current + 1, totalSteps - 1);
}
export function prevStepIndex(current: number): number {
  return Math.max(current - 1, 0);
}

// ── finish() decision tree ────────────────────────────────────────────────────

export interface FinishDeps {
  applyOnboardingSettings: (patch: FinishPatch) => void;
  setIdentityName?: (
    name: string,
  ) => Promise<{ ok: boolean; reason?: string; displayName?: string; message?: string }>;
  notifyOnboardingComplete?: () => void;
  notifyChatActive?: (active: boolean) => void;
}

export interface FinishPatch {
  fo76Name: string;
  playsFo76: boolean;
  themeId: string;
  discordLinked: boolean;
  discordName: string;
  discordDisplayName?: string;
  steamLinked: boolean;
  onboarded: true;
}

/** Build the settings patch persisted on finish. */
export function buildFinishPatch(state: OnboardingState): FinishPatch {
  return {
    fo76Name: state.fo76Name,
    playsFo76: state.playsFo76,
    themeId: state.themeId,
    discordLinked: state.discordLinked,
    discordName: state.discordName,
    discordDisplayName: state.discordDisplayName || undefined,
    steamLinked: state.steamLinked,
    onboarded: true,
  };
}

/**
 * Whether finish() should attempt to set the FO76 name as the chat display name.
 * Only when a name was entered, the user opted into FO76, and a prior taken-name
 * soft failure (or Skip) has NOT flagged skipNameOnNextFinish.
 */
export function shouldSetIdentityName(state: OnboardingState): boolean {
  return Boolean(state.fo76Name && state.playsFo76 && !state.skipNameOnNextFinish);
}

/**
 * Core finish() flow with injected deps. Mirrors onboarding.ts finish():
 *  1) persist the settings patch
 *  2) (when wantName) re-register the FO76 name; 'taken' returns {nameTaken:true}
 *     WITHOUT engaging the game gate (caller keeps onboarding open)
 *  3) engage the game gate via notifyOnboardingComplete (falling back to
 *     notifyChatActive(true) on older main processes)
 */
export async function runFinish(
  state: OnboardingState,
  deps: FinishDeps,
): Promise<{ nameTaken: boolean }> {
  deps.applyOnboardingSettings(buildFinishPatch(state));

  if (shouldSetIdentityName(state) && deps.setIdentityName) {
    try {
      const res = await deps.setIdentityName(state.fo76Name);
      if (!res.ok && res.reason === 'taken') {
        return { nameTaken: true };
      }
      // Any other failure is non-fatal — fall through to completion.
    } catch {
      /* non-fatal — proceed */
    }
  }

  notifyComplete(deps);
  return { nameTaken: false };
}

/**
 * The notify-completion fallback chain: prefer notifyOnboardingComplete (engages
 * the game gate + guiding toast); fall back to notifyChatActive(true) on older
 * main processes that lack the newer IPC. Swallows errors (web overlay context).
 */
export function notifyComplete(deps: FinishDeps): void {
  try {
    if (deps.notifyOnboardingComplete) deps.notifyOnboardingComplete();
    else deps.notifyChatActive?.(true);
  } catch {
    /* optional */
  }
}

// ── name-taken reducer ────────────────────────────────────────────────────────

export interface FinishUiDirective {
  /** Footer note text (empty string clears it). */
  note: string;
  /** Whether the note should render in the warn style. */
  warn: boolean;
  /** Whether the GET STARTED button should be re-enabled for another press. */
  disabled: boolean;
  /** Whether to flag skipNameOnNextFinish so the next press proceeds nameless. */
  skipNameOnNextFinish: boolean;
  /** Whether onboarding should be dismissed (success path). */
  dismiss: boolean;
}

/**
 * Reduce a runFinish() result into the footer UI directive.
 * - nameTaken (first press): show a gentle warn note, re-enable the button, and
 *   flag skipNameOnNextFinish so the second press proceeds without the name.
 * - success: clear the note and dismiss.
 */
export function reduceFinishResult(
  state: OnboardingState,
  result: { nameTaken: boolean },
): FinishUiDirective {
  if (result.nameTaken) {
    return {
      note: `"${state.fo76Name}" is taken — pick another, or leave blank to use your Discord name.`,
      warn: true,
      disabled: false,
      skipNameOnNextFinish: true,
      dismiss: false,
    };
  }
  return { note: '', warn: false, disabled: false, skipNameOnNextFinish: false, dismiss: true };
}
