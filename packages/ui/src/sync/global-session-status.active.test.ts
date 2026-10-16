import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Event } from './types';
import { applyGlobalSessionActiveSnapshot, applyGlobalSessionStatusEvent, useGlobalSessionStatusStore } from './global-session-status';

const runtime = vi.hoisted(() => ({ generation: 0, now: 100 }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'test-runtime',
  getRuntimeGeneration: () => runtime.generation,
}));
beforeEach(() => {
  runtime.generation += 1;
  runtime.now = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => runtime.now);
  useGlobalSessionStatusStore.setState({ statusById: new Map() });
});
afterEach(() => vi.restoreAllMocks());

test('complete process snapshot retains unknown IDs without inventing a directory and empty success clears them', () => {
  applyGlobalSessionActiveSnapshot({ unknown: { type: 'running' } }, 100);
  expect(useGlobalSessionStatusStore.getState().statusById.get('unknown')).toEqual({ status: 'busy', directory: '' });
  const first = useGlobalSessionStatusStore.getState().statusById;
  applyGlobalSessionActiveSnapshot({ unknown: { type: 'running' } }, 101);
  expect(useGlobalSessionStatusStore.getState().statusById).toBe(first);
  applyGlobalSessionActiveSnapshot({}, 102);
  expect(useGlobalSessionStatusStore.getState().statusById.size).toBe(0);
  applyGlobalSessionActiveSnapshot({ unknown: { type: 'running' } }, 100);
  expect(useGlobalSessionStatusStore.getState().statusById.size).toBe(0);
});

test('lifecycle events received during GET win, including terminal events for unseen sessions', () => {
  runtime.now = 101;
  applyGlobalSessionStatusEvent('/workspace', { type: 'session.execution.succeeded', properties: { sessionID: 'finished' } } as Event);
  applyGlobalSessionStatusEvent('/workspace', { type: 'session.execution.started', properties: { sessionID: 'started' } } as Event);
  applyGlobalSessionActiveSnapshot({ finished: { type: 'running' } }, 100);
  expect([...useGlobalSessionStatusStore.getState().statusById.keys()]).toEqual(['started']);
  applyGlobalSessionActiveSnapshot({}, 102);
  expect(useGlobalSessionStatusStore.getState().statusById.size).toBe(0);
});

test('new runtime accepts its own snapshot clock', () => {
  applyGlobalSessionActiveSnapshot({}, 1000);
  runtime.generation += 1;
  applyGlobalSessionActiveSnapshot({ other: { type: 'running' } }, 10);
  expect(useGlobalSessionStatusStore.getState().statusById.has('other')).toBe(true);
});
