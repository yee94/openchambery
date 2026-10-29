import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FilesAPI } from '@/lib/api/types';
import { GuiPluginsProvider } from '@/lib/gui-plugins/GuiPluginsProvider';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { GuiFileLinkBridge } from './GuiFileLinkBridge';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { mobileWindowStack } from '@/components/ui/MobileWindowStack';

const state = vi.hoisted(() => ({
  transport: 'lazy-runtime',
  list: vi.fn(), gui: vi.fn(), toast: vi.fn(),
  files: null as FilesAPI | null,
  session: { id: 'lazy-session', directory: '/workspace' },
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => state.transport, getRuntimeKey: () => state.transport, getRuntimeGeneration: () => 0,
  subscribeRuntimeEndpointChanged: (callback: () => void) => {
    window.addEventListener('yuri:runtime-endpoint-changed', callback);
    return () => window.removeEventListener('yuri:runtime-endpoint-changed', callback);
  },
}));
vi.mock('@/lib/instanceScopedStorage', () => ({ instanceScopedStorageKey: (key: string, runtime: string) => `${runtime}:${key}` }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ files: state.files }) }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (value: { currentSessionId: string }) => unknown) => select({ currentSessionId: state.session.id }) }));
vi.mock('@/sync/sync-context', () => ({ useCurrentSessionEntity: () => state.session }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (value: { isMobile: boolean }) => unknown) => select({ isMobile: false }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
vi.mock('@/components/chat/fileReferenceActions', () => ({ openFileReference: vi.fn(async () => {}) }));
vi.mock('@/lib/opencode/gui', () => ({ createGuiClient: () => ({ plugin: { list: state.list, gui: state.gui } }) }));
vi.mock('@/components/ui', () => ({ toast: { error: state.toast } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
// Keep Dialog dependencies out of this happy-dom fixture; assert real host inline ownership below.
vi.mock('./GuiPluginSurface', () => ({ GuiPluginSurface: () => null }));
vi.mock('./GuiPluginLoadingNotice', () => ({ GuiPluginLoadingNotice: () => null }));

const source = 'File preview fixture';
const bundle = {
  code: `
    const G = require('@opencode/plugin/gui');
    const S = require('solid-js');
    module.exports.default = G.Plugin.define({
      setup(ctx) {
        ctx.add(G.LinkHandler, {
          match: link => link.href.endsWith('.preview'),
          open: link => ctx.layout.open('preview:' + link.href, link.session),
        });
        ctx.add(G.Panel, {
          id: 'files', region: 'side',
          list: ({ open }) => open.map(id => ({ id, title: id, file: id })),
          render(props) {
            const node = document.createElement('pre');
            node.setAttribute('data-preview', '');
            S.createRenderEffect(() => {
              node.textContent = props.screen.file.get(props.tab.file)?.content?.content ?? '';
            });
            return node;
          },
        });
      },
    });
  `,
  revision: 'lazy-one', options: {},
};
const plugin = { id: 'preview', features: { gui: true }, source: { type: 'package', target: 'preview' }, state: { status: 'active' } };
const path = '/workspace/workbench.preview';
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let context: ReturnType<typeof useGuiPlugins>;

function FileFixture({ sheet = false }: { sheet?: boolean }) {
  context = useGuiPlugins();
  const [open, setOpen] = React.useState(false);
  return <>
    <button onClick={() => setOpen(!open)}>{open ? 'close-file' : 'open-file'}</button>
    {open && (sheet ? <MobileResizableSheet id="gui-mobile-file" open onOpenChange={setOpen}
      title="File preview" ariaLabel="File preview" closeAriaLabel="Close" resizeAriaLabel="Resize" initiallyExpanded>
      <GuiFileLinkBridge path={path} base="/workspace"><pre data-source>{source}</pre></GuiFileLinkBridge>
    </MobileResizableSheet> : <GuiFileLinkBridge path={path} base="/workspace"><pre data-source>{source}</pre></GuiFileLinkBridge>)}
  </>;
}

async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}

async function until(assertion: () => void) {
  const deadline = Date.now() + 3_000;
  while (true) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    try { assertion(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
  }
}

async function start(sheet = false) {
  await act(async () => root.render(<QueryClientProvider client={client}><GuiPluginsProvider><FileFixture sheet={sheet} /></GuiPluginsProvider></QueryClientProvider>));
  await until(() => {
    expect(context.inventory).toEqual([{ id: 'preview', enabled: true }]);
    expect(context.loading).toBe(false);
  });
  expect(context.requested).toBe(false);
  expect(context.host).toBeNull();
  expect(state.gui).not.toHaveBeenCalled();
  expect(container.querySelector('[data-preview]')).toBeNull();
  expect(state.files!.readFile).not.toHaveBeenCalled();
}

async function expectPreview() {
  await until(() => {
    expect(container.querySelector('[data-gui-file-view] [data-gui-plugin-mount] [data-preview]')?.textContent).toBe(source);
    expect(context.loading).toBe(false);
  });
  expect(context.snapshot.plugins).toMatchObject([{ id: 'preview', status: 'active' }]);
  expect(context.host!.filePanel(path)).toMatchObject({ pluginId: 'preview', inline: true, file: path });
  expect(context.snapshot.panels.filter((panel) => panel.active && !panel.inline)).toEqual([]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('[data-source]')).toBeNull();
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(state.files!.readFile).toHaveBeenCalledWith(path, { directory: '/workspace' });
  expect(state.toast).not.toHaveBeenCalled();
  return container.querySelector('[data-preview]')!;
}

beforeEach(() => {
  state.transport = 'lazy-runtime';
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  state.list.mockReset().mockResolvedValue({ data: [plugin] });
  state.gui.mockReset();
  state.toast.mockReset();
  state.files = {
    readFile: vi.fn(async (file) => ({ path: file, content: source })),
    statFile: vi.fn(async (file) => ({ path: file, isFile: true, size: source.length, mtimeMs: 1 })),
    listDirectory: vi.fn(), search: vi.fn(), createDirectory: vi.fn(),
  };
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.restoreAllMocks();
});

it.each([false, true])('removes mounted plugin DOM and contributions when switching to an instance without GUI (sheet=%s)', async (sheet) => {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const result = matchMedia(query);
    if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(result, 'matches', { value: true });
    return result;
  });
  state.gui.mockResolvedValue({ data: bundle });
  await start(sheet);
  await click('open-file');
  await until(() => expect(document.querySelector('[data-preview]')?.textContent).toBe(source));
  const oldHost = context.host!;
  state.list.mockResolvedValue({ data: [] });
  await act(async () => {
    state.transport = 'empty-runtime';
    window.dispatchEvent(new CustomEvent('yuri:runtime-endpoint-changed'));
  });
  await until(() => {
    expect(context.host).toBeNull();
    expect(context.inventory).toEqual([]);
    expect(context.loading).toBe(false);
    expect(document.querySelector('[data-preview]')).toBeNull();
    expect(document.querySelector('[data-source]')?.textContent).toBe(source);
  });
  expect(oldHost.getSnapshot().plugins).toEqual([]);
  expect(oldHost.getSnapshot().panels).toEqual([]);
  expect(state.gui).toHaveBeenCalledOnce();
});

it('keeps the main file action usable while inventory and bundle reads are suspended', async () => {
  let inventory!: (value: { data: typeof plugin[] }) => void;
  let finish!: (value: { data: typeof bundle }) => void;
  state.list.mockImplementationOnce(() => new Promise((resolve) => { inventory = resolve; }));
  state.gui.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<QueryClientProvider client={client}><GuiPluginsProvider><FileFixture /></GuiPluginsProvider></QueryClientProvider>));
  await until(() => expect(state.list).toHaveBeenCalledOnce());
  await click('open-file');
  expect(container.textContent).toContain('close-file');
  expect(context.host).toBeNull();
  await act(async () => inventory({ data: [plugin] }));
  await until(() => expect(state.gui).toHaveBeenCalledOnce());
  await click('close-file');
  expect(container.textContent).toContain('open-file');
  expect(context.loading).toBe(true);
  await act(async () => finish({ data: bundle }));
  await until(() => expect(context.loading).toBe(false));
  await click('open-file');
  await expectPreview();
});

it('opens a ready plugin preview when the real mobile sheet becomes the active window', async () => {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const result = matchMedia(query);
    if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(result, 'matches', { value: true });
    return result;
  });
  state.gui.mockResolvedValue({ data: bundle });
  await start(true);
  await act(async () => context.requestLoad());
  await until(() => expect(context.snapshot.plugins).toMatchObject([{ id: 'preview', status: 'active' }]));
  await click('open-file');
  await until(() => {
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.hasAttribute('inert')).toBe(false);
    expect(dialog!.querySelector('[data-preview]')?.textContent).toBe(source);
  });
  expect(context.host!.filePanel(path)).toMatchObject({ inline: true, file: path });
  expect(state.gui).toHaveBeenCalledOnce();
  let uncover!: () => void;
  await act(async () => { uncover = mobileWindowStack.add({ id: 'cover-file', onClose() {} }); });
  expect(document.querySelector('[data-gui-file-view] [data-preview]')).toBeNull();
  expect(context.snapshot.panels.filter((panel) => panel.active)).toEqual([]);
  await act(async () => uncover());
  await until(() => expect(document.querySelector('[data-gui-file-view] [data-preview]')?.textContent).toBe(source));
  const toggle = document.querySelector<HTMLButtonElement>('[aria-label="filesView.editor.switchToEditMode"]')!;
  await act(async () => toggle.click());
  await act(async () => { uncover = mobileWindowStack.add({ id: 'cover-file', onClose() {} }); });
  await act(async () => uncover());
  expect(document.querySelector('[data-gui-file-view] [data-source]')?.textContent).toBe(source);
  expect(document.querySelector('[data-gui-file-view] [data-preview]')).toBeNull();
  await click('close-file');
  await click('open-file');
  await until(() => expect(document.querySelector('[data-gui-file-view] [data-preview]')?.textContent).toBe(source));
  expect(state.gui).toHaveBeenCalledOnce();
});

it('defers the CJS bundle until file opening, presents preview preparation, and reopens without another request', async () => {
  let complete!: (value: { data: typeof bundle }) => void;
  state.gui.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await start();
  await click('open-file');
  await until(() => expect(state.gui).toHaveBeenCalledOnce());
  expect(context.requested).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('guiPlugins.preview.loadingTitleguiPlugins.preview.loadingDescription');
  expect(container.querySelector('[data-gui-preview-loading] svg')).not.toBeNull();
  expect(container.querySelector('[data-source]')).toBeNull();
  expect(container.querySelector('[data-preview]')).toBeNull();
  expect(state.files!.readFile).not.toHaveBeenCalled();
  await act(async () => complete({ data: bundle }));
  const preview = await expectPreview();
  const host = context.host;
  await click('close-file');
  expect(container.querySelector('[data-preview]')).toBeNull();
  expect(context.snapshot.activePanel).toBeNull();
  expect(context.host).toBe(host);
  await click('open-file');
  expect(await expectPreview()).not.toBe(preview);
  expect(context.host).toBe(host);
  expect(state.gui).toHaveBeenCalledOnce();
  expect(state.list).toHaveBeenCalledOnce();
});

it('lets users read source during preparation without a late preview taking over', async () => {
  let complete!: (value: { data: typeof bundle }) => void;
  state.gui.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await start();
  await click('open-file');
  await until(() => expect(state.gui).toHaveBeenCalledOnce());
  await click('guiPlugins.preview.viewSource');
  expect(container.querySelector('[data-source]')?.textContent).toBe(source);
  expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
  await act(async () => complete({ data: bundle }));
  await until(() => expect(context.loading).toBe(false));
  expect(container.querySelector('[data-source]')?.textContent).toBe(source);
  expect(container.querySelector('[data-preview]')).toBeNull();
});

it('preserves source after bundle failure and refresh mounts the real inline preview', async () => {
  state.gui.mockRejectedValue(new Error('bundle unavailable'));
  await start();
  await click('open-file');
  await until(() => expect(container.querySelector('[role="alert"]')?.textContent).toBe('bundle unavailable'));
  expect(context.loading).toBe(false);
  expect(container.querySelector('[data-source]')?.textContent).toBe(source);
  expect(container.querySelector('[data-preview]')).toBeNull();
  expect(state.gui).toHaveBeenCalledTimes(2);
  state.gui.mockResolvedValue({ data: bundle });
  await click('guiPlugins.refresh');
  await expectPreview();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(state.gui).toHaveBeenCalledTimes(3);
});

it('reports a real plugin render failure inside the opened file surface', async () => {
  state.gui.mockResolvedValue({ data: { ...bundle, code: bundle.code.replace("const node = document.createElement('pre');", "throw new Error('preview render failed');") } });
  await start();
  await click('open-file');
  await until(() => expect(container.querySelector('[data-gui-file-view] [role="alert"]')?.textContent).toBe('preview render failed'));
  expect(container.querySelector('[data-source]')?.textContent).toBe(source);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
