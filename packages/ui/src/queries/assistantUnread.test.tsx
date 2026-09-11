import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// @ts-expect-error Shared server contract fixtures are JavaScript.
import { assistantContractFixtures } from '../../../web/server/lib/assistants/contracts.js';
import { parseAssistantDTO, parseAssistantReadResponse, type AssistantContactMessage, type AssistantSnapshotDTO } from './assistantDTO';
import { getLoadedAssistantReadPosition } from './assistantContactMessages';

const state = vi.hoisted(() => ({
  transport: 'unread-a', generation: 1,
  fetch: vi.fn(),
  client: null as QueryClient | null,
  listeners: new Set<(event: { type: string; revision?: number }) => void>(),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => state.transport,
  getRuntimeGeneration: () => state.generation,
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: state.fetch }));
vi.mock('@/lib/queryRuntime', () => ({ get queryClient() { return state.client; } }));
vi.mock('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (listener: (event: { type: string; revision?: number }) => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
import { assistantQueryKeys, assistantSnapshotQueryOptions, markAllAssistantsRead, markAssistantContactRead, useAssistantUnreadTotal } from './assistantQueries';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const position = (ordinal: number, generation = 0) => ({ ordinal, generation, messageID: `message-${ordinal}` });
const assistant = (id = 'a', count = 2) => parseAssistantDTO({
  ...assistantContractFixtures.assistant, id, unreadCount: count, readTip: position(10), readWatermark: position(2),
});
const row = (ordinal: number, text = 'reply'): AssistantContactMessage => ({
  messageID: `message-${ordinal}`, assistantID: 'a', ordinal, role: 'assistant', status: 'complete',
  turnID: 'turn', bubbleIndex: 0, createdAt: 1, fromAssistantID: null, fromAssistantName: null,
  text, parts: [{ type: 'text', text }], cards: [],
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  state.transport = 'unread-a'; state.generation = 1;
  state.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  state.fetch.mockReset();
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; host?.remove(); state.client?.clear(); state.listeners.clear();
  vi.restoreAllMocks();
});

describe('Assistant shared read contract', () => {
  test('parses the server response and rejects malformed counts and positions', () => {
    expect(parseAssistantReadResponse(assistantContractFixtures.contactReadResponse)).toEqual(assistantContractFixtures.contactReadResponse);
    for (const unreadCount of [-1, 1.5, NaN, '3']) {
      expect(() => parseAssistantDTO({ ...assistantContractFixtures.assistant, unreadCount })).toThrow();
    }
    expect(() => parseAssistantReadResponse({ ...assistantContractFixtures.contactReadResponse, readWatermark: position(1, -1) })).toThrow();
    const legacy = { ...assistantContractFixtures.assistant, unreadCount: undefined, readTip: undefined, readWatermark: undefined };
    expect(parseAssistantDTO(legacy)).toMatchObject({ unreadCount: 0, readTip: null, readWatermark: null });
  });

  test('reports the loaded visible ordinal while snapshot tip is ahead; skips internal and streaming tails', () => {
    const page = { generation: 0, messages: [row(4), row(5, 'oc.settle.done'), { ...row(6), status: 'streaming' }] };
    expect(getLoadedAssistantReadPosition(assistant(), page)).toEqual(position(4));
    expect(getLoadedAssistantReadPosition(assistant(), { ...page, messages: [row(7)] })).toEqual(position(7));
    expect(getLoadedAssistantReadPosition(assistant(), { ...page, messages: [{ ...row(7), role: 'peer' }] })).toEqual(position(7));
    // Per-part: settle beside spoken body still qualifies as the loaded cursor.
    const mixed = {
      ...row(8),
      parts: [{ type: 'text' as const, text: 'oc.settle.complete' }, { type: 'text' as const, text: 'spoken' }],
      text: 'oc.settle.completespoken',
    };
    expect(getLoadedAssistantReadPosition(assistant(), { generation: 0, messages: [mixed] })).toEqual(position(8));
  });

  test('fences wiped generations, already-read rows, empty and foreign transcripts', () => {
    const item = assistant();
    expect(getLoadedAssistantReadPosition(item, { generation: 1, messages: [row(4)] })).toBeNull();
    expect(getLoadedAssistantReadPosition(item, { generation: 0, messages: [row(2)] })).toBeNull();
    expect(getLoadedAssistantReadPosition(item, { generation: 0, messages: [] })).toBeNull();
    expect(getLoadedAssistantReadPosition(item, { generation: 0, messages: [{ ...row(4), assistantID: 'other' }] })).toBeNull();
    expect(getLoadedAssistantReadPosition({ ...item, unreadCount: 0 }, { generation: 0, messages: [row(4)] })).toBeNull();
    // Same ordinal as watermark: full messageID keyset decides already-read (not ordinal alone).
    const atMark = { ...row(2), messageID: 'message-2' };
    const afterMarkSameOrdinal = { ...row(2), messageID: 'message-2z' };
    expect(getLoadedAssistantReadPosition(item, { generation: 0, messages: [atMark] })).toBeNull();
    expect(getLoadedAssistantReadPosition(item, { generation: 0, messages: [afterMarkSameOrdinal] }))
      .toEqual({ generation: 0, ordinal: 2, messageID: 'message-2z' });
  });

  test('POST captures the exact row and invalidates only the current runtime snapshot', async () => {
    const invalidate = vi.spyOn(state.client!, 'invalidateQueries');
    state.fetch.mockResolvedValue(response({ ...assistantContractFixtures.contactReadResponse, assistantID: 'a/b' }));
    await markAssistantContactRead('a/b', position(4));
    const [url, init] = state.fetch.mock.calls[0];
    expect(url).toBe('/api/openchamber/assistants/a%2Fb/contact/read');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(position(4));
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: assistantQueryKeys.snapshot('unread-a'), exact: true });
  });

  test('stale runtime completions leave the new runtime cache alone', async () => {
    let finish!: (value: Response) => void;
    state.fetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const invalidate = vi.spyOn(state.client!, 'invalidateQueries');
    const flight = markAssistantContactRead('a', position(4));
    const rejected = expect(flight).rejects.toMatchObject({ code: 'runtime_stale' });
    state.transport = 'unread-b'; state.generation += 1;
    finish(response({ ...assistantContractFixtures.contactReadResponse, assistantID: 'a' }));
    await rejected;
    expect(invalidate).not.toHaveBeenCalled();
  });

  test('failed snapshot reconciliation preserves authoritative prior counts', async () => {
    const snapshot = { enabled: true, revision: 10, assistants: [assistant()] };
    state.client!.setQueryData(assistantQueryKeys.snapshot(), snapshot);
    state.fetch.mockResolvedValue(response({ error: 'offline' }, 503));
    await expect(state.client!.fetchQuery({ ...assistantSnapshotQueryOptions(), retry: false })).rejects.toThrow();
    expect(state.client!.getQueryData(assistantQueryKeys.snapshot())).toEqual(snapshot);
  });

  test('all-read keeps click-time tips, bounded fanout and independent successes after failure', async () => {
    const snapshot = { enabled: true, revision: 10, assistants: Array.from({ length: 9 }, (_, i) => assistant(`a${i}`)) };
    const pending: Array<() => void> = [];
    state.fetch.mockImplementation((url: string) => new Promise<Response>((resolve) => {
      const id = url.split('/')[4];
      pending.push(() => resolve(id === 'a1'
        ? response({ error: 'contact_generation_conflict' }, 409)
        : response({ ...assistantContractFixtures.contactReadResponse, assistantID: id })));
    }));
    const flight = markAllAssistantsRead(snapshot);
    expect(state.fetch).toHaveBeenCalledTimes(4);
    snapshot.assistants[8].readTip = position(99);
    for (const done of pending.splice(0)) done();
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(8));
    for (const done of pending.splice(0)) done();
    await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledTimes(9));
    expect(JSON.parse(state.fetch.mock.calls[8][1].body)).toEqual(position(10));
    pending.splice(0).forEach((done) => done());
    expect(await flight).toEqual({ failed: 1 });
  });

  test('navigation shares snapshot GET and follows another client read tip without transcript requests', async () => {
    let snapshot: AssistantSnapshotDTO = { enabled: true, revision: 10, assistants: [assistant('a', 120), assistant('b', 3)] };
    state.fetch.mockImplementation(() => Promise.resolve(response(snapshot)));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    function Total() { return <output>{useAssistantUnreadTotal()}</output>; }
    await act(async () => root!.render(<QueryClientProvider client={state.client!}><Total /><Total /></QueryClientProvider>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect([...host.querySelectorAll('output')].map((node) => node.textContent)).toEqual(['123', '123']);
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(state.listeners.size).toBe(1);
    snapshot = { ...snapshot, revision: 11, assistants: [assistant('a', 0), assistant('b', 3)] };
    await act(async () => {
      state.listeners.forEach((listener) => listener({ type: 'assistants-changed', revision: 11 }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.textContent).toBe('33');
    expect(state.fetch.mock.calls.every(([url]) => url === '/api/openchamber/assistants/snapshot')).toBe(true);

    snapshot = { ...snapshot, revision: 12, assistants: [assistant('a', 2), assistant('b', 3)] };
    state.fetch.mockImplementation((url: string) => {
      if (url.endsWith('/a/contact/read')) {
        snapshot = { ...snapshot, revision: 13, assistants: [assistant('a', 0), assistant('b', 3)] };
        return Promise.resolve(response({ ...assistantContractFixtures.contactReadResponse, assistantID: 'a', revision: 13 }));
      }
      if (url.endsWith('/b/contact/read')) return Promise.resolve(response({ error: 'offline' }, 503));
      return Promise.resolve(response(snapshot));
    });
    await act(async () => {
      expect(await markAllAssistantsRead(snapshot)).toEqual({ failed: 1 });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(state.client!.getQueryData<AssistantSnapshotDTO>(assistantQueryKeys.snapshot())?.assistants.map((item) => item.unreadCount)).toEqual([0, 3]);
    expect(host.textContent).toBe('33');
  });
});
