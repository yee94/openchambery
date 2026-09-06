import { describe, expect, test } from 'vitest';

import {
  abortSession,
  fetchSessionMessages,
  parseMessagesPayload,
  promptAsync,
} from './sessionApi';

describe('Lynx session API', () => {
  test('parseMessagesPayload never invents empty success from junk', () => {
    expect(parseMessagesPayload(null)).toBeNull();
    expect(parseMessagesPayload({ available: false })).toBeNull();
    const page = parseMessagesPayload({
      messages: [
        { info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
        { info: { id: 'msg_2', role: 'assistant' }, parts: [{ type: 'text', text: 'hi' }] },
      ],
    }, { requestedLimit: 30 });
    expect(page?.entries).toHaveLength(2);
    expect(page?.canLoadEarlier).toBe(false);
  });

  test('prompt_async / abort / messages hit official paths and surface HTTP failures', async () => {
    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (path.includes('prompt_async')) {
        return { ok: true, status: 204, json: async () => true };
      }
      if (path.includes('/abort')) {
        return { ok: false, status: 503, json: async () => ({ error: 'busy' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'x' }] }],
      };
    };

    const deps = { runtimeFetch };
    const sent = await promptAsync(deps, {
      sessionId: 'ses_1',
      directory: '/repo',
      text: 'hello',
      providerID: 'anthropic',
      modelID: 'claude',
      messageId: 'msg_client',
    });
    expect(sent).toEqual({ status: 'ok', messageId: 'msg_client' });
    expect(calls[0]?.path).toContain('/session/ses_1/prompt_async');
    expect(calls[0]?.path).toContain('directory=%2Frepo');
    expect(calls[0]?.method).toBe('POST');

    const aborted = await abortSession(deps, { sessionId: 'ses_1' });
    expect(aborted.status).toBe('failed');
    expect(aborted).toMatchObject({ httpStatus: 503 });

    const messages = await fetchSessionMessages(deps, { sessionId: 'ses_1', limit: 30 });
    expect(messages.status).toBe('ok');
    if (messages.status === 'ok') {
      expect(messages.page.entries[0]?.text).toBe('x');
    }
  });

  test('no-runtime-shaped fetch failure is not empty success', async () => {
    const runtimeFetch = async () => ({
      ok: false,
      status: 0,
      json: async () => ({ error: 'no-runtime' }),
    });
    const result = await fetchSessionMessages({ runtimeFetch }, { sessionId: 'ses_1' });
    expect(result.status).toBe('failed');
  });
});
