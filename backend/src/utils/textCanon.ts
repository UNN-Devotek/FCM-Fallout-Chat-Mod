/**
 * Canonical text form for moderation matching.
 *
 * Bare NFC normalization is largely ineffective against combining-diacritic
 * bypass: a denylist phrase like `café` compiled as `/\bcafé\b/i` will NOT match
 * a user-supplied `café`, because `é` is not an ASCII word character, so the
 * trailing `\b` boundary never forms (the boundary needs a `\w`→non-`\w`
 * transition, and `é` is non-`\w`). NFC also leaves the visible accent in place,
 * so an attacker can pad ASCII slurs with combining marks (`ｎｉｇｇéｒ`-style) and
 * slip past ASCII denylist phrases entirely.
 *
 * `canon()` instead decomposes to NFD and STRIPS all combining marks
 * (Unicode general category Mark, `\p{M}`), collapsing `café` → `cafe`,
 * `é` → `e`, and any base-letter + combining-diacritic sequence to its plain
 * base letter. The result ends in real ASCII word characters, so word-boundary
 * regexes match as intended, and ASCII denylist phrases catch diacritic-padded
 * variants.
 *
 * IMPORTANT: `canon()` is used ONLY for MATCHING. The original, unmodified
 * message/name is always what gets stored, broadcast, and shown in violation
 * evidence — the canonical form must never leak into persisted/displayed data.
 *
 * This does NOT collapse homoglyphs (Cyrillic `е` vs Latin `e`) or remove
 * zero-width characters; those are separate concerns handled elsewhere if/when
 * needed. Stripping marks is the high-value, low-risk defense for the documented
 * combining-diacritic bypass.
 */
export function canon(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';
  // NFD splits precomposed characters into base + combining marks; \p{M} then
  // removes every combining mark. The 'u' flag is required for \p{…} classes.
  return input.normalize('NFD').replace(/\p{M}/gu, '');
}
