import { describe, expect, it, vi } from 'vitest';

import type { ActiveRuntime } from '@/lib/connectionController';
import {
  CHAT_INITIAL_TURNS,
  loadSessionMessages,
  parseSessionMessagesPage,
  SessionMessagesError,
} from '@/lib/sessionMessages';

const activeDirect = (url = 'http://127.0.0.1:2606'): ActiveRuntime => ({
  connectionId: 'c1',
  label: 'local',
  candidates: [{ kind: 'direct', url }],
  transport: { kind: 'direct', url },
  clientToken: 'token-1',
});

describe('parseSessionMessagesPage', () => {
  it('parses Host records shape', () => {
    const page = parseSessionMessagesPage({
      records: [
        { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
        { info: { id: 'a1', role: 'assistant' }, parts: [{ type: 'text', text: 'yo' }] },
      ],
      cursor: null,
      complete: true,
      turnCount: 1,
    });
    expect(page.records).toHaveLength(2);
    expect(page.complete).toBe(true);
  });

  it('rejects partial', () => {
    expect(() => parseSessionMessagesPage({ partial: true, records: [] })).toThrow(
      SessionMessagesError,
    );
  });
});

describe('loadSessionMessages', () => {
  it('GETs /api/openchamber/sessions/:id/messages?turns=6 with bearer', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          records: [{ info: { id: 'm1', role: 'user' }, parts: [{ type: 'text', text: 'a' }] }],
          cursor: null,
          complete: true,
          turnCount: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch);

    const page = await loadSessionMessages(activeDirect(), { sessionId: 'ses/a b' });
    expect(page.records[0]?.info.id).toBe('m1');
    expect(calls[0]?.url).toContain(
      `/api/openchamber/sessions/${encodeURIComponent('ses/a b')}/messages`,
    );
    expect(calls[0]?.url).toContain(`turns=${CHAT_INITIAL_TURNS}`);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-1');
    vi.unstubAllGlobals();
  });

  it('throws on HTTP failure (not empty success)', async () => {
    vi.stubGlobal('fetch', (async () => new Response('nope', { status: 500 })) as typeof fetch);
    await expect(
      loadSessionMessages(activeDirect(), { sessionId: 'ses_1' }),
    ).rejects.toBeInstanceOf(SessionMessagesError);
    vi.unstubAllGlobals();
  });
});
