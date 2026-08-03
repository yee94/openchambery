import { DualLimitLru } from '@/lib/dualLimitLru';

type HighlightMemoOptions<Value> = {
    maxEntries: number;
    maxBytes: number;
    weigh: (value: Value) => number;
};

type InFlightJob<Value> = {
    promise: Promise<Value | null>;
    controller: AbortController;
    waiters: number;
};

/**
 * Result cache and in-flight coalescing for worker tokenization.
 *
 * Tokenization is pure — the same code in the same language always produces the
 * same markup — but nothing upstream memoizes it. `markdownCore`'s block cache
 * is keyed by part id plus block index, so it misses whenever a message
 * re-segments, and it evicts long before a scrolled-through history stops
 * needing its earlier blocks; the file and diff surfaces have no cache at all.
 * Every miss is a fresh grammar run on a worker that is already the busiest
 * thread in the app, and a saturated worker delivers late enough that code
 * blocks visibly repaint after the text around them has settled.
 *
 * Keys are the code itself, so entries stay valid across re-indexing and are
 * shared between surfaces showing the same snippet. Hashing instead would risk
 * serving one block's colors for another's text.
 *
 * `null` means the worker was unavailable or failed, which is transient, so it
 * is never cached.
 */
export class HighlightMemo<Value> {
    readonly #cache: DualLimitLru<string, Value>;
    readonly #weigh: (value: Value) => number;
    readonly #inFlight = new Map<string, InFlightJob<Value>>();

    constructor(options: HighlightMemoOptions<Value>) {
        this.#cache = new DualLimitLru({
            maxEntries: options.maxEntries,
            maxBytes: options.maxBytes,
        });
        this.#weigh = options.weigh;
    }

    get size(): number {
        return this.#cache.size;
    }

    get inFlightSize(): number {
        return this.#inFlight.size;
    }

    peek(key: string): Value | undefined {
        return this.#cache.get(key);
    }

    run(
        key: string,
        start: (signal: AbortSignal) => Promise<Value | null>,
        signal?: AbortSignal,
    ): Promise<Value | null> {
        const cached = this.#cache.get(key);
        if (cached !== undefined) {
            return Promise.resolve(cached);
        }
        if (signal?.aborted) {
            return Promise.resolve(null);
        }

        const job = this.#inFlight.get(key) ?? this.#startJob(key, start);
        job.waiters += 1;
        return this.#attach(key, job, signal);
    }

    clear(): void {
        this.#cache.clear();
    }

    #startJob(
        key: string,
        start: (signal: AbortSignal) => Promise<Value | null>,
    ): InFlightJob<Value> {
        const controller = new AbortController();
        const job: InFlightJob<Value> = {
            controller,
            waiters: 0,
            promise: Promise.resolve(null),
        };
        const settle = (value: Value | null): Value | null => {
            if (this.#inFlight.get(key) === job) {
                this.#inFlight.delete(key);
            }
            if (value !== null) {
                this.#cache.set(key, value, this.#weigh(value) + key.length * 2);
            }
            return value;
        };
        job.promise = start(controller.signal).then(settle, () => settle(null));
        this.#inFlight.set(key, job);
        return job;
    }

    #attach(key: string, job: InFlightJob<Value>, signal?: AbortSignal): Promise<Value | null> {
        return new Promise<Value | null>((resolve) => {
            let settled = false;
            const finish = (value: Value | null): void => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                resolve(value);
            };
            // Only the last caller standing may cancel the shared job. A row
            // scrolling out of view must not strip highlighting from another
            // row that is still waiting on the same snippet.
            const onAbort = (): void => {
                if (settled) return;
                job.waiters -= 1;
                if (job.waiters <= 0 && this.#inFlight.get(key) === job) {
                    this.#inFlight.delete(key);
                    job.controller.abort();
                }
                finish(null);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            void job.promise.then(finish, () => finish(null));
        });
    }
}

const NUL = '\u0000';

export const highlightCacheKey = (lang: string, code: string): string => `${lang}${NUL}${code}`;

export const highlightTokensCacheKey = (
    themeName: string,
    lang: string,
    code: string,
): string => `${themeName}${NUL}${lang}${NUL}${code}`;

export const weighHtml = (html: string): number => html.length * 2;

export const weighLines = (lines: readonly string[]): number => {
    let bytes = lines.length * 8;
    for (const line of lines) bytes += line.length * 2;
    return bytes;
};

export const weighTokenLines = (lines: readonly (readonly (readonly [number, string, number])[])[]): number => {
    let bytes = lines.length * 8;
    for (const line of lines) {
        bytes += line.length * 32;
        for (const run of line) bytes += run[1].length * 2;
    }
    return bytes;
};
