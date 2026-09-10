import { describe, expect, test } from 'vitest';

import {
  requestLynxRevertConfirm,
  resolveLynxRevertConfirm,
} from './revertConfirm';

describe('requestLynxRevertConfirm', () => {
  test('Cap-style confirm only opens for a real path', () => {
    expect(requestLynxRevertConfirm('')).toBeNull();
    expect(requestLynxRevertConfirm('  ')).toBeNull();
    expect(requestLynxRevertConfirm(' src/a.ts ')).toEqual({
      path: 'src/a.ts',
      paths: ['src/a.ts'],
    });
  });

  test('Cap revert-all accepts multiple paths (dedupe + trim)', () => {
    expect(requestLynxRevertConfirm([])).toBeNull();
    expect(requestLynxRevertConfirm(['  ', ''])).toBeNull();
    expect(requestLynxRevertConfirm(['a.ts', ' a.ts ', 'b.ts'])).toEqual({
      path: 'a.ts',
      paths: ['a.ts', 'b.ts'],
    });
  });
});

describe('resolveLynxRevertConfirm', () => {
  test('cancel clears without revert; confirm returns paths', () => {
    const pending = requestLynxRevertConfirm(['a.ts', 'b.ts']);
    expect(resolveLynxRevertConfirm(pending, 'cancel')).toEqual({
      pending: null,
      shouldRevert: false,
      path: null,
      paths: null,
    });
    expect(resolveLynxRevertConfirm(pending, 'confirm')).toEqual({
      pending: null,
      shouldRevert: true,
      path: 'a.ts',
      paths: ['a.ts', 'b.ts'],
    });
    expect(resolveLynxRevertConfirm(null, 'confirm')).toEqual({
      pending: null,
      shouldRevert: false,
      path: null,
      paths: null,
    });
  });
});
