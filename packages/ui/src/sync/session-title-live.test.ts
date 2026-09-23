import { afterAll, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { handleEvent } from './sync-context';
import { INITIAL_STATE, type Event } from './types';
import type { Session } from '@/lib/opencode/v2-types';
import type { ChildStoreManager } from './child-store';

vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ home: '/workspace', data: [] }), {
    headers: { 'content-type': 'application/json' },
  })));
});
afterAll(() => vi.unstubAllGlobals());

test('smart-title loading and completion update automatically without clearing execution status', () => {
  const directory = '/repo';
  const session = { id: 'ses_title', title: 'Original', directory, time: { created: 10, updated: 20 } } as Session;
  const busy = { type: 'busy' as const };
  const store = createStore(() => ({
    ...INITIAL_STATE,
    session: [session],
    session_status: { [session.id]: busy },
    session_status_observed_at: { [session.id]: 100 },
  }));
  const children = {
    getChild: () => store,
    children: new Map([[directory, store]]),
    ensureChild: () => store,
    mark: () => undefined,
  } as unknown as ChildStoreManager;
  const routing = {
    sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map(),
  } as Parameters<typeof handleEvent>[3];
  const emit = (type: string, properties: Record<string, unknown>) =>
    handleEvent(directory, { type, properties } as Event, children, routing);

  emit('openchamber:session-metadata', { sessionID: session.id, metadata: {
    openchamber: { titleRefresh: { isGenerating: true } },
  } });
  expect(store.getState().session[0].metadata?.openchamber).toEqual({ titleRefresh: { isGenerating: true } });
  expect(store.getState().session_status[session.id]).toBe(busy);

  emit('session.updated', { info: { ...session, title: 'Generated title', metadata: {
    openchamber: { titleRefresh: { lastAutoTitle: 'Generated title' } },
  } } });
  expect(store.getState().session[0].title).toBe('Generated title');
  expect(store.getState().session_status[session.id]).toBe(busy);
  expect(store.getState().session_status_observed_at[session.id]).toBe(100);

  emit('session.execution.succeeded', { sessionID: session.id });
  expect(store.getState().session_status[session.id].type).toBe('idle');
  emit('session.execution.started', { sessionID: session.id });
  expect(store.getState().session_status[session.id].type).toBe('busy');
});
