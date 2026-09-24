import { describe, expect, test } from 'bun:test';

import {
  canPresentAssistantTps,
  computeAssistantTps,
  computeAssistantTpsByStep,
  formatAssistantTps,
} from '../assistantTps';

describe('computeAssistantTps', () => {
  test('matches OpenCode TUI by aggregating generated tokens and provider intervals across steps', () => {
    const tps = computeAssistantTps([
      { createdAt: 6_000, streamedAt: 10_000, outputTokens: 20, reasoningTokens: 5 },
      { createdAt: 24_000, streamedAt: 30_000, outputTokens: 30, reasoningTokens: 10 },
    ]);

    // (20 + 5 + 30 + 10) tokens / ((4 + 6) seconds) = 6.5 tok/s.
    expect(tps).toBe(6.5);
  });

  test('does not display a partial turn if any assistant step lacks a streamed boundary', () => {
    expect(computeAssistantTps([
      { createdAt: 1_000, streamedAt: 2_000, outputTokens: 50 },
      { createdAt: 3_000, outputTokens: 50 },
    ])).toBeNull();
  });

  test('computes the same cumulative rate at each assistant step as the TUI footer', () => {
    expect(computeAssistantTpsByStep([
      { createdAt: 1_000, streamedAt: 2_000, outputTokens: 40 },
      { createdAt: 3_000, streamedAt: 5_000, outputTokens: 30, reasoningTokens: 10 },
      { createdAt: 6_000, outputTokens: 20 },
    ])).toEqual([40, 26.666666666666668, null]);
  });

  test('returns null when the turn has no generated tokens or provider duration', () => {
    expect(computeAssistantTps([
      { createdAt: 1_000, streamedAt: 2_000, outputTokens: 0, reasoningTokens: 0 },
    ])).toBeNull();
    expect(computeAssistantTps([
      { createdAt: 1_000, streamedAt: 1_000, outputTokens: 100 },
    ])).toBeNull();
    expect(computeAssistantTps([])).toBeNull();
  });

  test('counts reasoning tokens and ignores invalid or negative token counts', () => {
    expect(computeAssistantTps([
      { createdAt: 1_000, streamedAt: 2_000, outputTokens: -5, reasoningTokens: 100 },
    ])).toBe(100);
  });
});

describe('canPresentAssistantTps', () => {
  test('shows a calculated rate for interrupted and failed turns', () => {
    expect(canPresentAssistantTps({ completionDisposition: 'abnormal', tps: 12.5 })).toBe(true);
    expect(canPresentAssistantTps({ completionDisposition: 'normal', tps: 12.5 })).toBe(true);
    expect(canPresentAssistantTps({ tps: 12.5 })).toBe(true);
  });

  test('hides an in-flight continuation and an uncalculable interrupt', () => {
    expect(canPresentAssistantTps({ completionDisposition: 'active', tps: 12.5 })).toBe(false);
    expect(canPresentAssistantTps({ completionDisposition: 'abnormal', tps: null })).toBe(false);
  });
});

describe('formatAssistantTps', () => {
  test('uses the TUI one-decimal format', () => {
    expect(formatAssistantTps(3.456)).toBe('3.5 tok/s');
    expect(formatAssistantTps(12.34)).toBe('12.3 tok/s');
    expect(formatAssistantTps(128.4)).toBe('128.4 tok/s');
    expect(formatAssistantTps(1234)).toBe('1234.0 tok/s');
  });

  test('returns empty for non-positive and non-finite rates', () => {
    expect(formatAssistantTps(0)).toBe('');
    expect(formatAssistantTps(Number.NaN)).toBe('');
  });
});
