import { describe, expect, test } from 'vitest';

import {
  requestLynxRevertConfirm,
  resolveLynxRevertConfirm,
} from './revertConfirm';

describe('requestLynxRevertConfirm', () => {
  test(' Cap-style confirm only opens for a real path', () => {
    expect(requestLynxRevertConfirm('')).toBeNull();
    expect(requestLynxRevertConfirm('  ')).toBeNull();
    expect(requestLynxRevertConfirm(' src/a.ts ')).toEqual({ path: 'src/a.ts' });
  });
});

describe('resolveLynxRevertConfirm', () => {
  test('cancel clears without revert; confirm returns path', () => {
    const pending = requestLynxRevertConfirm('a.ts');
    expect(resolveLynxRevertConfirm(pending, 'cancel')).toEqual({
      pending: null,
      shouldRevert: false,
      path: null,
    });
    expect(resolveLynxRevertConfirm(pending, 'confirm')).toEqual({
      pending: null,
      shouldRevert: true,
      path: 'a.ts',
    });
    expect(resolveLynxRevertConfirm(null, 'confirm')).toEqual({
      pending: null,
      shouldRevert: false,
      path: null,
    });
  });
});
