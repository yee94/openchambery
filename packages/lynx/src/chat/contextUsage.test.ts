import { describe, expect, test } from 'vitest';

import {
  buildLynxChatContextChrome,
  buildLynxContextDisplay,
  fetchLynxModelContextLimit,
  formatLynxContextTokens,
  getLynxLatestAssistantTotalTokens,
  getLynxLatestUserMessageModel,
  getLynxNumericLimit,
  getLynxTokenCount,
  resolveLynxContextColorClass,
  resolveLynxContextLimitFromProvidersPayload,
} from './contextUsage';

describe('lynx contextUsage', () => {
  test('formats token counts compactly', () => {
    expect(formatLynxContextTokens(500)).toBe('500');
    expect(formatLynxContextTokens(1_500)).toBe('1.5K');
    expect(formatLynxContextTokens(2_000_000)).toBe('2.0M');
  });

  test('reads numeric model limits safely', () => {
    expect(getLynxNumericLimit({ context: 200_000, output: 8_192 }, 'context')).toBe(200_000);
    expect(getLynxNumericLimit({ context: '200000' }, 'context')).toBe(undefined);
    expect(getLynxNumericLimit(null, 'context')).toBe(undefined);
    expect(getLynxTokenCount(12)).toBe(12);
    expect(getLynxTokenCount(undefined)).toBe(0);
  });

  test('builds display only when tokens and limits are present', () => {
    expect(buildLynxContextDisplay({ totalTokens: 0, contextLimit: 100, isDraft: false })).toBeNull();
    expect(buildLynxContextDisplay({ totalTokens: 50, contextLimit: 100, isDraft: true })).toBeNull();
    expect(buildLynxContextDisplay({ totalTokens: 50, contextLimit: 100, isDraft: false })).toEqual({
      percentage: 50,
      tokens: '50/100',
      colorClass: 'text-[var(--status-success)]',
      status: 'success',
    });
    expect(resolveLynxContextColorClass(80)).toBe('text-[var(--status-warning)]');
    expect(resolveLynxContextColorClass(95)).toBe('text-[var(--status-error)]');
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

    expect(getLynxLatestUserMessageModel(messages)).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
    });
    expect(getLynxLatestAssistantTotalTokens(messages)).toBe(150);
  });

  test('compaction row newer than the last assistant resets the token baseline', () => {
    const messages = [
      { id: 'a1', role: 'assistant', tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } },
      { id: 'u-compact', role: 'user' },
    ];
    const partsByMessage = new Map([['u-compact', [{ type: 'compaction' }]]]);
    const getParts = (messageId: string) => partsByMessage.get(messageId);

    expect(getLynxLatestAssistantTotalTokens(messages, getParts)).toBe(0);
  });

  test('resolves context limit from Cap providers payload', () => {
    const payload = {
      providers: [
        {
          id: 'anthropic',
          models: [{ id: 'claude', limit: { context: 200_000, output: 8192 } }],
        },
      ],
    };
    expect(resolveLynxContextLimitFromProvidersPayload(payload, {
      providerID: 'anthropic',
      modelID: 'claude',
    })).toBe(200_000);
    expect(resolveLynxContextLimitFromProvidersPayload(payload, {
      providerID: 'openai',
      modelID: 'gpt',
    })).toBe(0);
  });

  test('fetchLynxModelContextLimit hits Cap providers and never invents limits', async () => {
    const calls: string[] = [];
    const runtimeFetch = async (path: string) => {
      calls.push(path);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          providers: [
            { id: 'anthropic', models: [{ id: 'claude', limit: { context: 100_000 } }] },
          ],
        }),
      };
    };
    const ok = await fetchLynxModelContextLimit(runtimeFetch, {
      directory: '/repo',
      modelRef: { providerID: 'anthropic', modelID: 'claude' },
    });
    expect(ok).toEqual({
      status: 'ok',
      limit: { providerID: 'anthropic', modelID: 'claude', contextLimit: 100_000, outputLimit: undefined },
    });
    expect(calls[0]).toContain('/api/config/providers');
    expect(calls[0]).toContain('directory=%2Frepo');

    expect(await fetchLynxModelContextLimit(null, {
      modelRef: { providerID: 'a', modelID: 'b' },
    })).toEqual({ status: 'no-runtime' });
  });

  test('buildLynxChatContextChrome wires tokens + limit', () => {
    const display = buildLynxChatContextChrome({
      messages: [
        { role: 'assistant', tokens: { input: 50, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      ],
      contextLimit: 100,
    });
    expect(display?.percentage).toBe(50);
    expect(display?.tokens).toBe('50/100');
  });
});
