import { describe, expect, it } from 'vitest';

import {
  buildMobileContextDisplay,
  getLatestAssistantTotalTokens,
  resolveContextLimitFromCatalog,
  sumContextTokenRecord,
} from '@/lib/contextUsage';

describe('contextUsage', () => {
  it('sums token records', () => {
    expect(
      sumContextTokenRecord({
        input: 10,
        output: 20,
        reasoning: 5,
        cache: { read: 1, write: 2 },
      }),
    ).toBe(38);
  });

  it('builds display only when tokens and limits exist', () => {
    expect(buildMobileContextDisplay({ totalTokens: 50, contextLimit: 100, isDraft: false })).toEqual({
      percentage: 50,
      tokensLabel: '50/100',
      tone: 'ok',
    });
    expect(buildMobileContextDisplay({ totalTokens: 0, contextLimit: 100, isDraft: false })).toBeNull();
    expect(buildMobileContextDisplay({ totalTokens: 50, contextLimit: 100, isDraft: true })).toBeNull();
  });

  it('uses newest assistant tokens and resets on compaction', () => {
    const messages = [
      { id: 'a1', role: 'assistant', tokens: { input: 100, output: 50 } },
      { id: 'u1', role: 'user' },
      { id: 'a2', role: 'assistant', tokens: { input: 10, output: 5 } },
    ];
    expect(getLatestAssistantTotalTokens(messages)).toBe(15);

    const compacted = [
      { id: 'a1', role: 'assistant', tokens: { input: 100, output: 50 } },
      { id: 'c1', role: 'user' },
    ];
    expect(
      getLatestAssistantTotalTokens(compacted, (id) =>
        id === 'c1' ? [{ type: 'compaction' }] : [],
      ),
    ).toBe(0);
  });

  it('resolves context limit from provider catalog', () => {
    const catalog = {
      providers: [
        {
          id: 'openai',
          models: {
            'gpt-4.1': { id: 'gpt-4.1', limit: { context: 128000, output: 16000 } },
          },
        },
      ],
    };
    expect(
      resolveContextLimitFromCatalog(catalog, { providerID: 'openai', modelID: 'gpt-4.1' }),
    ).toBe(128000);
    expect(resolveContextLimitFromCatalog(catalog, null)).toBe(0);
  });
});
