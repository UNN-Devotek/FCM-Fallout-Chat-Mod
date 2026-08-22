/**
 * wireSanitize.ts — repair mod-supplied strings mangled by ZFE's outbound encoder.
 *
 * ZFE 0.9.12–0.12.1 (at least) corrupt string values a mod passes through `chat.v1.*`: each
 * character is emitted followed by the literal text `u0000` — the escape for the 0x00 high byte
 * of the UTF-16 code unit, with the backslash lost. ZFE builds the frame itself, so its OWN
 * values (`op`, the relay token, cursors) are clean; only the mod-supplied values are damaged.
 *
 * Proven on dev 2026-08-06 with widget v2.9.8: the widget logged `displayName=Abderaan`
 * (8 clean ASCII characters) and the relay stored
 * `Au0000bu0000du0000eu0000ru0000au0000au0000n` (43 characters).
 *
 * ── WHY REPAIR IS CORROBORATION-GATED ────────────────────────────────────────────────────────
 * The de-interleave pattern is NOT self-identifying. A perfectly legitimate message body such as
 * `au0000bu0000c` matches it exactly and would be silently rewritten to `abc`. Deinterleaving a
 * body on its own evidence is therefore unsafe and must never be done.
 *
 * `channel` is different: its decoded value must be a KNOWN SLUG. That makes the repair
 * positively verifiable — we accept it only when de-interleaving turns an unrecognised slug into
 * a recognised one. That success is then the corroborating evidence that THIS FRAME came from a
 * mangling client, which is what licenses repairing the body alongside it.
 *
 * So: detect on `channel`, then repair `body` only for that frame. A frame whose channel is
 * already clean gets its body passed through untouched, whatever it happens to look like.
 *
 * Remove all of this once ZFE ships a fix AND the affected builds are out of circulation.
 * ZFE 0.9.12–0.12.1 (at least) corrupt every string value a mod passes through
 * `chat.v1.*`: each character is emitted followed by the literal text `u0000` — the escape
 * for the 0x00 high byte of the UTF-16 code unit, with the backslash lost. ZFE's own values
 * (the relay token, cursors) are unaffected, and ZFE parses the mod's JSON envelope correctly,
 * so only the extracted string VALUES are damaged.
 *
 * Proven on dev 2026-08-06 with widget v2.9.8: the widget logged `displayName=Abderaan`
 * (8 clean ASCII characters) and the relay stored
 * `Au0000bu0000du0000eu0000ru0000au0000au0000n` (43 characters). The same transform hits the
 * `channel` field, so `global` arrives as `gu0000lu0000ou0000bu0000au0000lu0000`, fails
 * `ALL_SLUGS.includes(slug)`, and every in-game send is rejected `invalid_channel`. The
 * `server` slug is mangled the same way, so the world/roster control intercept never fires and
 * SERVER chat can never bind.
 *
 * This is an upstream ZFE defect and the widget cannot work around it — a clean string goes in
 * and a mangled one comes out. The relay repairs it on receipt so affected clients work today.
 * Remove this once ZFE ships a fix AND the old builds are out of circulation.
 *
 * SAFETY: only a string that is mangled END TO END is repaired. The pattern is every character
 * followed by the escape, with the final character bare. Ordinary text that merely happens to
 * contain "u0000" does not match and is returned untouched, so a legitimate message body is
 * never silently rewritten.
 */

/**
 * The three observed escape forms, longest first so the backslash variant is tried before the
 * bare one. The NUL is built with fromCharCode so no control byte sits in this source file.
 * bare one. Built with fromCharCode for the NUL so no control byte sits in this source file.
 * Never add a whitespace form — it would de-interleave ordinary spaced prose.
 */
const ESCAPE_FORMS: string[] = ['\\u0000', 'u0000', String.fromCharCode(0)];

/**
 * Undo the per-character escape padding if — and only if — it covers the whole string.
 * Returns the input unchanged when it is not uniformly padded.
 *
 * LOW-LEVEL PRIMITIVE. A positive result is NOT proof of mangling (see the note above); callers
 * must corroborate before trusting it on free-form text.
 */
export function deinterleaveZfeNulEscapes(input: string, minPaddedChars = 2): string {
  if (!input) return input;

  for (const esc of ESCAPE_FORMS) {
    const stride = esc.length + 1;
    // A fully mangled string is (char + escape) repeated, then one trailing bare character.
    // `minPaddedChars` defaults to 2 so short strings cannot match by accident. Callers that
    // have ALREADY corroborated the frame (see repairBody) drop to 1, because at that point a
    // false positive is no longer possible and a two-character body still needs repairing.
    if (input.length < stride * minPaddedChars + 1) continue;
    if ((input.length - 1) % stride !== 0) continue;

    let ok = true;
    const out: string[] = [];
    for (let i = 0; i < input.length - 1; i += stride) {
      out.push(input[i]);
      if (input.slice(i + 1, i + 1 + esc.length) !== esc) { ok = false; break; }
    }
    if (!ok) continue;

    out.push(input[input.length - 1]);
    return out.join('');
  }

  return input;
}

export interface ChannelRepair {
  /** The slug to route on. */
  slug: string;
  /**
   * True only when de-interleaving turned an unrecognised slug into a recognised one. This is the
   * frame-level "this client mangles strings" signal — the ONLY thing that licenses body repair.
   */
  mangled: boolean;
}

/**
 * Resolve the channel slug, positively verifying any repair against the known slug set.
 *
 * - already a known slug        -> pass through, mangled=false
 * - de-interleaves to a known slug -> repaired, mangled=true
 * - neither                     -> pass the ORIGINAL through untouched so the caller emits its
 *                                  normal "unknown channel" error against what was really sent
 */
export function repairChannel(value: unknown, isKnownSlug: (slug: string) => boolean): ChannelRepair {
  const raw = typeof value === 'string' ? value : '';
  if (!raw) return { slug: '', mangled: false };
  if (isKnownSlug(raw)) return { slug: raw, mangled: false };

  const decoded = deinterleaveZfeNulEscapes(raw);
  if (decoded !== raw && isKnownSlug(decoded)) return { slug: decoded, mangled: true };

  return { slug: raw, mangled: false };
}

/**
 * Repair a body ONLY when its frame's channel proved mangled. Never call this with
 * `mangled` derived from the body itself.
 */
export function repairBody(value: unknown, channelWasMangled: boolean): string {
  const raw = typeof value === 'string' ? value : '';
  if (!channelWasMangled) return raw;
  // Corroborated frame: a short body like "hi" -> "hu0000i" is still mangled and must be
  // repaired, and the accidental-match guard is no longer needed here.
  return deinterleaveZfeNulEscapes(raw, 1);
}

/**
 * Repair a display name from register/hello.
 *
 * Those frames carry no channel, so there is nothing to corroborate against — this is the one
 * place a bare de-interleave is still applied. The residual risk is a character name literally
 * shaped like `au0000bu0000c`, which would be shortened. That is accepted deliberately: FO76
 * names are short and this shape requires the exact `u0000` filler between every character.
 * It is NOT acceptable for message bodies, which are free-form and attacker-influenced.
 */
export function readWireDisplayName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return deinterleaveZfeNulEscapes(value);
}

/** Convenience for callers that need a repaired string without channel corroboration. */
export function readWireString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return deinterleaveZfeNulEscapes(value);
}
