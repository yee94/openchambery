import { DualLimitLru } from '@/lib/dualLimitLru';

const CACHE_MAX_ENTRIES = 512;
const CACHE_MAX_BYTES = 64 * 1024;
const ENTRY_WEIGHT_BYTES = 96;

/**
 * A remembered height is only meaningful at the width it was measured at, and
 * every Markdown row in the transcript shares one column width. Tracking a
 * single width and dropping everything when it moves is both cheaper and safer
 * than keying each entry by width, which would keep stale per-width entries
 * alive across sidebar toggles and window resizes.
 */
let measuredWidth: number | null = null;

const heights = new DualLimitLru<string, number>({
    maxEntries: CACHE_MAX_ENTRIES,
    maxBytes: CACHE_MAX_BYTES,
});

const hash = (input: string): string => {
    let value = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        value ^= input.charCodeAt(index);
        value = Math.imul(value, 0x01000193);
    }
    return (value >>> 0).toString(36);
};

export const markdownHeightCacheKey = (content: string, variant: string): string => (
    `${variant}:${content.length}:${hash(content)}`
);

export const rememberMarkdownHeight = (
    key: string,
    height: number,
    width: number,
): void => {
    if (!Number.isFinite(height) || !Number.isFinite(width) || height <= 0 || width <= 0) {
        return;
    }

    const roundedWidth = Math.round(width);
    if (measuredWidth !== roundedWidth) {
        heights.clear();
        measuredWidth = roundedWidth;
    }

    heights.set(key, Math.round(height), ENTRY_WEIGHT_BYTES);
};

export const recallMarkdownHeight = (key: string): number | undefined => heights.get(key);

export const clearMarkdownHeightCache = (): void => {
    heights.clear();
    measuredWidth = null;
};

export const markdownHeightCacheSize = (): number => heights.size;
