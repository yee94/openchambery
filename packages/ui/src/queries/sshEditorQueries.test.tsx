import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { sshEditorQueryOptions, useSshEditorQuery } from './sshEditorQueries';

const io = vi.hoisted(() => ({
  key: 'host:ssh-a', transport: 'direct:a', desktop: true,
  listeners: new Set<() => void>(), invoke: vi.fn(),
}));
vi.mock('@/lib/desktop', () => ({
  hasDesktopInvoke: () => io.desktop, isDesktopShell: () => io.desktop, invokeDesktop: io.invoke,
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => io.key,
  getRuntimeTransportIdentity: () => io.transport,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    io.listeners.add(listener);
    return () => { io.listeners.delete(listener); };
  },
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('capability errors remain errors, and cancellation discards IPC responses', async () => {
  const query = sshEditorQueryOptions();
  io.invoke.mockRejectedValueOnce(new Error('IPC unavailable'));
  await expect(query.queryFn({ signal: new AbortController().signal })).rejects.toThrow('IPC unavailable');
  const controller = new AbortController();
  controller.abort();
  io.invoke.mockResolvedValueOnce({ appIds: ['cursor'] });
  await expect(query.queryFn({ signal: controller.signal })).rejects.toThrow();
  expect(sshEditorQueryOptions('local').enabled).toBe(false);
  io.desktop = false;
  expect(sshEditorQueryOptions().enabled).toBe(false);
  io.desktop = true;
});

test('switching SSH to ordinary Relay never reuses SSH capability while new IPC is pending', async () => {
  io.key = 'host:ssh-a';
  io.transport = 'direct:a';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sshEditorQueryOptions().queryKey, { hostId: 'ssh-a', appIds: ['cursor'] });
  let resolve!: (value: null) => void;
  io.invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const host = document.createElement('div');
  const root = createRoot(host);
  const Probe = () => {
    const query = useSshEditorQuery();
    return <span>{query.data?.hostId ?? 'hidden'}</span>;
  };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    expect(host.textContent).toBe('ssh-a');
    await act(async () => {
      io.key = 'host:relay-b';
      io.transport = 'relay:b';
      io.listeners.forEach((listener) => listener());
    });
    expect(host.textContent).toBe('hidden');
    expect(io.invoke).toHaveBeenLastCalledWith('desktop_ssh_editor_apps', { hostId: 'relay-b' });
    await act(async () => {
      resolve(null);
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(host.textContent).toBe('hidden');
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});
