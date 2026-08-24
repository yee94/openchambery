import { describe, expect, it } from 'vitest';
import { reduceBackfillState } from './history-state.js';

describe('reduceBackfillState', () => {
  it.each([
    {
      name: 'invalidate resets cursor/complete and preserves provisionals',
      state: { cursor: 'opaque-1', complete: true },
      event: 'invalidate',
      expected: { cursor: null, complete: false, disposition: 'preserve' },
    },
    {
      name: 'invalidate from incomplete state',
      state: { cursor: 'opaque-2', complete: false },
      event: { type: 'invalidate' },
      expected: { cursor: null, complete: false, disposition: 'preserve' },
    },
    {
      name: 'page with next cursor stays incomplete and preserves',
      state: { cursor: null, complete: false },
      event: { type: 'page', nextCursor: 'opaque-3' },
      expected: { cursor: 'opaque-3', complete: false, disposition: 'preserve' },
    },
    {
      name: 'page with empty cursor completes and preserves',
      state: { cursor: 'opaque-3', complete: false },
      event: { type: 'page', nextCursor: null },
      expected: { cursor: null, complete: true, disposition: 'preserve' },
    },
    {
      name: 'page with empty string cursor completes and preserves',
      state: { cursor: 'opaque-4', complete: false },
      event: { type: 'page', nextCursor: '' },
      expected: { cursor: null, complete: true, disposition: 'preserve' },
    },
    {
      name: 'session-missing completes and discards provisionals',
      state: { cursor: 'opaque-5', complete: false },
      event: 'session-missing',
      expected: { cursor: null, complete: true, disposition: 'discard-provisional' },
    },
    {
      name: 'session-missing from complete state',
      state: { cursor: null, complete: true },
      event: { type: 'session-missing' },
      expected: { cursor: null, complete: true, disposition: 'discard-provisional' },
    },
    {
      name: 'unknown event preserves state',
      state: { cursor: 'opaque-6', complete: true },
      event: { type: 'unknown' },
      expected: { cursor: 'opaque-6', complete: true, disposition: 'preserve' },
    },
  ])('$name', ({ state, event, expected }) => {
    expect(reduceBackfillState(state, event)).toEqual(expected);
  });
});
