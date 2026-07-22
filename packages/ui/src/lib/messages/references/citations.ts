import type { Part } from '@opencode-ai/sdk/v2';

const isCodeSelectionFilename = (filename: string, mime?: string): boolean => (
    mime === 'text/plain' && /:\d+(?:-\d+)?$/.test(filename)
);

/** Build citation icon hints from sibling file parts on the same user message. */
export const buildCitationIconsFromParts = (
    parts: readonly Part[] | undefined,
): Map<string, 'image' | 'attachment'> => {
    const icons = new Map<string, 'image' | 'attachment'>();
    if (!parts || parts.length === 0) return icons;

    for (const part of parts) {
        if (part.type !== 'file') continue;
        const filename = typeof part.filename === 'string' ? part.filename.trim() : '';
        if (!filename) continue;
        const key = filename.toLowerCase();
        const mime = typeof part.mime === 'string' ? part.mime : undefined;
        if (mime?.startsWith('image/')) {
            icons.set(key, 'image');
            continue;
        }
        if (isCodeSelectionFilename(filename, mime)) {
            icons.set(key, 'attachment');
        }
    }

    return icons;
};
