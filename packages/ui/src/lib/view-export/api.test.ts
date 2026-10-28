import { afterEach, describe, expect, it, vi } from 'vitest';
import { createViewExportAPI, VIEW_EXPORT_LIMITS } from './api';
import type { ViewExportEvent, ViewExportRequest } from './types';

const environment = vi.hoisted(() => ({ desktop: undefined as unknown, native: false, available: false, plugin: {} }));
vi.mock('@/lib/desktop', () => ({ getDesktopViewExportBridge: () => environment.desktop }));
vi.mock('@/lib/platform', () => ({ isCapacitorApp: () => environment.native }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isPluginAvailable: () => environment.available }, registerPlugin: () => environment.plugin }));
afterEach(() => { environment.desktop = undefined; environment.native = false; environment.available = false; });

const available = { version: 1, exportPDF: true, exportLongImage: true, limits: VIEW_EXPORT_LIMITS };
const input = { snapshot: { html: '<div>Report</div>', width: 640, height: 2400 }, filename: 'Report' };
function fixture() {
    let listener: ((event: ViewExportEvent) => void) | undefined;
    let finish: (result: unknown) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const stop = vi.fn();
    const request = vi.fn(async (method: string, _input?: unknown) => {
        if (method === 'capabilities') return available;
        if (method === 'cancel') { finish({ status: 'cancelled' }); return undefined; }
        return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    });
    const subscribe = vi.fn(async (receive: (event: ViewExportEvent) => void) => { listener = receive; return stop; });
    return { api: createViewExportAPI(async () => ({ request, subscribe })), request, stop,
        send: (event: ViewExportEvent) => listener?.(event), finish: (value: unknown) => finish(value), fail: (error: unknown) => fail(error) };
}

describe('client-container export boundary', () => {
    it('keeps plain browser, hosted mobile and old mobile shells explicitly unsupported', async () => {
        const api = createViewExportAPI();
        expect(await api.capabilities()).toMatchObject({ exportPDF: false, exportLongImage: false });
        await expect(api.exportPDF(input)).rejects.toMatchObject({ code: 'EXPORT_UNSUPPORTED' });
        environment.native = true;
        expect(await api.capabilities()).toMatchObject({ exportPDF: false, exportLongImage: false });
    });

    it('uses separate desktop methods and filters task/stage progress, releasing listeners on success', async () => {
        const f = fixture(), progress = vi.fn();
        const result = f.api.exportPDF({ ...input, pageSize: 'letter' }, { onProgress: progress });
        await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('exportPDF', expect.anything()));
        const task = f.request.mock.calls.find(([method]) => method === 'exportPDF')![1] as ViewExportRequest;
        expect(task).toMatchObject({ pageSize: 'letter', snapshot: input.snapshot, filename: 'Report.pdf' });
        expect(task).not.toHaveProperty('format');
        f.send({ taskId: 'old', stage: 'saving' });
        f.send({ taskId: task.taskId, stage: 'rendering', completed: 1, total: 3 });
        f.send({ taskId: task.taskId, stage: 'encoding', completed: 4, total: 3 });
        expect(progress.mock.calls).toEqual([[{ stage: 'rendering', completed: 1, total: 3 }]]);
        f.finish({ status: 'saved' });
        await expect(result).resolves.toEqual({ status: 'saved' });
        f.send({ taskId: task.taskId, stage: 'saving' });
        expect(progress).toHaveBeenCalledTimes(1);
        expect(f.stop).toHaveBeenCalledOnce();
        const image = f.api.exportLongImage({ ...input, filename: 'Report.v2.pdf' });
        await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('exportLongImage', expect.anything()));
        expect(f.request.mock.calls.find(([method]) => method === 'exportLongImage')?.[1]).toMatchObject({ filename: 'Report.v2.png' });
        f.finish({ status: 'saved' });
        await image;
    });

    it('cancels by opaque task id and suppresses progress after abort', async () => {
        const f = fixture(), controller = new AbortController(), progress = vi.fn();
        const result = f.api.exportLongImage(input, { signal: controller.signal, onProgress: progress });
        await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('exportLongImage', expect.anything()));
        const task = f.request.mock.calls.find(([method]) => method === 'exportLongImage')![1] as ViewExportRequest;
        controller.abort();
        f.send({ taskId: task.taskId, stage: 'saving' });
        await expect(result).resolves.toEqual({ status: 'cancelled' });
        expect(f.request).toHaveBeenCalledWith('cancel', { taskId: task.taskId });
        expect(progress).not.toHaveBeenCalled();
        expect(f.stop).toHaveBeenCalledOnce();
    });

    it('does not dispatch an already cancelled request, or one cancelled while subscribing', async () => {
        const f = fixture(), controller = new AbortController(); controller.abort();
        await expect(f.api.exportPDF(input, { signal: controller.signal })).resolves.toEqual({ status: 'cancelled' });
        expect(f.request).not.toHaveBeenCalled();
        const next = new AbortController(), stop = vi.fn();
        const request = vi.fn(async () => available);
        const api = createViewExportAPI(async () => ({ request, subscribe: async () => { next.abort(); return stop; } }));
        await expect(api.exportPDF(input, { signal: next.signal })).resolves.toEqual({ status: 'cancelled' });
        expect(request.mock.calls).toHaveLength(1);
        expect(stop).toHaveBeenCalledOnce();
    });

    it('preserves native error codes and cleanup instead of treating failure as success', async () => {
        const f = fixture();
        const error = Object.assign(new Error('Disk write failed'), { code: 'EXPORT_SAVE_FAILED' });
        const outcome = expect(f.api.exportPDF(input)).rejects.toBe(error);
        await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('exportPDF', expect.anything()));
        f.fail(error);
        await outcome;
        expect(f.stop).toHaveBeenCalledOnce();
    });

    it('rejects excessive dimensions, UTF-8 payloads and path inputs before starting native work', async () => {
        const f = fixture();
        for (const snapshot of [
            { ...input.snapshot, width: 8193 }, { ...input.snapshot, width: 8192, height: 8192 },
            { ...input.snapshot, html: '界'.repeat(Math.floor(VIEW_EXPORT_LIMITS.maxHTMLBytes / 3) + 1) },
        ]) await expect(f.api.exportPDF({ ...input, snapshot })).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
        await expect(f.api.exportPDF({ ...input, filename: '../file' })).rejects.toMatchObject({ code: 'EXPORT_INVALID_INPUT' });
        expect(f.request.mock.calls.every(([method]) => method === 'capabilities')).toBe(true);
    });

    it('detects formats independently and does not infer native support from a JS proxy', async () => {
        environment.native = true; environment.available = true;
        const remove = vi.fn(async () => {});
        const exportLongImage = vi.fn(async () => ({ status: 'saved' }));
        environment.plugin = {
            capabilities: async () => ({ ...available, exportPDF: false }), exportLongImage,
            addListener: vi.fn(async () => ({ remove })),
        };
        const api = createViewExportAPI();
        expect(await api.capabilities()).toMatchObject({ exportPDF: false, exportLongImage: true });
        await expect(api.exportPDF(input)).rejects.toMatchObject({ code: 'EXPORT_UNSUPPORTED' });
        await expect(api.exportLongImage(input)).resolves.toEqual({ status: 'saved' });
        expect(exportLongImage).toHaveBeenCalledOnce();
        expect(remove).toHaveBeenCalledOnce();
    });

    it('unwraps desktop envelopes without consulting remote runtime or Relay identity', async () => {
        const request = vi.fn(async (method: string) => method === 'capabilities'
            ? { ok: true, value: available }
            : { ok: false, error: { code: 'EXPORT_SAVE_FAILED', message: 'Write failed' } });
        const stop = vi.fn();
        environment.desktop = { request, subscribe: () => stop };
        await expect(createViewExportAPI().exportPDF(input)).rejects.toMatchObject({ code: 'EXPORT_SAVE_FAILED' });
        expect(stop).toHaveBeenCalledOnce();
    });
});
