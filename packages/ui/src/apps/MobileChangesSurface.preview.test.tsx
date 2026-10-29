import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { MobileChangesSurface } from './MobileChangesSurface';

const fixture = vi.hoisted(() => {
  const diff = { original: '', modified: 'export default () => null' };
  const paths = ['30 📚 Learning/相机画幅图解.eficy', 'notes.md'];
  const noop = vi.fn();
  return {
    openFile: vi.fn(),
    git: { getRemotes: vi.fn(async () => []) },
    status: { files: paths.map(path => ({ path, index: '?', working_dir: '?' })) },
    store: {
      directories: new Map([['/workspace', { diffCache: new Map(paths.map(path => [path, diff])) }]]),
      setActiveDirectory: noop, ensureAll: noop, fetchStatus: noop, fetchBranches: noop,
      prefetchDiffs: noop, getDiff: () => diff, setDiff: noop,
    },
    t: (key: string) => key,
  };
});
vi.mock('@/apps/mobileAppContext', () => ({ useMobileAppActions: () => ({ openFile: fixture.openFile }) }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ git: fixture.git }) }));
vi.mock('@/stores/useGitStore', () => ({
  useGitStore: (select: (state: typeof fixture.store) => unknown) => select(fixture.store),
  useGitStatus: () => fixture.status, useIsGitRepo: () => true, useGitLoadingStatus: () => false,
}));
vi.mock('@/lib/gitApi', () => ({ generateCommitMessage: vi.fn(), stageGitFile: vi.fn(), stageGitFiles: vi.fn(), unstageGitFile: vi.fn(), unstageGitFiles: vi.fn() }));
vi.mock('@/mobile/mobileBackNavigation', () => ({ useMobileBackRoute: () => {} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.t }) }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/views/git/ChangesPanel', () => ({ ChangesPanel: () => null }));
vi.mock('@/components/views/git/CommitSection', () => ({ CommitSection: () => null }));
vi.mock('@/components/views/git/SyncActions', () => ({ SyncActions: () => null }));
vi.mock('@/components/views/PierreDiffViewer', () => ({ PierreDiffViewer: () => <div data-diff /> }));
vi.mock('@/components/ui/ScrollShadow', () => ({ ScrollShadow: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/MobileResizableSheet', () => ({ MobileSheetHeaderActions: ({ children }: { children: React.ReactNode }) => <header data-sheet-actions>{children}</header> }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

test.each([false, true])('Changes opens plugin and Markdown files through the same preview route (sheet: %s)', async (hideDiffHeader) => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  for (const path of ['30 📚 Learning/相机画幅图解.eficy', 'notes.md']) {
    await act(async () => root.render(<MobileChangesSurface initialDiffPath={path} hideDiffHeader={hideDiffHeader} />));
    expect(container.querySelector('[data-diff]')).not.toBeNull();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="diffView.actions.openFilePreview"]');
    expect(button).not.toBeNull();
    if (hideDiffHeader) expect(button?.closest('[data-sheet-actions]')).not.toBeNull();
    await act(async () => button!.click());
    expect(fixture.openFile).toHaveBeenLastCalledWith({ path: `/workspace/${path}` });
  }
});
