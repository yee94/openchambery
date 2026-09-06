import { describe, expect, test } from 'vitest';

import {
  createLynxImeInsetPublisher,
  LYNX_IME_INSET_DEFAULT,
  LYNX_IME_INSET_WIRING_NOTES,
  type LynxImeInsetListener,
} from './imeInset';

describe('Lynx IME inset publisher', () => {
  test('no host → default snapshot; notes require autocomplete above glass', () => {
    const pub = createLynxImeInsetPublisher();
    expect(pub.isAvailable()).toBe(false);
    expect(pub.getSnapshot()).toEqual(LYNX_IME_INSET_DEFAULT);
    expect(LYNX_IME_INSET_WIRING_NOTES.some((n) => n.includes('ABOVE glass'))).toBe(true);
  });

  test('host subscribe forwards snapshots', () => {
    const pub = createLynxImeInsetPublisher();
    const seen: number[] = [];
    const holder: { listener: LynxImeInsetListener | null } = { listener: null };
    pub.inject({
      subscribe: (l) => {
        holder.listener = l;
        return () => {
          holder.listener = null;
        };
      },
      getSnapshot: () => ({ keyboardHeight: 320, safeAreaBottom: 34, collapsedComposerHeight: 56 }),
    });
    const unsub = pub.subscribe((s) => seen.push(s.keyboardHeight));
    holder.listener?.({ keyboardHeight: 320, safeAreaBottom: 34, collapsedComposerHeight: 56 });
    expect(seen).toEqual([320]);
    expect(pub.getSnapshot().keyboardHeight).toBe(320);
    unsub();
  });
});
