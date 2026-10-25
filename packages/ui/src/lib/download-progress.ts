export type DownloadProgress = (percent: number | null) => void;

/** Read the response once; only report a percentage when its decoded size is known. */
export async function readDownloadBlob(response: Response, signal?: AbortSignal, onProgress?: DownloadProgress, maxBytes = Infinity): Promise<Blob> {
    signal?.throwIfAborted();
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    const encoded = response.headers.get('content-encoding');
    const length = encoded && encoded !== 'identity' ? 0
        : Number(range?.[3] ?? response.headers.get('content-length'));
    const total = Number.isSafeInteger(length) && length > 0 ? length : null;
    if (range && (Number(range[1]) !== 0 || Number(range[2]) + 1 !== Number(range[3]))) {
        await response.body?.cancel();
        throw new Error('Incomplete media range');
    }
    if (!onProgress && !Number.isFinite(maxBytes)) {
        const blob = await response.blob();
        signal?.throwIfAborted();
        if (total && blob.size !== total) throw new Error('Truncated media download');
        return blob;
    }
    onProgress?.(total ? 0 : null);
    if (!response.body) {
        const blob = await response.blob();
        signal?.throwIfAborted();
        onProgress?.(100);
        return blob;
    }
    const reader = response.body.getReader();
    const chunks: ArrayBuffer[] = [];
    let loaded = 0;
    let previous: number | null = total ? 0 : null;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
        for (;;) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            signal?.throwIfAborted();
            if (done) break;
            loaded += value.byteLength;
            if (loaded > maxBytes) throw new Error('File requires a streaming destination');
            chunks.push(new Uint8Array(value).buffer);
            if (total && loaded > total) throw new Error('Media size differs from response headers');
            const percent = total ? Math.min(99, Math.floor(loaded / total * 100)) : null;
            if (percent !== previous) { previous = percent; onProgress?.(percent); }
        }
        if (total && loaded !== total) throw new Error('Truncated media download');
        const blob = new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
        onProgress?.(100);
        return blob;
    } finally {
        signal?.removeEventListener('abort', abort);
        // A tee sibling may still be active; cancellation must not await it.
        void reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
