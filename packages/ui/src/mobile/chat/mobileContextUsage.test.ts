import { describe, expect, test } from 'bun:test';

import {
  buildMobileContextDisplay,
  formatContextTokens,
  getLatestAssistantTotalTokens,
  getLatestUserMessageModel,
  getNumericLimit,
  getTokenCount,
  resolveContextColorClass,
} from './mobileContextUsage';

describe('mobileContextUsage', () => {
  test('formats token counts compactly', () => {
    expect(formatContextTokens(500)).toBe('500');
    expect(formatContextTokens(1_500)).toBe('1.5K');
    expect(formatContextTokens(2_000_000)).toBe('2.0M');
  });

  test('reads numeric model limits safely', () => {
    expect(getNumericLimit({ context: 200_000, output: 8_192 }, 'context')).toBe(200_000);
    expect(getNumericLimit({ context: '200000' }, 'context')).toBe(undefined);
    expect(getNumericLimit(null, 'context')).toBe(undefined);
    expect(getTokenCount(12)).toBe(12);
    expect(getTokenCount(undefined)).toBe(0);
  });

  test('builds display only when tokens and limits are present', () => {
    expect(buildMobileContextDisplay({ totalTokens: 0, contextLimit: 100, isDraft: false })).toBeNull();
    expect(buildMobileContextDisplay({ totalTokens: 50, contextLimit: 100, isDraft: true })).toBeNull();
    expect(buildMobileContextDisplay({ totalTokens: 50, contextLimit: 100, isDraft: false })).toEqual({
      percentage: 50,
      tokens: '50/100',
      colorClass: 'text-[var(--status-success)]',
    });
    expect(resolveContextColorClass(80)).toBe('text-[var(--status-warning)]');
    expect(resolveContextColorClass(95)).toBe('text-[var(--status-error)]');
  });

  test('finds latest user model and assistant token totals', () => {
    const messages = [
      { role: 'user', model: { providerID: 'openai', modelID: 'gpt-4.1' } },
      {
        role: 'assistant',
        tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 1, write: 2 } },
      },
      { role: 'user', model: { providerID: 'anthropic', modelID: 'claude' } },
      {
        role: 'assistant',
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ];

    expect(getLatestUserMessageModel(messages)).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
    });
    expect(getLatestAssistantTotalTokens(messages)).toBe(150);
  });

  test('compaction row newer than the last assistant resets the token baseline', () => {
    const messages = [
      { id: 'a1', role: 'assistant', tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } },
      { id: 'u-compact', role: 'user' },
    ];
    const partsByMessage = new Map([['u-compact', [{ type: 'compaction' }]]]);
    const getParts = (messageId: string) => partsByMessage.get(messageId);

    expect(getLatestAssistantTotalTokens(messages, getParts)).toBe(0);
  });

  test('post-compaction assistant with tokens becomes the new baseline', () => {
    const messages = [
      { id: 'a1', role: 'assistant', tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } },
      { id: 'u-compact', role: 'user' },
      { id: 'a2', role: 'assistant', tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
    ];
    const partsByMessage = new Map([['u-compact', [{ type: 'compaction' }]]]);
    const getParts = (messageId: string) => partsByMessage.get(messageId);

    expect(getLatestAssistantTotalTokens(messages, getParts)).toBe(15);
  });

  test('without a parts getter the scan keeps its legacy behavior', () => {
    const messages = [
      { id: 'a1', role: 'assistant', tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } },
      { id: 'u-compact', role: 'user' },
    ];

    expect(getLatestAssistantTotalTokens(messages)).toBe(150);
  });
});
