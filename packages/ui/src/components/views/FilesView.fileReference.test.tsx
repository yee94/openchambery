import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TransactionSpec } from '@codemirror/state';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';

const harness = vi.hoisted(() => ({
  files: { readFile: vi.fn(), listDirectory: vi.fn(), statFile: vi.fn(), writeFile: vi.fn() },
  runtime: { isDesktop: false },
  noop: () => {},
  empty: [],
  t: (key: string) => key,
}));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: harness.t }) }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: vi.fn(async () => new Response('{}')) }));
vi.mock('@/stores/useOpenInAppsStore', () => ({
  useOpenInAppsStore: (selector: (state: unknown) => unknown) => selector({ availableApps: harness.empty, initialize: harness.noop }),
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => harness }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false, isTablet: false, screenWidth: 1400 }) }));
vi.mock('@/contexts/useThemeSystem', async () => {
  const { getDefaultTheme } = await import('@/lib/theme/themes');
  const theme = getDefaultTheme(false);
  const value = { currentTheme: theme, availableThemes: [theme], lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id };
  return { useThemeSystem: () => value, useOptionalThemeSystem: () => value };
});
vi.mock('@/lib/shiki/appThemeRegistry', () => ({ ensurePierreThemeRegistered: harness.noop, getResolvedShikiTheme: () => 'light' }));
vi.mock('@/lib/codemirror/shikiHighlight', () => ({ shikiHighlightExtension: () => [] }));
vi.mock('@/lib/codemirror/languageByExtension', () => ({ languageByExtension: () => [], loadLanguageByExtension: async () => [] }));
vi.mock('@/stores/useGitStore', () => ({ useGitStatus: () => null }));
vi.mock('@/hooks/useMessageTTS', () => ({ useMessageTTS: () => ({ isPlaying: false, play: harness.noop, stop: harness.noop }) }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: () => null }));
vi.mock('@/components/diagram', () => ({ DiagramEditor: () => null }));
vi.mock('@/components/views/DiffView', () => ({ DiffView: () => null }));
vi.mock('@/components/layout/ContextSidebarTab', () => ({ ContextPanelContent: () => null }));
vi.mock('@/components/layout/ContextPanelSessionTranscript', () => ({ ContextPanelSessionTranscript: () => null }));
vi.mock('@/sync/sync-context', () => ({
  useDirectoryStore: () => ({ subscribe: () => harness.noop, getState: () => ({ session: harness.empty }) }),
  setContextPanelViewedSession: harness.noop,
  setExternallyViewedSession: harness.noop,
}));
vi.mock('@/components/comments', () => ({
  useInlineCommentController: () => ({ drafts: harness.empty, reset: harness.noop, setSelection: harness.noop }),
  buildCodeMirrorCommentWidgets: () => [],
  CodeSelectionActionBubble: () => null,
  normalizeLineRange: (value: unknown) => value,
}));
vi.mock('@/components/ui/CodeMirrorEditor', async () => {
  const { EditorState } = await import('@codemirror/state');
  return {
    CodeMirrorEditor: ({ value, onChange, readOnly, onViewReady }: {
      value: string; onChange: (value: string) => void; readOnly: boolean;
      onViewReady: (view: unknown) => void;
    }) => {
      const ready = React.useRef(onViewReady);
      const [view] = React.useState(() => ({
        state: EditorState.create({ doc: value }),
        focus: harness.noop,
        dispatch(spec: TransactionSpec) { this.state = this.state.update(spec).state; },
      }));
      React.useLayoutEffect(() => { view.state = EditorState.create({ doc: value }); }, [value, view]);
      React.useEffect(() => { ready.current(view); }, [view]);
      return <>
        <pre data-testid="editor">{value}</pre>
        <textarea data-testid="draft" value={value} readOnly={readOnly} onInput={(event) => onChange(event.currentTarget.value)} />
      </>;
    },
  };
});
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));

import { FilesView } from './FilesView';
import { ContextPanel } from '@/components/layout/ContextPanel';
import { openFileReference } from '@/components/chat/fileReferenceActions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let reactRoot: Root;

// The panel owns the label and passes its target to the real file view.
function FilePanel() {
  const panel = useUIStore((state) => state.contextPanelByDirectory['/repo']);
  const tab = panel?.tabs.find((entry) => entry.id === panel.activeTabId);
  const targetPath = tab?.targetPath ?? null;
  return <><h1>{targetPath}</h1><FilesView key={targetPath} mode="editor-only" targetPath={targetPath} /></>;
}

async function open(path: string, atLine = false) {
  await act(async () => {
    if (atLine) useUIStore.getState().openContextFileAtLine('/repo', path, 3);
    else useUIStore.getState().openContextFile('/repo', path);
    useFilesViewTabsStore.getState().setSelectedPath('/repo', path, { allowOutsideRoot: true });
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.files.readFile.mockReset();
  harness.files.writeFile.mockReset().mockResolvedValue({ success: true });
  harness.files.statFile.mockReset().mockImplementation(async (path: string) => ({ path, size: 9, isFile: true }));
  harness.files.listDirectory.mockClear();
  harness.files.listDirectory.mockResolvedValue({ entries: [] });
  useFilesViewTabsStore.setState({ byRoot: {} });
  useUIStore.setState({ contextPanelByDirectory: {}, pendingFileFocusPath: null, pendingFileNavigation: null, pendingFileViewerMode: null, mainTabGuard: null });
  window.localStorage.setItem('openchamber:files:auto-save-enabled', 'false');
  host = document.createElement('div');
  document.body.append(host);
  reactRoot = createRoot(host);
});

afterEach(async () => {
  await act(async () => reactRoot.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('file reference failure lifecycle', () => {
  test.each([
    ['/repo/.../B.ts', 'ENOENT: no such file or directory'],
    ['/repo/folder', 'EISDIR: illegal operation on a directory'],
    ['/outside/B.ts', 'EACCES: permission denied'],
    ['/outside/B.ts', 'Path is outside the workspace'],
    ['/repo/B.ts', 'Network request failed'],
  ])('binds the panel to failed %s and settles both pending intents (%s)', async (path, message) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    const failure = deferred<{ content: string }>();
    harness.files.readFile.mockImplementation((requested: string) => requested === '/repo/A.ts'
      ? Promise.resolve({ content: 'content-A' }) : failure.promise);
    await open('/repo/A.ts');
    // A is already open; focus is irrelevant to establishing the previous content.
    useUIStore.setState({ pendingFileFocusPath: null });
    await act(async () => reactRoot.render(<FilePanel />));
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-A');

    await open(path, true);
    expect(host.querySelector('[data-testid="editor"]')?.textContent).not.toBe('content-A');
    await act(async () => useUIStore.getState().setPendingFileFocusPath(path));
    // A failed read stays terminal even while unrelated UI updates continue.
    harness.files.readFile.mockImplementation((requested: string) => requested === '/repo/A.ts'
      ? Promise.resolve({ content: 'content-A' }) : new Promise(() => {}));
    await act(async () => failure.reject(new Error(message)));
    expect(useUIStore.getState().pendingFileFocusPath).toBeNull();
    expect(useUIStore.getState().pendingFileNavigation).toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe(path);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(host.querySelector('[data-testid="editor"]')).toBeNull();
    const count = harness.files.readFile.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    for (let index = 0; index < 3; index += 1) {
      await act(async () => reactRoot.render(<FilePanel />));
    }
    expect(harness.files.readFile.mock.calls.length).toBe(count);
    expect(harness.files.readFile.mock.calls.filter(([requested]) => requested === path)).toHaveLength(1);
  });

  test('a late B failure preserves the newer C request and content', async () => {
    const b = deferred<{ content: string }>();
    const c = deferred<{ content: string }>();
    harness.files.readFile.mockImplementation((path: string) => path === '/repo/B.ts' ? b.promise : c.promise);
    await open('/repo/B.ts', true);
    await act(async () => reactRoot.render(<FilePanel />));
    await open('/repo/C.ts', true);
    await act(async () => useUIStore.getState().setPendingFileFocusPath('/repo/C.ts'));
    const navigation = useUIStore.getState().pendingFileNavigation;
    await act(async () => b.reject(new Error('ENOENT: no such file or directory')));
    expect(useUIStore.getState().pendingFileNavigation).toBe(navigation);
    expect(useUIStore.getState().pendingFileFocusPath).toBe('/repo/C.ts');
    await act(async () => c.resolve({ content: 'content-C' }));
    expect(host.querySelector('h1')?.textContent).toBe('/repo/C.ts');
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-C');
    expect(harness.files.readFile.mock.calls.filter(([path]) => path === '/repo/C.ts')).toHaveLength(1);
  });

  test.each([
    ['/repo/B.ts', 'ENOENT: no such file or directory'],
    ['/repo/folder', 'EISDIR: illegal operation on a directory'],
  ])('full view preserves fallback and directory expansion after %s fails', async (path, message) => {
    const failure = deferred<{ content: string }>();
    const previousPath = path.endsWith('folder') ? '/repo/folder/A.ts' : '/repo/A.ts';
    harness.files.readFile.mockImplementation((requested: string) => requested === previousPath
      ? Promise.resolve({ content: 'content-A' }) : failure.promise);
    useFilesViewTabsStore.getState().setSelectedPath('/repo', previousPath);
    await act(async () => reactRoot.render(<FilesView />));
    await open(path, true);
    await act(async () => useUIStore.getState().setPendingFileFocusPath(path));
    await act(async () => failure.reject(new Error(message)));
    expect(useUIStore.getState().pendingFileNavigation).toBeNull();
    expect(useUIStore.getState().pendingFileFocusPath).toBeNull();
    expect(useFilesViewTabsStore.getState().byRoot['/repo'].selectedPath).toBe(previousPath);
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-A');
    expect(harness.files.readFile.mock.calls.filter(([requested]) => requested === path)).toHaveLength(1);
    if (path.endsWith('folder')) {
      expect(useFilesViewTabsStore.getState().byRoot['/repo'].expandedPaths).toContain(path);
      expect(harness.files.listDirectory).toHaveBeenCalledWith(path);
    }
  });

  test('an allowed outside file still uses the existing read capability', async () => {
    harness.files.readFile.mockResolvedValue({ content: 'outside-content' });
    await open('/outside/C.ts');
    await act(async () => reactRoot.render(<FilePanel />));
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('outside-content');
    expect(harness.files.readFile).toHaveBeenCalledWith('/outside/C.ts', {
      allowOutsideWorkspace: true,
      outsideFileGrant: undefined,
      directory: '/repo',
    });
  });
});

async function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}

function activeFilePath() {
  const panel = useUIStore.getState().contextPanelByDirectory['/repo'];
  return panel?.tabs.find((tab) => tab.id === panel.activeTabId)?.targetPath;
}

describe('ContextPanel writable file navigation', () => {
  test.each([
    ['tab', false], ['reference', false], ['line-reference', false],
    ['tab', true], ['reference', true],
  ] as const)('keeps A draft until a decision for %s (autosave %s)', async (source, autoSave) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    window.localStorage.setItem('openchamber:files:auto-save-enabled', String(autoSave));
    harness.files.readFile.mockImplementation(async (path: string) => ({ content: path === '/repo/A.ts' ? 'content-A' : 'content-B' }));
    useUIStore.getState().openContextFile('/repo', '/repo/B.ts');
    useUIStore.getState().openContextFile('/repo', '/repo/A.ts');
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    const editor = host.querySelector<HTMLTextAreaElement>('[data-testid="draft"]')!;
    expect(editor.readOnly).toBe(false);
    await act(async () => {
      editor.value = 'unsaved-A';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const requestB = async () => {
      await act(async () => {
        if (source === 'tab') {
          const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((entry) => entry.textContent?.includes('B.ts'));
          expect(tab).toBeTruthy();
          tab!.click();
        } else if (source === 'line-reference') {
          await openFileReference('/repo/B.ts:3', false, { effectiveDirectory: '/repo' });
        } else {
          await openFileReference('/repo/B.ts', false, { effectiveDirectory: '/repo' });
        }
      });
    };
    await requestB();
    expect(activeFilePath()).toBe('/repo/A.ts');
    expect(host.querySelector('[data-testid="draft"]')).toBe(editor);
    expect(editor.value).toBe('unsaved-A');
    expect(harness.files.writeFile).not.toHaveBeenCalled();
    expect(harness.files.readFile.mock.calls.filter(([path]) => path === '/repo/B.ts')).toHaveLength(0);
    await clickButton('filesView.dialog.cancel');
    expect(activeFilePath()).toBe('/repo/A.ts');
    expect(editor.value).toBe('unsaved-A');
    expect(useUIStore.getState().pendingFileFocusPath).toBeNull();
    expect(useUIStore.getState().pendingFileNavigation).toBeNull();
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
    await requestB();
    if (autoSave) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      expect(harness.files.writeFile).toHaveBeenCalledWith('/repo/A.ts', 'unsaved-A');
      await clickButton('filesView.unsaved.saveChanges');
    } else {
      const save = deferred<{ success: boolean }>();
      harness.files.writeFile.mockReturnValueOnce(save.promise);
      await clickButton('filesView.unsaved.saveChanges');
      expect(activeFilePath()).toBe('/repo/A.ts');
      expect(host.querySelector('[data-testid="draft"]')).toBe(editor);
      expect(editor.value).toBe('unsaved-A');
      expect(harness.files.readFile.mock.calls.filter(([path]) => path === '/repo/B.ts')).toHaveLength(0);
      await act(async () => save.resolve({ success: true }));
    }
    expect(harness.files.writeFile).toHaveBeenCalledWith('/repo/A.ts', 'unsaved-A');
    expect(activeFilePath()).toBe('/repo/B.ts');
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-B');
  });

  test('a failed save retains A and explicit discard then opens B', async () => {
    harness.files.readFile.mockImplementation(async (path: string) => ({ content: path === '/repo/A.ts' ? 'content-A' : 'content-B' }));
    harness.files.writeFile.mockResolvedValue({ success: false });
    useUIStore.getState().openContextFile('/repo', '/repo/A.ts');
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    const editor = host.querySelector<HTMLTextAreaElement>('[data-testid="draft"]')!;
    await act(async () => {
      editor.value = 'unsaved-A';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => useUIStore.getState().openContextFile('/repo', '/repo/B.ts'));
    await clickButton('filesView.unsaved.saveChanges');
    expect(activeFilePath()).toBe('/repo/A.ts');
    expect(host.querySelector('[data-testid="draft"]')).toBe(editor);
    expect(editor.value).toBe('unsaved-A');
    expect(harness.files.readFile.mock.calls.filter(([path]) => path === '/repo/B.ts')).toHaveLength(0);
    await clickButton('filesView.unsaved.discard');
    expect(activeFilePath()).toBe('/repo/B.ts');
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-B');
    expect(harness.files.writeFile).toHaveBeenCalledTimes(1);
  });

  test('explicit retry recovers the same failed target after the file becomes readable', async () => {
    harness.files.readFile.mockRejectedValueOnce(new Error('ENOENT: file not found')).mockResolvedValue({ content: 'recovered-B' });
    useUIStore.getState().openContextFile('/repo', '/repo/B.ts');
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    expect(harness.files.readFile).toHaveBeenCalledTimes(1);
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    expect(harness.files.readFile).toHaveBeenCalledTimes(1);
    await clickButton('contextPanel.preview.actions.retry');
    expect(harness.files.readFile).toHaveBeenCalledTimes(2);
    expect(activeFilePath()).toBe('/repo/B.ts');
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('recovered-B');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
