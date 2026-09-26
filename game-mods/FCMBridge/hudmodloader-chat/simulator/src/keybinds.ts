export const keybindFields = ['openKey', 'channelNextKey', 'channelPrevKey', 'scrollUpKey',
  'scrollDownKey', 'scrollBottomKey', 'activateLinkKey', 'hideKey'] as const;
export type KeybindField = typeof keybindFields[number];
export type KeybindProfile = Record<KeybindField, string>;

export const defaultKeybinds: KeybindProfile = {
  openKey: 'INSERT', channelNextKey: 'PAGEDOWN', channelPrevKey: 'PAGEUP',
  scrollUpKey: 'UP', scrollDownKey: 'DOWN', scrollBottomKey: '', activateLinkKey: 'F8', hideKey: 'DELETE',
};

export const supportedKeys = ['', 'ENTER', 'INSERT', 'DELETE', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN',
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'ESCAPE', 'TAB', 'SPACE', 'PERIOD',
  'COMMA', 'SEMICOLON', 'EQUALS', 'MINUS', 'SLASH', 'GRAVE', 'LEFTBRACKET', 'BACKSLASH',
  'RIGHTBRACKET', 'APOSTROPHE', 'BACKSPACE', 'CAPSLOCK', 'NUMLOCK', 'SCROLLLOCK',
  'PRINTSCREEN', 'PAUSE', 'SHIFT', 'CONTROL', 'ALT',
  'NUMPADMULTIPLY', 'NUMPADADD', 'NUMPADSUBTRACT', 'NUMPADDECIMAL', 'NUMPADDIVIDE',
  ...Array.from({ length: 10 }, (_, i) => `NUMPAD${i}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), ...'0123456789'.split('')];

const rawVirtualKey = (token: string): number | null => {
  const match = /^VK_([0-9]{1,3})$/.exec(token);
  if (!match) return null;
  const keyCode = Number(match[1]);
  return keyCode > 0 && keyCode < 255 ? keyCode : null;
};

export function normalizeKeybinds(value: unknown): KeybindProfile {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const output = { ...defaultKeybinds };
  for (const field of keybindFields) {
    const raw = typeof input[field] === 'string' ? input[field].trim() : output[field];
    if (raw === '' && (field === 'scrollBottomKey' || field === 'hideKey')) output[field] = '';
    else if (supportedKeys.includes(raw.toUpperCase()) || rawVirtualKey(raw.toUpperCase()) !== null)
      output[field] = raw.toUpperCase();
    else throw new Error(`Unsupported ${field}: ${raw}`);
  }
  const active = keybindFields.map(field => output[field]).filter(Boolean);
  const codes = active.map(key => browserKey(key)?.keyCode ?? key);
  if (new Set(codes).size !== codes.length) throw new Error('Each active action must use a different key');
  return output;
}

export function applyKeybindsToIni(source: string, profile: KeybindProfile): string {
  let result = source;
  for (const field of keybindFields) {
    const pattern = new RegExp(`^${field}=.*$`, 'm');
    if (!pattern.test(result)) throw new Error(`FCMChat.ini is missing ${field}`);
    result = result.replace(pattern, `${field}=${profile[field]}`);
  }
  return result;
}

export function browserKey(token: string): { code: string; key: string; keyCode: number } | null {
  const key = token.toUpperCase();
  const named: Record<string, [string, string, number]> = {
    ENTER: ['Enter', 'Enter', 13], INSERT: ['Insert', 'Insert', 45], DELETE: ['Delete', 'Delete', 46], HOME: ['Home', 'Home', 36], END: ['End', 'End', 35],
    PAGEUP: ['PageUp', 'PageUp', 33], PAGEDOWN: ['PageDown', 'PageDown', 34], UP: ['ArrowUp', 'ArrowUp', 38],
    DOWN: ['ArrowDown', 'ArrowDown', 40], LEFT: ['ArrowLeft', 'ArrowLeft', 37], RIGHT: ['ArrowRight', 'ArrowRight', 39],
    ESCAPE: ['Escape', 'Escape', 27], TAB: ['Tab', 'Tab', 9], SPACE: ['Space', ' ', 32],
    PERIOD: ['Period', '.', 190],
    COMMA: ['Comma', ',', 188], SEMICOLON: ['Semicolon', ';', 186], EQUALS: ['Equal', '=', 187],
    MINUS: ['Minus', '-', 189], SLASH: ['Slash', '/', 191], GRAVE: ['Backquote', '`', 192],
    LEFTBRACKET: ['BracketLeft', '[', 219], BACKSLASH: ['Backslash', '\\', 220],
    RIGHTBRACKET: ['BracketRight', ']', 221], APOSTROPHE: ['Quote', "'", 222],
    BACKSPACE: ['Backspace', 'Backspace', 8], CAPSLOCK: ['CapsLock', 'CapsLock', 20],
    NUMLOCK: ['NumLock', 'NumLock', 144], SCROLLLOCK: ['ScrollLock', 'ScrollLock', 145],
    PRINTSCREEN: ['PrintScreen', 'PrintScreen', 44], PAUSE: ['Pause', 'Pause', 19],
    SHIFT: ['ShiftLeft', 'Shift', 16], CONTROL: ['ControlLeft', 'Control', 17],
    ALT: ['AltLeft', 'Alt', 18],
    NUMPADMULTIPLY: ['NumpadMultiply', '*', 106], NUMPADADD: ['NumpadAdd', '+', 107],
    NUMPADSUBTRACT: ['NumpadSubtract', '-', 109], NUMPADDECIMAL: ['NumpadDecimal', '.', 110],
    NUMPADDIVIDE: ['NumpadDivide', '/', 111],
  };
  if (named[key]) return { code: named[key][0], key: named[key][1], keyCode: named[key][2] };
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return { code: key, key, keyCode: 111 + Number(key.slice(1)) };
  if (/^NUMPAD[0-9]$/.test(key)) return { code: `Numpad${key.slice(6)}`, key: key.slice(6), keyCode: 96 + Number(key.slice(6)) };
  if (/^[A-Z]$/.test(key)) return { code: `Key${key}`, key: key.toLowerCase(), keyCode: key.charCodeAt(0) };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, key, keyCode: key.charCodeAt(0) };
  const rawCode = rawVirtualKey(key);
  if (rawCode !== null) return { code: key, key: 'Unidentified', keyCode: rawCode };
  return null;
}
