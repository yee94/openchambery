import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

const sdk = vi.hoisted(() => ({ locationGet: vi.fn(), list: vi.fn(), remove: vi.fn() }));
const runtime = vi.hoisted(() => ({ transport: 'runtime-a', generation: 0, listeners: new Set<() => void>() }));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: { getApiClient: () => ({
  location: { get: sdk.locationGet }, permission: { saved: { list: sdk.list, remove: sdk.remove } },
}) } }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => runtime.generation,
  getRuntimeTransportIdentity: () => runtime.transport,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener);
  },
}));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: create(() => ({ currentDirectory: '/a' })) }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: create(() => ({ activeProjectId: 'path_L2E' })) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/button', () => ({ Button: ({ variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} /> }));
vi.mock('@/components/sections/shared/SettingsGroup', () => ({
  SettingsGroup: ({ label, description, children }: { label: React.ReactNode; description?: React.ReactNode; children: React.ReactNode }) => <section>{label}{description}{children}</section>,
  SettingsRow: ({ label, children }: { label: React.ReactNode; children: React.ReactNode }) => <div>{label}{children}</div>,
}));

import { SavedPermissionsSection } from './SavedPermissionsSection';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { savedPermissionListQueryOptions } from '@/queries/savedPermissionQueries';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const rule = (projectID: string, resource = projectID) => ({ id: 'same-rule-id', projectID, action: 'bash', resource });
const scope = (directory = '/a', projectID = 'upstream-a') => ({ transport: runtime.transport, generation: runtime.generation, directory, projectID });
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };

describe('SavedPermissionsSection scope ownership', () => {
  let client: QueryClient;
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.transport = 'runtime-a';
    runtime.generation = 0;
    useDirectoryStore.setState({ currentDirectory: '/a' });
    sdk.locationGet.mockImplementation(async ({ location }: { location: { directory: string } }) => ({
      project: { id: `upstream-${location.directory.slice(1)}` },
    }));
    sdk.list.mockImplementation(async ({ projectID }: { projectID: string }) => [rule(projectID)]);
    sdk.remove.mockResolvedValue(undefined);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  async function mount() {
    await act(async () => root.render(<QueryClientProvider client={client}><SavedPermissionsSection /></QueryClientProvider>));
    await settle();
    await settle();
  }
  async function switchDirectory(directory: string) {
    await act(async () => { useDirectoryStore.setState({ currentDirectory: directory }); });
    await settle();
    await settle();
  }
  async function clickDelete() {
    const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === 'settings.permissions.saved.delete');
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }

  it('loads by upstream project ID while the local project ID is path_base64', async () => {
    await mount();
    expect(sdk.locationGet).toHaveBeenCalledWith({ location: { directory: '/a' } }, { signal: expect.any(AbortSignal) });
    expect(sdk.list).toHaveBeenCalledWith({ projectID: 'upstream-a' }, { signal: expect.any(AbortSignal) });
    expect(container.textContent).toContain('upstream-a');
  });

  it('cancels an old project lookup before listing rules for the next directory', async () => {
    const old = deferred<{ project: { id: string } }>();
    sdk.locationGet.mockImplementationOnce(() => old.promise);
    await mount();
    expect(container.textContent).toContain('common.loading');
    const signal = sdk.locationGet.mock.calls[0][1].signal as AbortSignal;
    await switchDirectory('/b');
    expect(signal.aborted).toBe(true);
    await act(async () => old.resolve({ project: { id: 'upstream-a' } }));
    await settle();
    expect(sdk.list).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('upstream-b');
    expect(container.textContent).not.toContain('upstream-a');
  });

  it('isolates out-of-order list results and cancels the old request', async () => {
    const old = deferred<ReturnType<typeof rule>[]>();
    sdk.list.mockImplementationOnce(() => old.promise);
    await mount();
    const signal = sdk.list.mock.calls[0][1].signal as AbortSignal;
    await switchDirectory('/b');
    expect(signal.aborted).toBe(true);
    await act(async () => old.resolve([rule('upstream-a')]));
    await settle();
    expect(container.textContent).toContain('upstream-b');
    expect(container.textContent).not.toContain('upstream-a');
  });

  it('shows first-load errors and retries, reserving empty copy for successful empty results', async () => {
    sdk.locationGet.mockRejectedValueOnce(new Error('offline'));
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('saved.loadFailed');
    expect(container.textContent).not.toContain('saved.empty');
    expect(sdk.list).not.toHaveBeenCalled();
    sdk.list.mockResolvedValue([]);
    await act(async () => container.querySelector('button')!.click());
    await settle();
    await settle();
    expect(container.textContent).toContain('saved.empty');
  });

  it('shows B list failure without A rows or delete actions', async () => {
    await mount();
    sdk.list.mockRejectedValueOnce(new Error('offline'));
    await switchDirectory('/b');
    expect(container.textContent).toContain('saved.loadFailed');
    expect(container.textContent).not.toContain('upstream-a');
    expect(container.textContent).not.toContain('saved.empty');
    expect(container.textContent).not.toContain('saved.delete');
  });

  it('preserves same-scope data on refresh failure and disables deletion', async () => {
    await mount();
    sdk.list.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await client.invalidateQueries({ queryKey: savedPermissionListQueryOptions(scope()).queryKey, exact: true }); });
    await settle();
    expect(container.textContent).toContain('upstream-a');
    expect(container.textContent).toContain('saved.loadFailed');
    const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent?.includes('saved.delete'));
    expect(button?.disabled).toBe(true);
  });

  it('updates only the captured A cache when deletion completes after switching to B', async () => {
    const deletion = deferred<void>();
    sdk.remove.mockReturnValueOnce(deletion.promise);
    await mount();
    const keyA = savedPermissionListQueryOptions(scope()).queryKey;
    await clickDelete();
    await switchDirectory('/b');
    await act(async () => deletion.resolve());
    await settle();
    expect(client.getQueryData(keyA)).toEqual([]);
    expect(container.textContent).toContain('upstream-b');
    expect(client.getQueryData(savedPermissionListQueryOptions(scope('/b', 'upstream-b')).queryKey)).toEqual([rule('upstream-b')]);
  });

  it('resolves the same directory again on runtime switch and ignores old deletion completion', async () => {
    const deletion = deferred<void>();
    sdk.remove.mockReturnValueOnce(deletion.promise);
    await mount();
    await clickDelete();
    sdk.list.mockResolvedValue([rule('upstream-a', 'runtime-b-resource')]);
    await act(async () => {
      runtime.transport = 'runtime-b';
      runtime.generation++;
      client.clear();
      runtime.listeners.forEach((listener) => listener());
    });
    await settle();
    await settle();
    await act(async () => deletion.resolve());
    await settle();
    expect(sdk.locationGet).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('runtime-b-resource');
    expect(client.getQueryCache().getAll().every((query) => query.queryKey[0] === 'runtime-b')).toBe(true);
  });

  it('keeps rules after delete failure and exposes a scoped error', async () => {
    sdk.remove.mockRejectedValueOnce(new Error('denied'));
    await mount();
    await clickDelete();
    await settle();
    expect(container.textContent).toContain('saved.deleteFailed');
    expect(container.textContent).toContain('upstream-a');
    await switchDirectory('/b');
    expect(container.textContent).not.toContain('saved.deleteFailed');
  });

  it('cancels an in-flight list across a runtime switch with identical directory and project IDs', async () => {
    const old = deferred<ReturnType<typeof rule>[]>();
    sdk.list.mockReturnValueOnce(old.promise);
    await mount();
    const signal = sdk.list.mock.calls[0][1].signal as AbortSignal;
    sdk.list.mockResolvedValue([rule('upstream-a', 'new-runtime-rule')]);
    await act(async () => {
      runtime.transport = 'runtime-b';
      runtime.generation++;
      client.clear();
      runtime.listeners.forEach((listener) => listener());
    });
    await settle();
    await settle();
    expect(signal.aborted).toBe(true);
    await act(async () => old.resolve([rule('upstream-a', 'old-runtime-rule')]));
    await settle();
    expect(container.textContent).toContain('new-runtime-rule');
    expect(container.textContent).not.toContain('old-runtime-rule');
  });

  it('keeps a late A deletion error outside the B view', async () => {
    const deletion = deferred<void>();
    sdk.remove.mockReturnValueOnce(deletion.promise);
    await mount();
    const keyA = savedPermissionListQueryOptions(scope()).queryKey;
    await clickDelete();
    await switchDirectory('/b');
    await act(async () => deletion.reject(new Error('denied')));
    await settle();
    expect(client.getQueryData(keyA)).toEqual([rule('upstream-a')]);
    expect(container.textContent).toContain('upstream-b');
    expect(container.textContent).not.toContain('saved.deleteFailed');
  });
});
