import { describe, expect, test } from 'bun:test';

import {
    clearMarkdownHydrationRestoreCache,
    createInitialMarkdownHydratedKeys,
    ensureNewestMarkdownKeyHydrated,
    getMarkdownHydrationBatch,
    pruneMarkdownHydratedKeys,
    readMarkdownHydrationRestore,
    writeMarkdownHydrationRestore,
    type MarkdownHydrationReleaseInput,
} from './markdownHydrationWindow';

const keys = (count: number): string[] => Array.from({ length: count }, (_, index) => `turn-${index}`);

const settled = (
    overrides: Partial<MarkdownHydrationReleaseInput> & Pick<
        MarkdownHydrationReleaseInput,
        'entryKeys' | 'mountedIndexes' | 'visibleStartIndex' | 'visibleEndIndex' | 'hydratedKeys'
    >,
): MarkdownHydrationReleaseInput => ({
    scrollDirection: null,
    preloadEntries: 3,
    allowVisibleRelease: true,
    preloadReleaseLimit: 4,
    ...overrides,
});

describe('markdown hydration window', () => {
    test('seeds the bottom-entering window hydrated on the first commit', () => {
        // Default seed window (12) covers the initial viewport + preload.
        expect([...createInitialMarkdownHydratedKeys(keys(100))]).toEqual(
            keys(12).map((_, index) => `turn-${88 + index}`),
        );
        // Caller-tuned window (summary mode passes 6).
        expect([...createInitialMarkdownHydratedKeys(keys(100), { seedCount: 6 })]).toEqual([
            'turn-94', 'turn-95', 'turn-96', 'turn-97', 'turn-98', 'turn-99',
        ]);
        // Short lists seed everything; empty lists seed nothing.
        expect([...createInitialMarkdownHydratedKeys(keys(3))]).toEqual(['turn-0', 'turn-1', 'turn-2']);
        expect(createInitialMarkdownHydratedKeys([]).size).toBe(0);
    });

    test('restore adds previously hydrated keys beyond the seed window', () => {
        const seeded = createInitialMarkdownHydratedKeys(keys(100), {
            seedCount: 6,
            restore: new Set(['turn-99', 'turn-40', 'turn-gone']),
        });
        expect(seeded.has('turn-99')).toBe(true);
        expect(seeded.has('turn-40')).toBe(true);
        // Keys no longer in entryKeys are dropped.
        expect(seeded.has('turn-gone')).toBe(false);
        // The seed window is still complete.
        expect([...seeded].filter((key) => Number(key.slice(5)) >= 94)).toHaveLength(6);
    });

    test('hydration restore cache round-trips per scope and evicts past its limit', () => {
        clearMarkdownHydrationRestoreCache();
        writeMarkdownHydrationRestore('scope-a', new Set(['turn-1', 'turn-2']));
        expect([...(readMarkdownHydrationRestore('scope-a') ?? [])]).toEqual(['turn-1', 'turn-2']);
        // Empty sets are not stored.
        writeMarkdownHydrationRestore('scope-empty', new Set());
        expect(readMarkdownHydrationRestore('scope-empty')).toBeUndefined();
        // LRU bound: 16 live entries, oldest evicted.
        for (let index = 0; index < 16; index += 1) {
            writeMarkdownHydrationRestore(`scope-${index}`, new Set([`turn-${index}`]));
        }
        // Refresh scope-0 so scope-1 becomes the oldest.
        readMarkdownHydrationRestore('scope-0');
        writeMarkdownHydrationRestore('scope-new', new Set(['turn-x']));
        expect(readMarkdownHydrationRestore('scope-1')).toBeUndefined();
        expect(readMarkdownHydrationRestore('scope-0')).toBeDefined();
        expect(readMarkdownHydrationRestore('scope-new')).toBeDefined();
        clearMarkdownHydrationRestoreCache();
        expect(readMarkdownHydrationRestore('scope-new')).toBeUndefined();
    });

    test('keeps a newly completed newest entry hydrated without waiting for scroll', () => {
        const hydrated = new Set(['turn-0']);
        const next = ensureNewestMarkdownKeyHydrated(hydrated, keys(2));
        expect([...next]).toEqual(['turn-0', 'turn-1']);
        expect(ensureNewestMarkdownKeyHydrated(next, keys(2))).toBe(next);
    });

    test('releases the whole visible window in one batch, newest to oldest', () => {
        const batch = getMarkdownHydrationBatch(settled({
            entryKeys: keys(100),
            mountedIndexes: [92, 93, 94, 95, 96, 97, 98, 99],
            visibleStartIndex: 94,
            visibleEndIndex: 99,
            hydratedKeys: new Set(['turn-99']),
            preloadReleaseLimit: 0,
        }));

        expect(batch).toEqual(['turn-98', 'turn-97', 'turn-96', 'turn-95', 'turn-94']);
    });

    test('carries metered off-screen preload alongside the visible batch', () => {
        const batch = getMarkdownHydrationBatch(settled({
            entryKeys: keys(100),
            mountedIndexes: [92, 93, 94, 95, 96, 97, 98, 99],
            visibleStartIndex: 94,
            visibleEndIndex: 99,
            hydratedKeys: new Set(['turn-99']),
        }));

        expect(batch).toEqual([
            'turn-98', 'turn-97', 'turn-96', 'turn-95', 'turn-94',
            'turn-93', 'turn-92',
        ]);
    });

    test('entering a populated viewport settles in a single release when under the visible budget', () => {
        const entryKeys = keys(100);
        // seedCount 1 isolates the release metering from the mount-time seed.
        const hydrated = createInitialMarkdownHydratedKeys(entryKeys, { seedCount: 1 });
        const read = () => getMarkdownHydrationBatch(settled({
            entryKeys,
            mountedIndexes: [94, 95, 96, 97, 98, 99],
            visibleStartIndex: 94,
            visibleEndIndex: 99,
            hydratedKeys: hydrated,
            // 6 visible incl. newest already hydrated → 5 pending; budget 6 settles once.
            visibleReleaseLimit: 6,
        }));

        for (const key of read()) hydrated.add(key);

        expect([...hydrated].sort()).toEqual([
            'turn-94', 'turn-95', 'turn-96', 'turn-97', 'turn-98', 'turn-99',
        ]);
        expect(read()).toEqual([]);
    });

    test('meters a dense visible window across idle commits instead of one freeze frame', () => {
        const entryKeys = keys(100);
        const hydrated = new Set(['turn-99']);
        const read = () => getMarkdownHydrationBatch(settled({
            entryKeys,
            mountedIndexes: Array.from({ length: 16 }, (_, i) => 84 + i),
            visibleStartIndex: 84,
            visibleEndIndex: 99,
            hydratedKeys: hydrated,
            preloadReleaseLimit: 0,
            visibleReleaseLimit: 4,
        }));

        const first = read();
        expect(first).toEqual(['turn-98', 'turn-97', 'turn-96', 'turn-95']);
        for (const key of first) hydrated.add(key);

        const second = read();
        expect(second).toEqual(['turn-94', 'turn-93', 'turn-92', 'turn-91']);
        for (const key of second) hydrated.add(key);

        // Remaining visible rows stay deferred for later idle frames.
        expect(hydrated.has('turn-84')).toBe(false);
        expect(hydrated.has('turn-90')).toBe(false);
    });

    test('a scrolling list withholds visible rows and lets only preload through', () => {
        const batch = getMarkdownHydrationBatch(settled({
            entryKeys: keys(100),
            mountedIndexes: [92, 93, 94, 95, 96, 97, 98, 99],
            visibleStartIndex: 94,
            visibleEndIndex: 99,
            hydratedKeys: new Set(['turn-99']),
            allowVisibleRelease: false,
            preloadReleaseLimit: 1,
        }));

        expect(batch).toEqual(['turn-93']);
    });

    test('scrolling preload keeps working until the visible window is reachable', () => {
        const entryKeys = keys(100);
        const hydrated = new Set(['turn-99']);
        const read = () => getMarkdownHydrationBatch(settled({
            entryKeys,
            mountedIndexes: [92, 93, 94, 95, 96, 97, 98, 99],
            visibleStartIndex: 94,
            visibleEndIndex: 99,
            hydratedKeys: hydrated,
            allowVisibleRelease: false,
            preloadReleaseLimit: 1,
        }));

        const released: string[] = [];
        for (let step = 0; step < 4; step += 1) {
            const batch = read();
            released.push(...batch);
            for (const key of batch) hydrated.add(key);
        }

        // Only the two mounted off-screen rows are reachable; visible rows stay
        // withheld no matter how many commits pass while scrolling.
        expect(released).toEqual(['turn-93', 'turn-92']);
        expect(hydrated.has('turn-94')).toBe(false);
    });

    test('preloads the newer side first while moving forward', () => {
        const batch = getMarkdownHydrationBatch(settled({
            entryKeys: keys(110),
            mountedIndexes: [89, 90, 91, 92, 93, 94, 95, 96, 97, 98],
            visibleStartIndex: 92,
            visibleEndIndex: 95,
            scrollDirection: 'forward',
            hydratedKeys: new Set(['turn-92', 'turn-93', 'turn-94', 'turn-95']),
            preloadReleaseLimit: 3,
        }));

        expect(batch).toEqual(['turn-96', 'turn-97', 'turn-98']);
    });

    test('preloads the older side first while moving backward', () => {
        const batch = getMarkdownHydrationBatch(settled({
            entryKeys: keys(110),
            mountedIndexes: [89, 90, 91, 92, 93, 94, 95, 96, 97, 98],
            visibleStartIndex: 92,
            visibleEndIndex: 95,
            scrollDirection: 'backward',
            hydratedKeys: new Set(['turn-92', 'turn-93', 'turn-94', 'turn-95']),
            preloadReleaseLimit: 3,
        }));

        expect(batch).toEqual(['turn-91', 'turn-90', 'turn-89']);
    });

    test('preloads one nearest mounted entry per release above an upward-moving viewport', () => {
        const entryKeys = keys(100);
        const hydrated = new Set(['turn-92', 'turn-93', 'turn-94', 'turn-95']);
        const read = () => getMarkdownHydrationBatch(settled({
            entryKeys,
            mountedIndexes: [89, 90, 91, 92, 93, 94, 95],
            visibleStartIndex: 92,
            visibleEndIndex: 95,
            scrollDirection: 'backward',
            hydratedKeys: hydrated,
            preloadReleaseLimit: 1,
        }));

        const released: string[] = [];
        for (let step = 0; step < 4; step += 1) {
            const batch = read();
            released.push(...batch);
            for (const key of batch) hydrated.add(key);
        }

        expect(released).toEqual(['turn-91', 'turn-90', 'turn-89']);
    });

    test('never preloads rows the virtualizer has not mounted', () => {
        const batch = getMarkdownHydrationBatch(settled({
            entryKeys: keys(100),
            mountedIndexes: [92, 93, 94, 95],
            visibleStartIndex: 92,
            visibleEndIndex: 95,
            scrollDirection: 'forward',
            hydratedKeys: new Set(['turn-92', 'turn-93', 'turn-94', 'turn-95']),
            preloadEntries: 20,
        }));

        expect(batch).toEqual([]);
    });

    test('a far jump hydrates the new viewport without filling intermediate history', () => {
        const batch = getMarkdownHydrationBatch(settled({
            entryKeys: keys(100),
            mountedIndexes: [27, 28, 29, 30, 31, 32, 33, 34, 35],
            visibleStartIndex: 30,
            visibleEndIndex: 35,
            scrollDirection: 'backward',
            hydratedKeys: new Set(['turn-99']),
        }));

        expect(batch).toEqual([
            'turn-35', 'turn-34', 'turn-33', 'turn-32', 'turn-31', 'turn-30',
            'turn-29', 'turn-28', 'turn-27',
        ]);
        expect(batch).not.toContain('turn-80');
    });

    test('stable hydrated keys survive prepends and removed keys are pruned', () => {
        const hydrated = new Set(['turn-a', 'turn-b']);
        const prepended = ['turn-old', 'turn-a', 'turn-b'];

        expect(pruneMarkdownHydratedKeys(hydrated, prepended)).toBe(hydrated);
        expect([...pruneMarkdownHydratedKeys(hydrated, ['turn-b'])])
            .toEqual(['turn-b']);
    });
});
