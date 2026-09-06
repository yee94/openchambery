import { describe, expect, test } from 'vitest';

import {
  fetchLynxPendingCards,
  rejectLynxQuestion,
  replyLynxPermission,
  replyLynxQuestion,
} from './pendingCards';

describe('Lynx pending question/permission cards', () => {
  test('lists Cap /question and /permission and filters by session', async () => {
    const calls: string[] = [];
    const runtimeFetch = async (path: string) => {
      calls.push(path);
      if (path.startsWith('/question')) {
        return {
          ok: true,
          status: 200,
          json: async () => ([
            { id: 'q1', sessionID: 'ses_a', questions: [{ question: 'Q?', header: 'H', options: [] }] },
            { id: 'q2', sessionID: 'ses_b', questions: [{ question: 'Other', header: 'H', options: [] }] },
          ]),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ([
          { id: 'p1', sessionID: 'ses_a', permission: 'edit', patterns: [], always: [] },
        ]),
      };
    };
    const result = await fetchLynxPendingCards(runtimeFetch, { sessionId: 'ses_a', directory: '/repo' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.questions.map((q) => q.id)).toEqual(['q1']);
      expect(result.permissions.map((p) => p.id)).toEqual(['p1']);
    }
    expect(calls[0]).toContain('/question?directory=%2Frepo');
    expect(calls[1]).toContain('/permission?directory=%2Frepo');
  });

  test('reply/reject hit official paths; no-runtime is not fake-success', async () => {
    expect(await replyLynxQuestion(null, { requestId: 'q', answers: [['a']] })).toEqual({ status: 'no-runtime' });
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      return { ok: true, status: 200, json: async () => true };
    };
    expect(await replyLynxQuestion(runtimeFetch, { requestId: 'q1', answers: [['yes']] })).toEqual({ status: 'ok' });
    expect(await rejectLynxQuestion(runtimeFetch, { requestId: 'q1' })).toEqual({ status: 'ok' });
    expect(await replyLynxPermission(runtimeFetch, { requestId: 'p1', reply: 'once' })).toEqual({ status: 'ok' });
    expect(calls.map((c) => c.path)).toEqual([
      '/question/q1/reply',
      '/question/q1/reject',
      '/permission/p1/reply',
    ]);
  });

  test('HTTP failure is failed not empty ok', async () => {
    const runtimeFetch = async (path: string) => ({
      ok: false,
      status: path.includes('question') ? 503 : 503,
      json: async () => ({ error: 'down' }),
    });
    const result = await fetchLynxPendingCards(runtimeFetch, {});
    expect(result.status).toBe('failed');
  });
});
