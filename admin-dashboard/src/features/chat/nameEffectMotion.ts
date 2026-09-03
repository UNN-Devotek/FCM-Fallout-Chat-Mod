/**
 * Stable scheduling for supporter name motion.
 *
 * The chat feed can mount many message rows at once. A process-global random
 * value would reshuffle on reconnects/renders, while no delay makes every row
 * animate in lockstep. Hashing the message identity gives each row its own
 * repeatable phase without a timer or per-frame JavaScript work.
 */

export const OVERSEER_ANIMATED_EFFECTS = [
  'glow-pulse',
  'crt-phosphor',
  'glitch',
  'shimmer',
] as const;

export type OverseerAnimatedEffect = typeof OVERSEER_ANIMATED_EFFECTS[number];

/** Supporter effects that have a brief, infrequent motion burst. */
export const OCCASIONAL_NAME_EFFECTS = [
  'chroma-split',
] as const;

export type OccasionalNameEffect = typeof OCCASIONAL_NAME_EFFECTS[number];
type NameMotionEffect = OverseerAnimatedEffect | OccasionalNameEffect;
const NAME_MOTION_EFFECTS = [
  ...OVERSEER_ANIMATED_EFFECTS,
  ...OCCASIONAL_NAME_EFFECTS,
] as const;

const EFFECT_CYCLE_SECONDS: Record<NameMotionEffect, number> = {
  'glow-pulse': 2.8,
  'crt-phosphor': 6,
  glitch: 11.5,
  shimmer: 8,
  'chroma-split': 12,
};

const GLITCH_MIN_SECONDS = 9.5;
const GLITCH_MAX_SECONDS = 13.5;
const CHROMA_MIN_SECONDS = 10.5;
const CHROMA_MAX_SECONDS = 15.5;

export type NameEffectMotionStyle = {
  '--fcm-effect-delay': string;
  '--fcm-glitch-duration'?: string;
  '--fcm-chroma-duration'?: string;
};

function hashSeed(seed: string): number {
  // FNV-1a keeps the output deterministic and distributes sequential message
  // IDs well enough for visual phase selection. It is not used for security.
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function unitInterval(seed: string): number {
  return hashSeed(seed) / 0xffffffff;
}

function isNameMotionEffect(effectId: string): effectId is NameMotionEffect {
  return (NAME_MOTION_EFFECTS as readonly string[]).includes(effectId);
}

/**
 * Return stable CSS variables for one name-motion effect.
 *
 * The negative delay starts each animation at a different point in its cycle.
 * Glitch and Chroma Split additionally get stable pseudo-random durations, so
 * their bursts do not recur at the same cadence across every visible message.
 */
export function nameEffectMotion(
  effectId: string | null | undefined,
  messageKey: string,
): NameEffectMotionStyle | Record<string, never> {
  if (!effectId || !isNameMotionEffect(effectId)) return {};

  const glitchDuration = GLITCH_MIN_SECONDS + unitInterval(`${messageKey}:glitch-duration`) * (GLITCH_MAX_SECONDS - GLITCH_MIN_SECONDS);
  const chromaDuration = CHROMA_MIN_SECONDS + unitInterval(`${messageKey}:chroma-duration`) * (CHROMA_MAX_SECONDS - CHROMA_MIN_SECONDS);
  const cycleSeconds = effectId === 'glitch'
    ? glitchDuration
    : effectId === 'chroma-split'
      ? chromaDuration
      : EFFECT_CYCLE_SECONDS[effectId];
  const phase = 0.15 + unitInterval(`${messageKey}:${effectId}:phase`) * Math.max(0.15, cycleSeconds - 0.15);
  const motion: NameEffectMotionStyle = {
    '--fcm-effect-delay': `-${phase.toFixed(3)}s`,
  };

  if (effectId === 'glitch') {
    motion['--fcm-glitch-duration'] = `${glitchDuration.toFixed(3)}s`;
  }
  if (effectId === 'chroma-split') {
    motion['--fcm-chroma-duration'] = `${chromaDuration.toFixed(3)}s`;
  }

  return motion;
}

export const NAME_EFFECT_MOTION_BOUNDS = {
  glitchMinSeconds: GLITCH_MIN_SECONDS,
  glitchMaxSeconds: GLITCH_MAX_SECONDS,
  chromaMinSeconds: CHROMA_MIN_SECONDS,
  chromaMaxSeconds: CHROMA_MAX_SECONDS,
} as const;
