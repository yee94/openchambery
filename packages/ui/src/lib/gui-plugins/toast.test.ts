import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { Contract, type Plugin, type SetupContext, type ToastOptions } from '@opencode/plugin/gui';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import type { FilesAPI } from '@/lib/api/types';
import { toast } from 'sonner';
import { GuiPluginHost } from './host';

const hosts: GuiPluginHost[] = [];
const contexts: SetupContext<Plugin.Definition>[] = [];
const bundle = (setup = '', revision = '1') => ({ revision, options: {}, code: `const G=require('@opencode/plugin/gui'); const S=require('solid-js'); module.exports.default=G.Plugin.define({setup(ctx){globalThis.__toastContexts.push(ctx);${setup}}});` });
function host(sink: typeof toast | null = toast) {
    vi.stubGlobal('__toastContexts', contexts);
    const value = new GuiPluginHost({ client: {} as OpenCodeClient,
        files: { readFile: vi.fn(), listDirectory: vi.fn(), search: vi.fn(), createDirectory: vi.fn() } as FilesAPI,
        toast: sink ?? undefined, queryClient: new QueryClient(), transport: 'relay:remote', storage: localStorage,
        locale: 'en', mode: 'dark', narrow: true });
    hosts.push(value);
    return value;
}
afterEach(() => {
    hosts.splice(0).forEach(value => value.dispose());
    contexts.length = 0;
    toast.dismiss();
    vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear();
});

describe('official GUI ctx.toast on the existing window toaster', () => {
    it('uses plain text and deduplicates per plugin without native access or a custom contract', () => {
        const h = host(); h.install('first', bundle()); h.install('second', bundle());
        const options = { title: '<img src=x onerror=alert(1)>', description: '<script>bad()</script>', variant: 'error' as const };
        const first = contexts[0].toast.show(options);
        expect(contexts[0].toast.show(options)).toBe(first);
        contexts[1].toast.show(options);
        const items = toast.getToasts();
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({ title: options.title, description: options.description, type: 'error', duration: 5000 });
        expect(contexts[0].desktop).toBeUndefined();
        expect(contexts[0].use(Contract.define('yuri.toast'))().status).toBe('inactive');
        first.dismiss(); first.dismiss();
        expect(toast.getToasts()).toHaveLength(1);
    });

    it.each(['uninstall', 'replace', 'dispose', 'fail'] as const)('revokes saved methods and dismisses owned messages on %s', (end) => {
        const h = host();
        h.install('first', bundle(`ctx.add(G.Command,{id:'fail',title:'Fail',run(){throw new Error('broken')}});`));
        h.install('other', bundle());
        const show = contexts[0].toast.show;
        show({ title: 'owned', persistent: true });
        contexts[1].toast.show({ title: 'other' });
        if (end === 'uninstall') h.uninstall('first');
        if (end === 'replace') h.install('first', bundle('', '2'));
        if (end === 'dispose') h.dispose();
        if (end === 'fail') h.runCommand('first.fail');
        show({ title: 'late' }).dismiss();
        expect(toast.getToasts().map(item => 'title' in item ? item.title : undefined)).toEqual(end === 'dispose' ? [] : ['other']);
    });

    it('keeps a toast beyond its Solid component owner and supports loading timeout and persistent dismissal', () => {
        vi.useFakeTimers();
        const h = host();
        h.install('first', bundle(`S.createRoot(dispose=>{ctx.toast.show({title:'component',variant:'loading',duration:25});dispose();});`));
        expect(toast.getToasts()).toHaveLength(1);
        vi.advanceTimersByTime(25);
        expect(toast.getToasts()).toHaveLength(0);
        const persistent = contexts[0].toast.show({ title: 'persistent', variant: 'loading', persistent: true, duration: 1 });
        vi.advanceTimersByTime(10_000);
        expect(toast.getToasts()).toHaveLength(1);
        persistent.dismiss();
        expect(toast.getToasts()).toHaveLength(0);
    });

    it('does not let a stale handle untrack a later toast with equal content', () => {
        const h = host(); h.install('first', bundle());
        const show = contexts[0].toast.show;
        const old = show({ title: 'same' }); old.dismiss();
        show({ title: 'same' }); old.dismiss();
        expect(toast.getToasts()).toHaveLength(1);
        h.uninstall('first');
        expect(toast.getToasts()).toHaveLength(0);
    });

    it('rejects malformed inputs, React content and unsupported controls before publishing', () => {
        const h = host(); h.install('first', bundle());
        for (const input of [null, { title: {} }, { title: 'x', description: {} }, { title: 'x', variant: 'warning' },
            { title: 'x', duration: -1 }, { title: 'x', duration: Infinity }, { title: 'x', persistent: 'yes' }]) {
            expect(() => contexts[0].toast.show(input as ToastOptions)).toThrow(expect.objectContaining({ code: 'GUI_PLUGIN_INVALID_INPUT' }));
        }
        for (const input of [{ title: 'x', actions: [] }, { title: 'x', icon: 'check' }]) {
            expect(() => contexts[0].toast.show(input as ToastOptions)).toThrow(expect.objectContaining({ code: 'GUI_PLUGIN_UNSUPPORTED' }));
        }
        expect(toast.getToasts()).toHaveLength(0);
        expect(contexts[0].signal.aborted).toBe(false);
    });

    it('does not allow plugins to forge the host namespace', () => {
        const h = host(); h.install('yuri.toast', bundle(`ctx.toast.show({title:'forged'});`));
        expect(h.getSnapshot().plugins[0]).toMatchObject({ status: 'failed' });
        h.install('ordinary', bundle());
        expect(() => contexts[0].provide(Contract.define('yuri.toast'), {})).toThrow('Contract must belong');
        expect(toast.getToasts()).toHaveLength(0);
    });

    it('reports an absent sink and isolates uncaught sink failure to its plugin', () => {
        const absent = host(null); absent.install('absent', bundle());
        expect(() => contexts[0].toast.show({ title: 'unavailable' })).toThrow(expect.objectContaining({ code: 'GUI_PLUGIN_UNSUPPORTED' }));
        const h = host();
        vi.spyOn(toast, 'error').mockImplementation(() => { throw new Error('sink failed'); });
        h.install('failed', bundle(`ctx.toast.show({title:'x',variant:'error'});`));
        h.install('working', bundle(`ctx.toast.show({title:'ok'});`));
        expect(h.getSnapshot().plugins.map(p => p.status)).toEqual(['failed', 'active']);
        expect(toast.getToasts()).toHaveLength(1);
    });
});
