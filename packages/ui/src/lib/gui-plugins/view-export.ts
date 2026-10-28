import { createSignal, type Accessor } from 'solid-js';
import { liveAccessor } from '@opencode/plugin/gui/yuri-host';
import type { Live } from '@opencode/plugin/gui';
import type {
    ExportLongImageAPI, ExportLongImageInput, ExportPDFAPI, ExportPDFInput, ViewExportAPI,
    ViewExportCapabilities, ViewExportOptions, ViewExportResult,
} from '@/lib/view-export/types';

export const isViewExportContract = (id: string): boolean => id === 'yuri.exportPDF' || id === 'yuri.exportLongImage';
type ExportAPI = ExportPDFAPI | ExportLongImageAPI;
type Entry = { live: Accessor<Live<ExportAPI>>; stop(): void };

/** Host-owned contracts use ordinary SDK tokens, never plugin main/native leases. */
export class GuiViewExports {
    private probe?: Promise<ViewExportCapabilities>;
    private clients = new Map<AbortSignal, Map<string, Entry>>();
    private ended = false;

    constructor(private api?: ViewExportAPI) {}

    use(id: string, owner: AbortSignal): Accessor<Live<ExportAPI>> {
        let entries = this.clients.get(owner);
        const existing = entries?.get(id);
        if (existing) return existing.live;
        const [live, setLive] = createSignal<Live<ExportAPI>>(this.api && !owner.aborted && !this.ended
            ? { status: 'pending' } : { status: 'inactive', reason: 'disabled' });
        const stop = () => {
            setLive({ status: 'inactive', reason: 'disabled' });
            owner.removeEventListener('abort', stop);
            this.clients.delete(owner);
        };
        const entry = { live: liveAccessor(live), stop };
        if (this.ended || owner.aborted) return entry.live;
        if (!entries) { entries = new Map(); this.clients.set(owner, entries); }
        entries.set(id, entry);
        owner.addEventListener('abort', stop, { once: true });
        if (!this.api) return entry.live;
        const api = this.api;
        this.probe ??= Promise.resolve().then(() => api.capabilities());
        void this.probe.then((capabilities) => {
            if (this.ended || owner.aborted) return;
            const method = id === 'yuri.exportPDF' ? 'exportPDF' : 'exportLongImage';
            if (capabilities.version !== 1 || !capabilities[method]) { setLive({ status: 'inactive', reason: 'disabled' }); return; }
            const run = async (input: ExportPDFInput | ExportLongImageInput, options: ViewExportOptions = {}): Promise<ViewExportResult> => {
                if (this.ended || owner.aborted || live().status !== 'active') return { status: 'cancelled' };
                const signal = AbortSignal.any([owner, ...(options.signal ? [options.signal] : [])]);
                try {
                    return await api[method](input, { ...options, signal });
                } catch (error) {
                    if (error && typeof error === 'object' && 'code' in error && error.code === 'EXPORT_UNSUPPORTED') {
                        setLive({ status: 'inactive', reason: 'failed' });
                    }
                    throw error;
                }
            };
            const value: ExportAPI = id === 'yuri.exportPDF'
                ? Object.freeze({ version: 1, limits: capabilities.limits, exportPDF: run })
                : Object.freeze({ version: 1, limits: capabilities.limits, exportLongImage: run });
            setLive({ status: 'active', generation: 1, value });
        }).catch(() => { if (!this.ended && !owner.aborted) setLive({ status: 'inactive', reason: 'failed' }); });
        return entry.live;
    }

    dispose(): void {
        this.ended = true;
        for (const entries of this.clients.values()) for (const entry of entries.values()) entry.stop();
        this.clients.clear();
    }
}
