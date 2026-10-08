import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';

const searchSessions = vi.hoisted(() => vi.fn(async (_query: string) => [
  { id: 'session-1', title: 'Recent conversation', time: { updated: 1 } },
]));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/lib/worktreeSessionCreator', () => ({ createWorktreeSession: vi.fn() }));
vi.mock('@/lib/terminalTabShortcuts', () => ({ openAndCreateTerminalTab: vi.fn() }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => null }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ files: {} }) }));
vi.mock('@/sync/session-ui-store', async () => {
  const { create } = await import('zustand');
  return { useSessionUIStore: create(() => ({
    openNewSessionDraft: vi.fn(), setCurrentSession: vi.fn(),
    worktreeMetadata: new Map(), availableWorktreesByProject: new Map(),
  })) };
});
vi.mock('@/stores/useGlobalSessionsStore', async () => {
  const { create } = await import('zustand');
  return {
    resolveGlobalSessionDirectory: () => '/project',
    useGlobalSessionsStore: create(() => ({ activeSessions: [], status: 'ready' })),
  };
});
vi.mock('@/stores/useDirectoryStore', async () => {
  const { create } = await import('zustand');
  return { useDirectoryStore: create(() => ({ currentDirectory: null })) };
});
vi.mock('@/stores/useProjectsStore', async () => {
  const { create } = await import('zustand');
  return { useProjectsStore: create(() => ({ projects: [], getActiveProject: () => null })) };
});
vi.mock('@/stores/useFileSearchStore', async () => {
  const { create } = await import('zustand');
  return { useFileSearchStore: create(() => ({ searchFiles: vi.fn(async () => []) })) };
});
vi.mock('@/queries/sessionTitleSearchQueries', () => ({
  sessionTitleSearchQueryOptions: (query: string) => ({ queryKey: ['search', query], queryFn: () => searchSessions(query) }),
}));

import { CommandPalette } from './CommandPalette';
import { useUIStore } from '@/stores/useUIStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('page presentation has a focused search header and results without dialog chrome', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onBack = vi.fn();
  useUIStore.getState().setCommandPaletteOpen(true);
  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}><CommandPalette presentation="page" onBack={onBack} /></QueryClientProvider>,
    ));
    const input = host.querySelector<HTMLInputElement>('header input')!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.inputMode).toBe('search');
    expect(input.value).toBe('');
    expect(searchSessions).toHaveBeenCalledWith('');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('Recent conversation');
    expect(input.closest('[data-slot="command-input-field"]')?.className).toContain('oc-mobile-glass-control');
    expect(input.closest('[data-slot="command-input-field"]')?.className).not.toContain('ring-');
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull();
    expect(host.querySelector('[data-slot="dialog-close"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="header.actions.backAria"]')!.click());
    expect(onBack).toHaveBeenCalledOnce();
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    client.clear();
    host.remove();
  }
});
