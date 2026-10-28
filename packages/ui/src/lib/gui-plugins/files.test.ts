import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createRenderEffect, createRoot, createSignal, getOwner, runWithOwner, type Owner } from 'solid-js';
import type { FilesAPI } from '@/lib/api/types';
import { GuiPluginFiles, normalizeGuiPath } from './files';

describe('GUI file model', () => {
    it('isolates file, selection and scroll subscriptions across 64 files', async () => {
        const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        let content = 'first';
        const model = new GuiPluginFiles({ readFile: async (path: string) => ({ path, content }) } as FilesAPI, query, 'runtime', '/work');
        for (let i = 0; i < 64; i++) await model.sync(`file-${i}`);
        const counts = Array.from({ length: 64 }, () => ({ file: 0, selection: 0, scroll: 0 }));
        let stop!: () => void;
        createRoot((dispose) => {
            stop = dispose;
            counts.forEach((count, i) => {
                createRenderEffect(() => { model.api.get(`file-${i}`); count.file++; });
                createRenderEffect(() => { model.api.selection.get(`file-${i}`); count.selection++; });
                createRenderEffect(() => { model.api.scroll.get(`file-${i}`); count.scroll++; });
            });
        });
        try {
            content = 'second';
            await model.sync('file-0', true);
            expect(counts[0]).toEqual({ file: 2, selection: 1, scroll: 1 });
            const snapshot = model.api.get('file-0');
            for (let i = 0; i < 50; i++) await model.sync('file-0', true);
            expect(model.api.get('file-0')).toBe(snapshot);
            model.api.selection.set('file-0', { start: 1, end: 2 });
            model.api.scroll.set('file-0', { top: 5 });
            for (let i = 0; i < 50; i++) {
                model.api.selection.set('/work/file-0', { end: 2, start: 1 });
                model.api.scroll.set('file-0', { top: 5 });
            }
            expect(counts[0]).toEqual({ file: 2, selection: 2, scroll: 2 });
            expect(counts.slice(1)).toEqual(Array.from({ length: 63 }, () => ({ file: 1, selection: 1, scroll: 1 })));
        } finally { stop(); model.dispose(); query.clear(); }
    });
    it('coalesces repeated force reads and publishes error recovery even with identical content', async () => {
        const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const readFile = vi.fn(async (path: string) => ({ path, content: 'same' }));
        const model = new GuiPluginFiles({ readFile } as unknown as FilesAPI, query, 'runtime', '/work');
        await model.sync('a');
        const original = model.api.get('a');
        let count = 0, missingCount = 0, stop!: () => void;
        createRoot((dispose) => {
            stop = dispose;
            createRenderEffect(() => { model.api.get('a'); count++; });
            createRenderEffect(() => { model.api.missing('a'); missingCount++; });
        });
        try {
            let finish!: (value: { path: string; content: string }) => void;
            readFile.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
            const pending = Array.from({ length: 50 }, () => model.sync('a', true));
            expect(readFile).toHaveBeenCalledTimes(2);
            finish({ path: '/work/a', content: 'same' });
            await Promise.all(pending);
            expect(readFile).toHaveBeenCalledTimes(3);
            expect(model.api.get('a')).toBe(original);
            expect(count).toBe(1);
            readFile.mockRejectedValueOnce(new Error('offline'));
            await expect(model.sync('a', true)).rejects.toThrow('offline');
            expect(count).toBe(2);
            expect(model.api.get('a')?.content).toBe(original?.content);
            await model.sync('a', true);
            expect(count).toBe(3);
            expect(model.api.get('a')?.error).toBeUndefined();
            expect(model.api.get('a')?.content).toBe(original?.content);
            expect(missingCount).toBe(1);
        } finally { stop(); model.dispose(); query.clear(); }
    });
    it('normalizes file URLs, Windows paths, UNC and directory boundaries', () => {
        const value = new GuiPluginFiles({} as FilesAPI, new QueryClient(), 'runtime', 'C:\\Work');
        expect(value.resolve('file:///C:/Work/a%20b.md')).toBe('a b.md');
        expect(value.resolve('c:\\Work\\dir\\..\\x')).toBe('x');
        expect(value.resolve('C:/Workspace/x')).toBe('C:/Workspace/x');
        expect(normalizeGuiPath('file://server/share/a')).toBe('//server/share/a');
    });
    it('releases dynamic subscriptions and notifies eviction without growing the 64-entry caches', async () => {
        const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const model = new GuiPluginFiles({ readFile: async (path: string) => ({ path, content: path }) } as FilesAPI, query, 'runtime', '/work');
        const [path, setPath] = createSignal('file-0');
        let stop!: () => void, evicted: unknown;
        createRoot((dispose) => {
            stop = dispose;
            createRenderEffect(() => { model.api.get(path()); model.api.selection.get(path()); model.api.scroll.get(path()); });
            createRenderEffect(() => { evicted = model.api.get('file-0'); });
        });
        try {
            for (let i = 0; i < 300; i++) {
                setPath(`file-${i}`);
                await model.sync(`file-${i}`);
                model.api.selection.set(`file-${i}`, { start: i, end: i });
                model.api.scroll.set(`file-${i}`, { top: i });
                expect(model['subscriptions'].size).toBeLessThanOrEqual(4);
            }
            expect(evicted).toBeUndefined();
            expect(model['states'].size).toBe(64);
            expect(model['selections'].size).toBe(64);
            expect(model['scrolls'].size).toBe(64);
            await model.sync('file-0');
            expect(evicted).toMatchObject({ loaded: true, content: { content: '/work/file-0' } });
            stop();
            expect(model['subscriptions'].size).toBe(0);
        } finally { stop(); model.dispose(); query.clear(); }
    });

    it('retains the 64 watch/cache and 256 API lease limits', async () => {
        const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const statFile = async (path: string) => ({ path, isFile: true, size: 1, mtimeMs: 1 });
        const readFile = async (path: string) => ({ path, content: path });
        const model = new GuiPluginFiles({ statFile, readFile } as FilesAPI, query, 'runtime', '/work');
        const stops: Array<() => void> = [];
        try {
            for (let i = 0; i < 64; i++) stops.push(model.watch(`file-${i}`));
            expect(() => model.watch('overflow')).toThrow('watch limit');
            await expect(model.sync('overflow')).rejects.toThrow('cache limit');
            for (let i = 0; i < 256; i++) {
                let ready!: Promise<void>;
                createRoot((dispose) => { stops.push(dispose); ready = model.api.sync('file-0'); });
                await ready;
            }
            createRoot((dispose) => {
                stops.push(dispose);
                expect(() => model.api.sync('file-0')).toThrow('consumer limit');
            });
        } finally { stops.forEach((stop) => stop()); model.dispose(); query.clear(); }
    });
    it('shares watcher leases, stops after the last consumer and fences stale reads', async () => {
        vi.useFakeTimers();
        let finish!: (value: { content: string; path: string }) => void;
        const statFile = vi.fn(async () => ({ path: '/work/a', isFile: true, size: 1, mtimeMs: 1 }));
        const readFile = vi.fn(() => new Promise<{ content: string; path: string }>((resolve) => { finish = resolve; }));
        const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const model = new GuiPluginFiles({ statFile, readFile } as unknown as FilesAPI, query, 'runtime', '/work');
        const first = model.watch('a'), second = model.watch('a');
        await vi.advanceTimersByTimeAsync(1);
        expect(statFile).toHaveBeenCalledTimes(1);
        first(); await vi.advanceTimersByTimeAsync(2_001);
        expect(statFile).toHaveBeenCalledTimes(2);
        second(); const calls = statFile.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(statFile).toHaveBeenCalledTimes(calls);
        const pending = model.api.sync('a');
        model.dispose(); finish({ path: '/work/a', content: 'stale' }); await pending;
        expect(model.api.get('a')).toBeUndefined();
        query.clear(); vi.useRealTimers();
    });

    it('stat changes refetch content; failed reads preserve the last complete content', async () => {
        vi.useFakeTimers();
        let mtime = 1;
        const readFile = vi.fn(async (path: string) => ({ path, content: `version-${mtime}` }));
        const statFile = vi.fn(async () => ({ path: '/work/a', isFile: true, size: 1, mtimeMs: mtime }));
        const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const model = new GuiPluginFiles({ statFile, readFile } as unknown as FilesAPI, query, 'runtime', '/work');
        await model.sync('a');
        expect(statFile).not.toHaveBeenCalled();
        const stop = model.watch('a');
        await vi.advanceTimersByTimeAsync(1);
        mtime = 2;
        await vi.advanceTimersByTimeAsync(2_001);
        expect(model.api.get('a')?.content?.content).toBe('version-2');
        readFile.mockRejectedValueOnce(new Error('offline'));
        await expect(model.api.sync('a', { force: true })).rejects.toThrow('offline');
        expect(model.api.get('a')).toMatchObject({ loaded: true, error: 'Error: offline', content: { content: 'version-2' } });
        stop(); model.dispose(); query.clear(); vi.useRealTimers();
    });

    it('API sync owns independent per-owner leases; unwatch cannot stop another owner or host lease', async () => {
        vi.useFakeTimers();
        let version = 1;
        const readFile = vi.fn(async (path: string) => ({ path, content: `v${version}` }));
        const statFile = vi.fn(async () => ({ path: '/work/a', isFile: true, size: 1, mtimeMs: version }));
        const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const model = new GuiPluginFiles({ statFile, readFile } as unknown as FilesAPI, query, 'runtime', '/work');
        let ownerA!: Owner, ownerB!: Owner, disposeA!: () => void, disposeB!: () => void;
        let ready!: Promise<void>;
        createRoot((dispose) => { disposeA = dispose; ownerA = getOwner()!; ready = model.api.sync('a'); });
        await ready;
        createRoot((dispose) => { disposeB = dispose; ownerB = getOwner()!; ready = model.api.sync('a'); });
        await ready;
        const stopHost = model.watch('a');
        runWithOwner(ownerA, () => model.api.unwatch('a'));
        disposeA();
        version = 2;
        await vi.advanceTimersByTimeAsync(2_001);
        expect(model.api.get('a')?.content?.content).toBe('v2');
        runWithOwner(ownerB, () => model.api.unwatch('a'));
        disposeB();
        version = 3;
        await vi.advanceTimersByTimeAsync(2_001);
        expect(model.api.get('a')?.content?.content).toBe('v3');
        stopHost();
        const count = statFile.mock.calls.length;
        await runWithOwner(ownerA, () => model.api.sync('a', { force: true }));
        await vi.advanceTimersByTimeAsync(4_001);
        expect(statFile).toHaveBeenCalledTimes(count);
        model.dispose(); query.clear(); vi.useRealTimers();
    });

    it('API-only watches clean up with their owner or model, without a PanelTab.file lease', async () => {
        vi.useFakeTimers();
        let version = 1;
        const statFile = vi.fn(async () => ({ path: '/work/a', isFile: true, size: 1, mtimeMs: version }));
        const readFile = vi.fn(async (path: string) => ({ path, content: `v${version}` }));
        const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const model = new GuiPluginFiles({ statFile, readFile } as unknown as FilesAPI, query, 'runtime', '/work');
        let stop!: () => void, ready!: Promise<void>;
        createRoot((dispose) => { stop = dispose; ready = model.api.sync('a'); });
        await ready; version = 2;
        await vi.advanceTimersByTimeAsync(2_001);
        expect(model.api.get('a')?.content?.content).toBe('v2');
        stop(); const count = statFile.mock.calls.length;
        await vi.advanceTimersByTimeAsync(4_001);
        expect(statFile).toHaveBeenCalledTimes(count);
        await model.api.sync('a');
        await vi.advanceTimersByTimeAsync(1);
        expect(statFile.mock.calls.length).toBeGreaterThan(count);
        model.dispose(); const endedCount = statFile.mock.calls.length;
        await model.api.sync('a', { force: true });
        await vi.advanceTimersByTimeAsync(4_001);
        expect(statFile).toHaveBeenCalledTimes(endedCount);
        query.clear(); vi.useRealTimers();
    });

    it('projects deletion/stat failure without erasing content and forces same-signature recovery', async () => {
        vi.useFakeTimers();
        let status: 'file' | 'missing' | 'error' = 'file';
        let content = 'original';
        const statFile = vi.fn(async () => {
            if (status === 'error') throw new Error('stat offline');
            return { path: '/work/a', isFile: status === 'file', size: 8, mtimeMs: 1 };
        });
        const readFile = vi.fn(async (path: string) => ({ path, content }));
        const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const model = new GuiPluginFiles({ statFile, readFile } as unknown as FilesAPI, query, 'runtime', '/work');
        await model.api.sync('a');
        await vi.advanceTimersByTimeAsync(1);
        status = 'missing';
        await vi.advanceTimersByTimeAsync(2_001);
        expect(model.api.get('a')).toMatchObject({ notFound: true, error: 'File does not exist', content: { content: 'original' } });
        status = 'file'; content = 'restored';
        await vi.advanceTimersByTimeAsync(2_001);
        expect(model.api.get('a')?.content?.content).toBe('restored');
        expect(model.api.get('a')?.error).toBeUndefined();
        expect(model.api.missing('a')).toBe(false);
        status = 'error';
        await vi.advanceTimersByTimeAsync(2_001);
        expect(model.api.get('a')).toMatchObject({ error: 'Error: stat offline', content: { content: 'restored' } });
        status = 'file'; content = 'repaired';
        await vi.advanceTimersByTimeAsync(2_001);
        expect(model.api.get('a')?.content?.content).toBe('repaired');
        expect(model.api.get('a')?.error).toBeUndefined();
        model.api.unwatch('a'); model.dispose(); query.clear(); vi.useRealTimers();
    });

    it('does not let an earlier read erase a later stat failure and bounds UTF-8 bytes', async () => {
        vi.useFakeTimers();
        let missing = false;
        let finish!: (value: { path: string; content: string }) => void;
        const readFile = vi.fn(() => new Promise<{ path: string; content: string }>((resolve) => { finish = resolve; }));
        const statFile = vi.fn(async () => ({ path: '/work/a', isFile: !missing, size: 1, mtimeMs: 1 }));
        const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const model = new GuiPluginFiles({ statFile, readFile } as unknown as FilesAPI, query, 'runtime', '/work');
        const pending = model.api.sync('a');
        await vi.advanceTimersByTimeAsync(1);
        missing = true; await vi.advanceTimersByTimeAsync(2_001);
        finish({ path: '/work/a', content: 'stale' }); await pending;
        expect(model.api.get('a')).toMatchObject({ notFound: true, error: 'File does not exist' });
        expect(model.api.get('a')?.content).toBeUndefined();
        model.dispose(); query.clear();
        const large = new GuiPluginFiles({ readFile: async (path: string) => ({ path, content: '中'.repeat(44_000) }) } as FilesAPI, query, 'other', '/work');
        await expect(large.sync('a')).rejects.toThrow('128 KiB');
        expect(large.api.get('a')?.loaded).not.toBe(true);
        large.dispose(); query.clear(); vi.useRealTimers();
    });

    it('renews effect-owned leases when Solid reuses an owner on rerun', async () => {
        vi.useFakeTimers();
        const statFile = vi.fn(async (path: string) => ({ path, isFile: true, size: 1, mtimeMs: 1 }));
        const readFile = vi.fn(async (path: string) => ({ path, content: path }));
        const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const model = new GuiPluginFiles({ statFile, readFile } as unknown as FilesAPI, query, 'runtime', '/work');
        const [path, setPath] = createSignal('a');
        let stop!: () => void;
        createRoot((dispose) => { stop = dispose; createRenderEffect(() => { void model.api.sync(path()); }); });
        await vi.advanceTimersByTimeAsync(1);
        setPath('b'); await vi.advanceTimersByTimeAsync(1);
        const aCalls = statFile.mock.calls.filter(([path]) => path === '/work/a').length;
        await vi.advanceTimersByTimeAsync(2_001);
        expect(model.api.get('b')?.content?.content).toBe('/work/b');
        expect(statFile.mock.calls.filter(([path]) => path === '/work/a')).toHaveLength(aCalls);
        expect(statFile.mock.calls.filter(([path]) => path === '/work/b').length).toBeGreaterThan(1);
        stop(); model.dispose(); query.clear(); vi.useRealTimers();
    });
});
