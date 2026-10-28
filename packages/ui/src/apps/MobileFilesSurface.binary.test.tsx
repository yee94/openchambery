import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { queryClient } from '@/lib/queryRuntime';
import { fileStatQueryOptions } from '@/queries/fileQueries';
import { MobileFilesSurface } from './MobileFilesSurface';

const state = vi.hoisted(() => ({
  files: { readFile: vi.fn(), statFile: vi.fn(), downloadFile: vi.fn(), listDirectory: vi.fn(), search: vi.fn(), createDirectory: vi.fn() },
  runtime: { isDesktop: false },
  plugin: false,
  t: (key: string) => key,
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => state }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: state.t }) }));
vi.mock('@/mobile/mobileBackNavigation', () => ({ useMobileBackRoute: () => {} }));
vi.mock('@/components/chat/imageSource', () => ({ useResolvedImageResource: () => ({ source: '', loading: false }) }));
vi.mock('@/components/chat/message/TextSelectionMenu', () => ({ TextSelectionMenu: () => null }));
vi.mock('@/components/views/PierreDiffViewer', () => ({ PIERRE_RUNTIME_BASE_CSS: '' }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: () => null }));
vi.mock('@/components/ui/MobileResizableSheet', () => ({ MobileSheetHeaderActions: () => null }));
vi.mock('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'light' } }, availableThemes: [] }) }));
vi.mock('@/lib/shiki/appThemeRegistry', () => ({ ensurePierreThemeRegistered: () => {} }));
vi.mock('@pierre/diffs/react', () => ({ File: ({ file }: { file: { contents: string } }) => <pre data-testid="text">{file.contents}</pre> }));
vi.mock('@/components/gui-plugins/GuiFileLinkBridge', () => ({
  GuiFileLinkBridge: ({ children }: { children: (view: { preview: React.ReactNode; toggle: React.ReactNode }) => React.ReactNode }) => children({
    preview: state.plugin ? <div data-testid="plugin">Plugin preview</div> : null,
    toggle: null,
  }),
}));

let host: HTMLDivElement;
let root: Root;
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}
async function render(path: string) {
  await act(async () => root.render(<QueryClientProvider client={queryClient}>
    <MobileFilesSurface key={path} initialFilePath={path} />
  </QueryClientProvider>));
  await settle();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  state.plugin = false;
  state.files.statFile.mockReset().mockImplementation(async (path: string) => ({ path, isFile: true, size: 500, isBinary: true }));
  state.files.readFile.mockReset().mockResolvedValue({ content: 'plain text' });
  state.files.downloadFile.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});

test('binary mobile detail skips text reads, hides copy text, and downloads only on click', async () => {
  await render('/workspace/installer.dmg');
  expect(state.files.statFile).toHaveBeenCalledTimes(1);
  expect(state.files.readFile).not.toHaveBeenCalled();
  expect(state.files.downloadFile).not.toHaveBeenCalled();
  expect(host.textContent).toContain('filesView.binary.description');
  expect(host.textContent).not.toContain('filesView.binary.openSystemApp');
  expect(host.querySelector('[aria-label="mobile.files.copyContentAria"]')).toBeNull();
  const download = [...host.querySelectorAll('button')].find((button) => button.textContent === 'sidebarFilesTree.menu.save');
  await act(async () => download!.click());
  expect(state.files.downloadFile).toHaveBeenCalledWith('/workspace/installer.dmg');
});

test('binary fallback stays behind plugin preview', async () => {
  state.plugin = true;
  await render('/workspace/file.custom');
  expect(host.querySelector('[data-testid="plugin"]')).not.toBeNull();
  expect(host.textContent).not.toContain('filesView.binary.description');
  expect(state.files.readFile).not.toHaveBeenCalled();
});

test('stat failure blocks content and is visible', async () => {
  state.files.statFile.mockRejectedValue(new Error('stat offline'));
  await render('/workspace/file.unknown');
  expect(state.files.readFile).not.toHaveBeenCalled();
  expect(host.textContent).toContain('stat offline');
  expect(host.querySelector('[data-testid="text"]')).toBeNull();
});

test('unknown-suffix text reads only after stat and reuses the watcher request', async () => {
  let resolve!: (value: unknown) => void;
  state.files.statFile.mockReturnValue(new Promise((done) => { resolve = done; }));
  await render('/workspace/file.unusual');
  expect(state.files.readFile).not.toHaveBeenCalled();
  await act(async () => resolve({ path: '/workspace/file.unusual', isFile: true, size: 10, isBinary: false }));
  await settle();
  await settle();
  expect(host.querySelector('[data-testid="text"]')?.textContent).toBe('plain text');
  expect(state.files.statFile).toHaveBeenCalledTimes(1);
  expect(state.files.readFile).toHaveBeenCalledTimes(1);
});

test('watcher changing text to binary disables content refetch even with unchanged size and mtime', async () => {
  const path = '/workspace/file.unusual';
  state.files.statFile.mockResolvedValue({ path, isFile: true, size: 10, mtimeMs: 1, isBinary: false });
  await render(path);
  await settle();
  expect(state.files.readFile).toHaveBeenCalledTimes(1);
  const options = fileStatQueryOptions(state.files, { scopeDirectory: '/workspace', path });
  await act(async () => queryClient.setQueryData(options.queryKey, { path, isFile: true, size: 10, mtimeMs: 1, isBinary: true }));
  await settle();
  expect(host.textContent).toContain('filesView.binary.description');
  expect(host.querySelector('[data-testid="text"]')).toBeNull();
  expect(state.files.readFile).toHaveBeenCalledTimes(1);
});

test('late stat for an old path never enables its content after navigation', async () => {
  let resolve!: (value: unknown) => void;
  state.files.statFile.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await render('/workspace/old.unusual');
  await render('/workspace/new.dmg');
  await act(async () => resolve({ path: '/workspace/old.unusual', isFile: true, size: 10, isBinary: false }));
  await settle();
  expect(host.textContent).toContain('filesView.binary.description');
  expect(state.files.readFile).not.toHaveBeenCalled();
});

test('a cached text classification must be revalidated before a newly opened file can read text', async () => {
  const path = '/workspace/replaced.unknown';
  const options = fileStatQueryOptions(state.files, { scopeDirectory: '/workspace', path });
  queryClient.setQueryData(options.queryKey, { path, isFile: true, size: 10, isBinary: false });
  let resolve!: (value: unknown) => void;
  state.files.statFile.mockReturnValue(new Promise((done) => { resolve = done; }));
  await render(path);
  expect(state.files.readFile).not.toHaveBeenCalled();
  await act(async () => resolve({ path, isFile: true, size: 4_000_000_000, isBinary: true }));
  await settle();
  expect(host.textContent).toContain('filesView.binary.description');
  expect(state.files.readFile).not.toHaveBeenCalled();
});

test('cached binary classification does not hide a failed stat revalidation behind download fallback', async () => {
  const path = '/workspace/cached.dmg';
  const options = fileStatQueryOptions(state.files, { scopeDirectory: '/workspace', path });
  queryClient.setQueryData(options.queryKey, { path, isFile: true, size: 500, isBinary: true });
  state.files.statFile.mockRejectedValue(new Error('stat revalidation offline'));
  await render(path);
  expect(host.textContent).toContain('stat revalidation offline');
  expect(host.textContent).not.toContain('filesView.binary.description');
  expect(host.textContent).not.toContain('sidebarFilesTree.menu.save');
  expect(state.files.readFile).not.toHaveBeenCalled();
  expect(state.files.downloadFile).not.toHaveBeenCalled();
});
