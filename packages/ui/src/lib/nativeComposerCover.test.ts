import { describe, expect, test, vi } from 'vitest';

import { createNativeComposerCover } from './nativeComposerCover';

describe('native composer cover', () => {
  test('conceals on the first hold and reveals only after every hold releases', () => {
    const session = { conceal: vi.fn(), reveal: vi.fn() };
    const cover = createNativeComposerCover(session);
    const releaseSelection = cover.hold('text-selection');
    const releaseBtw = cover.hold('btw-page');

    expect(session.conceal).toHaveBeenCalledTimes(1);
    expect(session.reveal).not.toHaveBeenCalled();

    releaseSelection();
    expect(session.reveal).not.toHaveBeenCalled();

    releaseBtw();
    expect(session.reveal).toHaveBeenCalledTimes(1);
  });

  test('a second release of the same hold is a no-op', () => {
    const session = { conceal: vi.fn(), reveal: vi.fn() };
    const cover = createNativeComposerCover(session);
    const release = cover.hold('text-selection');

    release();
    release();

    expect(session.reveal).toHaveBeenCalledTimes(1);
  });
});
