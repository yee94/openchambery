import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { useGuiPlugins } from '@/lib/gui-plugins/react';
import { GuiPluginMount } from './GuiPluginMount';
import { GuiPluginSurface } from './GuiPluginSurface';
import { GuiPluginsManager } from './GuiPluginsManager';
import { GuiFileLinkBridge } from './GuiFileLinkBridge';
import { GuiPluginCommands } from './GuiPluginCommands';

type Context = ReturnType<typeof useGuiPlugins>;
const state = vi.hoisted(() => ({
  context: null as Context | null,
  toast: vi.fn(),
  t: (key: string, values?: Record<string, string | number>) => `${key}${values ? `:${Object.values(values).join(',')}` : ''}`,
}));
vi.mock('@/lib/gui-plugins/react', () => ({ useGuiPlugins: () => state.context }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: state.t }) }));
vi.mock('@/components/ui', () => ({ toast: { error: state.toast } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./GuiPluginWindow', () => ({
  GuiPluginWindow: ({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) => open
    ? <section data-window><button onClick={onClose}>dismiss-window</button>{children}</section> : null,
}));
vi.mock('@/components/ui/command', () => ({
  CommandGroup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  CommandItem: ({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) => <button onClick={onSelect}>{children}</button>,
}));

function makeHost() {
  const log: string[] = [];
  const mount = (kind: string) => vi.fn((key: string, node: HTMLElement) => {
    log.push(`mount:${kind}:${key}`);
    const child = document.createElement('span');
    child.textContent = `external:${key}`;
    node.append(child);
    return () => { log.push(`dispose:${kind}:${key}`); child.remove(); };
  });
  const methods = {
    mountPanel: mount('panel'), mountSettings: mount('settings'),
    openLink: vi.fn(() => true), runCommand: vi.fn(),
    registerFileView: vi.fn(() => vi.fn()),
    filePanel: vi.fn(() => state.context?.snapshot.panels.find((panel) => panel.inline)),
    selectPanel: vi.fn(), closePanel: vi.fn(), hidePanel: vi.fn(),
  };
  return { methods, log, host: methods as unknown as NonNullable<Context['host']> };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let fixture: ReturnType<typeof makeHost>;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const click = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === text || node.getAttribute('aria-label') === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
};
const context = () => state.context!;
const updateSnapshot = (patch: Partial<Context['snapshot']>) => {
  state.context = { ...context(), snapshot: { ...context().snapshot, ...patch } };
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture = makeHost();
  state.toast.mockClear();
  state.context = {
    host: fixture.host,
    snapshot: { plugins: [{ id: 'demo', revision: 'one', status: 'active' }], panels: [], commands: [], settings: [], menuItems: [], activePanel: null },
    inventory: [{ id: 'demo', enabled: true }], loading: false, error: null,
    setEnabled: vi.fn(), refresh: vi.fn(), requested: true, requestLoad: vi.fn(),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('foreign DOM ownership', () => {
  test.each(['inline', 'standalone'] as const)('%s panel keeps its DOM across 50 unrelated plugin reloads and remounts only its owner', async (surface) => {
    const plugin = { id: 'demo', revision: 'one', status: 'active' as const };
    updateSnapshot({
      plugins: [plugin, { id: 'other', revision: 'one', status: 'active' }],
      panels: [{ key: 'demo:a', pluginId: 'demo', title: 'Preview', active: true, inline: surface === 'inline', file: '/workspace/a.ydsl' }],
      activePanel: 'demo:a',
    });
    const view = () => surface === 'inline' ? <GuiFileLinkBridge path="/workspace/a.ydsl" /> : <GuiPluginSurface />;
    await render(view());
    const child = container.querySelector('[data-gui-plugin-mount]')!.firstChild;
    for (let index = 0; index < 50; index++) {
      updateSnapshot({ plugins: [plugin, { id: 'other', revision: String(index), status: 'active' }] });
      await render(view());
      expect(container.querySelector('[data-gui-plugin-mount]')!.firstChild).toBe(child);
    }
    expect(fixture.log).toEqual(['mount:panel:demo:a']);
    updateSnapshot({ plugins: [{ ...plugin, revision: 'two' }, context().snapshot.plugins[1]] });
    await render(view());
    expect(fixture.log).toEqual(['mount:panel:demo:a', 'dispose:panel:demo:a', 'mount:panel:demo:a']);
    expect(container.querySelector('[data-gui-plugin-mount]')!.firstChild).not.toBe(child);
    for (let index = 0; index < 50; index++) {
      updateSnapshot({ plugins: context().snapshot.plugins.map((item) => ({ ...item })) });
      await render(view());
    }
    expect(fixture.methods.mountPanel).toHaveBeenCalledTimes(2);
  });

  test('manager exposes session.panel launchers before any panel exists and reports launcher failures', async () => {
    const run = vi.fn();
    updateSnapshot({ menuItems: [{ key: 'launch', title: 'Open diagram', description: 'Create a diagram panel', run }] });
    await render(<GuiPluginsManager />);
    expect(container.textContent).toContain('guiPlugins.panels');
    expect(container.textContent).toContain('Open diagram');
    expect(container.textContent).toContain('Create a diagram panel');
    await click('guiPlugins.open');
    expect(run).toHaveBeenCalledTimes(1);
    run.mockImplementationOnce(() => { throw new Error('launcher failed'); });
    await click('guiPlugins.open');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('launcher failed');
    await click('guiPlugins.open');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    updateSnapshot({ menuItems: [] });
    await render(<GuiPluginsManager />);
    expect(container.textContent).not.toContain('Open diagram');
  });

  test('keeps a mount through unrelated renders and disposes before changing key, kind or host', async () => {
    await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" />);
    for (let i = 0; i < 50; i++) await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" />);
    expect(fixture.methods.mountPanel).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('external:a');
    await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="b" />);
    await render(<GuiPluginMount host={fixture.host} kind="settings" contributionKey="b" />);
    expect(fixture.log).toEqual(['mount:panel:a', 'dispose:panel:a', 'mount:panel:b', 'dispose:panel:b', 'mount:settings:b']);
    const next = makeHost();
    await render(<GuiPluginMount host={next.host} kind="settings" contributionKey="b" />);
    expect(fixture.log.at(-1)).toBe('dispose:settings:b');
    expect(next.log).toEqual(['mount:settings:b']);
    await render(null);
    expect(next.log.at(-1)).toBe('dispose:settings:b');
  });

  test('exposes mount errors without leaving partial foreign DOM', async () => {
    fixture.methods.mountPanel.mockImplementation((_key, node) => {
      node.textContent = 'partial';
      throw new Error('render failed');
    });
    await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" />);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('render failed');
    expect(container.textContent).not.toContain('partial');
  });

  test('locale changes do not recreate foreign content', async () => {
    const previous = state.t;
    try {
      await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" />);
      state.t = (key: string) => `translated:${key}`;
      await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" />);
      expect(fixture.log).toEqual(['mount:panel:a']);
      expect(container.textContent).toBe('external:a');
    } finally { state.t = previous; }
  });

  test('clears the container even when disposal fails', async () => {
    fixture.methods.mountPanel.mockImplementation((_key, node) => {
      node.textContent = 'foreign';
      return () => { throw new Error('dispose failed'); };
    });
    await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" />);
    const node = container.querySelector('[data-gui-plugin-mount]')!;
    await render(null);
    expect(node.childNodes.length).toBe(0);
    expect(state.toast).toHaveBeenCalledWith('dispose failed');
  });

  test('surface selects and closes tabs; hiding disposes and reopening mounts again', async () => {
    updateSnapshot({ panels: [{ key: 'a', pluginId: 'demo', title: 'Alpha', active: true }, { key: 'b', pluginId: 'demo', title: 'Beta', active: false }], activePanel: 'a' });
    await render(<GuiPluginSurface />);
    await click('Beta');
    expect(fixture.methods.selectPanel).toHaveBeenCalledWith('b');
    updateSnapshot({ activePanel: 'b' });
    await render(<GuiPluginSurface />);
    expect(fixture.log).toEqual(['mount:panel:a', 'dispose:panel:a', 'mount:panel:b']);
    await click('guiPlugins.closePanel:Beta');
    expect(fixture.methods.closePanel).toHaveBeenCalledWith('b');
    await click('dismiss-window');
    expect(fixture.methods.hidePanel).toHaveBeenCalledTimes(1);
    updateSnapshot({ activePanel: null });
    await render(<GuiPluginSurface />);
    expect(fixture.log.at(-1)).toBe('dispose:panel:b');
    updateSnapshot({ activePanel: 'b' });
    await render(<GuiPluginSurface />);
    expect(fixture.log.at(-1)).toBe('mount:panel:b');
  });

  test('settings contributions are disposed when removed or the host changes', async () => {
    updateSnapshot({ settings: [{ key: 'settings', pluginId: 'demo', title: 'Preferences' }] });
    await render(<GuiPluginsManager />);
    await click('guiPlugins.open');
    expect(fixture.log).toEqual(['mount:settings:settings']);
    const next = makeHost();
    state.context = { ...context(), host: next.host };
    await render(<GuiPluginsManager />);
    expect(fixture.log.at(-1)).toBe('dispose:settings:settings');
    expect(next.log).toEqual([]);
    await click('guiPlugins.open');
    updateSnapshot({ settings: [] });
    await render(<GuiPluginsManager />);
    expect(next.log).toEqual(['mount:settings:settings', 'dispose:settings:settings']);
    updateSnapshot({ settings: [{ key: 'settings', pluginId: 'demo', title: 'Preferences' }] });
    await render(<GuiPluginsManager />);
    expect(next.methods.mountSettings).toHaveBeenCalledTimes(1);
  });

  test('batched same-key plugin replacement remounts settings when its bundle revision changes', async () => {
    const plugin = { id: 'demo', status: 'active' as const, revision: 'one' };
    updateSnapshot({ plugins: [plugin], settings: [{ key: 'settings', pluginId: 'demo', title: 'Preferences' }] });
    await render(<GuiPluginsManager />);
    await click('guiPlugins.open');
    updateSnapshot({ plugins: [{ ...plugin, revision: 'two' }] as typeof plugin[] });
    await render(<GuiPluginsManager />);
    expect(fixture.log).toEqual(['mount:settings:settings', 'dispose:settings:settings', 'mount:settings:settings']);
  });

  test.each(['demo', 'demo:tools'])('settings uses exact owner %s even when contribution keys have ambiguous prefixes', async (pluginId) => {
    const plugin = { id: pluginId, revision: 'one', status: 'active' as const };
    const otherId = pluginId === 'demo' ? 'demo:tools' : 'demo';
    const key = 'demo:tools:settings';
    updateSnapshot({
      plugins: [plugin, { id: otherId, revision: 'one', status: 'active' }],
      settings: [{ key, pluginId, title: 'Preferences' }],
    });
    await render(<GuiPluginsManager />);
    await click('guiPlugins.open');
    const child = container.querySelector('[data-gui-plugin-mount]')!.firstChild;
    for (let index = 0; index < 50; index++) {
      updateSnapshot({ plugins: [plugin, { id: otherId, revision: String(index), status: 'active' }] });
      await render(<GuiPluginsManager />);
      expect(container.querySelector('[data-gui-plugin-mount]')!.firstChild).toBe(child);
    }
    expect(fixture.log).toEqual([`mount:settings:${key}`]);
    updateSnapshot({ plugins: [{ ...plugin, revision: 'two' }, context().snapshot.plugins[1]] });
    await render(<GuiPluginsManager />);
    expect(fixture.log).toEqual([`mount:settings:${key}`, `dispose:settings:${key}`, `mount:settings:${key}`]);
    expect(container.querySelector('[data-gui-plugin-mount]')!.firstChild).not.toBe(child);
    for (let index = 0; index < 50; index++) {
      updateSnapshot({ plugins: context().snapshot.plugins.map((item) => ({ ...item })) });
      await render(<GuiPluginsManager />);
    }
    expect(fixture.methods.mountSettings).toHaveBeenCalledTimes(2);
  });

  test('failed plugins stay visible through a toast after their panel disappears without duplicate alerts', async () => {
    updateSnapshot({ plugins: [{ id: 'demo', revision: 'one', status: 'failed', error: 'plugin crashed' }] });
    await render(<GuiPluginSurface />);
    for (let i = 0; i < 50; i++) {
      updateSnapshot({ plugins: [{ id: 'demo', revision: 'one', status: 'failed', error: 'plugin crashed' }] });
      await render(<GuiPluginSurface />);
    }
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith('demo: plugin crashed');
  });
});

describe('file link routing', () => {
  test('requests GUI code only for a visible active file and offers source during loading', async () => {
    state.context = { ...context(), host: null, requested: false, loading: true };
    updateSnapshot({ plugins: [] });
    const view = (active: boolean) => <GuiFileLinkBridge path="/remote/中文 页面.eficy" active={active}><pre>source</pre></GuiFileLinkBridge>;
    await render(view(false));
    expect(context().requestLoad).not.toHaveBeenCalled();
    await render(<div hidden>{view(true)}</div>);
    expect(context().requestLoad).not.toHaveBeenCalled();
    await render(view(true));
    expect(context().requestLoad).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('guiPlugins.preview.loadingTitleguiPlugins.preview.loadingDescription');
    expect(container.querySelector('[data-gui-preview-loading] svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-gui-preview-loading]')?.className).toContain('min-h-[240px]');
    expect(container.querySelector('pre')).toBeNull();
    state.context = { ...context(), requested: true };
    for (let index = 0; index < 50; index++) await render(view(true));
    expect(context().requestLoad).toHaveBeenCalledOnce();
    await click('guiPlugins.preview.viewSource');
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('source');
  });

  test('loading occupies the existing preview slot and source choice survives a ready panel', async () => {
    state.context = { ...context(), host: null, loading: true };
    updateSnapshot({ plugins: [] });
    const view = (path = '/workspace/a.preview') => <GuiFileLinkBridge path={path}>{({ preview, toggle }) => <>
      <header data-file-toolbar>{toggle}</header><main>{preview ?? <pre>source</pre>}</main>
    </>}</GuiFileLinkBridge>;
    await render(view());
    expect(container.querySelector('main [data-gui-preview-loading]')).not.toBeNull();
    expect(container.querySelector('header [data-gui-preview-loading]')).toBeNull();
    await click('filesView.editor.switchToEditMode');
    expect(container.querySelector('main pre')?.textContent).toBe('source');
    state.context = { ...context(), host: fixture.host };
    updateSnapshot({ plugins: [{ id: 'demo', revision: 'one', status: 'active' }], panels: [{ key: 'demo:a', pluginId: 'demo', title: 'Preview', inline: true, active: true, file: '/workspace/a.preview' }] });
    await render(view());
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    expect(container.querySelector('[data-gui-plugin-mount]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('source');
    await click('filesView.editor.switchToPreviewMode');
    expect(container.textContent).toContain('external:demo:a');
    updateSnapshot({ panels: [] });
    await render(view('/workspace/b.preview'));
    expect(container.querySelector('[data-gui-preview-loading]')).not.toBeNull();
  });

  test('unmatched files leave loading when discovery finishes and expose ordinary source without controls', async () => {
    fixture.methods.openLink.mockReturnValue(false);
    state.context = { ...context(), loading: true };
    const view = () => <GuiFileLinkBridge path="a.txt"><pre>source</pre></GuiFileLinkBridge>;
    await render(view());
    expect(container.querySelector('[data-gui-preview-loading]')).not.toBeNull();
    state.context = { ...context(), loading: false };
    await render(view());
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('source');
    expect(container.querySelector('button')).toBeNull();
  });

  test('a failed bundle exposes source and error instead of covering it with another pending bundle', async () => {
    state.context = { ...context(), loading: true, inventory: [{ id: 'demo', enabled: true, error: 'Download failed' }] };
    await render(<GuiFileLinkBridge path="a.txt"><pre>source</pre></GuiFileLinkBridge>);
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('source');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Download failed');
  });

  test('shows failed bundle loading with retry and restores an inline preview without a modal', async () => {
    state.context = { ...context(), host: null, inventory: [{ id: 'demo', enabled: true, error: 'Relay unavailable' }] };
    updateSnapshot({ plugins: [] });
    const view = () => <GuiFileLinkBridge path="/remote/a.eficy"><pre>source</pre></GuiFileLinkBridge>;
    await render(view());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Relay unavailable');
    await click('guiPlugins.refresh');
    expect(context().refresh).toHaveBeenCalledOnce();
    state.context = { ...context(), host: fixture.host, inventory: [{ id: 'demo', enabled: true }] };
    updateSnapshot({ plugins: [{ id: 'demo', revision: 'one', status: 'active' }], panels: [{ key: 'demo:a', pluginId: 'demo', title: 'Preview', inline: true, active: true, file: '/remote/a.eficy' }] });
    await render(view());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('external:demo:a');
    expect(container.querySelector('[data-window]')).toBeNull();
  });

  test('a ready file plugin renders while an unrelated bundle is still loading', async () => {
    state.context = { ...context(), loading: true };
    await render(<GuiFileLinkBridge path="/remote/a.eficy" />);
    expect(fixture.methods.openLink).toHaveBeenCalledOnce();
    updateSnapshot({ panels: [{ key: 'demo:a', pluginId: 'demo', title: 'Preview', inline: true, active: true, file: '/remote/a.eficy' }] });
    await render(<GuiFileLinkBridge path="/remote/a.eficy" />);
    expect(container.textContent).toContain('external:demo:a');
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    await click('filesView.editor.switchToEditMode');
    expect(container.querySelector('[data-gui-plugin-mount]')).toBeNull();
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    await click('filesView.editor.switchToPreviewMode');
    expect(container.textContent).toContain('external:demo:a');
  });

  test('renders a file panel inline, switches to source and back, and never opens a window', async () => {
    updateSnapshot({ panels: [{ key: 'demo:a', pluginId: 'demo', title: 'a.ydsl', active: true, file: '/workspace/a.ydsl', inline: true }], activePanel: 'demo:a' });
    const view = <><GuiFileLinkBridge path="/workspace/a.ydsl" base="/workspace">{({ preview, toggle }) => <><header data-file-toolbar>{toggle}</header><main>{preview ?? <pre>editable source</pre>}</main></>}</GuiFileLinkBridge><GuiPluginSurface /></>;
    await render(view);
    expect(fixture.methods.registerFileView).toHaveBeenCalledWith('/workspace/a.ydsl', '/workspace');
    expect(container.querySelector('[data-window]')).toBeNull();
    expect(container.querySelector('[data-gui-file-view]')?.textContent).toContain('external:demo:a');
    expect(container.textContent).not.toContain('editable source');
    expect(container.querySelectorAll('[data-file-toolbar] button')).toHaveLength(1);
    expect(container.querySelector('[data-file-toolbar] button')?.textContent).toBe('');
    expect(container.textContent).not.toContain('guiPlugins.preview');
    await click('filesView.editor.switchToEditMode');
    expect(container.textContent).toContain('editable source');
    expect(fixture.log.at(-1)).toBe('dispose:panel:demo:a');
    for (let index = 0; index < 50; index++) await render(view);
    expect(fixture.methods.mountPanel).toHaveBeenCalledTimes(1);
    expect(fixture.methods.registerFileView).toHaveBeenCalledTimes(1);
    await click('filesView.editor.switchToPreviewMode');
    expect(fixture.methods.mountPanel).toHaveBeenCalledTimes(2);
    updateSnapshot({ panels: [], activePanel: null, plugins: [] });
    await render(<GuiFileLinkBridge path="/workspace/a.ydsl"><pre>editable source</pre></GuiFileLinkBridge>);
    expect(container.textContent).toBe('editable source');
  });

  test('takes over after initial loading but ignores 50 unrelated panel snapshots', async () => {
    state.context = { ...context(), loading: true, host: null };
    await render(<GuiFileLinkBridge path="/workspace/a.md" base="/workspace" />);
    expect(fixture.methods.openLink).not.toHaveBeenCalled();
    state.context = { ...context(), loading: false, host: fixture.host };
    await render(<GuiFileLinkBridge path="/workspace/a.md" base="/workspace" />);
    expect(fixture.methods.openLink).toHaveBeenCalledWith({ href: '/workspace/a.md', base: '/workspace', exact: true });
    for (let i = 0; i < 50; i++) {
      updateSnapshot({ activePanel: i % 2 ? 'panel' : null });
      await render(<GuiFileLinkBridge path="/workspace/a.md" base="/workspace" />);
    }
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button')).toBeNull();
  });

  test('reacts to first plugin registration, path, base, and host identity', async () => {
    updateSnapshot({ plugins: [] });
    await render(<GuiFileLinkBridge path="a.md" base="/one" />);
    expect(fixture.methods.openLink).not.toHaveBeenCalled();
    updateSnapshot({ plugins: [{ id: 'demo', revision: 'one', status: 'active' }] });
    await render(<GuiFileLinkBridge path="a.md" base="/one" />);
    await render(<GuiFileLinkBridge path="b.md" base="/one" />);
    await render(<GuiFileLinkBridge path="b.md" base="/two" />);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(3);
    const next = makeHost();
    state.context = { ...context(), host: next.host };
    await render(<GuiFileLinkBridge path="b.md" base="/two" />);
    expect(next.methods.openLink).toHaveBeenCalledTimes(1);
  });

  test('same-host bundle revision changes retry matching without a transient loading render', async () => {
    const plugin = { id: 'demo', status: 'active' as const, revision: 'one' };
    updateSnapshot({ plugins: [plugin] });
    await render(<GuiFileLinkBridge path="a.md" />);
    updateSnapshot({ plugins: [{ ...plugin, revision: 'two' }] as typeof plugin[] });
    await render(<GuiFileLinkBridge path="a.md" />);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(2);
  });

  test('inactive and inert file views never take focus; reactivation opens the file', async () => {
    await render(<GuiFileLinkBridge path="a.md" active={false} />);
    expect(fixture.methods.openLink).not.toHaveBeenCalled();
    await render(<div inert><GuiFileLinkBridge path="a.md" /></div>);
    expect(fixture.methods.openLink).not.toHaveBeenCalled();
    await render(<GuiFileLinkBridge path="a.md" />);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(1);
    await render(<GuiFileLinkBridge path="a.md" active={false} />);
    await render(<GuiFileLinkBridge path="a.md" />);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(2);
  });

  test('strict effects do not open the same file twice, while close/reopen does', async () => {
    await render(<React.StrictMode><GuiFileLinkBridge path="a.md" /></React.StrictMode>);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(1);
    await render(null);
    await render(<GuiFileLinkBridge path="a.md" />);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(2);
  });

  test('a loading cycle retries once and failed matching preserves source fallback', async () => {
    fixture.methods.openLink.mockReturnValue(false);
    const view = <><GuiFileLinkBridge path="a.txt" /><pre>source fallback</pre></>;
    await render(view);
    expect(container.textContent).toContain('source fallback');
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('source fallback');
    state.context = { ...context(), loading: true };
    await render(<><GuiFileLinkBridge path="a.txt" /><pre>source fallback</pre></>);
    state.context = { ...context(), loading: false };
    await render(<><GuiFileLinkBridge path="a.txt" /><pre>source fallback</pre></>);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(2);
  });

  test('handler errors are visible and manual retry remains available', async () => {
    fixture.methods.openLink.mockImplementation(() => { throw new Error('link failed'); });
    await render(<GuiFileLinkBridge path="a.md" />);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('link failed');
    fixture.methods.openLink.mockReturnValue(true);
    await click('filesView.editor.switchToPreviewMode');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

test('palette filters commands, closes before running, and exposes rejected actions', async () => {
  updateSnapshot({ commands: [{ key: 'diagram', title: 'Diagram', run: () => {} }, { key: 'chart', title: 'Chart', run: () => {} }] });
  const close = vi.fn();
  fixture.methods.runCommand.mockImplementation(() => {
    expect(close).toHaveBeenCalledTimes(1);
    return Promise.reject(new Error('command failed'));
  });
  await render(<GuiPluginCommands query="Diagram" onSelect={close} />);
  expect(container.textContent).not.toContain('Chart');
  await click('Diagram');
  expect(fixture.methods.runCommand).toHaveBeenCalledWith('diagram');
  expect(state.toast).toHaveBeenCalledWith('command failed');
});

test.each(['manager', 'commands'])('%s requests deferred plugins on entry and retries after runtime scope resets', async (entry) => {
  state.context = { ...context(), host: null, requested: false, loading: true };
  updateSnapshot({ plugins: [] });
  const view = () => entry === 'manager' ? <GuiPluginsManager /> : <GuiPluginCommands query="" onSelect={() => {}} />;
  await render(view());
  expect(context().requestLoad).toHaveBeenCalledOnce();
  state.context = { ...context(), requested: true };
  for (let index = 0; index < 50; index++) await render(view());
  expect(context().requestLoad).toHaveBeenCalledOnce();
  state.context = { ...context(), requested: false };
  await render(view());
  expect(context().requestLoad).toHaveBeenCalledTimes(2);
});
