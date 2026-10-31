import { describe, expect, it } from 'vitest';
import type { UsageWindow } from '@/types/quota';
import { accountHeadingAt, tagWindowsWithAccount } from './accountGroups';

const window = (label: string): UsageWindow => ({
  usedPercent: 0, remainingPercent: 100, windowSeconds: null, resetAfterSeconds: null,
  resetAt: null, resetAtFormatted: null, resetAfterFormatted: null, label,
});

describe('quota account groups', () => {
  it('labels only the first row of each account when a provider has several', () => {
    const entries = tagWindowsWithAccount([
      ['alice@x.com · Total', window('Total')], ['alice@x.com · Other', window('Other')],
      ['bob@x.com · Total', window('Total')],
    ], [{ name: 'alice@x.com' }, { name: 'bob@x.com' }]);
    expect([0, 1, 2].map((index) => accountHeadingAt(entries, index))).toEqual(['alice@x.com', null, 'bob@x.com']);
  });

  it('adds no labels for a single account', () => {
    const source: Array<[string, UsageWindow]> = [['alice@x.com · Total', window('Total')]];
    const entries = tagWindowsWithAccount(source, [{ name: 'alice@x.com' }]);
    expect(entries).toBe(source);
    expect(accountHeadingAt(entries, 0)).toBeNull();
  });
});
