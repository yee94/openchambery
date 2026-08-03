import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';

import {
  computeAssistantTps,
  computeGenerationDurationMs,
  formatAssistantTps,
  sumToolDurationMs,
} from '../assistantTps';

const part = (data: Record<string, unknown>): Part => data as unknown as Part;

describe('sumToolDurationMs', () => {
  test('returns 0 for empty parts', () => {
    expect(sumToolDurationMs([])).toBe(0);
    expect(sumToolDurationMs(null)).toBe(0);
  });

  test('sums completed tool intervals only', () => {
    const parts = [
      part({ type: 'tool', state: { time: { start: 1000, end: 1500 } } }),
      part({ type: 'tool', state: { time: { start: 2000, end: 2300 } } }),
      part({ type: 'tool', state: { time: { start: 3000 } } }),
      part({ type: 'text', time: { start: 1000, end: 4000 } }),
    ];
    expect(sumToolDurationMs(parts)).toBe(800);
  });

  test('ignores inverted tool intervals', () => {
    expect(
      sumToolDurationMs([
        part({ type: 'tool', state: { time: { start: 2000, end: 1000 } } }),
      ]),
    ).toBe(0);
  });
});

describe('computeGenerationDurationMs', () => {
  test('returns null without completed/created', () => {
    expect(computeGenerationDurationMs(null, 2000, [])).toBeNull();
    expect(computeGenerationDurationMs(1000, null, [])).toBeNull();
    expect(computeGenerationDurationMs(2000, 1000, [])).toBeNull();
  });

  test('subtracts tool duration from wall clock', () => {
    const parts = [
      part({ type: 'tool', state: { time: { start: 1100, end: 1600 } } }),
    ];
    // wall 2000ms, tool 500ms → generation 1500ms
    expect(computeGenerationDurationMs(1000, 3000, parts)).toBe(1500);
  });

  test('returns null when tools consume the entire span', () => {
    const parts = [
      part({ type: 'tool', state: { time: { start: 1000, end: 3000 } } }),
    ];
    expect(computeGenerationDurationMs(1000, 3000, parts)).toBeNull();
  });
});

describe('computeAssistantTps', () => {
  test('uses output + reasoning over generation seconds', () => {
    // 1000ms generation, 50 output + 50 reasoning → 100 tok/s
    const tps = computeAssistantTps({
      createdAt: 1_000,
      completedAt: 2_000,
      outputTokens: 50,
      reasoningTokens: 50,
      parts: [],
    });
    expect(tps).toBe(100);
  });

  test('excludes tool time from the rate', () => {
    // wall 5s, tool 3s → generation 2s; 200 tokens → 100 tok/s
    const tps = computeAssistantTps({
      createdAt: 1_000,
      completedAt: 6_000,
      outputTokens: 200,
      reasoningTokens: 0,
      parts: [part({ type: 'tool', state: { time: { start: 2_000, end: 5_000 } } })],
    });
    expect(tps).toBe(100);
  });

  test('returns null when there are no generated tokens', () => {
    expect(
      computeAssistantTps({
        createdAt: 1_000,
        completedAt: 2_000,
        outputTokens: 0,
        reasoningTokens: 0,
        parts: [],
      }),
    ).toBeNull();
  });

  test('returns null while still streaming (no completed)', () => {
    expect(
      computeAssistantTps({
        createdAt: 1_000,
        completedAt: null,
        outputTokens: 100,
        reasoningTokens: 0,
        parts: [],
      }),
    ).toBeNull();
  });
});

describe('formatAssistantTps', () => {
  test('formats small and large rates', () => {
    expect(formatAssistantTps(3.456)).toBe('3.46 tok/s');
    expect(formatAssistantTps(12.34)).toBe('12.3 tok/s');
    expect(formatAssistantTps(128.4)).toBe('128 tok/s');
    expect(formatAssistantTps(1234)).toBe('1.2k tok/s');
    expect(formatAssistantTps(12500)).toBe('13k tok/s');
  });

  test('returns empty for non-positive', () => {
    expect(formatAssistantTps(0)).toBe('');
    expect(formatAssistantTps(Number.NaN)).toBe('');
  });
});
