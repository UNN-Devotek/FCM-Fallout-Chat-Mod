/**
 * wireSanitize.ts — repair mod-supplied strings mangled by ZFE's outbound encoder.
 *
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
 * bare one. Built with fromCharCode for the NUL so no control byte sits in this source file.
 * Never add a whitespace form — it would de-interleave ordinary spaced prose.
 */
const ESCAPE_FORMS: string[] = ['\\u0000', 'u0000', String.fromCharCode(0)];

/**
 * Undo the per-character escape padding if — and only if — it covers the whole string.
 * Returns the input unchanged when it is not uniformly mangled.
 */
export function deinterleaveZfeNulEscapes(input: string): string {
  if (!input) return input;

  for (const esc of ESCAPE_FORMS) {
    const stride = esc.length + 1;
    // A fully mangled string is (char + escape) repeated, then one trailing bare character.
    // Require at least two padded characters so short strings cannot match by accident.
    if (input.length < stride * 2 + 1) continue;
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

/** Convenience for the relay's frame readers: coerce to string, then repair. */
export function readWireString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return deinterleaveZfeNulEscapes(value);
}
