import { isNpmScopedPackageMention } from '@/lib/search/fileMentionSearch';

const FILE_EXTENSION_PATTERN = /\.[a-z0-9]{1,8}$/i;

const looksLikeFilePath = (mention: string): boolean => (
    !isNpmScopedPackageMention(mention)
    && (mention.includes('/') || mention.includes('\\') || mention.includes('.'))
);

/** Absolute path paste whose last segment already has an extension or trailing slash. */
export const looksLikePastedFileReference = (mention: string): boolean => {
    if (!looksLikeFilePath(mention)) return false;
    const normalized = mention.replace(/\\/g, '/');
    if (normalized.endsWith('/')) return true;
    const lastSegment = normalized.split('/').filter(Boolean).pop() ?? normalized;
    return FILE_EXTENSION_PATTERN.test(lastSegment);
};

const isMultiSegmentAbsolutePath = (value: string): boolean => {
    const normalized = value.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(normalized)) return normalized.slice(3).includes('/');
    if (normalized.startsWith('//')) return normalized.replace(/^\/+/, '').includes('/');
    if (normalized.startsWith('/')) return normalized.slice(1).includes('/');
    return false;
};

type SpacedAtMention = {
    value: string;
    /** Exclusive end of `@${value}`. */
    end: number;
};

/**
 * A pasted absolute path may contain spaces (`/Users/.../Application Support/file.png`).
 * Extend only while the token stays a multi-segment absolute path and stop at the
 * first extension or trailing slash, so following prose is not swallowed.
 */
export const readSpacedPastedFileMention = (text: string, at: number): SpacedAtMention | null => {
    if (text[at] !== '@') return null;
    const rest = text.slice(at + 1);
    const firstBreak = rest.search(/\s/);
    const firstToken = firstBreak === -1 ? rest : rest.slice(0, firstBreak);
    if (!firstToken || /[\r\n]/.test(firstToken) || !isMultiSegmentAbsolutePath(firstToken)) return null;

    let end = at + 1 + firstToken.length;
    let value = firstToken;
    if (looksLikePastedFileReference(value)) return { value, end };

    while (end < text.length && /[ \t]/.test(text[end])) {
        let next = end + 1;
        while (next < text.length && !/\s/.test(text[next])) next += 1;
        if (next === end + 1) break;
        const extended = text.slice(at + 1, next);
        if (extended.length > 4096) break;
        value = extended;
        end = next;
        if (looksLikePastedFileReference(value)) return { value, end };
    }
    return null;
};

/** Longest confirmed mention that itself contains whitespace and ends on a boundary. */
export const findLongestConfirmedSpacedMention = (
    text: string,
    at: number,
    confirmedValues: ReadonlySet<string> | undefined,
): SpacedAtMention | null => {
    if (!confirmedValues || confirmedValues.size === 0 || text[at] !== '@') return null;
    const rest = text.slice(at + 1);
    let best: string | null = null;
    for (const value of confirmedValues) {
        if (!value || (!value.includes(' ') && !value.includes('\t'))) continue;
        if (!rest.startsWith(value)) continue;
        const next = text[at + 1 + value.length];
        if (next !== undefined && !/\s/.test(next)) continue;
        if (!best || value.length > best.length) best = value;
    }
    if (!best) return null;
    return { value: best, end: at + 1 + best.length };
};
