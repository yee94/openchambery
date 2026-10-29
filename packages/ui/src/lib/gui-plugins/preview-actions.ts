import { createContext, onCleanup, useContext as readSolidContext } from 'solid-js';
import type { ViewExportSnapshot, ViewExportProgress } from '@/lib/view-export/types';

export const PREVIEW_ACTIONS_CONTRACT = 'yuri.previewActions';

export interface PreviewSnapshotOptions {
    signal?: AbortSignal;
    onProgress?: (progress: Omit<ViewExportProgress, 'stage'> & { stage: ViewExportProgress['stage'] | 'capturing' }) => void;
}

export interface PreviewActionSurface {
    readonly element: HTMLElement;
    readonly signal: AbortSignal;
    snapshot(options?: PreviewSnapshotOptions): Promise<ViewExportSnapshot>;
}

export interface PreviewActionsAPI {
    readonly version: 1;
    register(input: {
        element: HTMLElement;
        capture(options: PreviewSnapshotOptions): Promise<ViewExportSnapshot>;
        render(surface: PreviewActionSurface): HTMLElement;
    }): () => void;
}

/** Private mount identity, inherited by the panel's Solid owner, never a tab lookup. */
export const PreviewActionsContext = createContext<{
    plugin: AbortSignal;
    signal: AbortSignal;
    content: HTMLElement;
    target: HTMLElement;
}>();

export function createPreviewActions(plugin: AbortSignal): PreviewActionsAPI {
    return {
        version: 1,
        register(input) {
            const mount = readSolidContext(PreviewActionsContext);
            if (!mount || mount.plugin !== plugin || mount.signal.aborted || plugin.aborted) {
                throw new Error('Preview actions require the owning mounted panel');
            }
            const controller = new AbortController();
            const signal = AbortSignal.any([plugin, mount.signal, controller.signal]);
            let element: HTMLElement | undefined;
            const dispose = () => {
                signal.removeEventListener('abort', dispose);
                controller.abort();
                element?.remove();
            };
            onCleanup(dispose);
            signal.addEventListener('abort', dispose, { once: true });
            try {
                element = input.render({
                    element: input.element,
                    signal,
                    async snapshot(options = {}) {
                        const captureSignal = AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]);
                        captureSignal.throwIfAborted();
                        if (!mount.content.contains(input.element) || mount.target.contains(input.element)) {
                            throw new Error('Preview capture region is no longer in its owning panel');
                        }
                        const snapshot = await input.capture({ ...options, signal: captureSignal });
                        captureSignal.throwIfAborted();
                        if (!mount.content.contains(input.element)) throw new Error('Preview capture region was replaced');
                        return snapshot;
                    },
                });
                signal.throwIfAborted();
                mount.target.append(element);
            } catch (error) {
                dispose();
                throw error;
            }
            return dispose;
        },
    };
}
