export type MarkdownHydrationScrollDirection = 'backward' | 'forward' | null;

type MarkdownHydrationCandidatesInput = {
    entryKeys: readonly string[];
    mountedIndexes: readonly number[];
    visibleStartIndex: number;
    visibleEndIndex: number;
    scrollDirection: MarkdownHydrationScrollDirection;
    preloadEntries: number;
    hydratedKeys: ReadonlySet<string>;
};

type MarkdownHydrationPlan = {
    visible: string[];
    preload: string[];
};

export type MarkdownHydrationReleaseInput = MarkdownHydrationCandidatesInput & {
    /**
     * Visible rows swap in front of the user, so a scrolling list withholds them
     * and lets only off-screen preload through.
     */
    allowVisibleRelease: boolean;
    preloadReleaseLimit: number;
    /**
     * Cap on how many still-deferred *visible* rows may hydrate in one commit.
     * Unlimited (`undefined` / non-positive ignored as unlimited) matches the
     * historical "whole viewport in one batch" settle. Dense collapsed
     * transcripts must meter this: dumping 12+ ChatMessage trees at scroll-end
     * shows up as a multi-hundred-ms React commit in Chrome traces.
     */
    visibleReleaseLimit?: number;
};

/**
 * Bottom-entering rows hydrate in the first commit. Mounting them as deferred
 * skeletons and swapping rich Markdown in over later frames is the
 * session-switch flicker this seed removes; scroll-time metering (below) is
 * untouched and still governs everything past this initial window.
 */
const INITIAL_MARKDOWN_HYDRATION_SEED = 12;

/**
 * Hydrated keys survive a session switch by scope key, so re-entering a
 * recently viewed transcript mounts every previously hydrated row rich
 * immediately instead of replaying placeholder swaps. Mirrors the
 * measurement-restore cache size (TIMELINE_CACHE_LIMIT).
 */
const MARKDOWN_HYDRATION_RESTORE_LIMIT = 16;

const hydrationRestoreCache = new Map<string, ReadonlySet<string>>();

/** Read-once-per-mount restore set. LRU-refreshed; undefined when unseen. */
export const readMarkdownHydrationRestore = (scopeKey: string): ReadonlySet<string> | undefined => {
    const restored = hydrationRestoreCache.get(scopeKey);
    if (!restored) return undefined;
    hydrationRestoreCache.delete(scopeKey);
    hydrationRestoreCache.set(scopeKey, restored);
    return restored;
};

/** Store the hydrated key set for the next mount of the same scope. */
export const writeMarkdownHydrationRestore = (scopeKey: string, keys: ReadonlySet<string>): void => {
    if (keys.size === 0) return;
    hydrationRestoreCache.delete(scopeKey);
    hydrationRestoreCache.set(scopeKey, keys);
    while (hydrationRestoreCache.size > MARKDOWN_HYDRATION_RESTORE_LIMIT) {
        const oldest = hydrationRestoreCache.keys().next().value;
        if (typeof oldest !== 'string') break;
        hydrationRestoreCache.delete(oldest);
    }
};

/** Test helper: drop all restore state. */
export const clearMarkdownHydrationRestoreCache = (): void => {
    hydrationRestoreCache.clear();
};

export const createInitialMarkdownHydratedKeys = (
    entryKeys: readonly string[],
    options?: {
        /** Rows from the bottom seeded rich on the first commit. */
        seedCount?: number;
        /** Previously hydrated keys (intersected with current entryKeys). */
        restore?: ReadonlySet<string> | null;
    },
): Set<string> => {
    const seedCount = Math.max(1, Math.floor(options?.seedCount ?? INITIAL_MARKDOWN_HYDRATION_SEED));
    const seeded = new Set<string>();
    for (
        let index = Math.max(0, entryKeys.length - seedCount);
        index < entryKeys.length;
        index += 1
    ) {
        const key = entryKeys[index];
        if (key) seeded.add(key);
    }
    const restore = options?.restore;
    if (restore && restore.size > 0) {
        const valid = new Set(entryKeys);
        for (const key of restore) {
            if (valid.has(key)) seeded.add(key);
        }
    }
    return seeded;
};

/**
 * Live streaming already paints rich Markdown in the tail. When that turn
 * remounts into virtualized history it must stay hydrated immediately — otherwise
 * the deferred skeleton replaces finished content for a frame.
 */
export const ensureNewestMarkdownKeyHydrated = (
    hydratedKeys: Set<string>,
    entryKeys: readonly string[],
): Set<string> => {
    const newestKey = entryKeys[entryKeys.length - 1];
    if (!newestKey || hydratedKeys.has(newestKey)) {
        return hydratedKeys;
    }
    const next = new Set(hydratedKeys);
    next.add(newestKey);
    return next;
};

const planMarkdownHydration = ({
    entryKeys,
    mountedIndexes,
    visibleStartIndex,
    visibleEndIndex,
    scrollDirection,
    preloadEntries,
    hydratedKeys,
}: MarkdownHydrationCandidatesInput): MarkdownHydrationPlan => {
    if (entryKeys.length === 0 || mountedIndexes.length === 0) {
        return { visible: [], preload: [] };
    }

    const mounted = new Set(mountedIndexes);
    const visible: string[] = [];
    const preload: string[] = [];
    const queued = new Set<string>();
    const addIndex = (candidates: string[], index: number) => {
        if (index < 0 || index >= entryKeys.length || !mounted.has(index)) {
            return;
        }
        const key = entryKeys[index];
        if (!key || hydratedKeys.has(key) || queued.has(key)) {
            return;
        }
        queued.add(key);
        candidates.push(key);
    };

    const lastIndex = entryKeys.length - 1;
    const start = Math.min(lastIndex, Math.max(0, Math.floor(visibleStartIndex)));
    const end = Math.min(lastIndex, Math.max(start, Math.floor(visibleEndIndex)));

    // The newest visible turn wins. Do not reverse DOM order; only reverse the
    // order in which rows are allowed to mount rich Markdown.
    for (let index = end; index >= start; index -= 1) {
        addIndex(visible, index);
    }

    // Preload runs on both sides of the fold. A row that only starts hydrating
    // once it is already on screen guarantees a visible placeholder-to-Markdown
    // swap; widening the window in the direction of travel means the row is
    // usually settled before it is ever painted.
    const preloadCount = Math.max(0, Math.floor(preloadEntries));
    const addAfter = () => {
        const preloadEnd = Math.min(lastIndex, end + preloadCount);
        for (let index = end + 1; index <= preloadEnd; index += 1) {
            addIndex(preload, index);
        }
    };
    const addBefore = () => {
        const preloadStart = Math.max(0, start - preloadCount);
        for (let index = start - 1; index >= preloadStart; index -= 1) {
            addIndex(preload, index);
        }
    };

    if (scrollDirection === 'backward') {
        addBefore();
        addAfter();
    } else {
        addAfter();
        addBefore();
    }

    return { visible, preload };
};

/**
 * Keys to release in the next commit.
 *
 * Visible rows prefer a single batch rather than one per commit: releasing them
 * individually makes the virtualizer remeasure and re-anchor once per row.
 * Off-screen preload is always metered. When the visible window is dense
 * (collapsed activity), `visibleReleaseLimit` caps the visible half of the
 * batch so scroll-end does not mount an entire screen of rich Markdown in one
 * React commit — remaining visible rows continue on subsequent idle frames.
 */
export const getMarkdownHydrationBatch = (
    input: MarkdownHydrationReleaseInput,
): string[] => {
    const { visible, preload } = planMarkdownHydration(input);
    const metered = preload.slice(0, Math.max(0, Math.floor(input.preloadReleaseLimit)));
    if (!input.allowVisibleRelease) {
        return metered;
    }
    const rawLimit = input.visibleReleaseLimit;
    const visibleBatch = typeof rawLimit === 'number' && rawLimit > 0
        ? visible.slice(0, Math.floor(rawLimit))
        : visible;
    return visibleBatch.length > 0 ? [...visibleBatch, ...metered] : metered;
};

export const pruneMarkdownHydratedKeys = (
    hydratedKeys: Set<string>,
    entryKeys: readonly string[],
): Set<string> => {
    const validKeys = new Set(entryKeys);
    let changed = false;
    const next = new Set<string>();
    for (const key of hydratedKeys) {
        if (validKeys.has(key)) {
            next.add(key);
        } else {
            changed = true;
        }
    }
    return changed ? next : hydratedKeys;
};
