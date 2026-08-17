import type { Part } from '@opencode-ai/sdk/v2';
import { stripComposerTriggerIconSlot } from '@/composer/inline-visual';

const IMAGE_FILENAME_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|heic|heif|tiff?)$/i;

const isCodeSelectionFilename = (filename: string, mime?: string): boolean => (
    mime === 'text/plain' && /:\d+(?:-\d+)?$/.test(filename)
);

const isAbsoluteCitationPath = (value: string): boolean => (
    value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
);

const isImageFilePart = (filename: string, mime?: string): boolean => (
    Boolean(mime?.startsWith('image/')) || IMAGE_FILENAME_PATTERN.test(filename)
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

const collectAbsoluteImageCitations = (text: string): string[] => {
    const citations: string[] = [];
    let cursor = 0;
    while (cursor < text.length) {
        const start = text.indexOf('[', cursor);
        if (start === -1) break;
        const end = text.indexOf(']', start + 1);
        if (end === -1) break;
        if (text[end + 1] === '(') {
            cursor = end + 1;
            continue;
        }
        const filename = stripComposerTriggerIconSlot(text.slice(start + 1, end)).trim();
        if (isAbsoluteCitationPath(filename) && IMAGE_FILENAME_PATTERN.test(filename)) {
            citations.push(filename);
        }
        cursor = end + 1;
    }
    return citations;
};

/**
 * Map durable `[/abs/hash.png]` citations back to the short file-part
 * filename so sent-message chips stay `[image-1.png]`.
 */
export const buildCitationHintsFromParts = (
    parts: readonly Part[] | undefined,
    text?: string,
): {
    icons: Map<string, 'image' | 'attachment'>;
    displayNames: Map<string, string>;
} => {
    const icons = buildCitationIconsFromParts(parts);
    const displayNames = new Map<string, string>();
    if (!text || !parts?.length) return { icons, displayNames };

    const imageFilenames: string[] = [];
    for (const part of parts) {
        if (part.type !== 'file') continue;
        const filename = typeof part.filename === 'string' ? part.filename.trim() : '';
        if (!filename) continue;
        const mime = typeof part.mime === 'string' ? part.mime : undefined;
        if (isImageFilePart(filename, mime)) imageFilenames.push(filename);
    }
    if (imageFilenames.length === 0) return { icons, displayNames };

    const pathCitations = collectAbsoluteImageCitations(text);
    const assign = (citation: string, filename: string) => {
        const key = citation.toLowerCase();
        displayNames.set(key, filename);
        icons.set(key, 'image');
    };
    if (imageFilenames.length === 1) {
        for (const citation of pathCitations) assign(citation, imageFilenames[0]!);
        return { icons, displayNames };
    }
    pathCitations.forEach((citation, index) => {
        const filename = imageFilenames[index];
        if (filename) assign(citation, filename);
    });
    return { icons, displayNames };
};
