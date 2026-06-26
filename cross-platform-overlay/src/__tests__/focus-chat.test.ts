// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { focusChatInput } from '../focus-chat';

type RectOpts = {
  top?: number;
  left?: number;
  width?: number;
  height?: number;
};

let activeElementRef: Element | null = null;

function setRect(el: HTMLElement, opts: RectOpts = {}): void {
  const top = opts.top ?? 0;
  const left = opts.left ?? 0;
  const width = opts.width ?? 200;
  const height = opts.height ?? 24;
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: left,
      y: top,
      top,
      left,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    }),
  });
}

function installFocusStub(el: HTMLElement): void {
  Object.defineProperty(el, 'focus', {
    configurable: true,
    value: vi.fn(() => {
      activeElementRef = el;
    }),
  });
}

function appendHost(): HTMLElement {
  const host = document.createElement('div');
  host.id = 'shell-overlay-host';
  document.body.appendChild(host);
  setRect(host, { top: 0, left: 0, width: 800, height: 600 });
  return host;
}

beforeEach(() => {
  document.body.innerHTML = '';
  activeElementRef = document.body;
  Object.defineProperty(document, 'activeElement', {
    configurable: true,
    get: () => activeElementRef,
  });
});

describe('focusChatInput', () => {
  it('prefers the visible rich chat input over textarea fallbacks', () => {
    const host = appendHost();

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Type a message...';
    textarea.value = 'fallback';
    host.appendChild(textarea);
    setRect(textarea, { top: 520, height: 20 });
    installFocusStub(textarea);

    const richInput = document.createElement('div');
    richInput.className = 'fcm-rich-input';
    richInput.setAttribute('contenteditable', 'true');
    richInput.textContent = 'hello world';
    host.appendChild(richInput);
    setRect(richInput, { top: 540, height: 24 });
    installFocusStub(richInput);

    const result = focusChatInput(document);

    expect(result.state).toBe('focused');
    expect(result.targetKind).toBe('rich');
    expect(result.targetLabel).toBe('rich-input');
    expect(document.activeElement).toBe(richInput);
  });

  it('falls back to the chat textarea and moves the caret to the end', () => {
    const host = appendHost();

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Type a message...';
    textarea.value = 'hello wasteland';
    host.appendChild(textarea);
    setRect(textarea, { top: 540, height: 24 });
    installFocusStub(textarea);

    const result = focusChatInput(document);

    expect(result.state).toBe('focused');
    expect(result.targetKind).toBe('textarea');
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });

  it('falls back to a hinted text-like input when no textarea is available', () => {
    const host = appendHost();

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search by name...';
    host.appendChild(search);
    setRect(search, { top: 120, height: 24 });
    installFocusStub(search);

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Chat message';
    input.value = 'hello';
    host.appendChild(input);
    setRect(input, { top: 540, height: 24 });
    installFocusStub(input);

    const result = focusChatInput(document);

    expect(result.state).toBe('focused');
    expect(result.targetKind).toBe('input');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it('blocks while the discord login wall is open', () => {
    const host = appendHost();

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Type a message...';
    host.appendChild(textarea);
    setRect(textarea, { top: 540, height: 24 });
    installFocusStub(textarea);

    const loginWall = document.createElement('div');
    loginWall.id = 'shell-discord-login-wall';
    document.body.appendChild(loginWall);
    setRect(loginWall, { top: 0, left: 0, width: 800, height: 600 });

    const result = focusChatInput(document);

    expect(result.state).toBe('blocked');
    expect(result.reason).toBe('discord login wall open');
    expect(document.activeElement).toBe(document.body);
  });

  it('ignores hidden, disabled, readonly, zero-size, and non-chat inputs', () => {
    const host = appendHost();

    const hiddenTextarea = document.createElement('textarea');
    hiddenTextarea.placeholder = 'Type a message...';
    host.appendChild(hiddenTextarea);
    setRect(hiddenTextarea, { top: 540, height: 24 });
    hiddenTextarea.hidden = true;
    installFocusStub(hiddenTextarea);

    const disabledTextarea = document.createElement('textarea');
    disabledTextarea.placeholder = 'Type a message...';
    disabledTextarea.disabled = true;
    host.appendChild(disabledTextarea);
    setRect(disabledTextarea, { top: 560, height: 24 });
    installFocusStub(disabledTextarea);

    const readonlyInput = document.createElement('input');
    readonlyInput.type = 'text';
    readonlyInput.placeholder = 'Chat message';
    readonlyInput.readOnly = true;
    host.appendChild(readonlyInput);
    setRect(readonlyInput, { top: 580, height: 24 });
    installFocusStub(readonlyInput);

    const zeroSizeRichInput = document.createElement('div');
    zeroSizeRichInput.className = 'fcm-rich-input';
    zeroSizeRichInput.setAttribute('contenteditable', 'true');
    host.appendChild(zeroSizeRichInput);
    setRect(zeroSizeRichInput, { top: 600, width: 0, height: 0 });
    installFocusStub(zeroSizeRichInput);

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search by name...';
    host.appendChild(searchInput);
    setRect(searchInput, { top: 620, height: 24 });
    installFocusStub(searchInput);

    const result = focusChatInput(document);

    expect(result.state).toBe('retry');
    expect(result.reason).toBe('no visible chat input under #shell-overlay-host');
    expect(document.activeElement).toBe(document.body);
  });
});
