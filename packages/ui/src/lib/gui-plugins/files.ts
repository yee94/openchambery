import { QueryObserver, type QueryClient } from '@tanstack/react-query';
import { batch, createSignal, getListener, getOwner, onCleanup, runWithOwner, type Owner } from 'solid-js';
import type { Files, FileState, LineRange } from '@opencode/plugin/gui';
import type { FilesAPI } from '@/lib/api/types';
import { fileContentQueryOptions, fileStatQueryOptions } from '@/queries/fileQueries';
import { normalizePath } from '@/lib/pathNormalization';

export function normalizeGuiPath(input: string): string {
    let path = input;
    if (/^file:/i.test(path)) {
        const url = new URL(path);
        path = `${url.hostname && url.hostname !== 'localhost' ? `//${url.hostname}` : ''}${decodeURIComponent(url.pathname)}`;
        if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    }
    const normalized = normalizePath(path) ?? '';
    return normalized === '.' ? '' : normalized;
}

const isAbsolute = (path: string) => /^(?:\/|[a-z]:\/)/i.test(path);
const unsupported = (): never => { throw new Error('Unsupported GUI file API: tree'); };
class MissingFileError extends Error {}
type Watch = { count: number; epoch: number; failed: boolean; stop: () => void };
type FileField = 'file' | 'missing' | 'selection' | 'scroll';
type Subscription = { revision: ReturnType<typeof createSignal<number>>; listeners: Set<NonNullable<ReturnType<typeof getListener>>> };
const contentBytes = (content: string) => new TextEncoder().encode(content).byteLength;

/** A single session/directory's bounded file model. Watches exist only while consumers hold leases. */
export class GuiPluginFiles {
    readonly api: Files;
    private ended = false;
    private states = new Map<string, FileState>();
    private inflight = new Map<string, Promise<void>>();
    private watches = new Map<string, Watch>();
    private apiLeases = new Map<Owner | null, Map<string, () => void>>();
    private registeredOwners = new WeakSet<Owner>();
    private endedOwners = new WeakSet<Owner>();
    private leaseCount = 0;
    private rerun = new Set<string>();
    private selections = new Map<string, LineRange | null>();
    private scrolls = new Map<string, { top?: number; left?: number }>();
    private subscriptions = new Map<string, Subscription>();

    constructor(private files: FilesAPI, private query: QueryClient, private transport: string, readonly root: string) {
        this.root = normalizeGuiPath(root);
        this.api = {
            root: this.root,
            ready: () => !this.ended,
            resolve: (path) => this.resolve(path),
            absolute: isAbsolute,
            get: (path) => { const key = this.track(path, 'file'); return this.states.get(key); },
            missing: (path) => { const key = this.track(path, 'missing'); return this.states.get(key)?.notFound === true; },
            sync: (path, options) => {
                const owner = getOwner();
                if (this.ended || (owner && this.endedOwners.has(owner))) return Promise.resolve();
                this.acquireApiLease(path);
                return this.sync(path, options?.force);
            },
            unwatch: (path) => this.releaseApiLease(getOwner(), this.resolve(path)),
            exists: async (path) => {
                try {
                    if (this.files.statFile) return (await this.query.fetchQuery(this.statOptions(path))).isFile;
                    const full = this.full(path);
                    const result = await this.files.listDirectory(full.slice(0, full.lastIndexOf('/')));
                    return result.entries.some((entry) => !entry.isDirectory && normalizeGuiPath(entry.path) === full);
                } catch { return false; }
            },
            search: async (text, options) => {
                if (options?.kind === 'any') throw new Error('Unsupported GUI file search: directories');
                options?.signal?.throwIfAborted();
                const rows = await this.query.fetchQuery({
                    queryKey: ['gui-plugin-files', transport, this.root, 'search', text, options?.limit],
                    gcTime: 30_000,
                    queryFn: async ({ signal }) => {
                        signal.throwIfAborted();
                        return this.files.search({ directory: this.root, query: text, maxResults: options?.limit ?? 100 });
                    },
                });
                options?.signal?.throwIfAborted();
                if (this.ended) throw new DOMException('GUI file model was disposed', 'AbortError');
                return rows.map((row) => this.resolve(row.path));
            },
            selection: {
                get: (path) => this.selections.get(this.track(path, 'selection')),
                set: (path, value) => {
                    const key = this.resolve(path), previous = this.selections.get(key);
                    if (previous === value || (previous && value && previous.start === value.start && previous.end === value.end && previous.side === value.side && previous.endSide === value.endSide)) return;
                    this.selections.set(key, value); this.trim(this.selections, 'selection'); this.changed(key, 'selection');
                },
            },
            scroll: {
                get: (path) => this.scrolls.get(this.track(path, 'scroll')) ?? {},
                set: (path, value) => {
                    const key = this.resolve(path), previous = this.scrolls.get(key), next = { ...previous, ...value };
                    if (previous?.top === next.top && previous?.left === next.left) return;
                    this.scrolls.set(key, next); this.trim(this.scrolls, 'scroll'); this.changed(key, 'scroll');
                },
            },
            tree: { list: unsupported, state: unsupported, sync: unsupported, expand: unsupported, collapse: unsupported },
        };
    }

    resolve(input: string): string {
        const path = normalizeGuiPath(input);
        if (!isAbsolute(path)) return path;
        if (path === this.root) return '';
        const prefix = this.root.endsWith('/') ? this.root : `${this.root}/`;
        return path.startsWith(prefix) ? path.slice(prefix.length) : path;
    }

    private full(path: string) { const resolved = this.resolve(path); return isAbsolute(resolved) ? resolved : normalizeGuiPath(`${this.root}/${resolved}`); }
    private input(path: string) { return { scopeDirectory: this.root, path: this.full(path), options: { directory: this.root } }; }
    private statOptions(path: string) { return { ...fileStatQueryOptions(this.files, this.input(path), this.transport), gcTime: 30_000 }; }
    private track(input: string, field: FileField) {
        const path = this.resolve(input);
        const listener = getListener();
        if (!listener || this.ended) return path;
        const key = `${field}:${path}`;
        let subscription = this.subscriptions.get(key);
        if (!subscription) {
            subscription = { revision: createSignal(0), listeners: new Set() };
            this.subscriptions.set(key, subscription);
        }
        const current = subscription;
        if (!current.listeners.has(listener)) {
            current.listeners.add(listener);
            runWithOwner(listener, () => onCleanup(() => {
                current.listeners.delete(listener);
                if (!current.listeners.size && this.subscriptions.get(key) === current) this.subscriptions.delete(key);
            }));
        }
        current.revision[0]();
        return path;
    }
    private changed(path: string, field: FileField) {
        if (!this.ended) this.subscriptions.get(`${field}:${path}`)?.revision[1]((value) => value + 1);
    }
    private trim<T>(map: Map<string, T>, field: FileField) {
        while (map.size > 64) {
            const path = map.keys().next().value!;
            map.delete(path);
            this.changed(path, field);
        }
    }
    private setState(path: string, next: FileState) {
        const previous = this.states.get(path);
        if (previous?.content?.content === next.content?.content && previous?.content?.type === next.content?.type) next.content = previous?.content;
        if (previous && previous.loaded === next.loaded && previous.loading === next.loading && previous.error === next.error && previous.notFound === next.notFound && previous.content === next.content) return;
        this.states.set(path, next);
        batch(() => {
            this.changed(path, 'file');
            if ((previous?.notFound === true) !== (next.notFound === true)) this.changed(path, 'missing');
        });
    }

    private acquireApiLease(input: string): void {
        const owner = getOwner();
        if (this.ended || (owner && this.endedOwners.has(owner)) || !this.files.statFile) return;
        const path = this.resolve(input);
        let leases = this.apiLeases.get(owner);
        if (leases?.has(path)) return;
        if (this.leaseCount >= 256) throw new Error('GUI file consumer limit exceeded');
        const stop = this.watch(path);
        if (!leases) { leases = new Map(); this.apiLeases.set(owner, leases); }
        leases.set(path, stop);
        this.leaseCount++;
        if (owner && !this.registeredOwners.has(owner)) {
            this.registeredOwners.add(owner);
            onCleanup(() => {
                // Solid reuses computation owners after effect cleanup. Roots, unlike computations, cannot restart.
                if (!('fn' in owner)) this.endedOwners.add(owner);
                this.registeredOwners.delete(owner);
                for (const key of [...(this.apiLeases.get(owner)?.keys() ?? [])]) this.releaseApiLease(owner, key);
            });
        }
        // Calls made after an await have no Solid owner. Their leases end at unwatch or model disposal.
    }

    private releaseApiLease(owner: Owner | null, path: string): void {
        const leases = this.apiLeases.get(owner);
        const stop = leases?.get(path);
        if (!stop) return;
        leases!.delete(path);
        this.leaseCount--;
        if (!leases!.size) this.apiLeases.delete(owner);
        stop();
    }

    private reserve(path: string): void {
        if (this.states.has(path)) return;
        if (this.states.size >= 64) {
            const evict = [...this.states.keys()].find((key) => !this.watches.has(key) && !this.inflight.has(key));
            if (!evict) throw new Error('GUI file cache limit exceeded');
            const wasMissing = this.states.get(evict)?.notFound === true;
            this.states.delete(evict);
            batch(() => {
                this.changed(evict, 'file');
                if (wasMissing) this.changed(evict, 'missing');
            });
        }
        this.states.set(path, { path, name: path.split('/').at(-1) ?? path });
    }

    async sync(input: string, force = false): Promise<void> {
        if (this.ended) return;
        const path = this.resolve(input);
        if (this.inflight.has(path)) { if (force) this.rerun.add(path); return this.inflight.get(path); }
        if (!force && this.states.get(path)?.loaded && !this.states.get(path)?.error) return;
        this.reserve(path);
        const previous = this.states.get(path);
        // Refresh a loaded preview in place; only cold reads need a loading transition.
        this.setState(path, { ...previous, path, name: path.split('/').at(-1) ?? path, loading: !previous?.loaded && !this.watches.get(path)?.failed });
        const task = (async () => {
            try {
                do {
                    this.rerun.delete(path);
                    const watch = this.watches.get(path);
                    const epoch = watch?.epoch;
                    try {
                        const options = fileContentQueryOptions(this.files, this.input(path), this.transport);
                        const content = await this.query.fetchQuery({ ...options, gcTime: 30_000, staleTime: force ? 0 : 30_000,
                            queryFn: async () => {
                                if (!this.files.readFile) throw new Error('File content reads are unavailable in this runtime');
                                const result = await this.files.readFile(this.full(path), { directory: this.root });
                                if (result.exists === false) throw new MissingFileError('File does not exist');
                                const content = result.content;
                                if (contentBytes(content) > 128 * 1024) throw new Error('GUI file preview exceeds 128 KiB');
                                return content;
                            },
                        });
                        if (this.ended) return;
                        if (contentBytes(content) > 128 * 1024) throw new Error('GUI file preview exceeds 128 KiB');
                        if (!watch || (watch.epoch === epoch && !watch.failed)) this.setState(path, { path, name: path.split('/').at(-1) ?? path, loaded: true, loading: false, content: { type: 'text', content } });
                    } catch (error) {
                        if (this.ended) return;
                        if (!watch || (watch.epoch === epoch && !watch.failed)) this.setState(path, { ...this.states.get(path)!, loading: false, ...(error instanceof MissingFileError ? { notFound: true } : {}), error: String(error) });
                        if (!this.rerun.has(path)) throw error;
                    }
                    force = true;
                } while (!this.ended && this.rerun.has(path));
            } finally { this.inflight.delete(path); this.rerun.delete(path); }
        })();
        this.inflight.set(path, task);
        return task;
    }

    watch(input: string): () => void {
        if (this.ended || !this.files.statFile) return () => {};
        const path = this.resolve(input);
        let watch = this.watches.get(path);
        if (!watch) {
            if (this.watches.size >= 64) throw new Error('GUI file watch limit exceeded');
            this.reserve(path);
            watch = { count: 0, epoch: 0, failed: false, stop: () => {} };
            const current = watch;
            this.watches.set(path, current);
            let signature: string | undefined;
            const observer = new QueryObserver(this.query, { ...this.statOptions(path), refetchInterval: 2_000, refetchIntervalInBackground: false });
            const stop = observer.subscribe((result) => {
                if (this.ended || this.watches.get(path) !== current || result.isFetching) return;
                if (result.isError || (result.isSuccess && !result.data.isFile)) {
                    current.failed = true;
                    current.epoch++;
                    this.setState(path, { ...this.states.get(path)!, loading: false,
                        notFound: result.isSuccess ? true : this.states.get(path)?.notFound,
                        error: result.isError ? String(result.error) : 'File does not exist',
                    });
                    return;
                }
                if (!result.data || !result.isSuccess) return;
                const next = `${result.data.size}:${result.data.mtimeMs ?? ''}`;
                const changed = current.failed || (signature !== undefined && next !== signature);
                current.failed = false;
                signature = next;
                if (changed) { current.epoch++; void this.sync(path, true).catch(() => {}); }
            });
            current.stop = () => { stop(); observer.destroy(); };
            // A new lease cannot infer cached content freshness from its first stat baseline.
            if (this.states.get(path)?.loaded) void this.sync(path, true).catch(() => {});
        }
        watch.count++;
        let active = true;
        return () => { if (!active) return; active = false; if (--watch.count === 0 && this.watches.get(path) === watch) this.stopWatch(path); };
    }

    private stopWatch(path: string) { this.watches.get(path)?.stop(); this.watches.delete(path); }
    dispose() { this.ended = true; for (const watch of this.watches.values()) watch.stop(); this.watches.clear(); this.apiLeases.clear(); this.leaseCount = 0; this.rerun.clear(); this.states.clear(); this.inflight.clear(); this.selections.clear(); this.scrolls.clear(); this.subscriptions.clear(); }
}
