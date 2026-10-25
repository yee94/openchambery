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
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/project' }));
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
vi.mock('@/queries/sessionContentSearchQueries', () => ({
  sessionContentIndexStatusOptions: () => ({ queryKey: ['content-status'], queryFn: async () => ({ phase: 'ready', total: 1, completed: 1, messages: 1 }) }),
  sessionContentSearchQueryOptions: () => ({ queryKey: ['content-search'], queryFn: async () => [{
    sessionID: 'session-1', messageID: 'old-message', directory: '/project', role: 'user', createdAt: 0, snippet: 'old matching body',
  }, {
    sessionID: 'session-1', messageID: 'message-1', directory: '/project', role: 'user', createdAt: 1, snippet: 'matching body result',
  }, {
    sessionID: 'session-1', messageID: 'older-message', directory: '/project', role: 'user', createdAt: 0, snippet: 'another old matching body',
  }], enabled: false }),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'test',
  getRuntimeGeneration: () => 1,
}));
vi.mock('@/components/chat/hooks/useChatTurnNavigation', () => ({ focusChatMessage: vi.fn() }));

import { CommandPalette } from './CommandPalette';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('closed palette performs zero commits for 50 unrelated catalog updates', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const committed = vi.fn();
  useUIStore.getState().setCommandPaletteOpen(false);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <React.Profiler id="palette" onRender={committed}><CommandPalette /></React.Profiler>
    </QueryClientProvider>));
    committed.mockClear();
    for (let i = 0; i < 50; i++) {
      await act(async () => useGlobalSessionsStore.setState({ activeSessions: [] }));
    }
    expect(committed).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});

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

test('combines title and body matches in five unified rows, freezes navigation and resets expansion', async () => {
  searchSessions.mockResolvedValue(Array.from({ length: 30 }, (_, i) => ({
    id: `session-${i}`, title: `matching conversation ${i}`, time: { updated: i },
  })));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useUIStore.getState().setCommandPaletteOpen(true);
  const type = async (value: string) => {
    const input = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><CommandPalette presentation="page" /></QueryClientProvider>));
    await type('matching');
    expect(host.querySelectorAll('[cmdk-item][data-value^="session:"]')).toHaveLength(4);
    expect(host.querySelectorAll('[cmdk-item][data-value^="message:"]')).toHaveLength(1);
    expect(host.querySelector('[data-value="session:session-1"]')).toBeNull();
    const bodyRow = host.querySelector('[cmdk-item][data-value^="message:"]')!;
    expect(bodyRow.textContent).toContain('matching conversation 1');
    expect(bodyRow.textContent).toContain('matching body result');
    expect(host.textContent).not.toContain('old matching body');
    expect(bodyRow.querySelectorAll('mark')).toHaveLength(2);
    expect(host.textContent).not.toContain('commandPalette.group.messages');
    expect(host.querySelector('[data-value="more:sessions"]')).not.toBeNull();
    await act(async () => host.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await act(async () => {
      client.setQueryData(['content-search'], [{ sessionID: 'new', messageID: 'new', directory: '/other', role: 'user', createdAt: 2, snippet: 'new background result' }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('matching body result');
    expect(host.textContent).not.toContain('new background result');
    await act(async () => (host.querySelector('[data-value="more:sessions"]') as HTMLElement).click());
    expect(host.querySelectorAll('[cmdk-item][data-value^="session:"]')).toHaveLength(29);
    expect(host.querySelectorAll('[cmdk-item][data-value^="message:"]')).toHaveLength(1);
    expect(host.querySelector('[data-value="more:sessions"]')).toBeNull();
    await type('conversation');
    expect(host.querySelectorAll('[cmdk-item][data-value^="session:"]')).toHaveLength(5);
    await type('matching');
    expect(host.querySelectorAll('[cmdk-item][data-value^="session:"]')).toHaveLength(5);
  } finally {
    await act(async () => { root.unmount(); useUIStore.getState().setCommandPaletteOpen(false); });
    client.clear(); host.remove();
  }
});
