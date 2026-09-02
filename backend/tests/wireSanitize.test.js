// Coverage for the ZFE outbound-encoding repair (see src/services/relay/wireSanitize.ts).
//
// Regression source: 2026-08-06. Widget v2.9.8 logged `displayName=Abderaan` (8 clean ASCII
// characters) while the relay stored `Au0000bu0000du0000eu0000ru0000au0000au0000n` (43).
//
// SECOND regression, found in review of the first fix: the de-interleave pattern is not
// self-identifying. A legitimate body `au0000bu0000c` matches it exactly and the original
// implementation silently rewrote it to `abc`. Repair is now gated on the CHANNEL — where the
// decoded value must be a known slug, making the repair positively verifiable — and only that
// corroboration licenses repairing the same frame's body.

const {
  deinterleaveZfeNulEscapes,
  repairChannel,
  repairBody,
  readWireDisplayName,
  readWireString,
} = require('../dist/services/relay/wireSanitize');

const NUL = String.fromCharCode(0);
const pad = (s, esc) => s.split('').join(esc);
const SLUGS = ['global', 'trade', 'events', 'raids', 'infests', 'server'];
const isKnown = (s) => SLUGS.includes(s);

describe('deinterleaveZfeNulEscapes (low-level primitive)', () => {
  it('repairs the bare u0000 form seen on the wire', () => {
    expect(deinterleaveZfeNulEscapes('Au0000bu0000du0000eu0000ru0000au0000au0000n'))
      .toBe('Abderaan');
  });

  it('repairs the backslash-escaped and real-NUL forms', () => {
    expect(deinterleaveZfeNulEscapes(pad('global', '\\u0000'))).toBe('global');
    expect(deinterleaveZfeNulEscapes(pad('global', NUL))).toBe('global');
  });

  it('leaves prose, partial matches and short input alone', () => {
    const body = 'the escape u0000 is a NUL';
    expect(deinterleaveZfeNulEscapes(body)).toBe(body);
    expect(deinterleaveZfeNulEscapes('Au0000bu0000cd')).toBe('Au0000bu0000cd');
    expect(deinterleaveZfeNulEscapes('a b c d e f g')).toBe('a b c d e f g');
    expect(deinterleaveZfeNulEscapes('')).toBe('');
    expect(deinterleaveZfeNulEscapes('ab')).toBe('ab');
  });

  it('DOES rewrite a legitimate-looking string — which is exactly why callers must corroborate', () => {
    expect(deinterleaveZfeNulEscapes('au0000bu0000c')).toBe('abc');
  });
});

describe('repairChannel — positive verification against the known slug set', () => {
  it('passes an already-clean slug through, not flagged as mangled', () => {
    expect(repairChannel('global', isKnown)).toEqual({ slug: 'global', mangled: false });
    expect(repairChannel('server', isKnown)).toEqual({ slug: 'server', mangled: false });
  });

  it('repairs a mangled slug and flags the frame', () => {
    expect(repairChannel(pad('global', 'u0000'), isKnown)).toEqual({ slug: 'global', mangled: true });
    expect(repairChannel(pad('server', 'u0000'), isKnown)).toEqual({ slug: 'server', mangled: true });
    expect(repairChannel(pad('events', 'u0000'), isKnown)).toEqual({ slug: 'events', mangled: true });
  });

  it('does NOT accept a repair that fails to yield a known slug', () => {
    // De-interleaves cleanly to "abc", but "abc" is not a channel — so no repair, no flag.
    expect(repairChannel('au0000bu0000c', isKnown)).toEqual({ slug: 'au0000bu0000c', mangled: false });
  });

  it('passes an unknown slug through untouched so the caller can report what was really sent', () => {
    expect(repairChannel('not-a-channel', isKnown)).toEqual({ slug: 'not-a-channel', mangled: false });
  });

  it('handles non-strings and empty input', () => {
    expect(repairChannel(undefined, isKnown)).toEqual({ slug: '', mangled: false });
    expect(repairChannel(null, isKnown)).toEqual({ slug: '', mangled: false });
    expect(repairChannel(42, isKnown)).toEqual({ slug: '', mangled: false });
    expect(repairChannel('', isKnown)).toEqual({ slug: '', mangled: false });
  });
});

describe('repairBody — only ever repaired on corroborated frames', () => {
  it('THE REGRESSION: a legitimate body survives when the channel was clean', () => {
    expect(repairBody('au0000bu0000c', false)).toBe('au0000bu0000c');
    expect(repairBody('xu0000yu0000z', false)).toBe('xu0000yu0000z');
  });

  it('repairs a mangled body when the channel proved mangled', () => {
    expect(repairBody(pad('hello there', 'u0000'), true)).toBe('hello there');
    expect(repairBody(pad('FCMCTL/1/ROSTER:AAA|BBB', 'u0000'), true))
      .toBe('FCMCTL/1/ROSTER:AAA|BBB');
  });

  it('leaves ordinary prose alone even on a corroborated frame', () => {
    const body = 'hey does anyone want to run a raid';
    expect(repairBody(body, true)).toBe(body);
  });

  it('handles non-strings', () => {
    expect(repairBody(undefined, true)).toBe('');
    expect(repairBody(null, false)).toBe('');
  });
});

describe('end-to-end frame semantics', () => {
  it('clean channel + trap-shaped body: body is preserved verbatim', () => {
    const ch = repairChannel('global', isKnown);
    expect(ch).toEqual({ slug: 'global', mangled: false });
    expect(repairBody('au0000bu0000c', ch.mangled)).toBe('au0000bu0000c');
  });

  it('mangled channel + mangled body: both repaired together', () => {
    const ch = repairChannel(pad('global', 'u0000'), isKnown);
    expect(ch).toEqual({ slug: 'global', mangled: true });
    expect(repairBody(pad('hi', 'u0000'), ch.mangled)).toBe('hi');
  });

  it('is idempotent on an already-repaired frame', () => {
    const ch = repairChannel('global', isKnown);
    expect(repairBody(repairBody('hi', ch.mangled), ch.mangled)).toBe('hi');
  });
});

describe('readWireDisplayName', () => {
  it('repairs the real 43-character value observed on dev', () => {
    expect(readWireDisplayName('Au0000bu0000du0000eu0000ru0000au0000au0000n')).toBe('Abderaan');
  });

  it('leaves a clean name alone', () => {
    expect(readWireDisplayName('Abderaan')).toBe('Abderaan');
  });

  it('returns empty for non-strings', () => {
    expect(readWireDisplayName(undefined)).toBe('');
    expect(readWireDisplayName(null)).toBe('');
    expect(readWireDisplayName(42)).toBe('');
  });

  it('documents the accepted residual risk: register/hello carry no channel to corroborate against', () => {
    // A name literally shaped like the pattern is shortened. Accepted for short FO76 names;
    // explicitly NOT acceptable for free-form bodies, which is why repairBody is gated.
    expect(readWireDisplayName('au0000bu0000c')).toBe('abc');
  });
});

describe('short bodies on a corroborated frame', () => {
  it('repairs a two-character mangled body that the default guard would skip', () => {
    // "hi" -> "hu0000i" is only one padded character; the standalone primitive deliberately
    // ignores it, but a frame whose channel already proved mangled must still be repaired.
    expect(deinterleaveZfeNulEscapes('hu0000i')).toBe('hu0000i');
    expect(repairBody('hu0000i', true)).toBe('hi');
  });

  it('still leaves a short body alone when the channel was clean', () => {
    expect(repairBody('hu0000i', false)).toBe('hu0000i');
  });
});

describe('readWireString', () => {
  it('repairs a mangled value', () => {
    expect(readWireString(pad('global', 'u0000'))).toBe('global');
  });

  it('returns empty for non-strings', () => {
    expect(readWireString(undefined)).toBe('');
    expect(readWireString(null)).toBe('');
    expect(readWireString(42)).toBe('');
    expect(readWireString({})).toBe('');
  });
});
