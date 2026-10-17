import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OpenChamberEvent } from '@/lib/openchamberEvents';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { queryClient } from '@/lib/queryRuntime';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { createProjectIdFromPath } from '@/lib/projectId';
import { sortProjectEntries } from '@/lib/projectOrder';
import { mountProjectOrderSync } from './project-order-sync';

const mocks = vi.hoisted(() => ({
  listeners: new Set<(event: OpenChamberEvent) => void>(),
  fetch: vi.fn(),
  save: vi.fn(async () => undefined),
  wait: vi.fn(async (_transport: string): Promise<void> => undefined),
  invalidate: vi.fn(),
}));
vi.mock('@/lib/openchamberEvents', () => ({
  subscribeOpenchamberEvents: (listener: (event: OpenChamberEvent) => void) => {
    mocks.listeners.add(listener);
    return () => mocks.listeners.delete(listener);
  },
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: mocks.save, waitForPendingSettingsUpdates: mocks.wait, invalidateSettingsCache: mocks.invalidate }));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: { setDirectory: vi.fn() } }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: { getState: () => ({}) } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ setDirectory: vi.fn() }) } }));

const projects = ['a', 'b', 'c'].map((name) => ({ id: createProjectIdFromPath(`/workspace/${name}`), path: `/workspace/${name}` }));
const order = () => useProjectsStore.getState().manualProjectOrder;
const tip = () => mocks.listeners.forEach((listener) => listener({ type: 'project-order-changed', occurredAt: 1 }));
const snapshot = (entries = [...projects].reverse(), projectSortOrder = 'manual') =>
  new Response(JSON.stringify({ projects: entries, projectSortOrder }));
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let dispose: (() => void) | undefined;

beforeEach(() => {
  queryClient.clear();
  mocks.fetch.mockReset();
  mocks.save.mockClear();
  mocks.wait.mockReset().mockResolvedValue(undefined);
  switchRuntimeEndpoint({ apiBaseUrl: 'https://host.example', runtimeKey: 'relay:host-a' });
  useProjectsStore.setState({ projects, manualProjectOrder: projects.map(({ id }) => id), activeProjectId: projects[0].id });
  useSessionDisplayStore.setState({ projectSortOrder: 'a-z' });
});
afterEach(() => { dispose?.(); dispose = undefined; queryClient.clear(); });

describe('shared project order synchronization', () => {
  test('repairs a stale client on mount even when the Relay ready event was missed', async () => {
    mocks.fetch.mockResolvedValue(snapshot());
    dispose = mountProjectOrderSync();
    await vi.waitFor(() => expect(order()).toEqual([...projects].reverse().map(({ id }) => id)));
    expect(useSessionDisplayStore.getState().projectSortOrder).toBe('manual');
    expect(sortProjectEntries(useProjectsStore.getState().projects, 'manual').map(({ id }) => id)).toEqual(order());
    expect(useProjectsStore.getState().activeProjectId).toBe(projects[0].id);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledWith('/api/config/settings', { signal: expect.any(AbortSignal) });
  });

  test('adopts another client drag and sort preference, and repairs a missed tip on reconnect', async () => {
    mocks.fetch.mockResolvedValue(snapshot(projects));
    dispose = mountProjectOrderSync();
    await tick();
    mocks.fetch.mockResolvedValue(snapshot([...projects].reverse(), 'z-a'));
    tip();
    await vi.waitFor(() => expect(order()[0]).toBe(projects[2].id));
    expect(useSessionDisplayStore.getState().projectSortOrder).toBe('z-a');
    mocks.fetch.mockResolvedValue(snapshot(projects));
    mocks.listeners.forEach((listener) => listener({ type: 'event-stream-ready' }));
    await vi.waitFor(() => expect(order()[0]).toBe(projects[0].id));
  });

  test('coalesces a burst during GET into one follow-up GET', async () => {
    let resolve!: (response: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
      .mockImplementation(async () => snapshot());
    dispose = mountProjectOrderSync();
    await tick();
    for (let i = 0; i < 100; i++) tip();
    resolve(snapshot(projects));
    await vi.waitFor(() => expect(order()[0]).toBe(projects[2].id));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  test('does not commit a late snapshot from the previous runtime', async () => {
    let resolve!: (response: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
      .mockImplementation(async () => snapshot([projects[1]], 'recent'));
    dispose = mountProjectOrderSync();
    await tick();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://other.example', runtimeKey: 'relay:host-b' });
    resolve(snapshot());
    await vi.waitFor(() => expect(order()).toEqual([projects[1].id]));
    expect(useSessionDisplayStore.getState().projectSortOrder).toBe('recent');
  });

  test('waits for pending local writes before reading server authority', async () => {
    let release!: () => void;
    mocks.wait.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    mocks.fetch.mockResolvedValue(snapshot());
    dispose = mountProjectOrderSync();
    await tick();
    expect(mocks.fetch).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(order()[0]).toBe(projects[2].id));
  });

  test('discards a read overtaken by a local drag and catches up after its save', async () => {
    let resolve!: (response: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
      .mockImplementation(async () => snapshot([projects[2], projects[0], projects[1]]));
    dispose = mountProjectOrderSync();
    await tick();
    useProjectsStore.getState().reorderProjectsById(projects[2].id, projects[0].id);
    resolve(snapshot(projects));
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    await tick();
    expect(order()).toEqual([projects[2].id, projects[0].id, projects[1].id]);
  });

  test('does not commit after unmount', async () => {
    let resolve!: (response: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    dispose = mountProjectOrderSync();
    await tick();
    dispose();
    resolve(snapshot());
    await tick();
    expect(order()).toEqual(projects.map(({ id }) => id));
    expect(mocks.listeners.size).toBe(0);
  });

  test('a previous runtime pending write cannot block the new runtime snapshot', async () => {
    let release!: () => void;
    mocks.wait.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    mocks.fetch.mockResolvedValue(snapshot([projects[1]]));
    dispose = mountProjectOrderSync();
    await tick();
    switchRuntimeEndpoint({ apiBaseUrl: 'https://other.example', runtimeKey: 'relay:host-b' });
    await vi.waitFor(() => expect(order()).toEqual([projects[1].id]));
    release();
    await tick();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  test('preserves cached order on failure and accepts authoritative empty on retry', async () => {
    mocks.fetch.mockImplementation(async () => new Response('unavailable', { status: 503 }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dispose = mountProjectOrderSync();
    await vi.waitFor(() => expect(warning).toHaveBeenCalled(), { timeout: 3000 });
    expect(order()).toEqual(projects.map(({ id }) => id));
    mocks.fetch.mockResolvedValue(snapshot([]));
    tip();
    await vi.waitFor(() => expect(order()).toEqual([]));
    expect(useProjectsStore.getState().projects).toEqual([]);
    warning.mockRestore();
  });

  test('sort preference writes to shared settings and old hosts default to manual', () => {
    useSessionDisplayStore.getState().setProjectSortOrder('recent');
    expect(mocks.save).toHaveBeenCalledWith({ projectSortOrder: 'recent' });
    useSessionDisplayStore.getState().synchronizeFromSettings({});
    expect(useSessionDisplayStore.getState().projectSortOrder).toBe('manual');
  });
});
