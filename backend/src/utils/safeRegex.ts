import logger from '../config/logger';

/**
 * Compile an admin-supplied regex pattern with ReDoS guards.
 *
 * The name-blacklist / auto-mod filters let admins store regex that is then run
 * against every message + username. A catastrophic pattern (e.g. `(a+)+$`) can
 * pin the Node event loop on crafted input. JS's built-in RegExp is a
 * backtracking engine with no timeout, so we mitigate at compile time:
 *   - cap the pattern length, and
 *   - reject obviously catastrophic nested-quantifier constructs.
 *
 * This is a proportionate, dependency-free guard (the finding is admin-gated and
 * low severity). The durable fix is a linear-time engine like `re2`; that's a
 * native module and is intentionally not pulled in here to avoid adding a build
 * toolchain to the alpine production image.
 *
 * Returns a compiled RegExp, or null if the pattern is invalid/unsafe (the
 * caller skips the entry).
 */
const MAX_PATTERN_LENGTH = 200;

// Nested quantifier applied to a quantified/grouped sub-expression — the classic
// exponential-backtracking shape: (a+)+ (a*)* (a+)* (.*)+ (\d+|x)* etc.
const CATASTROPHIC = /(\([^)]*[+*][^)]*\)|\[[^\]]*\][+*]|\.[+*])[+*]/;

export function compileUserRegex(pattern: string, label = 'user-regex', flags = 'i'): RegExp | null {
  if (typeof pattern !== 'string' || pattern.length === 0) return null;
  if (pattern.length > MAX_PATTERN_LENGTH) {
    logger.warn({ label, length: pattern.length }, 'regex pattern exceeds max length — skipped');
    return null;
  }
  if (CATASTROPHIC.test(pattern)) {
    logger.warn({ label }, 'regex pattern contains a catastrophic-backtracking construct — skipped');
    return null;
  }
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    // A pattern that is invalid only under the 'u' flag (e.g. a lone backslash
    // sequence the admin wrote for non-unicode mode) falls back to 'i' so we
    // never silently drop a previously-working blacklist entry.
    if (flags !== 'i') {
      try {
        return new RegExp(pattern, 'i');
      } catch { /* fall through to the warn below */ }
    }
    logger.warn({ label, err }, 'invalid regex pattern — skipped');
    return null;
  }
}

/**
 * Hard cap on the input length fed to a user-defined regex. Even a guarded
 * pattern degrades on very long input; moderated text (messages/usernames) is
 * short, so truncating before matching bounds the worst case with no real cost.
 */
export const MAX_REGEX_INPUT = 2000;

export function clampRegexInput(input: string): string {
  return input.length > MAX_REGEX_INPUT ? input.slice(0, MAX_REGEX_INPUT) : input;
}
