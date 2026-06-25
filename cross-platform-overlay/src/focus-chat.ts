export type FocusChatState = 'focused' | 'retry' | 'blocked';
export type FocusChatTargetKind = 'rich' | 'textarea' | 'input';

export interface FocusChatResult {
  state: FocusChatState;
  reason: string;
  targetKind?: FocusChatTargetKind;
  targetLabel?: string;
}

const TEXT_LIKE_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel']);
const CHAT_HINT_RE = /(message|chat|composer|reply|input)/i;

const BLOCKING_UI_RULES = [
  { selector: '#shell-settings-backdrop.open', reason: 'settings open' },
  { selector: '#shell-onboarding-backdrop.open', reason: 'onboarding open' },
  { selector: '#shell-discord-login-wall', reason: 'discord login wall open' },
  { selector: '[role="dialog"][aria-modal="true"]', reason: 'modal dialog open' },
] as const;

function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected || el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  const view = el.ownerDocument.defaultView;
  const style = view?.getComputedStyle?.(el);
  if (!style) return false;
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isEditableContentElement(el: HTMLElement): boolean {
  const attr = (el.getAttribute('contenteditable') || '').toLowerCase();
  return el.isContentEditable || attr === 'true' || attr === 'plaintext-only';
}

function isReadOnlyOrDisabled(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    return el.disabled || el.readOnly;
  }
  return false;
}

function isEligibleBase(el: HTMLElement): boolean {
  return isVisible(el) && !isReadOnlyOrDisabled(el);
}

function elementHintText(el: HTMLElement): string {
  const parts = [
    el.id,
    el.className,
    el.getAttribute('name'),
    el.getAttribute('aria-label'),
    el.getAttribute('placeholder'),
    el.getAttribute('data-placeholder'),
  ].filter(Boolean);
  return parts.join(' ');
}

function isTextLikeInput(el: HTMLInputElement): boolean {
  const type = (el.getAttribute('type') || el.type || '').toLowerCase();
  return TEXT_LIKE_INPUT_TYPES.has(type);
}

function compareByBottomPosition(a: HTMLElement, b: HTMLElement): number {
  return b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom;
}

function pickBottomMost<T extends HTMLElement>(candidates: T[]): T | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareByBottomPosition)[0] ?? null;
}

function moveCaretToEnd(target: HTMLElement): void {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const value = target.value ?? '';
    try { target.setSelectionRange(value.length, value.length); } catch { /* ignore */ }
    return;
  }

  if (!isEditableContentElement(target)) return;
  const doc = target.ownerDocument;
  const view = doc.defaultView;
  const selection = view?.getSelection?.();
  if (!selection) return;
  const range = doc.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function focusWithoutScroll(target: HTMLElement): void {
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
}

function describeTarget(target: HTMLElement, kind: FocusChatTargetKind): string {
  if (kind === 'rich') return target.classList.contains('fcm-rich-input') ? 'rich-input' : 'contenteditable';
  if (kind === 'textarea') return 'textarea';
  const type = (target as HTMLInputElement).type || 'text';
  return `input:${type}`;
}

function findBlockingUiReason(doc: Document): string | null {
  for (const rule of BLOCKING_UI_RULES) {
    const matches = Array.from(doc.querySelectorAll<HTMLElement>(rule.selector)).filter(isVisible);
    if (matches.length > 0) return rule.reason;
  }
  return null;
}

function findRichTarget(host: HTMLElement): HTMLElement | null {
  const exact = Array.from(host.querySelectorAll<HTMLElement>('.fcm-rich-input')).filter(
    el => isEligibleBase(el) && isEditableContentElement(el),
  );
  if (exact.length > 0) return pickBottomMost(exact);

  const generic = Array.from(host.querySelectorAll<HTMLElement>('[contenteditable]')).filter(
    el => isEligibleBase(el) && isEditableContentElement(el),
  );
  return pickBottomMost(generic);
}

function findTextareaTarget(host: HTMLElement): HTMLTextAreaElement | null {
  const textareas = Array.from(host.querySelectorAll<HTMLTextAreaElement>('textarea')).filter(isEligibleBase);
  const hinted = textareas.filter(el => CHAT_HINT_RE.test(elementHintText(el)));
  return pickBottomMost(hinted.length > 0 ? hinted : textareas);
}

function findInputTarget(host: HTMLElement): HTMLInputElement | null {
  const inputs = Array.from(host.querySelectorAll<HTMLInputElement>('input')).filter(
    el => isEligibleBase(el) && isTextLikeInput(el) && CHAT_HINT_RE.test(elementHintText(el)),
  );
  return pickBottomMost(inputs);
}

function hasFocusedTarget(doc: Document, target: HTMLElement): boolean {
  const active = doc.activeElement;
  if (active === target) return true;
  if (active instanceof HTMLElement && target.contains(active)) return true;
  const selection = doc.defaultView?.getSelection?.();
  return !!selection?.anchorNode && target.contains(selection.anchorNode);
}

export function focusChatInput(doc: Document = document): FocusChatResult {
  const blockedReason = findBlockingUiReason(doc);
  if (blockedReason) return { state: 'blocked', reason: blockedReason };

  const host = doc.getElementById('shell-overlay-host');
  if (!(host instanceof HTMLElement)) {
    return { state: 'retry', reason: 'overlay host missing' };
  }

  const richTarget = findRichTarget(host);
  if (richTarget) {
    focusWithoutScroll(richTarget);
    moveCaretToEnd(richTarget);
    return hasFocusedTarget(doc, richTarget)
      ? { state: 'focused', reason: 'focused rich input', targetKind: 'rich', targetLabel: describeTarget(richTarget, 'rich') }
      : { state: 'retry', reason: 'rich input did not accept focus', targetKind: 'rich', targetLabel: describeTarget(richTarget, 'rich') };
  }

  const textareaTarget = findTextareaTarget(host);
  if (textareaTarget) {
    focusWithoutScroll(textareaTarget);
    moveCaretToEnd(textareaTarget);
    return hasFocusedTarget(doc, textareaTarget)
      ? { state: 'focused', reason: 'focused textarea', targetKind: 'textarea', targetLabel: describeTarget(textareaTarget, 'textarea') }
      : { state: 'retry', reason: 'textarea did not accept focus', targetKind: 'textarea', targetLabel: describeTarget(textareaTarget, 'textarea') };
  }

  const inputTarget = findInputTarget(host);
  if (inputTarget) {
    focusWithoutScroll(inputTarget);
    moveCaretToEnd(inputTarget);
    return hasFocusedTarget(doc, inputTarget)
      ? { state: 'focused', reason: 'focused text input', targetKind: 'input', targetLabel: describeTarget(inputTarget, 'input') }
      : { state: 'retry', reason: 'text input did not accept focus', targetKind: 'input', targetLabel: describeTarget(inputTarget, 'input') };
  }

  return { state: 'retry', reason: 'no visible chat input under #shell-overlay-host' };
}
