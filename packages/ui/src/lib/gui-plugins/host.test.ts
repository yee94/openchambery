import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import type { FilesAPI } from '@/lib/api/types';
import { GuiPluginHost, type PluginGuiBundle } from './host';

const hosts: GuiPluginHost[] = [];
function host(focusFile?: (path: string, directory: string) => Promise<void>) {
    const files: FilesAPI = { listDirectory: vi.fn(async () => ({ directory: '/work', entries: [] })), search: vi.fn(async () => []), createDirectory: vi.fn(), readFile: vi.fn(async (path) => ({ path, content: path })) };
    const rpc = vi.fn();
    const result = new GuiPluginHost({ client: { rpc } as unknown as OpenCodeClient, files, queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }), storage: localStorage, transport: 'test-runtime', locale: 'en', mode: 'dark', narrow: false, focusFile });
    hosts.push(result);
    return result;
}
const bundle = (setup: string, revision = '1', declarations = ''): PluginGuiBundle => ({ code: `const G = require('@opencode/plugin/gui'); const S = require('solid-js'); module.exports.default = G.Plugin.define({ ${declarations} setup(ctx) { ${setup} } });`, revision, options: {} });
afterEach(() => { for (const item of hosts.splice(0)) item.dispose(); localStorage.clear(); document.body.replaceChildren(); });

describe('GUI plugin host with the actual official Solid SDK', () => {
    it('keeps mounted tab consumers quiet across unrelated derivations without freezing changed fields or accessors', () => {
        const value = host();
        value.setSession({ id: 'one', directory: '/work' });
        const counts = { plain: 0, accessor: 0, mutable: 0 };
        Reflect.set(globalThis, '__guiTabCounts', counts);
        try {
            value.install('tabs', bundle(`
                const [title, setTitle] = S.createSignal('before');
                const mutable = {id:'mutable', title:'before'};
                ctx.add(G.Command, {id:'rename', title:'Rename', run(){setTitle('after')}});
                ctx.add(G.Panel, {id:'p', region:'side', list(){
                    const captured = title();
                    mutable.title = captured;
                    return [{id:'plain', title:captured}, {id:'accessor', get title(){return captured}}, mutable];
                }, render(props){
                    const node = document.createElement('span');
                    S.createRenderEffect(() => {globalThis.__guiTabCounts[props.tab.id]++; node.textContent = props.tab.title});
                    return node;
                }});
            `));
            const plain = document.createElement('div'), accessor = document.createElement('div'), mutable = document.createElement('div');
            const stopPlain = value.mountPanel('tabs:plain', plain), stopAccessor = value.mountPanel('tabs:accessor', accessor);
            const stopMutable = value.mountPanel('tabs:mutable', mutable);
            const original = plain.firstChild;
            for (let n = 0; n < 50; n++) value.install('unrelated', bundle('', String(n)));
            expect(counts.plain).toBe(1);
            expect(counts.mutable).toBe(1);
            expect(plain.firstChild).toBe(original);
            value.runCommand('tabs.rename');
            expect(counts.plain).toBe(2);
            expect(plain.textContent).toBe('after');
            expect(accessor.textContent).toBe('after');
            expect(mutable.textContent).toBe('after');
            expect(counts.mutable).toBe(2);
            expect(plain.firstChild).toBe(original);
            stopPlain(); stopAccessor(); stopMutable();
            const stopped = { ...counts };
            value.setAppearance({locale:'en',mode:'light',narrow:false});
            value.uninstall('tabs');
            expect(counts).toEqual(stopped);
        } finally { Reflect.deleteProperty(globalThis, '__guiTabCounts'); }
    });

    it('publishes synchronous empty and failed session snapshots and ignores released or late actions', async () => {
        const value = host();
        const snapshots: ReturnType<GuiPluginHost['getSnapshot']>[] = [];
        value.subscribe(() => snapshots.push(value.getSnapshot()));
        value.setSession({id:'empty',directory:'/work'});
        expect(snapshots.at(-1)?.sessionKey).toBe('test-runtime\nempty');
        value.install('failure', bundle(`throw new Error('setup failed')`));
        expect(value.getSnapshot().plugins[0].status).toBe('failed');
        value.setSession({id:'failed',directory:'/work'});
        expect(snapshots.at(-1)?.sessionKey).toBe('test-runtime\nfailed');
        value.uninstall('failure');
        expect(snapshots.at(-1)?.plugins).toEqual([]);
        value.install('late', bundle(`
            globalThis.__guiLateAction = () => ctx.layout.open('late:tab', ctx.sessions.current());
            ctx.add(G.Command, {id:'fail',title:'Fail',async run(){await Promise.resolve(); throw new Error('late failure')}});
        `));
        const pending = value.runCommand('late.fail');
        value.uninstall('late');
        const empty = value.getSnapshot();
        (Reflect.get(globalThis, '__guiLateAction') as () => void)();
        await pending;
        expect(value.getSnapshot()).toBe(empty);
        value.setSession(undefined);
        expect(snapshots.at(-1)?.sessionKey).toBeUndefined();
        const ended = snapshots.length;
        value.dispose();
        value.setSession({id:'ignored',directory:'/work'});
        expect(snapshots).toHaveLength(ended);
        Reflect.deleteProperty(globalThis, '__guiLateAction');
    });

    it('owns custom file icon registration through reload, failure, disable and disposal', () => {
        const value = host();
        const icon = (color: string) => `ctx.add(G.Registry.define('yuri.file-icon'),{id:'icon',extensions:['eficy'],svg:'<svg xmlns="http://www.w3.org/2000/svg"><path fill="${color}" d="M0 0h16v16z"/></svg>'});`;
        value.install('first', bundle(icon('red')));
        const original = value.fileIcons.get('card.eficy');
        expect(original).toContain('data:image/svg+xml,');
        value.install('second', bundle(icon('blue')));
        expect(value.fileIcons.get('card.eficy')).not.toBe(original);
        value.uninstall('second');
        expect(value.fileIcons.get('card.eficy')).toBe(original);
        value.install('first', bundle(icon('green'), '2'));
        expect(decodeURIComponent(value.fileIcons.get('card.eficy')!)).toContain('green');
        value.install('first', bundle(icon('blue') + `ctx.add(G.Command,{id:'fail',title:'Fail',run(){throw new Error('broken')}});`, '3'));
        value.runCommand('first.fail');
        expect(value.fileIcons.get('card.eficy')).toBeUndefined();
        expect(value.getSnapshot().plugins[0].status).toBe('failed');
        value.install('first', bundle(icon('red'), '3'));
        expect(value.fileIcons.get('card.eficy')).toBe(original);
        value.uninstall('first');
        expect(value.fileIcons.get('card.eficy')).toBeUndefined();
        value.install('first', bundle(icon('red')));
        value.dispose();
        expect(value.fileIcons.get('card.eficy')).toBeUndefined();
    });

    it('keeps file previews active when optional icon validation fails', () => {
        const value = host();
        value.install('valid', bundle(`ctx.add(G.Registry.define('yuri.file-icon'),{id:'icon',extensions:['eficy'],svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'});`));
        const current = value.fileIcons.get('a.eficy');
        value.setSession({ id: 'one', directory: '/work' });
        value.install('invalid', bundle(`
            ctx.add(G.Registry.define('yuri.file-icon'),{id:'icon',extensions:['eficy'],svg:'https://example.com/icon.svg'});
            ctx.add(G.LinkHandler,{match:link=>link.href.endsWith('.eficy'),open:link=>ctx.layout.open('invalid:'+link.href,link.session)});
            ctx.add(G.Panel,{id:'files',region:'side',list:({open})=>open.map(id=>({id,title:id,file:id})),render:()=>null});
        `));
        expect(value.getSnapshot().plugins.find((plugin) => plugin.id === 'invalid')?.status).toBe('active');
        expect(value.getSnapshot().plugins.find((plugin) => plugin.id === 'invalid')?.error).toBeTruthy();
        expect(value.fileIcons.get('a.eficy')).toBe(current);
        value.registerFileView('/work/report.eficy');
        expect(value.openLink({ href: '/work/report.eficy' })).toBe(true);
        expect(value.filePanel('/work/report.eficy')?.pluginId).toBe('invalid');
    });

    it('does zero icon parsing, encoding or notification for unrelated session/layout updates', () => {
        const value = host(), counts = { reads: 0 };
        Reflect.set(globalThis, '__guiIconCounts', counts);
        value.install('icons', bundle(`
            ctx.add(G.Registry.define('yuri.file-icon'),()=>{ globalThis.__guiIconCounts.reads++; return {id:'icon',extensions:['eficy'],svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'} });
            ctx.add(G.Panel,{id:'p',region:'side',list:({open})=>open.map(id=>({id,title:id})),render:()=>null});
        `));
        const notify = vi.fn(), reads = counts.reads;
        value.fileIcons.subscribe(notify);
        const encode = vi.spyOn(globalThis, 'encodeURIComponent');
        const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
        try {
            for (let i = 0; i < 50; i++) {
                value.setSession({ id: `s${i}`, directory: '/work' });
                value.selectPanel('icons:tab'); value.hidePanel(); value.closePanel('icons:tab');
                value.setAppearance({ locale: 'en', mode: i % 2 ? 'light' : 'dark', narrow: false });
                value.install('unrelated', bundle('', String(i)));
            }
            expect(counts.reads).toBe(reads);
            expect(notify).not.toHaveBeenCalled();
            expect(encode).not.toHaveBeenCalled();
            expect(parse).not.toHaveBeenCalled();
        } finally { encode.mockRestore(); parse.mockRestore(); Reflect.deleteProperty(globalThis, '__guiIconCounts'); }
    });

    it('retracts stale icons on invalid reactive replacement without disabling commands', () => {
        const value = host();
        value.install('icons', bundle(`
            const [invalid,setInvalid]=S.createSignal(false);
            ctx.add(G.Registry.define('yuri.file-icon'),()=>({id:'icon',extensions:['eficy'],svg:invalid()?'invalid':'<svg xmlns="http://www.w3.org/2000/svg"/>'}));
            ctx.add(G.Command,{id:'toggle',title:'Toggle',run(){setInvalid(v=>!v)}});
        `));
        expect(value.fileIcons.get('a.eficy')).toBeDefined();
        value.runCommand('icons.toggle');
        expect(value.fileIcons.get('a.eficy')).toBeUndefined();
        expect(value.getSnapshot().plugins[0]).toMatchObject({ status: 'active', error: expect.any(String) });
        expect(value.getSnapshot().commands).toHaveLength(1);
        value.runCommand('icons.toggle');
        expect(value.fileIcons.get('a.eficy')).toBeDefined();
        expect(value.getSnapshot().plugins[0].error).toBeUndefined();
    });

    it('isolates throwing icon accessors during setup and reactive updates, then clears their recovered diagnostic', () => {
        const value = host();
        value.install('icons', bundle(`
            const [broken,setBroken]=S.createSignal(true);
            ctx.add(G.Registry.define('yuri.file-icon'),()=>{
                if(broken()) throw new Error('icon accessor failed');
                return {id:'icon',extensions:['eficy'],svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'};
            });
            ctx.add(G.Command,{id:'toggle',title:'Toggle',run(){setBroken(v=>!v)}});
        `));
        expect(value.getSnapshot().plugins[0]).toMatchObject({ status: 'active', error: 'icon accessor failed' });
        expect(value.getSnapshot().commands).toHaveLength(1);
        expect(value.fileIcons.get('a.eficy')).toBeUndefined();
        value.runCommand('icons.toggle');
        expect(value.getSnapshot().plugins[0].error).toBeUndefined();
        expect(value.fileIcons.get('a.eficy')).toBeDefined();
        value.runCommand('icons.toggle');
        expect(value.getSnapshot().plugins[0]).toMatchObject({ status: 'active', error: 'icon accessor failed' });
        expect(value.fileIcons.get('a.eficy')).toBeUndefined();
    });

    it('preserves non-icon diagnostics when an icon recovers and still fails non-icon setup accessors', () => {
        const value = host();
        value.install('icons', bundle(`
            const [broken,setBroken]=S.createSignal(true);
            const stop=ctx.add(G.Style,()=>{ S.onCleanup(()=>{throw new Error('style cleanup failed')}); return ''; });
            ctx.add(G.Registry.define('yuri.file-icon'),()=>({id:'icon',extensions:['eficy'],svg:broken()?'invalid':'<svg xmlns="http://www.w3.org/2000/svg"/>'}));
            ctx.add(G.Command,{id:'recover',title:'Recover',run(){stop();setBroken(false)}});
        `));
        value.runCommand('icons.recover');
        expect(value.fileIcons.get('a.eficy')).toBeDefined();
        expect(value.getSnapshot().plugins[0]).toMatchObject({ status: 'active', error: expect.stringContaining('style cleanup failed') });
        value.install('broken', bundle(`ctx.add(G.Command,()=>{throw new Error('command accessor failed')});`));
        expect(value.getSnapshot().plugins.find((plugin) => plugin.id === 'broken')).toMatchObject({ status: 'failed', error: 'command accessor failed' });
    });

    it('updates reactive icons and retracts manually released contributions', () => {
        const value = host();
        value.install('icons', bundle(`
            const [enabled,setEnabled]=S.createSignal(true);
            const stop=ctx.add(G.Registry.define('yuri.file-icon'),()=>enabled()?{id:'icon',extensions:['eficy'],svg:'<svg xmlns="http://www.w3.org/2000/svg"/>'}:undefined);
            ctx.add(G.Command,{id:'toggle',title:'Toggle',run(){setEnabled(v=>!v)}});
            ctx.add(G.Command,{id:'remove',title:'Remove',run:stop});
        `));
        expect(value.fileIcons.get('a.eficy')).toBeDefined();
        value.runCommand('icons.toggle');
        expect(value.fileIcons.get('a.eficy')).toBeUndefined();
        value.runCommand('icons.toggle');
        expect(value.fileIcons.get('a.eficy')).toBeDefined();
        value.runCommand('icons.remove');
        expect(value.fileIcons.get('a.eficy')).toBeUndefined();
    });

    it('navigates official local links before dispatching a file handler, without recursive navigation', async () => {
        const focusFile = vi.fn(async () => {});
        const value = host(focusFile);
        value.setSession({ id: 'one', directory: '/work' });
        value.install('files', bundle(`
            globalThis.__openGuiLink = ctx.links.open;
            ctx.add(G.LinkHandler,{match:link=>link.href.endsWith('.ydsl'),open:link=>ctx.layout.open('files:'+link.href,link.session)});
            ctx.add(G.Panel,{id:'files',region:'side',list:({open})=>open.map(id=>({id,title:id,file:id})),render:()=>null});
        `));
        const open = Reflect.get(globalThis, '__openGuiLink') as (link: { href: string; base?: string }) => Promise<boolean> | boolean;
        try {
            expect(open({ href: '../中文 report.ydsl', base: '/work/nested' })).toBe(true);
            expect(focusFile).toHaveBeenLastCalledWith('/work/中文 report.ydsl', '/work');
            expect(value.getSnapshot().activePanel).toBeNull();
            value.registerFileView('/work/中文 report.ydsl');
            value.openLink({ href: '/work/中文 report.ydsl' });
            expect(focusFile).toHaveBeenCalledTimes(1);
            expect(value.filePanel('/work/中文 report.ydsl')).toMatchObject({ inline: true });
            for (const href of ['https://example.com/a.eficy', 'mailto:a.eficy', 'javascript:alert(1)']) expect(await open({ href })).toBe(false);
            expect(focusFile).toHaveBeenCalledTimes(1);
            await open({ href: 'file:///C:/demo/%E4%B8%AD%E6%96%87%20report.eficy' });
            expect(focusFile).toHaveBeenLastCalledWith('C:/demo/中文 report.eficy', '/work');
            value.dispose();
            expect(await open({ href: '/work/stale.eficy' })).toBe(false);
        } finally { Reflect.deleteProperty(globalThis, '__openGuiLink'); }
    });

    it('publishes exact contribution owners instead of requiring key prefix inference', () => {
        const value = host();
        value.setSession({ id: 'one', directory: '/work' });
        for (const id of ['demo', 'demo:tools']) value.install(id, bundle(`
            ctx.add(G.Panel,{id:'p',region:'side',list:()=>[{id:'tab',title:'Tab'}],render:()=>null});
            ctx.add(G.SettingsPage,{id:'settings',title:'Settings',render:()=>null});
        `));
        expect(value.getSnapshot().panels.map(({ key, pluginId }) => ({ key, pluginId }))).toEqual([
            { key: 'demo:tab', pluginId: 'demo' }, { key: 'demo:tools:tab', pluginId: 'demo:tools' },
        ]);
        expect(value.getSnapshot().settings.map(({ key, pluginId }) => ({ key, pluginId }))).toEqual([
            { key: 'demo:settings', pluginId: 'demo' }, { key: 'demo:tools:settings', pluginId: 'demo:tools' },
        ]);
    });

    it('does no derivation or publication for repeated layout states and intermediate file leases', () => {
        const value = host();
        value.setSession({ id: 'one', directory: '/work' });
        const counts = { list: 0, focus: 0, close: 0 };
        Reflect.set(globalThis, '__guiOperationCounts', counts);
        value.install('view', bundle(`
            ctx.add(G.Panel,{id:'p',region:'side',list:({open})=>{
                globalThis.__guiOperationCounts.list++;
                return open.map(id=>({id,title:id,file:id}));
            },render:()=>null,focus(){globalThis.__guiOperationCounts.focus++},close(){globalThis.__guiOperationCounts.close++}});
        `));
        value.selectPanel('view:a.ydsl');
        const notify = vi.fn();
        value.subscribe(notify);
        const snapshot = value.getSnapshot(), lists = counts.list;
        for (let index = 0; index < 50; index++) value.selectPanel('view:a.ydsl');
        expect(counts.list).toBe(lists);
        expect(counts.focus).toBe(51); // Explicit opening still requests focus.
        expect(notify).not.toHaveBeenCalled();
        expect(value.getSnapshot()).toBe(snapshot);
        value.hidePanel();
        notify.mockClear();
        const hiddenLists = counts.list;
        for (let index = 0; index < 50; index++) value.hidePanel();
        expect(counts.list).toBe(hiddenLists);
        expect(notify).not.toHaveBeenCalled();
        const release = value.registerFileView('/work/a.ydsl');
        notify.mockClear();
        const leaseLists = counts.list;
        for (let index = 0; index < 50; index++) value.registerFileView('/work/a.ydsl')();
        expect(counts.list).toBe(leaseLists);
        expect(notify).not.toHaveBeenCalled();
        expect(value.filePanel('/work/a.ydsl')).toBeDefined();
        release();
        expect(value.filePanel('/work/a.ydsl')).toBeUndefined();
        value.closePanel('view:a.ydsl');
        notify.mockClear();
        const closedLists = counts.list;
        for (let index = 0; index < 50; index++) value.closePanel('view:a.ydsl');
        expect(counts.close).toBe(1);
        expect(counts.list).toBe(closedLists);
        expect(notify).not.toHaveBeenCalled();
        Reflect.deleteProperty(globalThis, '__guiOperationCounts');
    });

    it('assigns file previews to the existing file view and releases it without opening a modal', () => {
        const value = host();
        value.setSession({ id: 'one', directory: '/work' });
        value.install('files', bundle(`
            ctx.add(G.LinkHandler,{match:link=>link.href.endsWith('.ydsl'),open:link=>ctx.layout.open('files:a.ydsl',link.session)});
            ctx.add(G.Panel,{id:'files',region:'side',list:({open})=>open.map(id=>({id,title:id,file:id})),render:()=>null});
        `));
        const release = value.registerFileView('/work/a.ydsl');
        value.openLink({ href: '/work/a.ydsl' });
        expect(value.filePanel('a.ydsl', '/work')).toMatchObject({ key: 'files:a.ydsl', file: '/work/a.ydsl', inline: true });
        const second = value.registerFileView('a.ydsl', '/work');
        release();
        expect(value.filePanel('/work/a.ydsl')).toBeDefined();
        second();
        expect(value.getSnapshot().activePanel).toBeNull();
        expect(value.filePanel('/work/a.ydsl')).toBeUndefined();
        value.selectPanel('files:a.ydsl');
        expect(value.getSnapshot().activePanel).toBe('files:a.ydsl');
        value.setSession({ id: 'two', directory: '/other' });
        expect(value.filePanel('/work/a.ydsl')).toBeUndefined();
    });
    it('keeps hidden commands callable and explicitly rejects unsupported file viewers', () => {
        const value = host();
        value.install('commands', bundle(`
            ctx.add(G.Command,{id:'hidden',title:'Hidden',hidden:true,run(){globalThis.__guiHiddenRan=true}});
            ctx.add(G.Command,{id:'invoke',title:'Invoke',run(){ctx.commands.run('commands.hidden')}});
        `));
        expect(value.getSnapshot().commands.map((command) => command.key)).toEqual(['commands.invoke']);
        value.runCommand('commands.invoke');
        expect(Reflect.get(globalThis, '__guiHiddenRan')).toBe(true);
        value.install('viewer', bundle(`ctx.add(require('@opencode/plugin/gui/file').FileViewer,{kinds:['document'],View(){return null}});`));
        expect(value.getSnapshot().plugins.find((plugin) => plugin.id === 'viewer')).toMatchObject({ status: 'failed', errorCode: 'GUI_PLUGIN_UNSUPPORTED', error: expect.stringContaining('registry.file.viewer') });
    });
    it('isolates failure, cleans styles and setup, and skips same-revision setup', () => {
        const value = host();
        value.install('good', bundle(`ctx.add(G.Style, '.plugin-fixture { color:red }'); ctx.add(G.Command,{id:'ok',title:'OK',run(){}}); S.onCleanup(() => { globalThis.__guiCleaned = (globalThis.__guiCleaned || 0) + 1 });`));
        const stable = value.getSnapshot();
        expect(stable.commands.map((item) => item.key)).toEqual(['good.ok']);
        expect(value.getSnapshot()).toBe(stable);
        value.install('good', bundle('throw new Error("not rerun")'));
        expect(value.getSnapshot()).toBe(stable);
        value.install('broken', bundle(`ctx.add(G.Style, '.broken-fixture {}'); throw new Error('setup failed')`));
        expect(value.getSnapshot().plugins.find((item) => item.id === 'broken')).toMatchObject({ status: 'failed', error: 'setup failed' });
        expect(value.getSnapshot().commands).toHaveLength(1);
        expect(document.head.textContent).not.toContain('.broken-fixture');
        value.uninstall('good');
        expect(document.head.textContent).not.toContain('.plugin-fixture');
        expect(Reflect.get(globalThis, '__guiCleaned')).toBeGreaterThan(0);
    });

    it('tracks localized commands and real usePlugin/usePanel mounted getters across session switches', () => {
        const value = host();
        value.setSession({ id: 'a', directory: '/a' });
        value.install('view', bundle(`
            ctx.add(G.Command, {id:'label', get title(){return ctx.t('label')},run(){}});
            ctx.add(G.Panel, {id:'view',region:'side', list: input => input.open.map(id => ({id,title:id})), render(props) {
                const p = G.usePlugin(); const frame = G.usePanel(); const node = document.createElement('div');
                S.createRenderEffect(() => node.textContent = [p.id, props.session.id, props.screen.file.root, frame.visible()].join('|'));
                return node;
            }});
            ctx.add(G.LinkHandler,{match: link => link.href === 'show', open: link => ctx.layout.open('view:main', link.session)});
        `, '1', `i18n:{en:{label:'English'},zh:{label:'中文'}},`));
        expect(value.openLink({ href: 'show' })).toBe(true);
        const element = document.createElement('div'); document.body.append(element);
        const stop = value.mountPanel('view:main', element);
        expect(element.textContent).toBe('view|a|/a|true');
        value.setAppearance({ locale: 'zh', mode: 'light', narrow: false });
        expect(value.getSnapshot().commands[0].title).toBe('中文');
        value.setSession({ id: 'b', directory: '/b' });
        expect(element.textContent).toBe('view|b|/b|false');
        value.openLink({ href: 'show' });
        expect(element.textContent).toBe('view|b|/b|true');
        value.hidePanel();
        expect(value.getSnapshot().panels).toHaveLength(1);
        expect(value.getSnapshot().activePanel).toBeNull();
        stop(); expect(element.textContent).toBe('');
    });

    it('official createKeyed follows contract generations and cleans scopes on unload', () => {
        const value = host();
        value.install('consumer', bundle(`
            const C = G.Contract.define('provider.api');
            G.createKeyed(ctx.use(C), api => { ctx.add(G.Command,{id:'live',title:api.title,run(){}}); });
        `));
        expect(value.getSnapshot().commands).toHaveLength(0);
        value.install('provider', bundle(`ctx.provide(G.Contract.define('provider.api'),{title:'first'});`));
        expect(value.getSnapshot().commands[0]?.title).toBe('first');
        value.install('provider', bundle(`ctx.provide(G.Contract.define('provider.api'),{title:'second'});`, '2'));
        expect(value.getSnapshot().commands.map((item) => item.title)).toEqual(['second']);
        value.uninstall('provider');
        expect(value.getSnapshot().commands).toHaveLength(0);
    });

    it('keeps noncurrent session layout writes scoped and rejects unsupported APIs', () => {
        const value = host();
        value.setSession({ id: 'a', directory: '/a' });
        value.install('scoped', bundle(`const a = ctx.sessions.current(); ctx.add(G.Command,{id:'open', title:'Open A', run(){ctx.layout.open('scoped:main',a)}}); ctx.add(G.Panel,{id:'p',region:'side',list: input => input.open.map(id=>({id,title:id})),render(){return null}});`));
        value.setSession({ id: 'b', directory: '/b' });
        value.runCommand('scoped.open');
        expect(value.getSnapshot().panels).toHaveLength(0);
        value.setSession({ id: 'a', directory: '/a' });
        expect(value.getSnapshot().plugins).toEqual([{ id: 'scoped', revision: '1', status: 'active', error: undefined }]);
        expect(value.getSnapshot().activePanel).toBe('scoped:main');
        value.install('unsupported', bundle(`ctx.dialogs.open(() => null)`));
        expect(value.getSnapshot().plugins.find((item) => item.id === 'unsupported')?.error).toContain('Unsupported GUI host API: ctx.dialogs');
    });

    it('runs every cleanup even when one throws, never runs main, and rejects native IPC and async setup', async () => {
        const value = host();
        Reflect.set(globalThis, '__guiCleanupOrder', []);
        value.install('cleanup', bundle(`
            S.onCleanup(() => globalThis.__guiCleanupOrder.push('first'));
            S.onCleanup(() => { throw new Error('cleanup error') });
            S.onCleanup(() => globalThis.__guiCleanupOrder.push('last'));
        `));
        value.uninstall('cleanup');
        expect(Reflect.get(globalThis, '__guiCleanupOrder')).toEqual(['last', 'first']);
        value.install('native', bundle(`
            const ipc = ctx.main(G.Ipc.define({id:'native',methods:{ping:{}}}));
            ctx.add(G.Command,{id:'ping',title:String(ctx.desktop),run:()=>ipc.ping()});
        `, '1', `main(){throw new Error('main must not execute')},`));
        expect(value.getSnapshot().commands[0].title).toBe('undefined');
        await value.runCommand('native.ping');
        expect(value.getSnapshot().plugins.find((item) => item.id === 'native')?.errorCode).toBe('GUI_PLUGIN_UNSUPPORTED');
        value.install('async', bundle('return Promise.resolve()'));
        expect(value.getSnapshot().plugins.find((item) => item.id === 'async')?.error).toContain('synchronous');
    });

    it('reacts to changed PanelTab objects without remounting and supplies the closed event tab', () => {
        const value = host(); value.setSession({ id: 'a', directory: '/a' });
        value.install('tabs', bundle(`
            const [title, setTitle] = S.createSignal('first');
            ctx.add(G.Command,{id:'rename',title:'Rename',run(){setTitle('second')}});
            ctx.add(G.Panel,{id:'p',region:'side',list: input => input.open.map(id=>({id,title:title()})),render(props){
                const node = document.createElement('span'); S.createRenderEffect(()=>node.textContent=props.tab.title); return node;
            },close(props){globalThis.__guiClosedTab=props.tab.id}});
        `));
        value.selectPanel('tabs:one');
        const element = document.createElement('div'); value.mountPanel('tabs:one', element);
        expect(element.textContent).toBe('first');
        value.runCommand('tabs.rename');
        expect(element.textContent).toBe('second');
        value.closePanel('tabs:one');
        expect(Reflect.get(globalThis, '__guiClosedTab')).toBe('one');
        value.setSession(undefined);
        expect(element.textContent).toBe('');
        expect(value.getSnapshot().plugins[0].status).toBe('active');
    });

    it('bindPlugin keeps the provider context while rendered by a consuming settings page', () => {
        const value = host();
        value.install('provider', bundle(`ctx.provide(G.Contract.define('provider.view'),{View:G.bindPlugin(()=>G.usePlugin().id)});`));
        value.install('consumer', bundle(`const source = ctx.use(G.Contract.define('provider.view')); ctx.add(G.SettingsPage,{id:'page',title:'Page',render(){return source().value.View({})}});`));
        const element = document.createElement('div');
        value.mountSettings('consumer:page', element);
        expect(element.textContent).toBe('provider');
        value.uninstall('consumer');
        expect(element.textContent).toBe('');
    });

    it('publishes revision, retains tabs on reload, disposes old mounts and permits same-revision failure retry', () => {
        const value = host(); value.setSession({ id: 'a', directory: '/a' });
        const code = (revision: string) => bundle(`
            if(globalThis.__guiRejectSetup) throw new Error('retry me');
            ctx.add(G.Panel,{id:'p',region:'side',list: input=>input.open.map(id=>({id,title:id})),render(){return '${revision}'}});
            ctx.add(G.SettingsPage,{id:'s',title:'Settings',render(){return '${revision}'}});
        `, revision);
        Reflect.set(globalThis, '__guiRejectSetup', false);
        value.install('reload', code('1')); value.selectPanel('reload:tab');
        const panel = document.createElement('div'), settings = document.createElement('div');
        value.mountPanel('reload:tab', panel); value.mountSettings('reload:s', settings);
        expect(panel.textContent).toBe('1'); expect(settings.textContent).toBe('1');
        value.install('reload', code('2'));
        expect(value.getSnapshot().plugins[0]).toMatchObject({ revision: '2', status: 'active' });
        expect(value.getSnapshot().activePanel).toBe('reload:tab');
        expect(panel.textContent).toBe(''); expect(settings.textContent).toBe('');
        value.mountPanel('reload:tab', panel); value.mountSettings('reload:s', settings);
        expect(panel.textContent).toBe('2'); expect(settings.textContent).toBe('2');
        Reflect.set(globalThis, '__guiRejectSetup', true);
        value.install('reload', code('3'));
        expect(value.getSnapshot().plugins[0]).toMatchObject({ revision: '3', status: 'failed' });
        Reflect.set(globalThis, '__guiRejectSetup', false);
        value.install('reload', code('3'));
        expect(value.getSnapshot().plugins[0]).toMatchObject({ revision: '3', status: 'active' });
        expect(value.getSnapshot().activePanel).toBe('reload:tab');
        const stable = value.getSnapshot(); value.install('reload', code('3'));
        expect(value.getSnapshot()).toBe(stable);
    });
});
