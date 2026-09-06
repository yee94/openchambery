import { describe, expect, it, vi } from 'vitest';

import type { ActiveRuntime } from '@/lib/connectionController';
import {
  abortSession,
  createSession,
  materializeDraftAndPrompt,
  promptAsync,
  SessionPromptError,
} from '@/lib/sessionPrompt';

const activeDirect = (url = 'http://127.0.0.1:2606'): ActiveRuntime => ({
  connectionId: 'c1',
  label: 'local',
  candidates: [{ kind: 'direct', url }],
  transport: { kind: 'direct', url },
  clientToken: 'token-1',
});

describe('sessionPrompt', () => {
  it('POST /api/session materializes a draft', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: 'ses_new', title: 'Hello' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch);

    const session = await createSession(activeDirect(), { directory: '/repo' });
    expect(session.id).toBe('ses_new');
    expect(calls[0]?.url).toContain('/api/session');
    expect(calls[0]?.init?.method).toBe('POST');
    vi.unstubAllGlobals();
  });

  it('POST prompt_async and abort', async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response('true', { status: 200 });
    }) as typeof fetch);

    await promptAsync(activeDirect(), { sessionId: 'ses_1', text: 'hi', directory: '/repo' });
    await abortSession(activeDirect(), { sessionId: 'ses_1', directory: '/repo' });

    expect(calls[0]?.url).toContain('/api/session/ses_1/prompt_async');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[1]?.url).toContain('/api/session/ses_1/abort');
    expect(calls[1]?.method).toBe('POST');
    vi.unstubAllGlobals();
  });

  it('materializeDraftAndPrompt creates then prompts', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/session') && !url.includes('prompt_async') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'ses_draft', directory: '/repo' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('true', { status: 200 });
    }) as typeof fetch);

    const session = await materializeDraftAndPrompt(activeDirect(), { text: 'first' });
    expect(session.id).toBe('ses_draft');
    expect(calls.some((u) => u.includes('/api/session') && !u.includes('prompt'))).toBe(true);
    expect(calls.some((u) => u.includes('/prompt_async'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('rejects empty prompt', async () => {
    await expect(promptAsync(activeDirect(), { sessionId: 's', text: '  ' })).rejects.toBeInstanceOf(
      SessionPromptError,
    );
  });
});
