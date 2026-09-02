import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'vitest';

import { CustomAnswerTextarea } from './QuestionCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
});

function installBorderBoxScrollHeight(
  textarea: HTMLTextAreaElement,
  getContentHeight: () => number,
) {
  Object.defineProperty(textarea, 'scrollHeight', {
    configurable: true,
    get() {
      if (textarea.style.height === 'auto' || textarea.style.height === '0px') {
        return getContentHeight();
      }
      const assigned = Number.parseFloat(textarea.style.height);
      if (!Number.isFinite(assigned)) return getContentHeight();
      const inner = assigned - 2;
      const content = getContentHeight();
      return inner < content ? content + 2 : content;
    },
  });
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    proto?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Question custom answer textarea', () => {
  test('deleting a line does not exceed React update depth', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let contentHeight = 40;

    await act(async () => {
      root.render(
        <CustomAnswerTextarea
          value="one"
          placeholder="Your answer"
          disabled={false}
          onValueChange={() => undefined}
          onKeyDown={() => undefined}
        />,
      );
    });

    const textarea = host.querySelector('textarea');
    expect(textarea).toBeTruthy();
    if (!textarea) throw new Error('expected textarea');

    installBorderBoxScrollHeight(textarea, () => contentHeight);

    contentHeight = 80;
    await setTextareaValue(textarea, 'one\ntwo\nthree');
    expect(textarea.style.height).toBe('80px');

    contentHeight = 48;
    await setTextareaValue(textarea, 'one\ntwo');

    expect(textarea.value).toBe('one\ntwo');
    expect(textarea.style.height).toBe('48px');
    await act(async () => {
      root.unmount();
    });
  });
});
