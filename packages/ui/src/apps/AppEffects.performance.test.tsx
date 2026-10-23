import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({
  keyboard: vi.fn(), queue: vi.fn(), reconcile: vi.fn(), start: vi.fn(), stop: vi.fn(),
  topology: vi.fn(() => () => {}), speech: vi.fn(() => () => {}),
}));
vi.mock('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: effects.keyboard }));
vi.mock('@/hooks/usePwaManifestSync', () => ({ usePwaManifestSync: () => {} }));
vi.mock('@/hooks/useWindowControlsOverlayLayout', () => ({ useWindowControlsOverlayLayout: () => {} }));
vi.mock('@/hooks/useQueuedMessageAutoSend', () => ({
  getQueuedMessageOwnershipGate: () => 'legacy-enabled',
  subscribeQueuedMessageOwnershipGate: () => () => {}, useQueuedMessageAutoSend: effects.queue,
}));
vi.mock('@/sync/queue-abort-optimistic', () => ({ useQueueAbortOptimisticReconcile: effects.reconcile }));
vi.mock('@/sync/session-actions', () => ({ setOptimisticRefs: () => {} }));
vi.mock('@/sync/notification-store', () => ({ markSessionViewed: () => {} }));
vi.mock('@/sync/sync-context', () => ({ setExternallyViewedSession: () => {} }));
vi.mock('@/sync/use-sync', () => ({ useSync: () => ({ optimistic: { add: () => {}, remove: () => {}, confirm: () => {} } }) }));
vi.mock('@/sync/worktree-order-sync', () => ({ useWorktreeOrderSync: () => {} }));
vi.mock('@/lib/webviewZoom', () => ({ restoreWebviewZoomFactor: () => {} }));
vi.mock('@/lib/worktrees/worktreeTopologySync', () => ({ startWorktreeTopologySync: effects.topology }));
vi.mock('@/sync/speech-settings-sync', () => ({ mountSpeechSettingsSync: effects.speech }));
vi.mock('@/sync/message-queue-server-runtime', () => ({
  getMessageQueueServerRuntime: () => ({ start: effects.start, stop: effects.stop }),
  installMessageQueueServerRuntimeSwitch: () => () => {},
}));
vi.mock('@/sync/message-queue-cutover', () => ({ getMessageQueueCutover: () => ({ start: () => {}, stop: () => {} }) }));
vi.mock('@/stores/useGlobalSessionsStore', async () => {
  const { create } = await import('zustand');
  return { useGlobalSessionsStore: create(() => ({ activeSessions: [], hasLoadedFullCatalog: false })),
    ensureFullGlobalSessionsLoaded: vi.fn(), resolveGlobalSessionDirectory: () => '/project' };
});
vi.mock('@/sync/session-ui-store', async () => {
  const { create } = await import('zustand');
  return { useSessionUIStore: create(() => ({ currentSessionId: null, isLoading: false })) };
});
vi.mock('@/stores/useUIStore', async () => {
  const { create } = await import('zustand');
  return { useUIStore: create(() => ({ autoDeleteEnabled: false, autoDeleteAfterDays: 0 })) };
});
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: {} }));
vi.mock('@/sync/sync-refs', () => ({ getAllSyncSessions: () => [] }));

import { SyncAppEffects } from './AppEffects';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

it('isolates 50 parent/catalog updates while retaining queue lifecycle and enabled changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (tick: number, enabled = true) => root.render(<><span>{tick}</span><SyncAppEffects embeddedBackgroundWorkEnabled={enabled} /></>);
  try {
    await act(async () => render(0));
    effects.keyboard.mockClear(); effects.queue.mockClear(); effects.reconcile.mockClear();
    for (let i = 0; i < 50; i++) {
      await act(async () => render(i + 1));
      await act(async () => useGlobalSessionsStore.setState({ activeSessions: [] }));
    }
    expect(effects.keyboard.mock.calls.length).toBe(0);
    expect(effects.queue.mock.calls.length).toBe(0);
    expect(effects.reconcile.mock.calls.length).toBe(0);
    expect(effects.start).toHaveBeenCalledOnce();
    await act(async () => render(51, false));
    expect(effects.queue).toHaveBeenLastCalledWith(false);
    expect(effects.start).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
  expect(effects.stop).toHaveBeenCalledOnce();
});
