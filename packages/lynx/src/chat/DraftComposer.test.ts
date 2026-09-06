import { describe, expect, test } from 'vitest';

import { materializeLynxDraftSession } from './DraftComposer';

describe('Lynx draft composer materialize', () => {
  test('POST /session then prompt_async; empty / no-runtime are honest', async () => {
    expect(await materializeLynxDraftSession({
      runtimeFetch: null,
      text: 'hi',
      model: { providerID: 'anthropic', modelID: 'claude' },
    })).toEqual({ status: 'no-runtime' });
    expect(await materializeLynxDraftSession({
      runtimeFetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      text: '  ',
      model: { providerID: 'anthropic', modelID: 'claude' },
    })).toEqual({ status: 'empty' });

    const calls: Array<{ path: string; method?: string; body?: string }> = [];
    const runtimeFetch = async (path: string, init?: { method?: string; body?: string }) => {
      calls.push({ path, method: init?.method, body: init?.body });
      if (path.startsWith('/session') && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ id: 'ses_d', directory: '/repo' }) };
      }
      return { ok: true, status: 204, json: async () => true };
    };
    const result = await materializeLynxDraftSession({
      runtimeFetch,
      text: 'hello draft',
      directory: '/repo',
      model: { providerID: 'anthropic', modelID: 'claude' },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.sessionId).toBe('ses_d');
      expect(result.promptResult).toEqual({ status: 'ok', messageId: expect.any(String) });
    }
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toContain('/session');
    expect(calls[1]?.path).toContain('/session/ses_d/prompt_async');
  });

  test('aborted signal / Stop spirit returns aborted (does not pretend success)', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await materializeLynxDraftSession({
      runtimeFetch: async () => ({ ok: true, status: 200, json: async () => ({ id: 'x' }) }),
      text: 'hi',
      model: { providerID: 'anthropic', modelID: 'claude' },
      signal: controller.signal,
    })).toEqual({ status: 'aborted' });

    let created = false;
    const midAbort = new AbortController();
    const result = await materializeLynxDraftSession({
      runtimeFetch: async (path, init) => {
        if (path.startsWith('/session') && init?.method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ id: 'ses_abort', directory: '/r' }) };
        }
        return { ok: true, status: 204, json: async () => true };
      },
      text: 'stop me',
      model: { providerID: 'anthropic', modelID: 'claude' },
      signal: midAbort.signal,
      onSessionCreated: () => {
        created = true;
        midAbort.abort();
      },
    });
    expect(created).toBe(true);
    expect(result).toEqual({ status: 'aborted' });
  });
});
