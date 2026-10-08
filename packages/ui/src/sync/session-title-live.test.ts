import { afterAll, expect, test, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { handleEvent } from './sync-context';
import { INITIAL_STATE, type Event } from './types';
import type { Session } from '@/lib/opencode/v2-types';
import type { ChildStoreManager } from './child-store';
import { normalizeOpenCodeEvent, toLegacyEventShape } from './opencode-event-normalizer';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ home: '/workspace', data: [] }), {
    headers: { 'content-type': 'application/json' },
  })));
});
afterAll(() => vi.unstubAllGlobals());

test('native rename reaches directory and global title state without changing live status', () => {
  const directory = '/repo';
  const session = { id: 'ses_native_title', title: 'Original', directory, time: { created: 10, updated: 20 } } as Session;
  const other = { ...session, id: 'ses_other' };
  const busy = { type: 'busy' as const };
  const store = createStore(() => ({ ...INITIAL_STATE, session: [session, other], session_status: { [session.id]: busy } }));
  const children = {
    getChild: () => store, children: new Map([[directory, store]]), ensureChild: () => store, mark: () => undefined,
  } as unknown as ChildStoreManager;
  const routing = {
    sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map(),
  } as Parameters<typeof handleEvent>[3];
  const previousGlobal = useGlobalSessionsStore.getState();
  useGlobalSessionsStore.setState({ activeSessions: [session, other], archivedSessions: [] });
  try {
    const emit = (title: string, created: number, sessionID = session.id) => {
      const result = normalizeOpenCodeEvent({ type: 'session.renamed', created, data: { sessionID, title } });
      if (result.action !== 'emit') throw new Error('Expected native rename to normalize');
      handleEvent(directory, toLegacyEventShape(result.event) as Event, children, routing);
    };
    emit('Generated title', 30);
    expect(store.getState().session[0].title).toBe('Generated title');
    expect(useGlobalSessionsStore.getState().activeSessions.find((row) => row.id === session.id)?.title).toBe('Generated title');
    expect(store.getState().session_status[session.id]).toBe(busy);
    expect(store.getState().session[1]).toBe(other);
    const updated = store.getState().session[0];
    emit('Generated title', 30);
    emit('Stale title', 29);
    emit('Unknown', 40, 'ses_missing');
    expect(store.getState().session[0]).toBe(updated);
    expect(store.getState().session).toHaveLength(2);
    expect(useGlobalSessionsStore.getState().activeSessions.find((row) => row.id === session.id)?.title).toBe('Generated title');
  } finally {
    useGlobalSessionsStore.setState(previousGlobal);
  }
});

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
