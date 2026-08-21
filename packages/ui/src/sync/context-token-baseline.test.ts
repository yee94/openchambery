import { describe, expect, test } from 'vitest';

import {
  hasCompactionPartType,
  readContextTokenCount,
  scanContextTokenBaseline,
  sumContextTokenRecord,
} from './context-token-baseline';

const TOKENS = { input: 100, output: 40, reasoning: 5, cache: { read: 1, write: 2 } };

describe('scanContextTokenBaseline', () => {
  test('returns the newest token-bearing assistant', () => {
    const messages = [
      { id: 'a1', role: 'assistant', tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
      { id: 'u1', role: 'user' },
      { id: 'a2', role: 'assistant', tokens: TOKENS },
    ];

    expect(scanContextTokenBaseline(messages, () => undefined)).toEqual({
      messageId: 'a2',
      totalTokens: 148,
      tokens: TOKENS,
    });
  });

  test('skips token-less assistants but never crosses a compaction row', () => {
    const messages = [
      { id: 'a1', role: 'assistant', tokens: TOKENS },
      { id: 'u-compact', role: 'user' },
      // Post-compaction assistant still streaming: all-zero token placeholder.
      { id: 'a2', role: 'assistant', tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    ];

    expect(scanContextTokenBaseline(messages, () => [{ type: 'compaction' }])).toEqual({ compacted: true });
  });

  test('compaction row newer than the last assistant resets the baseline', () => {
    const messages = [
      { id: 'a1', role: 'assistant', tokens: TOKENS },
      { id: 'u-compact', role: 'user' },
    ];

    expect(scanContextTokenBaseline(messages, () => [{ type: 'compaction' }])).toEqual({ compacted: true });
  });

  test('a post-compaction assistant with tokens wins over the compaction row', () => {
    const messages = [
      { id: 'a1', role: 'assistant', tokens: TOKENS },
      { id: 'u-compact', role: 'user' },
      { id: 'a2', role: 'assistant', tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } },
    ];

    expect(scanContextTokenBaseline(messages, (id) => (id === 'u-compact' ? [{ type: 'compaction' }] : undefined))).toEqual({
      messageId: 'a2',
      totalTokens: 15,
      tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  });

  test('plain /compact text without a compaction part does not reset the baseline', () => {
    const messages = [
      { id: 'a1', role: 'assistant', tokens: TOKENS },
      { id: 'u-compact', role: 'user' },
    ];

    const baseline = scanContextTokenBaseline(messages, () => [{ type: 'text', text: '/compact' }]);
    expect(baseline && 'totalTokens' in baseline ? baseline.totalTokens : 0).toBe(148);
  });

  test('returns null without token-bearing assistants', () => {
    expect(scanContextTokenBaseline([{ id: 'u1', role: 'user' }], () => undefined)).toBeNull();
    expect(scanContextTokenBaseline([], () => undefined)).toBeNull();
    expect(
      scanContextTokenBaseline([{ id: 'a1', role: 'assistant', tokens: { input: 0, output: 0, reasoning: 0 } }], () => undefined),
    ).toBeNull();
  });

  test('reads token fields defensively', () => {
    expect(readContextTokenCount(undefined)).toBe(0);
    expect(readContextTokenCount(Number.NaN)).toBe(0);
    expect(readContextTokenCount(7)).toBe(7);
    expect(sumContextTokenRecord({ input: 1, cache: { read: 2 } })).toBe(3);
  });

  test('hasCompactionPartType matches only the compaction part type', () => {
    expect(hasCompactionPartType([{ type: 'compaction' }])).toBe(true);
    expect(hasCompactionPartType(undefined)).toBe(false);
    expect(hasCompactionPartType([{ type: 'text', text: '/compact' }])).toBe(false);
  });
});
