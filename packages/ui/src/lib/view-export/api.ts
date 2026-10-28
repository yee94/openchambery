import { getDesktopViewExportBridge } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { createUuid } from '@/lib/uuid';
import type {
    ExportLongImageInput, ExportPDFInput, ViewExportAPI, ViewExportCapabilities, ViewExportErrorCode,
    ViewExportEvent, ViewExportLimits, ViewExportMethod, ViewExportOptions, ViewExportProgress,
    ViewExportRequest, ViewExportResult,
} from './types';

export const VIEW_EXPORT_LIMITS: ViewExportLimits = Object.freeze({
    maxHTMLBytes: 16 * 1024 * 1024, maxWidth: 8192, maxHeight: 32768, maxPixels: 16 * 1024 * 1024,
});

class ViewExportError extends Error {
    constructor(readonly code: ViewExportErrorCode, message: string) { super(message); this.name = 'ViewExportError'; }
}

const unsupported = () => new ViewExportError('EXPORT_UNSUPPORTED', 'This container does not support view export.');
const unavailable: ViewExportCapabilities = Object.freeze({ version: 1, exportPDF: false, exportLongImage: false, limits: VIEW_EXPORT_LIMITS });
export const unsupportedViewExportAPI: ViewExportAPI = Object.freeze({
    capabilities: async () => unavailable,
    exportPDF: async () => { throw unsupported(); },
    exportLongImage: async () => { throw unsupported(); },
});

interface NativeViewExport {
    capabilities(): Promise<unknown>;
    exportPDF(input: ViewExportRequest): Promise<unknown>;
    exportLongImage(input: ViewExportRequest): Promise<unknown>;
    cancel(input: { taskId: string }): Promise<unknown>;
    addListener(name: 'progress', listener: (event: ViewExportEvent) => void): Promise<{ remove(): Promise<void> }>;
}

interface ExportTransport {
    request(method: 'capabilities' | ViewExportMethod | 'cancel', input?: unknown): Promise<unknown>;
    subscribe(listener: (event: ViewExportEvent) => void): Promise<() => void>;
}

async function resolveTransport(): Promise<ExportTransport | undefined> {
    const desktop = getDesktopViewExportBridge();
    if (desktop) return {
        request: async (method, input) => {
            const reply = await desktop.request(method, input);
            if (!reply.ok) throw new ViewExportError(reply.error.code, reply.error.message);
            return reply.value;
        },
        subscribe: async (listener) => desktop.subscribe(listener),
    };
    if (!isCapacitorApp()) return;
    const { Capacitor, registerPlugin } = await import('@capacitor/core');
    if (!Capacitor.isPluginAvailable('YuriViewExport')) return;
    const plugin = registerPlugin<NativeViewExport>('YuriViewExport');
    return {
        request: (method, input) => {
            if (method === 'capabilities') return plugin.capabilities();
            if (method === 'cancel') return plugin.cancel(input as { taskId: string });
            return plugin[method](input as ViewExportRequest);
        },
        subscribe: async (listener) => {
            const handle = await plugin.addListener('progress', listener);
            return () => { void handle.remove().catch(() => {}); };
        },
    };
}

function capabilities(value: unknown): ViewExportCapabilities {
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
        || !('exportPDF' in value) || typeof value.exportPDF !== 'boolean'
        || !('exportLongImage' in value) || typeof value.exportLongImage !== 'boolean'
        || !('limits' in value) || !value.limits || typeof value.limits !== 'object') throw unsupported();
    const limits = { ...VIEW_EXPORT_LIMITS };
    for (const key of Object.keys(limits) as (keyof ViewExportLimits)[]) {
        const limit: unknown = Reflect.get(value.limits, key);
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) throw unsupported();
        limits[key] = Math.min(limits[key], limit);
    }
    return Object.freeze({ version: 1, exportPDF: value.exportPDF, exportLongImage: value.exportLongImage, limits: Object.freeze(limits) });
}

function inputFor(method: ViewExportMethod, input: ExportPDFInput | ExportLongImageInput, limits: ViewExportLimits): ExportPDFInput | ExportLongImageInput {
    const { snapshot, filename } = input ?? {};
    if (!snapshot || typeof snapshot.html !== 'string' || !snapshot.html.trim()
        || !Number.isSafeInteger(snapshot.width) || snapshot.width <= 0
        || !Number.isSafeInteger(snapshot.height) || snapshot.height <= 0
        || typeof filename !== 'string' || !filename.trim() || filename.length > 240
        || /[\\/]/.test(filename) || [...filename].some(character => character.charCodeAt(0) < 32)
        || filename === '.' || filename === '..') {
        throw new ViewExportError('EXPORT_INVALID_INPUT', 'A static snapshot, positive dimensions and a filename are required.');
    }
    if (snapshot.width > limits.maxWidth || snapshot.height > limits.maxHeight || snapshot.width * snapshot.height > limits.maxPixels
        || snapshot.html.length > limits.maxHTMLBytes || new TextEncoder().encode(snapshot.html).byteLength > limits.maxHTMLBytes) {
        throw new ViewExportError('EXPORT_TOO_LARGE', 'The view exceeds this container’s export limits.');
    }
    const pageSize = 'pageSize' in input ? input.pageSize : undefined;
    if (pageSize !== undefined && (method !== 'exportPDF' || !['a4', 'letter'].includes(pageSize))) {
        throw new ViewExportError('EXPORT_INVALID_INPUT', 'Unsupported PDF page size.');
    }
    const name = filename.replace(/\.(pdf|png)$/i, '') + (method === 'exportPDF' ? '.pdf' : '.png');
    return { snapshot: { html: snapshot.html, width: snapshot.width, height: snapshot.height }, filename: name,
        ...(method === 'exportPDF' && pageSize ? { pageSize } : {}) };
}

function readProgress(event: ViewExportEvent): ViewExportProgress | undefined {
    if (!['preparing', 'rendering', 'encoding', 'saving'].includes(event.stage)) return;
    if (event.completed === undefined && event.total === undefined) return { stage: event.stage };
    if (typeof event.completed !== 'number' || typeof event.total !== 'number'
        || !Number.isFinite(event.completed) || !Number.isFinite(event.total)
        || event.total <= 0 || event.completed < 0 || event.completed > event.total) return;
    return { stage: event.stage, completed: event.completed, total: event.total };
}

/** No runtime URL, remote credentials, or plugin native lease is involved. */
export function createViewExportAPI(resolve: () => Promise<ExportTransport | undefined> = resolveTransport): ViewExportAPI {
    const run = async (method: ViewExportMethod, input: ExportPDFInput | ExportLongImageInput, options: ViewExportOptions = {}): Promise<ViewExportResult> => {
        if (options.signal?.aborted) return { status: 'cancelled' };
        const transport = await resolve();
        if (!transport) throw unsupported();
        const available = capabilities(await transport.request('capabilities'));
        if (!available[method]) throw unsupported();
        if (options.signal?.aborted) return { status: 'cancelled' };
        const request = { ...inputFor(method, input, available.limits), taskId: createUuid() };
        let active = true;
        const stop = await transport.subscribe((event) => {
            if (!active || options.signal?.aborted || !event || event.taskId !== request.taskId) return;
            const progress = readProgress(event);
            if (progress) options.onProgress?.(progress);
        });
        const cancel = () => { void transport.request('cancel', { taskId: request.taskId }).catch(() => {}); };
        try {
            if (options.signal?.aborted) return { status: 'cancelled' };
            // Start before adding abort: a cancel cannot overtake creation of this task.
            const pending = transport.request(method, request);
            options.signal?.addEventListener('abort', cancel, { once: true });
            if (options.signal?.aborted) cancel();
            const result = await pending;
            if (!result || typeof result !== 'object' || !('status' in result)
                || (result.status !== 'saved' && result.status !== 'cancelled')) {
                throw new ViewExportError('EXPORT_RENDER_FAILED', 'Invalid export result from the container.');
            }
            return { status: result.status };
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'EXPORT_ABORTED') return { status: 'cancelled' };
            throw error;
        } finally {
            active = false;
            options.signal?.removeEventListener('abort', cancel);
            stop();
        }
    };
    return {
        capabilities: async () => {
            const transport = await resolve();
            return transport ? capabilities(await transport.request('capabilities')) : unavailable;
        },
        exportPDF: (input, options) => run('exportPDF', input, options),
        exportLongImage: (input, options) => run('exportLongImage', input, options),
    };
}
