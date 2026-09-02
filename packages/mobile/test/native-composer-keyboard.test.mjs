import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  nativeComposerBottomGap,
  nextNativeComposerKeyboardSession,
} from '../contracts/native-composer-keyboard.mjs';

test('hide events close the keyboard session even when the end-frame still overlaps', () => {
  assert.equal(nextNativeComposerKeyboardSession(true, 'willHide'), false);
  assert.equal(nextNativeComposerKeyboardSession(true, 'didHide'), false);
  assert.equal(nextNativeComposerKeyboardSession(false, 'willChangeFrame'), false);
  assert.equal(nextNativeComposerKeyboardSession(false, 'didChangeFrame'), false);
});

test('a leftover on-screen changeFrame after hide cannot keep the overlay raised', () => {
  const raised = nativeComposerBottomGap({
    sessionOpen: true,
    event: 'willHide',
    overlap: 336,
    windowSafeBottom: 34,
  });
  assert.equal(raised, 46);

  const stale = nativeComposerBottomGap({
    sessionOpen: false,
    event: 'didChangeFrame',
    overlap: 336,
    windowSafeBottom: 34,
  });
  assert.equal(stale, 46);
});

test('show and in-session frame changes follow the keyboard overlap', () => {
  assert.equal(nextNativeComposerKeyboardSession(false, 'willShow'), true);
  assert.equal(nativeComposerBottomGap({
    sessionOpen: false,
    event: 'willShow',
    overlap: 336,
    windowSafeBottom: 34,
  }), 348);
  assert.equal(nativeComposerBottomGap({
    sessionOpen: true,
    event: 'willChangeFrame',
    overlap: 180,
    windowSafeBottom: 34,
  }), 192);
});
