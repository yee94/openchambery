import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FilesAPI } from '@/lib/api/types';
import { GuiPluginsProvider } from '@/lib/gui-plugins/GuiPluginsProvider';
import { useGuiPlugins } from '@/lib/gui-plugins/react';
import { GuiFileLinkBridge } from './GuiFileLinkBridge';
import { MarkdownRenderer } from '@/components/chat/MarkdownRendererImpl';
import { GuiPluginHost } from '@/lib/gui-plugins/host';

const state = vi.hoisted(() => ({ list: vi.fn(), gui: vi.fn(), files: null as FilesAPI | null,
  session: { id: 'perf-session', directory: '/workspace' } }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => 'perf-runtime', getRuntimeKey: () => 'perf-runtime', getRuntimeGeneration: () => 0 }));
vi.mock('@/lib/instanceScopedStorage', () => ({ instanceScopedStorageKey: (key: string, runtime: string) => `${runtime}:${key}` }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ files: state.files, runtime: { isVSCode: false } }) }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/workspace' }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (value: { currentSessionId: string }) => unknown) => select({ currentSessionId: state.session.id }) }));
vi.mock('@/sync/sync-context', () => ({ useCurrentSessionEntity: () => state.session }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (value: { isMobile: boolean }) => unknown) => select({ isMobile: false }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
vi.mock('@/components/chat/fileReferenceActions', () => ({ openFileReference: vi.fn(async () => {}), getFileReferenceLinkLimit: () => 100 }));
vi.mock('@/lib/opencode/gui', () => ({ createGuiClient: () => ({ plugin: { list: state.list, gui: state.gui } }) }));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./GuiPluginSurface', () => ({ GuiPluginSurface: () => null }));
vi.mock('./GuiPluginLoadingNotice', () => ({ GuiPluginLoadingNotice: () => null }));

const bundle = { revision: 'perf-one', options: {}, code: `
 const G = require('@opencode/plugin/gui'); const S = require('solid-js');
 const c = globalThis.__guiPerf; c.evaluate++;
 module.exports.default = G.Plugin.define({ setup(ctx) {
   c.setup++;
   ctx.add(G.LinkHandler, { match(link) { c.match++; return link.href.endsWith('.eficy'); },
     open(link) { c.open++; ctx.layout.open('perf:' + link.href, link.session); } });
   ctx.add(G.Panel, { id: 'files', region: 'side',
     list({open}) { c.list++; return open.map(id => ({id, title:id, file:id})); },
     render(props) { c.render++; S.onCleanup(() => c.dispose++);
       const node = document.createElement('pre'); node.dataset.perfPreview = '';
       S.createRenderEffect(() => { c.fileEffect++; node.textContent = props.screen.file.get(props.tab.file)?.content?.content ?? ''; });
       return node;
     }
   });
   return () => c.setupDispose++;
 } });` };
const plugin = { id: 'perf', features: { gui: true }, source: { type: 'package', target: 'perf' }, state: { status: 'active' } };
let root: Root, container: HTMLDivElement, client: QueryClient;
let context: ReturnType<typeof useGuiPlugins>;
let counters: Record<string, number>;
let idle: IdleRequestCallback | undefined;
let source = 'initial';
function Fixture({ delta = 0, links = 0, files = 0, content }: { delta?: number; links?: number; files?: number; content?: string }) {
  context = useGuiPlugins();
  return <><MarkdownRenderer content={content ?? `${Array.from({length: links}, (_, n) => `[file${n}](/workspace/${n}.eficy)`).join(' ')} token${delta}`}
    messageId="perf" isStreaming disableStreamAnimation isAnimated={false} />
    {Array.from({length: files}, (_, n) => <GuiFileLinkBridge key={n} path={`/workspace/${n}.eficy`} base="/workspace" />)}</>;
}
const draw = async (props: React.ComponentProps<typeof Fixture> = {}) => {
  await act(async () => root.render(<QueryClientProvider client={client}><GuiPluginsProvider><Fixture {...props} /></GuiPluginsProvider></QueryClientProvider>));
};
async function until(check: () => void) {
  const deadline = Date.now() + 5000;
  while (true) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    try { check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
  }
}
const snapshot = () => ({...counters, reads: vi.mocked(state.files!.readFile!).mock.calls.length, stats: vi.mocked(state.files!.statFile!).mock.calls.length, downloads: state.gui.mock.calls.length});
const difference = (before: Record<string, number>) => Object.fromEntries(Object.entries(snapshot()).map(([k,v]) => [k, v - before[k]]));
const report = (name: string, before: Record<string, number>) => console.log('GUI_PERF', JSON.stringify({name, ...difference(before)}));
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear();
  counters = {evaluate:0,setup:0,match:0,open:0,list:0,render:0,dispose:0,fileEffect:0,setupDispose:0,notify:0,publish:0,filePanel:0};
  const prototype = GuiPluginHost.prototype as unknown as {publish():void};
  const publish = prototype.publish;
  vi.spyOn(prototype, 'publish').mockImplementation(function(this: GuiPluginHost) { counters.publish++; publish.call(this); });
  Object.assign(globalThis, {__guiPerf:counters}); source = 'initial'; idle = undefined;
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => { idle = callback; return 1; });
  vi.stubGlobal('cancelIdleCallback', () => {});
  state.list.mockReset().mockResolvedValue({data:[plugin]}); state.gui.mockReset().mockResolvedValue({data:bundle});
  state.files = {readFile: vi.fn(async path => ({path,content:source})), statFile: vi.fn(async path => ({path,isFile:true,size:7,mtimeMs:1})), listDirectory: vi.fn(), search:vi.fn(), createDirectory:vi.fn()};
  client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function preload() {
  await draw(); await until(() => expect(idle).toBeDefined());
  const waiting=snapshot();
  for(let delta=0;delta<100;delta++) await draw({delta});
  report('before-idle-stream-100',waiting);
  expect(difference(waiting).downloads).toBe(0); expect(counters.setup).toBe(0);
  const before = snapshot();
  await act(async () => idle!({didTimeout:false,timeRemaining:()=>50}));
  await until(() => { expect(context.snapshot.plugins[0]?.status).toBe('active'); expect(context.loading).toBe(false); });
  context.host!.subscribe(() => counters.notify++);
  const original = context.host!.filePanel.bind(context.host);
  vi.spyOn(context.host!, 'filePanel').mockImplementation((...args) => { counters.filePanel++; return original(...args); });
  report('cold-idle-preload', before);
  expect(difference(before)).toMatchObject({evaluate:1,setup:1,downloads:1,render:0,reads:0});
}

it('measures real Provider/Host/Markdown/Bridge operation counts', async () => {
  await preload();
  for (const links of [0,1,10,50]) for (const deltas of [100,1000]) {
    const before = snapshot();
    for (let delta=0; delta<deltas; delta++) await draw({links,delta});
    report(`stream-${deltas}-links-${links}`, before);
    expect(difference(before).match).toBe(0); expect(difference(before).setup).toBe(0);
  }
  const text='[preview](/workspace/逐字.eficy)'; const beforeChars=snapshot();
  for (let n=1;n<=text.length;n++) await draw({content:text.slice(0,n)});
  await until(() => expect(container.querySelector('a[href="/workspace/逐字.eficy"]')).not.toBeNull());
  report('character-path',beforeChars); expect(difference(beforeChars).match).toBe(0);
  const same = snapshot();
  for (let n=0;n<1000;n++) { context.requestLoad(); context.host!.setAppearance({locale:'en',mode:'dark',narrow:false}); context.host!.setSession({...state.session}); context.host!.install('perf',bundle); }
  report('warm-request-appearance-session-install-1000',same);
  expect(difference(same).setup).toBe(0); expect(difference(same).notify).toBe(0);
  for (const files of [1,10]) {
    const open=snapshot(); await draw({files});
    await until(() => expect(container.querySelectorAll('[data-perf-preview]')).toHaveLength(files));
    await until(() => expect(container.querySelector('[data-perf-preview]')?.textContent).toBe(source));
    report(`open-files-${files}`,open);
    expect(difference(open).match).toBe(files);
    expect(difference(open).render).toBe(files);
    // Opening includes both presentation-lease and panel-layout transitions; cap their combined fanout.
    expect(difference(open).notify).toBeLessThanOrEqual(3 * files);
    for (const deltas of [100,1000]) { const before=snapshot(); for(let delta=0;delta<deltas;delta++) await draw({files,delta,links:10}); report(`open-${files}-stream-${deltas}`,before); expect(difference(before).match).toBe(0); expect(difference(before).render).toBe(0); }
    const close=snapshot(); await draw(); report(`close-files-${files}`,close);
    expect(difference(close).fileEffect).toBe(0);
    expect(difference(close).notify).toBeLessThanOrEqual(files);
    expect(difference(close).dispose).toBe(files);
  }
  const reopen=snapshot(); await draw({files:1}); await until(() => expect(container.querySelector('[data-perf-preview]')).not.toBeNull()); report('warm-reopen',reopen);
  const key=client.getQueryCache().getAll().find(query=>JSON.stringify(query.queryKey).includes('stat') && JSON.stringify(query.queryKey).includes('/workspace/0.eficy'))!.queryKey;
  const identical=snapshot();
  for(let n=0;n<100;n++) await act(async () => { client.setQueryData(key,{...client.getQueryData<Record<string,unknown>>(key)!}); });
  report('watch-identical-stat-100',identical);
  expect(difference(identical).reads).toBe(0);
  for (const changed of [false,true]) {
    const before=snapshot(); if(changed) source='changed';
    await act(async () => { const data=client.getQueryData<Record<string,unknown>>(key)!; client.setQueryData(key,{...data,mtimeMs:changed?3:2}); });
    await until(() => expect(difference(before).reads).toBe(1));
    await act(async () => { await new Promise(resolve=>setTimeout(resolve,20)); });
    report(`watch-stat-change-content-${changed}`,before);
    expect(difference(before).notify).toBe(0); expect(difference(before).render).toBe(0);
    expect(difference(before).fileEffect).toBe(changed ? 1 : 0);
  }
  const cycles=snapshot();
  for(let n=0;n<10;n++) { await draw(); await draw({files:1}); await until(() => expect(container.querySelector('[data-perf-preview]')).not.toBeNull()); }
  report('warm-close-reopen-10',cycles);
  expect(difference(cycles).setup).toBe(0); expect(difference(cycles).render).toBe(10); expect(difference(cycles).dispose).toBe(10);
  expect(difference(cycles).fileEffect).toBe(10);
  expect(difference(cycles).notify).toBeLessThanOrEqual(40);
}, 120_000);
