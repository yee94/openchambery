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

export const createInitialMarkdownHydratedKeys = (entryKeys: readonly string[]): Set<string> => {
    const newestKey = entryKeys[entryKeys.length - 1];
    return newestKey ? new Set([newestKey]) : new Set();
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

    if (scrollDirection === 'backward') {
        const preloadCount = Math.max(0, Math.floor(preloadEntries));
        const preloadStart = Math.max(0, start - preloadCount);
        for (let index = start - 1; index >= preloadStart; index -= 1) {
            addIndex(preload, index);
        }
    }

    return { visible, preload };
};

/**
 * Keys to release in the next commit: the whole visible window at once, and
 * otherwise the single nearest off-screen preload row.
 *
 * Releasing visible rows one per commit makes the virtualizer remeasure the row
 * and re-anchor the scroll offset once per row, so entering a session walks
 * through one visible reflow per turn before it settles. Off-screen preload
 * rows keep the incremental cadence: they grow above the fold where the
 * anchoring rules already compensate their height, and they are not worth a
 * larger burst of Markdown work on a scroll path.
 */
export const getMarkdownHydrationBatch = (
    input: MarkdownHydrationCandidatesInput,
): string[] => {
    const { visible, preload } = planMarkdownHydration(input);
    return visible.length > 0 ? visible : preload.slice(0, 1);
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
