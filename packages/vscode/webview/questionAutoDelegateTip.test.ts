import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import {
  QUESTION_AUTO_DELEGATE_HOST_TIP_TYPE,
  applyQuestionAutoDelegateHostTip,
} from './questionAutoDelegateTip';

describe('applyQuestionAutoDelegateHostTip', () => {
  test('refreshes once per tip and never re-enters via synthetic message dispatch', () => {
    const refresh = vi.fn();
    let depth = 0;
    let maxDepth = 0;

    const handle = (msg: unknown) => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      try {
        // Production path: tip handler must not invent another window message.
        // If a buggy implementation dispatched MessageEvent('message'), a real
        // listener would call handle again and blow the stack (oracle recursion).
        const handled = applyQuestionAutoDelegateHostTip(msg, () => {
          refresh();
        });
        assert.equal(handled, true);
      } finally {
        depth -= 1;
      }
    };

    handle({
      type: QUESTION_AUTO_DELEGATE_HOST_TIP_TYPE,
      properties: { epoch: 'e1', revision: 3 },
    });
    handle({
      type: QUESTION_AUTO_DELEGATE_HOST_TIP_TYPE,
      properties: { epoch: 'e1', revision: 4 },
    });

    assert.equal(refresh.mock.calls.length, 2);
    assert.equal(maxDepth, 1);
  });

  test('ignores unrelated envelopes without refreshing', () => {
    const refresh = vi.fn();
    assert.equal(applyQuestionAutoDelegateHostTip({ type: 'connectionStatus' }, refresh), false);
    assert.equal(applyQuestionAutoDelegateHostTip(null, refresh), false);
    assert.equal(refresh.mock.calls.length, 0);
  });
});
