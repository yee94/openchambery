import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { Contract, type Plugin, type SetupContext } from '@opencode/plugin/gui';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import type { FilesAPI } from '@/lib/api/types';
import type { ExportLongImageAPI, ExportPDFAPI, ViewExportAPI, ViewExportOptions } from '@/lib/view-export/types';
import { GuiPluginHost } from './host';

const pdf = Contract.define<ExportPDFAPI, 'yuri.exportPDF'>('yuri.exportPDF');
const png = Contract.define<ExportLongImageAPI, 'yuri.exportLongImage'>('yuri.exportLongImage');
const limits = { maxHTMLBytes: 16 * 1024 * 1024, maxWidth: 8192, maxHeight: 32768, maxPixels: 16 * 1024 * 1024 };
const input = { filename: 'report', snapshot: { html: '<p>Report</p>', width: 600, height: 4000 } };
const hosts: GuiPluginHost[] = [];
const contexts: SetupContext<Plugin.Definition>[] = [];
const client = { rpc: vi.fn() } as unknown as OpenCodeClient;
const bundle = (setup = '') => ({ revision: '1', options: {}, code: `const G=require('@opencode/plugin/gui'); module.exports.default=G.Plugin.define({setup(ctx){globalThis.__exportContexts.push(ctx);${setup}}});` });

function host(api?: ViewExportAPI) {
    vi.stubGlobal('__exportContexts', contexts);
    const files = { readFile: vi.fn(), listDirectory: vi.fn(), search: vi.fn(), createDirectory: vi.fn() } as FilesAPI;
    const result = new GuiPluginHost({ client, files, viewExport: api, queryClient: new QueryClient(),
        transport: 'relay:remote', storage: localStorage, locale: 'en', mode: 'dark', narrow: true });
    hosts.push(result);
    return result;
}

afterEach(() => { hosts.splice(0).forEach(item => item.dispose()); contexts.length = 0; vi.unstubAllGlobals(); localStorage.clear(); });

describe('Yuri export contracts on the official GUI context', () => {
    it('leaves OpenCode client intact and activates the two APIs independently without plugin main', async () => {
        const api: ViewExportAPI = {
            capabilities: vi.fn<ViewExportAPI['capabilities']>(async () => ({ version: 1, exportPDF: true, exportLongImage: false, limits })),
            exportPDF: vi.fn<ViewExportAPI['exportPDF']>(async () => ({ status: 'saved' })), exportLongImage: vi.fn(),
        };
        const h = host(api); h.install('report', bundle());
        const ctx = contexts[0], live = ctx.use(pdf), image = ctx.use(png);
        expect(ctx.client).toBe(client);
        expect(ctx.desktop).toBeUndefined();
        expect(live()).toEqual({ status: 'pending' });
        expect(ctx.use(pdf)).toBe(live);
        await vi.waitFor(() => expect(live().status).toBe('active'));
        expect(image().status).toBe('inactive');
        const value = live();
        if (value.status !== 'active') throw new Error('Expected PDF capability');
        await expect(value.value.exportPDF(input)).resolves.toEqual({ status: 'saved' });
        expect(api.exportPDF).toHaveBeenCalledWith(input, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        for (let i = 0; i < 50; i++) {
            h.setAppearance({ locale: 'en', mode: i % 2 ? 'light' : 'dark', narrow: true });
            expect(ctx.use(pdf)).toBe(live);
            expect(live()).toBe(value);
        }
        expect(api.capabilities).toHaveBeenCalledOnce();
        expect(api.exportLongImage).not.toHaveBeenCalled();
    });

    it('keeps unavailable and failed probes distinct, with stable accessors', async () => {
        const h = host(); h.install('report', bundle());
        const live = contexts[0].use(pdf);
        expect(live()).toMatchObject({ status: 'inactive', reason: 'disabled' });
        expect(contexts[0].use(pdf)).toBe(live);
        const failed = host({ capabilities: vi.fn(async () => { throw new Error('Native probe failed'); }), exportPDF: vi.fn(), exportLongImage: vi.fn() });
        failed.install('other', bundle());
        const next = contexts[1].use(pdf);
        await vi.waitFor(() => expect(next()).toMatchObject({ status: 'inactive', reason: 'failed' }));
        expect(failed.getSnapshot().plugins[0].status).toBe('active');
    });

    it('rejects namespace spoofing before evaluating a reserved plugin or providing a host token', () => {
        const h = host();
        h.install('yuri', bundle());
        h.install('yuri.exportPDF', bundle());
        expect(contexts).toHaveLength(0);
        expect(h.getSnapshot().plugins.every(plugin => plugin.status === 'failed')).toBe(true);
        h.install('report', bundle());
        expect(() => contexts[0].provide(pdf, {} as ExportPDFAPI)).toThrow('only by the Yuri host');
    });

    it('keeps snapshot policy failures retryable and withdraws only an unavailable capability', async () => {
        const exportPDF = vi.fn<ViewExportAPI['exportPDF']>()
            .mockRejectedValueOnce(Object.assign(new Error('Static content required'), { code: 'EXPORT_FORBIDDEN' }))
            .mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { code: 'EXPORT_UNSUPPORTED' }));
        const h = host({ capabilities: async () => ({ version: 1, exportPDF: true, exportLongImage: true, limits }), exportPDF, exportLongImage: vi.fn() });
        h.install('report', bundle());
        const live = contexts[0].use(pdf);
        await vi.waitFor(() => expect(live().status).toBe('active'));
        const state = live();
        if (state.status !== 'active') throw new Error('Expected capability');
        await expect(state.value.exportPDF(input)).rejects.toMatchObject({ code: 'EXPORT_FORBIDDEN' });
        expect(live()).toBe(state);
        await expect(state.value.exportPDF(input)).rejects.toMatchObject({ code: 'EXPORT_UNSUPPORTED' });
        expect(live()).toMatchObject({ status: 'inactive', reason: 'failed' });
    });

    it('aborts only the owning plugin tasks and fences late probes and old retained clients', async () => {
        let firstSignal: AbortSignal | undefined;
        const api: ViewExportAPI = {
            capabilities: async () => ({ version: 1, exportPDF: true, exportLongImage: true, limits }),
            exportPDF: vi.fn<ViewExportAPI['exportPDF']>((_input, options?: ViewExportOptions) => new Promise(resolve => {
                firstSignal = options!.signal!;
                firstSignal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
            })),
            exportLongImage: vi.fn<ViewExportAPI['exportLongImage']>(async () => ({ status: 'saved' })),
        };
        const h = host(api); h.install('one', bundle()); h.install('two', bundle());
        const one = contexts[0].use(pdf), two = contexts[1].use(png);
        await vi.waitFor(() => expect(one().status).toBe('active'));
        const before = one();
        if (before.status !== 'active') throw new Error('Expected capability');
        const running = before.value.exportPDF(input);
        h.uninstall('one');
        expect(firstSignal?.aborted).toBe(true);
        await expect(running).resolves.toEqual({ status: 'cancelled' });
        expect(one().status).toBe('inactive');
        await expect(before.value.exportPDF(input)).resolves.toEqual({ status: 'cancelled' });
        expect(api.exportPDF).toHaveBeenCalledOnce();
        expect(two().status).toBe('active');
        h.dispose();
        expect(two().status).toBe('inactive');

        let finish!: (value: Awaited<ReturnType<ViewExportAPI['capabilities']>>) => void;
        const late = host({ ...api, capabilities: () => new Promise(resolve => { finish = resolve; }) });
        late.install('late', bundle());
        const latest = contexts[2].use(pdf);
        await Promise.resolve();
        late.dispose();
        finish({ version: 1, exportPDF: true, exportLongImage: true, limits });
        await Promise.resolve();
        expect(latest().status).toBe('inactive');
    });
});
