import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FilesAPI } from '@/lib/api/types';
import { GuiPluginsProvider } from '@/lib/gui-plugins/GuiPluginsProvider';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { GuiFileLinkBridge } from './GuiFileLinkBridge';

const state = vi.hoisted(() => ({
  list: vi.fn(), gui: vi.fn(), toast: vi.fn(),
  files: null as FilesAPI | null,
  session: { id: 'lazy-session', directory: '/workspace' },
}));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => 'lazy-runtime', getRuntimeKey: () => 'lazy-runtime' }));
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

function FileFixture() {
  context = useGuiPlugins();
  const [open, setOpen] = React.useState(false);
  return <>
    <button onClick={() => setOpen(!open)}>{open ? 'close-file' : 'open-file'}</button>
    {open && <GuiFileLinkBridge path={path} base="/workspace"><pre data-source>{source}</pre></GuiFileLinkBridge>}
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

async function start() {
  await act(async () => root.render(<QueryClientProvider client={client}><GuiPluginsProvider><FileFixture /></GuiPluginsProvider></QueryClientProvider>));
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
});

it('defers the CJS bundle until file opening, preserves source while pending, and reopens without another request', async () => {
  let complete!: (value: { data: typeof bundle }) => void;
  state.gui.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await start();
  await click('open-file');
  await until(() => expect(state.gui).toHaveBeenCalledOnce());
  expect(context.requested).toBe(true);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('guiPlugins.loading');
  expect(container.querySelector('[data-source]')?.textContent).toBe(source);
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
