import { describe, expect, it, vi } from 'vitest';

import type { ActiveRuntime } from '@/lib/connectionController';
import {
  findSessionInIndexSnapshot,
  loadSessionGet,
  loadSessionIndexSnapshot,
  lookupSessionIndexById,
  parseSessionIndexSnapshot,
  SessionIndexError,
} from '@/lib/sessionIndex';

const activeDirect = (url = 'http://127.0.0.1:2606'): ActiveRuntime => ({
  connectionId: 'c1',
  label: 'local',
  candidates: [{ kind: 'direct', url }],
  transport: { kind: 'direct', url },
  clientToken: 'token-1',
});

describe('loadSessionIndexSnapshot', () => {
  it('throws on HTTP failure so UI cannot treat it as empty', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response('nope', { status: 500 });
    }) as typeof fetch);
    await expect(loadSessionIndexSnapshot(activeDirect())).rejects.toBeInstanceOf(SessionIndexError);
    expect(calls[0]?.url).toBe('http://127.0.0.1:2606/api/openchamber/session-index');
    expect(calls[0]?.init?.headers).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('returns null for 501 unsupported', async () => {
    vi.stubGlobal('fetch', (async () => new Response('', { status: 501 })) as typeof fetch);
    await expect(loadSessionIndexSnapshot(activeDirect())).resolves.toBeNull();
    vi.unstubAllGlobals();
  });

  it('parses a live available snapshot with bearer auth', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          available: true,
          revision: 9,
          directories: [
            {
              directory: '/code/openchamber',
              sessions: [{ id: 's1', title: 'Hello' }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch);
    const snapshot = await loadSessionIndexSnapshot(activeDirect());
    expect(snapshot?.revision).toBe(9);
    expect(snapshot?.directories[0]?.sessions[0]?.id).toBe('s1');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-1');
    vi.unstubAllGlobals();
  });
});

describe('findSessionInIndexSnapshot', () => {
  it('returns the matching row with directory fallback', () => {
    const snapshot = parseSessionIndexSnapshot({
      available: true,
      revision: 1,
      directories: [
        {
          directory: '/code/openchamber',
          sessions: [
            { id: 's1', title: 'Hello', project: { branch: 'main' } },
            { id: 's2', title: 'Other' },
          ],
        },
      ],
    });
    expect(snapshot).toBeTruthy();
    const hit = findSessionInIndexSnapshot(snapshot!, 's1');
    expect(hit).toMatchObject({
      id: 's1',
      title: 'Hello',
      directory: '/code/openchamber',
      project: { branch: 'main' },
    });
    expect(findSessionInIndexSnapshot(snapshot!, 'missing')).toBeNull();
  });
});

describe('lookupSessionIndexById', () => {
  it('parses Cap deep-link lookup including assistantName', async () => {
    vi.stubGlobal(
      'fetch',
      (async (input: RequestInfo | URL) => {
        expect(String(input)).toContain('/api/openchamber/session-index/session/ses_abc');
        return new Response(
          JSON.stringify({
            available: true,
            session: {
              id: 'ses_abc',
              directory: '/repo/work',
              title: 'Hello',
              assistantName: '🧭 Nav',
              project: { branch: 'feat/x' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch,
    );
    await expect(lookupSessionIndexById(activeDirect(), 'ses_abc')).resolves.toEqual({
      id: 'ses_abc',
      directory: '/repo/work',
      title: 'Hello',
      parentID: null,
      branch: 'feat/x',
      assistantID: null,
      assistantName: '🧭 Nav',
    });
    vi.unstubAllGlobals();
  });

  it('returns null on 404', async () => {
    vi.stubGlobal('fetch', (async () => new Response('', { status: 404 })) as typeof fetch);
    await expect(lookupSessionIndexById(activeDirect(), 'missing')).resolves.toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('loadSessionGet', () => {
  it('parses OpenCode session.get title fallback', async () => {
    vi.stubGlobal(
      'fetch',
      (async (input: RequestInfo | URL) => {
        expect(String(input)).toContain('/api/session/ses_1');
        return new Response(
          JSON.stringify({ id: 'ses_1', title: 'From GET', directory: '/repo', project: { branch: 'main' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch,
    );
    await expect(loadSessionGet(activeDirect(), 'ses_1')).resolves.toEqual({
      id: 'ses_1',
      title: 'From GET',
      directory: '/repo',
      branch: 'main',
    });
    vi.unstubAllGlobals();
  });
});
