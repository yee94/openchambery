import { describe, expect, test } from 'bun:test';

import {
    HighlightMemo,
    highlightCacheKey,
    highlightTokensCacheKey,
    weighLines,
    weighTokenLines,
} from './markdownHighlightCache';

const memo = (maxEntries = 8) => new HighlightMemo<string>({
    maxEntries,
    maxBytes: 1024 * 1024,
    weigh: (value) => value.length * 2,
});

const deferred = () => {
    let resolve!: (value: string | null) => void;
    const promise = new Promise<string | null>((r) => { resolve = r; });
    return { promise, resolve };
};

describe('highlight cache keys', () => {
    test('separates language from code so no concatenation can collide', () => {
        expect(highlightCacheKey('ts', 'x')).not.toBe(highlightCacheKey('t', 'sx'));
    });

    test('keys token runs by theme, so a theme switch cannot serve stale colors', () => {
        expect(highlightTokensCacheKey('dark', 'ts', 'x'))
            .not.toBe(highlightTokensCacheKey('light', 'ts', 'x'));
    });
});

describe('HighlightMemo', () => {
    test('runs the job once and serves later callers from cache', async () => {
        const cache = memo();
        let runs = 0;
        const start = async () => { runs += 1; return 'html'; };

        expect(await cache.run('k', start)).toBe('html');
        expect(await cache.run('k', start)).toBe('html');
        expect(runs).toBe(1);
    });

    test('coalesces concurrent callers onto one job', async () => {
        const cache = memo();
        const job = deferred();
        let runs = 0;
        const start = () => { runs += 1; return job.promise; };

        const first = cache.run('k', start);
        const second = cache.run('k', start);
        expect(runs).toBe(1);
        expect(cache.inFlightSize).toBe(1);

        job.resolve('html');
        expect(await first).toBe('html');
        expect(await second).toBe('html');
        expect(cache.inFlightSize).toBe(0);
    });

    test('never caches a failed highlight, so a transient worker outage retries', async () => {
        const cache = memo();
        let runs = 0;
        const start = async () => { runs += 1; return runs === 1 ? null : 'html'; };

        expect(await cache.run('k', start)).toBe(null);
        expect(await cache.run('k', start)).toBe('html');
        expect(runs).toBe(2);
    });

    test('caches nothing when the job rejects', async () => {
        const cache = memo();
        expect(await cache.run('k', () => Promise.reject(new Error('worker gone')))).toBe(null);
        expect(cache.peek('k')).toBeUndefined();
        expect(cache.inFlightSize).toBe(0);
    });

    test('an aborted caller does not cancel the job another caller still wants', async () => {
        const cache = memo();
        const job = deferred();
        let aborted = false;
        const start = (signal: AbortSignal) => {
            signal.addEventListener('abort', () => { aborted = true; });
            return job.promise;
        };

        const leaving = new AbortController();
        const staying = cache.run('k', start);
        const abandoned = cache.run('k', start, leaving.signal);

        leaving.abort();
        expect(aborted).toBe(false);
        expect(await abandoned).toBe(null);

        job.resolve('html');
        expect(await staying).toBe('html');
    });

    test('cancels the shared job once every caller has abandoned it', async () => {
        const cache = memo();
        const job = deferred();
        let aborted = false;
        const start = (signal: AbortSignal) => {
            signal.addEventListener('abort', () => { aborted = true; });
            return job.promise;
        };

        const first = new AbortController();
        const second = new AbortController();
        const a = cache.run('k', start, first.signal);
        const b = cache.run('k', start, second.signal);

        first.abort();
        expect(aborted).toBe(false);
        second.abort();
        expect(aborted).toBe(true);
        expect(cache.inFlightSize).toBe(0);

        expect(await a).toBe(null);
        expect(await b).toBe(null);
    });

    test('a caller arriving with an already-aborted signal starts no job', async () => {
        const cache = memo();
        let runs = 0;
        const controller = new AbortController();
        controller.abort();

        expect(await cache.run('k', async () => { runs += 1; return 'html'; }, controller.signal)).toBe(null);
        expect(runs).toBe(0);
    });

    test('a cache hit resolves even for a caller that already aborted elsewhere', async () => {
        const cache = memo();
        await cache.run('k', async () => 'html');

        const controller = new AbortController();
        controller.abort();
        expect(await cache.run('k', async () => 'other', controller.signal)).toBe('html');
    });

    test('evicts least recently used entries past the entry budget', async () => {
        const cache = memo(2);
        await cache.run('a', async () => 'A');
        await cache.run('b', async () => 'B');
        await cache.run('a', async () => 'A2');
        await cache.run('c', async () => 'C');

        expect(cache.peek('b')).toBeUndefined();
        expect(cache.peek('a')).toBe('A');
        expect(cache.peek('c')).toBe('C');
    });
});

describe('weights', () => {
    test('counts every line of per-line HTML', () => {
        expect(weighLines(['ab', 'cd'])).toBeGreaterThan(weighLines(['ab']));
    });

    test('counts token colors, which dominate a long styled line', () => {
        const plain = weighTokenLines([[[1, '', 0]]]);
        const colored = weighTokenLines([[[1, '#abcdef', 0]]]);
        expect(colored).toBeGreaterThan(plain);
    });
});
