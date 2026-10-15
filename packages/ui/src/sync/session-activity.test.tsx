import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { ChildStoreManager } from './child-store';
import { useSessionActivity } from './sync-context';
import { getSessionActivityReader } from './session-activity';
import { applyDirectoryEvent } from './event-reducer';
import { applyGlobalSessionStatusSnapshot, useGlobalSessionStatusStore } from './global-session-status';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { Event } from './types';

vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ home: '/workspace', data: [] })));
});

const context = (globalThis as unknown as {
  __openchamber_sync_context__: React.Context<{ childStores: ChildStoreManager } | null>;
}).__openchamber_sync_context__;
let root: Root | undefined;
const host = document.createElement('div');
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useGlobalSessionStatusStore.setState({ statusById: new Map() });
  useGlobalSessionsStore.setState({ activeSessions: [] });
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; });

test('a completed parent keeps its session loading while a background descendant runs', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const children = new ChildStoreManager();
  const store = children.ensureChild('/workspace', { bootstrap: false });
  store.setState({
    session: [
      { id: 'parent', time: { created: 1, updated: 1 } },
      { id: 'child', parentID: 'parent', time: { created: 2, updated: 2 } },
    ] as Session[],
    session_status: { parent: { type: 'idle' }, child: { type: 'busy' } },
  });
  function Row() {
    const loading = useSessionActivity('parent');
    return <span data-loading={loading} />;
  }
  let unrelatedRenders = 0;
  function UnrelatedRow() {
    const loading = useSessionActivity('unrelated');
    unrelatedRenders += 1;
    return <span data-loading={loading} />;
  }
  root = createRoot(host);
  await act(async () => root!.render(<context.Provider value={{ childStores: children }}><Row /><UnrelatedRow /></context.Provider>));
  expect(host.firstElementChild?.getAttribute('data-loading')).toBe('true');
  expect(store.getState().session_status.parent.type).toBe('idle');
  const rendersBefore = unrelatedRenders;
  await act(async () => store.setState({ session_status: { parent: { type: 'idle' }, child: { type: 'idle' } } }));
  expect(host.firstElementChild?.getAttribute('data-loading')).toBe('false');
  expect(unrelatedRenders).toBe(rendersBefore);
});

test('cross-directory nested children release ancestors only when the last live execution ends', () => {
  const children = new ChildStoreManager();
  const parent = children.ensureChild('/parent', { bootstrap: false });
  const tasks = children.ensureChild('/tasks', { bootstrap: false });
  parent.setState({ session: [{ id: 'root' }] as Session[], session_status: { root: { type: 'idle' } } });
  tasks.setState({ session: [
    { id: 'child', parentID: 'root' }, { id: 'grandchild', parentID: 'child' },
    { id: 'sibling', parentID: 'root' },
  ] as Session[] });
  const reader = getSessionActivityReader(children);
  const notify = vi.fn();
  const unsubscribe = reader.subscribe(notify);
  const event = (type: string, sessionID: string, extra = {}) => {
    const state = tasks.getState();
    const draft = { ...state, session_status: { ...state.session_status }, session_status_observed_at: { ...state.session_status_observed_at } };
    applyDirectoryEvent(draft, { type, properties: { sessionID, ...extra } } as Event, { now: () => 100 });
    tasks.setState(draft);
  };
  event('session.execution.started', 'grandchild');
  expect([...reader.read()].sort()).toEqual(['child', 'grandchild', 'root']);
  event('session.execution.started', 'sibling');
  event('session.execution.succeeded', 'grandchild');
  expect([...reader.read()].sort()).toEqual(['root', 'sibling']);
  event('session.status', 'sibling', { status: { type: 'retry', attempt: 1, message: 'retry', next: 200 } });
  expect(reader.read().has('root')).toBe(true);
  event('session.execution.failed', 'sibling');
  expect(reader.read().size).toBe(0);
  event('session.execution.started', 'grandchild');
  event('session.execution.interrupted', 'grandchild', { reason: 'user' });
  expect(reader.read().size).toBe(0);
  expect(parent.getState().session_status.root.type).toBe('idle');
  unsubscribe();
});

test('late metadata, reconnect idle, cycles and new runtimes never leave sticky ancestor activity', () => {
  const children = new ChildStoreManager();
  const reader = getSessionActivityReader(children);
  const unsubscribe = reader.subscribe(() => {});
  applyGlobalSessionStatusSnapshot('/remote', { task: { type: 'busy' } });
  expect([...reader.read()]).toEqual(['task']);
  useGlobalSessionsStore.setState({ activeSessions: [{ id: 'task', parentID: 'root' }] as Session[] });
  expect(reader.read().has('root')).toBe(true);
  const store = children.ensureChild('/remote', { bootstrap: false });
  store.setState({ session_status: { task: { type: 'idle' } } });
  expect(reader.read().size).toBe(0);
  store.setState({ session: [{ id: 'task', parentID: 'root' }, { id: 'root', parentID: 'task' }] as Session[], session_status: { task: { type: 'busy' } } });
  expect(reader.read().size).toBe(2);
  applyGlobalSessionStatusSnapshot('/remote', {});
  store.setState({ session_status: { task: { type: 'idle' } } });
  expect(reader.read().size).toBe(0);
  expect(getSessionActivityReader(new ChildStoreManager()).read().size).toBe(0);
  unsubscribe();
});

test('many row readers share one projection and unrelated updates do not rescan or notify', () => {
  const children = new ChildStoreManager();
  const store = children.ensureChild('/workspace', { bootstrap: false });
  let visits = 0;
  const sessions = Array.from({ length: 2000 }, (_, index) => ({
    get id() { visits += 1; return `session-${index}`; },
    parentID: index === 0 ? undefined : 'session-0',
  })) as Session[];
  store.setState({ session: sessions, session_status: { 'session-1999': { type: 'busy' } } });
  const reader = getSessionActivityReader(children);
  const notify = vi.fn();
  const subscriptions = Array.from({ length: 100 }, () => reader.subscribe(notify));
  const snapshot = reader.read();
  visits = 0;
  notify.mockClear();
  for (let index = 0; index < 100; index += 1) {
    store.setState({ session_status_observed_at: { 'session-1999': index } });
    expect(reader.read()).toBe(snapshot);
  }
  expect(visits).toBe(0);
  expect(notify).not.toHaveBeenCalled();
  store.setState({ session_status: { 'session-1999': { type: 'retry', attempt: 1, message: '', next: 1 } } });
  expect(reader.read()).toBe(snapshot);
  expect(visits).toBeLessThanOrEqual(6000);
  expect(notify).not.toHaveBeenCalled();
  subscriptions.forEach((unsubscribe) => unsubscribe());
  visits = 0;
  store.setState({ session_status: {} });
  expect(visits).toBe(0);
  expect(reader.read().size).toBe(0);
});
