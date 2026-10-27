import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SidebarFooter } from './SidebarFooter';
import { useUpdateStore } from '@/stores/useUpdateStore';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./DeviceConnections', () => ({ DeviceConnections: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useUpdateStore.getState();
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;

function renderFooter(onOpenUpdate: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  return { client, render: () => act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <SidebarFooter
          showRuntimeButtons={false}
          showUpdateButton
          onOpenSettings={() => {}}
          onOpenShortcuts={() => {}}
          onOpenUpdate={onOpenUpdate}
        />
      </QueryClientProvider>,
    );
  }) };
}

const button = () => host.querySelector('button') as HTMLButtonElement;

beforeEach(() => {
  useUpdateStore.setState(initialState, true);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
});

describe('SidebarFooter update button', () => {
  test('a queued update restarts once through the mutation and stays disabled while pending', async () => {
    let resolveRestart: () => void = () => {};
    const restartToUpdate = vi.fn(() => new Promise<void>((resolve) => { resolveRestart = resolve; }));
    useUpdateStore.setState({ downloaded: true, available: true, restartToUpdate });
    const onOpenUpdate = vi.fn();
    const { render } = renderFooter(onOpenUpdate);
    await render();

    await act(async () => button().click());
    await act(async () => button().click());
    await act(async () => button().click());

    expect(restartToUpdate).toHaveBeenCalledTimes(1);
    expect(onOpenUpdate).not.toHaveBeenCalled();
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-busy')).toBe('true');
    expect(button().getAttribute('aria-label')).toBe('updateDialog.status.updating');

    resolveRestart();
    await act(async () => {});
    expect(restartToUpdate).toHaveBeenCalledTimes(1);
  });

  test('an undownloaded update still opens the update dialog', async () => {
    const restartToUpdate = vi.fn(async () => {});
    useUpdateStore.setState({ downloaded: false, available: true, restartToUpdate });
    const onOpenUpdate = vi.fn();
    const { render } = renderFooter(onOpenUpdate);
    await render();

    await act(async () => button().click());

    expect(onOpenUpdate).toHaveBeenCalledTimes(1);
    expect(restartToUpdate).not.toHaveBeenCalled();
  });
});
