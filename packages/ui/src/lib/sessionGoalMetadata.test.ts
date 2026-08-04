import { describe, expect, test } from 'bun:test';
import { formatGoalDuration, formatGoalTokens } from './sessionGoalMetadata';

describe('formatGoalTokens', () => {
  test('formats compact token counts', () => {
    expect(formatGoalTokens(0)).toBe('0');
    expect(formatGoalTokens(999)).toBe('999');
    expect(formatGoalTokens(1_200)).toBe('1.2K');
    expect(formatGoalTokens(12_000)).toBe('12K');
    expect(formatGoalTokens(1_500_000)).toBe('1.5M');
    expect(formatGoalTokens(12_000_000)).toBe('12M');
    expect(formatGoalTokens(1_200_000_000)).toBe('1.2B');
  });
});

describe('formatGoalDuration', () => {
  test('formats compact wall-clock durations', () => {
    expect(formatGoalDuration(0)).toBe('0s');
    expect(formatGoalDuration(12_000)).toBe('12s');
    expect(formatGoalDuration(65_000)).toBe('1m5s');
    expect(formatGoalDuration(120_000)).toBe('2m');
    expect(formatGoalDuration(3_720_000)).toBe('1h2m');
    expect(formatGoalDuration(7_200_000)).toBe('2h');
  });
});
