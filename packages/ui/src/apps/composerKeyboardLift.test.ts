import { describe, expect, test } from 'bun:test';

import {
  getAndroidComposerImeStateAction,
  isComposerKeyboardFocusTransfer,
  isComposerKeyboardTarget,
  shouldReserveChatScrollInset,
} from './composerKeyboardLift';

const createElement = (tag: string, className = ''): HTMLElement => {
  const children: Element[] = [];
  const el = {
    tagName: tag.toUpperCase(),
    className,
    children,
    parentElement: null as HTMLElement | null,
    closest(selector: string) {
      let current: HTMLElement | null = el as unknown as HTMLElement;
      while (current) {
        if (selector.startsWith('.') && current.className.split(/\s+/).includes(selector.slice(1))) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    },
    append(...nodes: HTMLElement[]) {
      for (const node of nodes) {
        Object.defineProperty(node, 'parentElement', {
          configurable: true,
          value: el as unknown as HTMLElement,
        });
        children.push(node);
      }
    },
    appendChild(node: HTMLElement) {
      this.append(node);
      return node;
    },
  };
  return el as unknown as HTMLElement;
};

describe('composerKeyboardLift', () => {
  test('detects targets inside the bottom mobile composer', () => {
    const composer = createElement('form', 'oc-mobile-composer');
    const textarea = createElement('textarea');
    composer.appendChild(textarea);

    expect(isComposerKeyboardTarget(textarea)).toBe(true);
    expect(isComposerKeyboardTarget(composer)).toBe(true);
  });

  test('rejects question / non-composer fields', () => {
    const card = createElement('div', 'question-card');
    const textarea = createElement('textarea');
    card.appendChild(textarea);

    expect(isComposerKeyboardTarget(textarea)).toBe(false);
    expect(isComposerKeyboardTarget(null)).toBe(false);
    expect(shouldReserveChatScrollInset(textarea)).toBe(true);
    expect(shouldReserveChatScrollInset(null)).toBe(false);
  });

  test('reserves chat scroll inset only for non-composer text fields', () => {
    const composer = createElement('form', 'oc-mobile-composer');
    const composerTextarea = createElement('textarea');
    const questionInput = createElement('input');
    const questionContentEditable = createElement('div') as HTMLElement & { isContentEditable: boolean };
    Object.defineProperty(questionContentEditable, 'isContentEditable', { value: true });
    composer.appendChild(composerTextarea);

    expect(shouldReserveChatScrollInset(questionInput)).toBe(true);
    expect(shouldReserveChatScrollInset(questionContentEditable)).toBe(true);
    expect(shouldReserveChatScrollInset(composerTextarea)).toBe(false);
    expect(shouldReserveChatScrollInset(createElement('button'))).toBe(false);
  });

  test('focus transfer stays armed only inside the composer', () => {
    const composer = createElement('form', 'oc-mobile-composer');
    const a = createElement('textarea');
    const b = createElement('input');
    composer.append(a, b);
    const outside = createElement('textarea');

    expect(isComposerKeyboardFocusTransfer(b)).toBe(true);
    expect(isComposerKeyboardFocusTransfer(outside)).toBe(false);
    expect(isComposerKeyboardFocusTransfer(null)).toBe(false);
  });

  test('routes native IME state to composer lift, cache, or field inset', () => {
    const composer = createElement('form', 'oc-mobile-composer');
    const textarea = createElement('textarea');
    const outside = createElement('input');
    composer.appendChild(textarea);

    expect(getAndroidComposerImeStateAction(false, textarea)).toBe('open');
    expect(getAndroidComposerImeStateAction(true, textarea)).toBe('cache');
    expect(getAndroidComposerImeStateAction(true, outside)).toBe('cache');
    expect(getAndroidComposerImeStateAction(false, outside)).toBe('field');
    expect(getAndroidComposerImeStateAction(false, createElement('button'))).toBe('ignore');
  });
});
