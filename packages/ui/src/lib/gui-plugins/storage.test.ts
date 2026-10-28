import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { GuiPluginStorage } from './storage';

describe('GUI plugin storage', () => {
    it('round-trips decoded values through transforming schemas rather than decoding them twice', () => {
        localStorage.clear();
        const host = new GuiPluginStorage(localStorage, 'codec');
        const storage = host.forPlugin('plugin', new AbortController().signal);
        const options = { schema: Schema.Struct({ count: Schema.NumberFromString }), initial: { count: 1 } };
        const store = storage.store('prefs', options);
        store.update((draft) => { draft.count = 42; });
        expect(store.value).toEqual({ count: 42 });
        expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!)).toEqual({ count: '42' });
        expect(host.forPlugin('plugin', new AbortController().signal).store('prefs', options).value).toEqual({ count: 42 });
    });
    const options = { schema: Schema.Struct({ count: Schema.Number }), initial: { count: 1 } };
    it('preserves memory across reload, isolates runtimes and rolls back failed durable writes', () => {
        localStorage.clear();
        const host = new GuiPluginStorage(localStorage, 'a');
        const controller = new AbortController();
        const first = host.forPlugin('plugin', controller.signal);
        const store = first.store('prefs', options);
        store.set({ count: 4 });
        const [memory, update] = first.memory('memory', { initial: { count: 1 } });
        update((draft) => { draft.count = 8; });
        controller.abort();
        const next = host.forPlugin('plugin', new AbortController().signal);
        const [restored, change] = next.memory('memory', { initial: { count: 0 } });
        expect(restored).toBe(memory);
        change((draft) => { draft.count++; });
        expect(restored.count).toBe(9);
        expect(next.store('prefs', options).value).toEqual({ count: 4 });
        expect(new GuiPluginStorage(localStorage, 'b').forPlugin('plugin', new AbortController().signal).store('prefs', options).value).toEqual({ count: 1 });
        const broken = new GuiPluginStorage({ getItem: () => null, setItem: () => { throw new Error('quota'); } } as unknown as Storage, 'a').forPlugin('x', new AbortController().signal).store('prefs', options);
        expect(() => broken.set({ count: 2 })).toThrow('quota');
        expect(broken.value).toEqual({ count: 1 });
        expect(() => next.store('legacy', { ...options, from: 'old' })).toThrow('migration');
    });
    it('decodes malformed values, rejects invalid updates, resets live stores only after successful removal', () => {
        localStorage.clear();
        const host = new GuiPluginStorage(localStorage, 'a');
        const storage = host.forPlugin('plugin', new AbortController().signal);
        const store = storage.store('prefs', options);
        store.set({ count: 3 });
        expect(() => store.set({ count: 'bad' } as unknown as { count: number })).toThrow();
        expect(store.value).toEqual({ count: 3 });
        localStorage.setItem(localStorage.key(0)!, '{"count":"bad"}');
        const loaded = host.forPlugin('plugin', new AbortController().signal).store('prefs', options);
        expect(loaded.value).toEqual({ count: 1 });
        storage.remove('prefs');
        expect(store.value).toEqual({ count: 1 });
    });
});
