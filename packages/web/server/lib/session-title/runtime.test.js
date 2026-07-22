import { describe, expect, it } from 'bun:test';
import {
  buildLatestTitleTranscript,
  canAutoRefreshSessionTitle,
  createSessionTitleRuntime,
  isDefaultSessionTitle,
  isForkedSessionTitle,
  looksLikeMultiRunSessionTitle,
  remainingTitleThrottleMs,
  TITLE_THROTTLE_MS,
} from './runtime.js';

describe('session-title helpers', () => {
  it('detects OpenCode default titles', () => {
    expect(isDefaultSessionTitle('New session - 2026-07-10T12:00:00.000Z')).toBe(true);
    expect(isDefaultSessionTitle('Child session - 2026-07-10T12:00:00.000Z')).toBe(true);
    expect(isDefaultSessionTitle('Debugging production 500 errors')).toBe(false);
  });

  it('detects titles created by session fork', () => {
    expect(isForkedSessionTitle('Fix fork selection (fork #1)')).toBe(true);
    expect(isForkedSessionTitle('Fix fork selection (fork #12)')).toBe(true);
    expect(isForkedSessionTitle('Fix fork selection')).toBe(false);
  });

  it('detects multi-run structural titles', () => {
    expect(looksLikeMultiRunSessionTitle('bench/anthropic/claude')).toBe(true);
    expect(looksLikeMultiRunSessionTitle('bench/g2/anthropic/claude/3')).toBe(true);
    expect(looksLikeMultiRunSessionTitle('bench/anthropic/claude/fusion')).toBe(true);
    expect(looksLikeMultiRunSessionTitle('Rate limiting implementation')).toBe(false);
  });

  it('protects manual renames after an auto title', () => {
    expect(canAutoRefreshSessionTitle('New session - 2026-07-10T12:00:00.000Z', '')).toBe(true);
    expect(canAutoRefreshSessionTitle('Auto title', 'Auto title')).toBe(true);
    expect(canAutoRefreshSessionTitle('My rename', 'Auto title')).toBe(false);
    expect(canAutoRefreshSessionTitle('bench/anthropic/claude', 'Auto title')).toBe(false);
  });

  it('computes remaining throttle window', () => {
    const now = 1_000_000;
    expect(remainingTitleThrottleMs(0, now)).toBe(0);
    expect(remainingTitleThrottleMs(now - TITLE_THROTTLE_MS, now)).toBe(0);
    expect(remainingTitleThrottleMs(now - 60_000, now)).toBe(TITLE_THROTTLE_MS - 60_000);
  });

  it('builds a transcript biased to the latest turns', () => {
    const messages = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: 'hello world' }],
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', text: 'hi there' }],
      },
      {
        info: { id: 'u2', role: 'user' },
        parts: [{ type: 'text', text: 'add rate limiting' }],
      },
      {
        info: { id: 'a2', role: 'assistant' },
        parts: [{ type: 'text', text: 'implemented rate limit' }],
      },
    ];
    const result = buildLatestTitleTranscript(messages, { maxTurns: 2 });
    expect(result.realUserCount).toBe(2);
    expect(result.lastAssistantId).toBe('a2');
    expect(result.transcript).toContain('add rate limiting');
    expect(result.transcript).toContain('implemented rate limit');
  });

  it('keeps an earlier subject anchor when latest turns are wrap-up only', () => {
    const messages = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: '实现会话标题主体性总结' }],
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', text: '开始改提示词和输入上下文' }],
      },
      {
        info: { id: 'u2', role: 'user' },
        parts: [{ type: 'text', text: '再补一下测试' }],
      },
      {
        info: { id: 'a2', role: 'assistant' },
        parts: [{ type: 'text', text: '测试已补' }],
      },
      {
        info: { id: 'u3', role: 'user' },
        parts: [{ type: 'text', text: '提交推送' }],
      },
      {
        info: { id: 'a3', role: 'assistant' },
        parts: [{ type: 'text', text: '已提交并推送' }],
      },
    ];
    const result = buildLatestTitleTranscript(messages, { maxTurns: 1 });
    expect(result.subjectAnchor).toBe('实现会话标题主体性总结');
    expect(result.transcript).toContain('Earlier subject anchor');
    expect(result.transcript).toContain('实现会话标题主体性总结');
    expect(result.transcript).toContain('提交推送');
    expect(result.languageSample).toBe('提交推送');
    expect(result.lastAssistantId).toBe('a3');
  });

  it('uses the latest real user text as the language sample', () => {
    const messages = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: '修复会话标题语言' }],
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', text: 'I updated the title prompt in English.' }],
      },
    ];
    const result = buildLatestTitleTranscript(messages, { maxTurns: 1 });
    expect(result.languageSample).toBe('修复会话标题语言');
  });

  it('keeps only the latest 5 turns by default', () => {
    const messages = [];
    for (let i = 1; i <= 12; i += 1) {
      messages.push({
        info: { id: `u${i}`, role: 'user' },
        parts: [{ type: 'text', text: `user turn ${i}` }],
      });
      messages.push({
        info: { id: `a${i}`, role: 'assistant' },
        parts: [{ type: 'text', text: `assistant turn ${i}` }],
      });
    }
    const result = buildLatestTitleTranscript(messages);
    // Latest window is turns 8–12; turn 1 only appears as subject anchor.
    expect(result.subjectAnchor).toBe('user turn 1');
    expect(result.transcript).toContain('Earlier subject anchor');
    expect(result.transcript).toContain('user turn 8');
    expect(result.transcript).toContain('user turn 12');
    expect(result.transcript).not.toContain('user turn 7');
    expect(result.lastAssistantId).toBe('a12');
  });

  it('gives user and assistant messages separate character budgets', () => {
    const messages = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: `user-start-${'u'.repeat(3_000)}-user-end` }],
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', text: `assistant-start-${'a'.repeat(2_000)}-assistant-end` }],
      },
    ];

    const result = buildLatestTitleTranscript(messages);
    const userText = result.transcript.match(/User:\n([^\n]+)/)?.[1] || '';
    const assistantText = result.transcript.match(/Assistant:\n([^\n]+)/)?.[1] || '';
    expect(userText.length).toBe(2_000);
    expect(assistantText.length).toBe(1_200);
    expect(userText).toContain('user-start');
    expect(assistantText).toContain('assistant-start');
    expect(userText).not.toContain('user-end');
    expect(assistantText).not.toContain('assistant-end');
  });

  it('stops at the most recent compaction boundary', () => {
    const messages = [
      {
        info: { id: 'u-old', role: 'user' },
        parts: [{ type: 'text', text: 'old topic before compact' }],
      },
      {
        info: { id: 'a-old', role: 'assistant' },
        parts: [{ type: 'text', text: 'old reply before compact' }],
      },
      {
        info: { id: 'u-compact', role: 'user' },
        parts: [{ type: 'compaction', auto: false }],
      },
      {
        info: { id: 'u-new', role: 'user' },
        parts: [{ type: 'text', text: 'new topic after compact' }],
      },
      {
        info: { id: 'a-new', role: 'assistant' },
        parts: [{ type: 'text', text: 'new reply after compact' }],
      },
    ];
    const result = buildLatestTitleTranscript(messages);
    expect(result.transcript).not.toContain('old topic before compact');
    expect(result.transcript).not.toContain('old reply before compact');
    expect(result.transcript).toContain('new topic after compact');
    expect(result.transcript).toContain('new reply after compact');
    expect(result.subjectAnchor).toBe('');
    expect(result.realUserCount).toBe(1);
    expect(result.lastAssistantId).toBe('a-new');
  });

  it('hard-caps the transcript under the char budget', () => {
    const huge = 'x'.repeat(80_000);
    const messages = [
      {
        info: { id: 'u1', role: 'user' },
        parts: [{ type: 'text', text: `early ${huge}` }],
      },
      {
        info: { id: 'a1', role: 'assistant' },
        parts: [{ type: 'text', text: `mid ${huge}` }],
      },
      {
        info: { id: 'u2', role: 'user' },
        parts: [{ type: 'text', text: `late ${huge}` }],
      },
      {
        info: { id: 'a2', role: 'assistant' },
        parts: [{ type: 'text', text: `tail ${huge}` }],
      },
    ];
    const result = buildLatestTitleTranscript(messages, { maxChars: 10_000 });
    expect(result.transcript.length).toBeLessThanOrEqual(10_000);
    expect(result.transcript).toContain('tail');
  });

  it('refreshes a fork title after its first newly-sent reply completes', async () => {
    const originalFetch = globalThis.fetch;
    const session = {
      id: 'ses-fork',
      title: 'Original work (fork #1)',
      metadata: {
        openchamber: {
          titleRefresh: {
            lastAutoTitle: 'Original work',
            generatedAt: 900,
            forMessageID: 'assistant-original',
          },
        },
      },
    };
    const messages = [
      { info: { id: 'user-original', role: 'user' }, parts: [{ type: 'text', text: 'Original work' }] },
      { info: { id: 'assistant-original', role: 'assistant' }, parts: [{ type: 'text', text: 'Original reply' }] },
      { info: { id: 'user-fork', role: 'user' }, parts: [{ type: 'text', text: 'Take a different implementation path' }] },
      { info: { id: 'assistant-fork', role: 'assistant', parentID: 'user-fork' }, parts: [{ type: 'text', text: 'Implemented the alternate path' }] },
    ];
    let generationCalls = 0;

    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/message')) {
        return new Response(JSON.stringify(messages), { status: 200 });
      }
      if (init.method === 'PATCH') {
        return new Response(JSON.stringify(session), { status: 200 });
      }
      return new Response(JSON.stringify(session), { status: 200 });
    };

    try {
      const runtime = createSessionTitleRuntime({
        buildOpenCodeUrl: (pathname) => `http://opencode${pathname}`,
        getOpenCodeAuthHeaders: () => ({}),
        getSmallModelService: async () => ({
          generateSmallModelText: async () => {
            generationCalls += 1;
            return { text: 'Alternate implementation path', providerID: 'test', modelID: 'test' };
          },
        }),
        now: () => 1_000,
        isTitleRefreshEnabled: () => true,
      });

      runtime.processPayload({
        type: 'session.created',
        properties: {
          directory: '/repo',
          info: { id: 'ses-fork', title: session.title, time: { created: 100 } },
        },
      });
      runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses-fork', directory: '/repo', status: { type: 'idle' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(generationCalls).toBe(0);

      runtime.processPayload({
        type: 'message.updated',
        properties: { directory: '/repo', info: { sessionID: 'ses-fork', role: 'user', time: { created: 200 } } },
      });
      runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses-fork', directory: '/repo', status: { type: 'busy' } },
      });
      runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: 'ses-fork', directory: '/repo', status: { type: 'idle' } },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(generationCalls).toBe(1);
      runtime.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
