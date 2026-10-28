import { Schema } from 'effect';
import { createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import type { Mutable, Persisted, Storage as PluginStorage, StorageScope, StoreOptions } from '@opencode/plugin/gui';

const MAX_STORES = 256;
const MAX_BYTES = 2 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(unwrap(value));

/** One runtime's window-local memory survives plugin replacement, never a runtime replacement. */
export class GuiPluginStorage {
    private memory = new Map<string, ReturnType<PluginStorage['memory']>>();
    private resets = new Map<string, Set<() => void>>();

    constructor(private backend: globalThis.Storage, private transport: string) {}

    forPlugin(id: string, signal: AbortSignal): PluginStorage {
        const keyOf = (key: string, scope: StorageScope = 'global') => {
            if (typeof scope === 'object' && 'session' in scope && !scope.session.location) {
                throw new Error('Unsupported GUI storage: session location is unknown');
            }
            const identity = scope === 'global' ? scope : 'session' in scope
                ? [scope.session.server.id, scope.session.id, scope.session.location]
                : [scope.server, scope.directory];
            return `yuri.gui-plugin.${JSON.stringify([this.transport, id, identity, key])}`;
        };
        const check = (from?: unknown) => {
            if (signal.aborted) throw new Error('GUI plugin has been disposed');
            if (from !== undefined) throw new Error('Unsupported GUI storage migration: from');
        };
        const handles = new Map<string, Persisted<object>>();
        const store = <S extends Schema.ConstraintCodec<object, unknown>>(key: string, options: StoreOptions<S>): Persisted<S['Type']> => {
            check(options.from);
            const name = keyOf(key, options.scope);
            const existing = handles.get(name);
            if (existing) return existing;
            if (handles.size >= MAX_STORES) throw new Error('GUI plugin store limit exceeded');
            const decode = Schema.decodeUnknownSync(options.schema);
            const encode = Schema.encodeSync(options.schema);
            const initial = decode(encode(clone(options.initial)));
            if (JSON.stringify(encode(initial)).length > MAX_BYTES) throw new Error('GUI plugin store exceeds 2 MiB');
            let loaded = initial;
            const raw = this.backend.getItem(name);
            if (raw !== null && raw.length <= MAX_BYTES) {
                try { loaded = decode(JSON.parse(raw)); } catch { loaded = initial; }
            }
            const [value, setValue] = createSignal(loaded);
            const commit = (next: S['Type']) => {
                check();
                const encoded = JSON.stringify(encode(clone(next)));
                if (encoded.length > MAX_BYTES) throw new Error('GUI plugin store exceeds 2 MiB');
                const decoded = decode(JSON.parse(encoded));
                this.backend.setItem(name, encoded);
                setValue(() => decoded);
            };
            const handle: Persisted<S['Type']> = {
                get value() { return value(); },
                ready: () => true,
                set: commit,
                update: (mutate) => {
                    const draft = clone(value()) as Mutable<S['Type']>;
                    if (mutate(draft) !== undefined) throw new Error('Store update must not return a replacement');
                    commit(draft as S['Type']);
                },
            };
            const reset = () => setValue(() => clone(initial));
            const resets = this.resets.get(name) ?? new Set();
            resets.add(reset);
            this.resets.set(name, resets);
            signal.addEventListener('abort', () => {
                resets.delete(reset);
                if (!resets.size) this.resets.delete(name);
                handles.clear();
            }, { once: true });
            handles.set(name, handle);
            return handle;
        };
        return {
            store,
            memory: <T extends object>(key: string, options: { initial: T }) => {
                check();
                const name = keyOf(key);
                const existing = this.memory.get(name);
                if (existing) return [existing[0] as T, (mutate: (draft: T) => void) => { check(); existing[1](mutate as (draft: object) => void); }] as const;
                if (this.memory.size >= MAX_STORES) throw new Error('GUI plugin memory store limit exceeded');
                if (JSON.stringify(options.initial).length > MAX_BYTES) throw new Error('GUI plugin memory exceeds 2 MiB');
                const [value, setValue] = createStore(clone(options.initial));
                const result = [value, (mutate: (draft: T) => void) => {
                    check();
                    const draft = clone(unwrap(value));
                    if (mutate(draft) !== undefined) throw new Error('Memory update must not return a replacement');
                    if (JSON.stringify(draft).length > MAX_BYTES) throw new Error('GUI plugin memory exceeds 2 MiB');
                    setValue(reconcile(draft));
                }] as const;
                // Store only state and an owner-independent setter, so reload can reuse the memory.
                this.memory.set(name, [value, (mutate) => {
                    const draft = clone(unwrap(value));
                    if (mutate(draft) !== undefined) throw new Error('Memory update must not return a replacement');
                    if (JSON.stringify(draft).length > MAX_BYTES) throw new Error('GUI plugin memory exceeds 2 MiB');
                    setValue(reconcile(draft));
                }] as ReturnType<PluginStorage['memory']>);
                return result;
            },
            remove: (key, options) => {
                check(options?.from);
                const name = keyOf(key, options?.scope);
                this.backend.removeItem(name);
                for (const reset of this.resets.get(name) ?? []) reset();
            },
        };
    }

    dispose() { this.memory.clear(); this.resets.clear(); }
}
