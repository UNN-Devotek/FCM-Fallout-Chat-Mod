// Coverage for the ZFE outbound-encoding repair (see src/services/relay/wireSanitize.ts).
//
// Regression source: 2026-08-06. Widget v2.9.8 logged `displayName=Abderaan` (8 clean ASCII
// characters) while the relay stored `Au0000bu0000du0000eu0000ru0000au0000au0000n` (43). The
// same transform hits `channel`, so every in-game send was rejected `invalid_channel` and the
// world/roster controls never matched, leaving SERVER chat permanently unbindable.

const { deinterleaveZfeNulEscapes, readWireString } = require('../dist/services/relay/wireSanitize');

const NUL = String.fromCharCode(0);
const pad = (s, esc) => s.split('').join(esc);

describe('deinterleaveZfeNulEscapes', () => {
  describe('repairs a fully mangled string', () => {
    it('bare u0000 form — the shape actually seen on the wire', () => {
      expect(deinterleaveZfeNulEscapes('Au0000bu0000du0000eu0000ru0000au0000au0000n'))
        .toBe('Abderaan');
    });

    it('the channel slug that broke every send', () => {
      expect(deinterleaveZfeNulEscapes(pad('global', 'u0000'))).toBe('global');
    });

    it('the server slug that blocked world binding', () => {
      expect(deinterleaveZfeNulEscapes(pad('server', 'u0000'))).toBe('server');
    });

    it('backslash-escaped form', () => {
      expect(deinterleaveZfeNulEscapes(pad('global', '\\u0000'))).toBe('global');
    });

    it('real NUL form', () => {
      expect(deinterleaveZfeNulEscapes(pad('global', NUL))).toBe('global');
    });

    it('a mangled control frame body', () => {
      expect(deinterleaveZfeNulEscapes(pad('FCMCTL/1/ROSTER:AAA|BBB', 'u0000')))
        .toBe('FCMCTL/1/ROSTER:AAA|BBB');
    });
  });

  describe('leaves everything else untouched — no silent rewriting', () => {
    it('already-clean slugs', () => {
      expect(deinterleaveZfeNulEscapes('global')).toBe('global');
      expect(deinterleaveZfeNulEscapes('server')).toBe('server');
    });

    it('ordinary prose', () => {
      const body = 'hey does anyone want to run a raid';
      expect(deinterleaveZfeNulEscapes(body)).toBe(body);
    });

    it('prose that merely mentions u0000', () => {
      const body = 'the escape u0000 is a NUL';
      expect(deinterleaveZfeNulEscapes(body)).toBe(body);
    });

    it('a string only partially matching the pattern', () => {
      const s = 'Au0000bu0000cd';
      expect(deinterleaveZfeNulEscapes(s)).toBe(s);
    });

    it('spaced text is never de-interleaved', () => {
      const body = 'a b c d e f g';
      expect(deinterleaveZfeNulEscapes(body)).toBe(body);
    });

    it('empty and short input', () => {
      expect(deinterleaveZfeNulEscapes('')).toBe('');
      expect(deinterleaveZfeNulEscapes('a')).toBe('a');
      expect(deinterleaveZfeNulEscapes('ab')).toBe('ab');
    });
  });

  it('is idempotent — repairing twice changes nothing', () => {
    const once = deinterleaveZfeNulEscapes(pad('global', 'u0000'));
    expect(deinterleaveZfeNulEscapes(once)).toBe('global');
  });
});

describe('readWireString', () => {
  it('repairs a mangled value', () => {
    expect(readWireString(pad('global', 'u0000'))).toBe('global');
  });

  it('returns empty for non-strings, matching the old typeof guards', () => {
    expect(readWireString(undefined)).toBe('');
    expect(readWireString(null)).toBe('');
    expect(readWireString(42)).toBe('');
    expect(readWireString({})).toBe('');
  });
});
