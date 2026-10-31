import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MobileFilesSurface } from './MobileFilesSurface';
import { queryClient, queryKeys } from '@/lib/queryRuntime';

const state = vi.hoisted(() => ({
  readFile: vi.fn(),
  statFile: vi.fn(),
  pluginPreview: false,
  t: (key: string) => key,
}));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ files: { readFile: state.readFile, statFile: state.statFile } }),
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => 'mobile-refresh-test',
  getRuntimeGeneration: () => 0,
  getRuntimeApiBaseUrl: () => '',
  subscribeRuntimeEndpointChanged: () => () => {},
  isRuntimeEndpointIdentityChange: () => false,
}));
vi.mock('@/lib/runtime-auth', () => ({
  acquireRuntimeUrlAuthToken: () => () => {}, refreshRuntimeUrlAuthToken: async () => 'fixture-url-token', subscribeRuntimeUrlAuthToken: () => () => {},
}));
vi.mock('@/lib/runtime-file-resource', () => ({ directFileResource: () => ({ url: 'about:blank' }), readRuntimeFile: vi.fn() }));
vi.mock('@/lib/relay/runtime-tunnel', () => ({ isRelayModeActive: () => false }));
vi.mock('@/components/gui-plugins/GuiFileLinkBridge', () => ({
  GuiFileLinkBridge: ({ children }: { children: (view: { preview: React.ReactNode; controls: null }) => React.ReactNode }) => children({
    preview: state.pluginPreview ? <div data-plugin-preview><input defaultValue="initial" /><iframe title="plugin-document" /></div> : null,
    controls: null,
  }),
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  SimpleMarkdownRenderer: ({ content }: { content: string }) => <article data-markdown>{content}</article>,
}));
vi.mock('@/components/chat/imageSource', () => ({ useResolvedImageResource: () => ({ source: '', loading: false }) }));
vi.mock('@/components/chat/message/TextSelectionMenu', () => ({ TextSelectionMenu: () => null }));
vi.mock('@/components/views/PierreDiffViewer', () => ({ PIERRE_RUNTIME_BASE_CSS: '' }));
vi.mock('@pierre/diffs/react', () => ({ File: () => null }));
vi.mock('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'light' } }, availableThemes: [] }),
}));
vi.mock('@/lib/shiki/appThemeRegistry', () => ({ ensurePierreThemeRegistered: () => {} }));
vi.mock('@/mobile/mobileBackNavigation', () => ({ useMobileBackRoute: () => {} }));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (select: (value: unknown) => unknown) => select({ pendingFileFocusPath: null, setPendingFileFocusPath: () => {} }),
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: state.t }) }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/MobileResizableSheet', () => ({ MobileSheetHeaderActions: () => null }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const path = '/workspace/report.md';
const statKey = queryKeys.files.stat('/workspace', path, undefined, 'mobile-refresh-test');
const contentKey = queryKeys.files.content('/workspace', path, undefined, 'mobile-refresh-test');
const documentContent = '# Report\n\n' + 'Reading paragraph.\n\n'.repeat(200);
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const deferredRead = () => {
  let resolve!: (value: { content: string }) => void;
  const promise = new Promise<{ content: string }>((done) => { resolve = done; });
  return { promise, resolve };
};

const flush = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

const mount = async (filePath = path) => {
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <MobileFilesSurface initialFilePath={filePath} directFilePreview hideFileHeader />
    </QueryClientProvider>,
  ));
  await flush();
  await flush();
};

beforeEach(() => {
  queryClient.clear();
  state.pluginPreview = false;
  state.statFile.mockResolvedValue({ path, size: 4000, mtimeMs: 1, isBinary: false });
  state.readFile.mockResolvedValue({ content: documentContent });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  queryClient.clear();
  vi.clearAllMocks();
});

test('the first file read still shows loading until content arrives', async () => {
  const read = deferredRead();
  state.readFile.mockReturnValueOnce(read.promise);
  await mount();
  expect(host.querySelector('[data-markdown]')).toBeNull();
  expect(host.textContent).toContain('filesView.state.loading');
  await act(async () => read.resolve({ content: documentContent }));
  await flush();
  expect(host.querySelector('[data-markdown]')?.textContent).toBe(documentContent);
});

test.each([
  ['unchanged content', documentContent, documentContent],
  ['updated content', documentContent, `${documentContent}\nNew paragraph.`],
  ['previously empty file', '', documentContent],
])('external file updates preserve the scroller with %s', async (_label, initial, updated) => {
  state.readFile.mockResolvedValueOnce({ content: initial });
  await mount();
  const article = host.querySelector('[data-markdown]')!;
  const scroller = article.parentElement!;
  scroller.scrollTop = initial ? 800 : 0;
  const readingPosition = scroller.scrollTop;

  for (let revision = 2; revision <= 4; revision += 1) {
    const read = deferredRead();
    state.readFile.mockReturnValueOnce(read.promise);
    state.statFile.mockResolvedValue({ path, size: 4000, mtimeMs: revision, isBinary: false });
    await act(async () => { await queryClient.refetchQueries({ queryKey: statKey, exact: true }); });
    await flush();
    expect(queryClient.isFetching({ queryKey: contentKey, exact: true })).toBe(1);
    expect(scroller.isConnected).toBe(true);
    expect(host.querySelector('[data-markdown]')).toBe(article);
    expect(article.textContent).toBe(revision === 2 ? initial : updated);
    expect(scroller.scrollTop).toBe(readingPosition);

    await act(async () => read.resolve({ content: updated }));
    await flush();
    expect(host.querySelector('[data-markdown]')).toBe(article);
    expect(article.textContent).toBe(updated);
    expect(scroller.scrollTop).toBe(readingPosition);
  }
  expect(state.readFile).toHaveBeenCalledTimes(4);
});

test('HTML metadata polling does not reload its document or read it as source', async () => {
  const htmlPath = '/workspace/report.html';
  await mount(htmlPath);
  const iframe = host.querySelector('iframe')!;
  expect(iframe).not.toBeNull();
  state.statFile.mockResolvedValue({ path: htmlPath, size: 4000, mtimeMs: 2, isBinary: false });
  await act(async () => { await queryClient.refetchQueries({
    queryKey: queryKeys.files.stat('/workspace', htmlPath, undefined, 'mobile-refresh-test'), exact: true,
  }); });
  await flush();
  expect(host.querySelector('iframe')).toBe(iframe);
  expect(state.readFile).not.toHaveBeenCalled();
});

test('Eficy plugin keeps its iframe and local controls while the source is revalidated', async () => {
  const pluginPath = '/workspace/report.eficy';
  state.pluginPreview = true;
  await mount(pluginPath);
  const preview = host.querySelector('[data-plugin-preview]')!;
  const iframe = preview.querySelector('iframe')!;
  const input = preview.querySelector('input')!;
  input.value = 'reader choice';
  const read = deferredRead();
  state.readFile.mockReturnValueOnce(read.promise);
  state.statFile.mockResolvedValue({ path: pluginPath, size: 4000, mtimeMs: 2, isBinary: false });
  await act(async () => { await queryClient.refetchQueries({
    queryKey: queryKeys.files.stat('/workspace', pluginPath, undefined, 'mobile-refresh-test'), exact: true,
  }); });
  await flush();
  expect(queryClient.isFetching({ queryKey: queryKeys.files.content('/workspace', pluginPath, undefined, 'mobile-refresh-test'), exact: true })).toBe(1);
  expect(preview.isConnected).toBe(true);
  await act(async () => read.resolve({ content: 'updated plugin source' }));
  await flush();
  expect(host.querySelector('[data-plugin-preview]')).toBe(preview);
  expect(preview.querySelector('iframe')).toBe(iframe);
  expect(input.value).toBe('reader choice');
});
