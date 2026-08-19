/**
 * Conservative target detector for the chat-only targeted-attack policy.
 *
 * We intentionally recognize explicit addressing only. Arbitrary player names
 * are not reliable targets because chat messages do not carry a roster.
 */
const DIRECT_TARGET_RE = /<@!?\d{17,20}>|@[\p{L}\p{N}][\p{L}\p{N}_.-]{0,49}|\b(?:you|you're|youre|your|yourself|u|ur)\b/iu;

export function hasDirectTarget(content: string): boolean {
  return Boolean(content && DIRECT_TARGET_RE.test(content));
}
