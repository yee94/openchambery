import {
    attachmentCitationDisplay,
    COMPOSER_TRIGGER_ICON_SLOT,
    stripComposerTriggerIconSlot,
} from '@/composer/inline-visual';

export interface ImageAttachmentCandidate {
    name: string;
    type?: string;
}

export interface CitationRange {
    start: number;
    end: number;
}

export interface AttachmentCitationDeletionIntent {
    key: 'Backspace' | 'Delete';
    selectionStart: number;
    selectionEnd: number;
    altKey?: boolean;
}

export interface AttachmentCitationDeletionResult {
    text: string;
    caret: number;
    removedFilenames: string[];
}

export interface AttachmentCitationCandidate {
    source: 'local' | 'server' | 'vscode';
    vscodeSource?: 'file' | 'selection';
    mimeType?: string;
}

export interface CodeSelectionCitationCandidate extends AttachmentCitationCandidate {
    filename: string;
    vscodePath?: string;
}

export interface DisplayFilePartCandidate {
    filename?: string;
    mime?: string;
}

const GENERIC_IMAGE_BASENAMES = new Set([
    'image',
    'screenshot',
    'screen-shot',
    'clipboard',
    'pasted-image',
    'pastedimage',
    'untitled',
    'unknown',
    'file',
    'blob',
]);

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/gif': 'gif',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/webp': 'webp',
};

const normalizeFilenameKey = (filename: string): string => filename.trim().toLowerCase();

const isUnsafeFilenameChar = (char: string): boolean => (
    char.charCodeAt(0) < 32 || '<>:"/\\|?*[]'.includes(char)
);

const sanitizeFilename = (name: string): string => {
    const basename = name.replace(/\\/g, '/').split('/').pop() ?? '';
    return Array.from(basename)
        .map((char) => (isUnsafeFilenameChar(char) ? '-' : char))
        .join('')
        .replace(/\s+/g, ' ')
        .replace(/-+/g, '-')
        .trim();
};

const getMimeExtension = (mimeType?: string): string => {
    const normalized = mimeType?.trim().toLowerCase() ?? '';
    return IMAGE_MIME_EXTENSIONS[normalized] ?? 'png';
};

const splitImageFilename = (candidate: ImageAttachmentCandidate): { base: string; ext: string } => {
    const clean = sanitizeFilename(candidate.name);
    const fallbackExt = getMimeExtension(candidate.type);
    const lastDot = clean.lastIndexOf('.');

    if (lastDot > 0 && lastDot < clean.length - 1) {
        const rawExt = clean.slice(lastDot + 1).toLowerCase();
        if (/^[a-z0-9]{1,10}$/.test(rawExt)) {
            return {
                base: clean.slice(0, lastDot).trim() || 'image',
                ext: rawExt,
            };
        }
    }

    return {
        base: clean.trim() || 'image',
        ext: fallbackExt,
    };
};

export const isGenericImageFilename = (filename: string): boolean => {
    const { base } = splitImageFilename({ name: filename });
    const normalized = base
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

    if (GENERIC_IMAGE_BASENAMES.has(normalized)) {
        return true;
    }

    const withoutCopyCounter = normalized.replace(/-\(\d+\)$/g, '');
    if (withoutCopyCounter !== normalized && GENERIC_IMAGE_BASENAMES.has(withoutCopyCounter)) {
        return true;
    }

    return /^(image|file|unknown|untitled|blob)-\d+$/.test(normalized);
};

const withExtension = (base: string, ext: string): string => `${base}.${ext}`;

const nextUniqueFilename = (base: string, ext: string, used: Set<string>): string => {
    const first = withExtension(base, ext);
    if (!used.has(normalizeFilenameKey(first))) {
        return first;
    }

    for (let index = 2; index < Number.MAX_SAFE_INTEGER; index += 1) {
        const candidate = withExtension(`${base}-${index}`, ext);
        if (!used.has(normalizeFilenameKey(candidate))) {
            return candidate;
        }
    }

    return withExtension(`${base}-${Date.now()}`, ext);
};

const nextGeneratedImageFilename = (ext: string, used: Set<string>): string => {
    for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
        const candidate = withExtension(`image-${index}`, ext);
        const generatedBaseTaken = Array.from(used).some((filename) => filename.startsWith(`image-${index}.`));
        if (!generatedBaseTaken && !used.has(normalizeFilenameKey(candidate))) {
            return candidate;
        }
    }

    return withExtension(`image-${Date.now()}`, ext);
};

export const assignImageAttachmentFilenames = (
    files: ImageAttachmentCandidate[],
    existingFilenames: string[],
): string[] => {
    const used = new Set(existingFilenames.map(normalizeFilenameKey));

    return files.map((file) => {
        const { base, ext } = splitImageFilename(file);
        const filename = isGenericImageFilename(withExtension(base, ext))
            ? nextGeneratedImageFilename(ext, used)
            : nextUniqueFilename(base, ext, used);
        used.add(normalizeFilenameKey(filename));
        return filename;
    });
};

export const buildAttachmentCitationText = (filenames: string[]): string => (
    filenames.map((filename) => attachmentCitationDisplay(filename)).join(' ')
);

/** Drop reserved icon wells before delivery so agents see plain `[filename]`. */
export const stripAttachmentCitationSlotsForDelivery = (text: string): string => (
    text.replaceAll(`[${COMPOSER_TRIGGER_ICON_SLOT}`, '[')
);

export const getAttachmentCitationIconPath = (filename: string): string => (
    filename.replace(/:\d+(?:-\d+)?$/, '')
);

export const isInlineAttachmentCitation = (attachment: AttachmentCitationCandidate): boolean => (
    (attachment.source === 'vscode' && attachment.vscodeSource === 'selection')
    || attachment.mimeType?.startsWith('image/') === true
);

export const expandCodeSelectionCitations = (
    text: string,
    attachments: CodeSelectionCitationCandidate[] | undefined,
): string => {
    let expanded = text;
    for (const attachment of attachments ?? []) {
        if (attachment.source !== 'vscode' || attachment.vscodeSource !== 'selection' || !attachment.vscodePath) {
            continue;
        }
        const lineRange = attachment.filename.match(/:(\d+(?:-\d+)?)$/)?.[1];
        if (!lineRange) continue;
        const expandedToken = `[${attachment.vscodePath}:${lineRange}]`;
        expanded = expanded
            .split(attachmentCitationDisplay(attachment.filename))
            .join(expandedToken)
            .split(`[${attachment.filename}]`)
            .join(expandedToken);
    }
    return expanded;
};

export const isCodeSelectionFilePart = (part: DisplayFilePartCandidate): boolean => (
    part.mime === 'text/plain'
    && typeof part.filename === 'string'
    && /:\d+(?:-\d+)?$/.test(part.filename)
);

/** OpenCode directory attachment mime — keep in sync with opencode session/prompt. */
export const DIRECTORY_ATTACHMENT_MIME = 'application/x-directory';

export const isDirectoryAttachmentMime = (mime?: string | null): boolean => (
    typeof mime === 'string' && mime.trim().toLowerCase() === DIRECTORY_ATTACHMENT_MIME
);

/** Trailing slash is OpenCode's lightweight directory marker on paths/URLs. */
export const isDirectoryAttachmentPath = (path?: string | null): boolean => (
    typeof path === 'string' && /[/\\]$/.test(path.trim())
);

export const findAttachmentCitationRanges = (text: string, filenames: string[]): CitationRange[] => {
    if (!text || !text.includes('[') || filenames.length === 0) {
        return [];
    }

    const known = new Set(filenames.map(normalizeFilenameKey));
    const ranges: CitationRange[] = [];
    let cursor = 0;

    while (cursor < text.length) {
        const start = text.indexOf('[', cursor);
        if (start === -1) {
            break;
        }

        const end = text.indexOf(']', start + 1);
        if (end === -1) {
            break;
        }

        // Markdown links keep their normal link highlighting; attachment citations
        // are plain bracket references like [desktop.png] or reserved [␠desktop.png].
        if (text[end + 1] !== '(') {
            const name = stripComposerTriggerIconSlot(text.slice(start + 1, end)).trim();
            if (known.has(normalizeFilenameKey(name))) {
                ranges.push({ start, end: end + 1 });
            }
        }

        cursor = end + 1;
    }

    return ranges;
};

export const removeAttachmentCitations = (text: string, filenames: string[]): string => {
    const ranges = findAttachmentCitationRanges(text, filenames);
    let nextText = text;

    for (let index = ranges.length - 1; index >= 0; index -= 1) {
        const range = ranges[index];
        let start = range.start;
        let end = range.end;

        if (end < nextText.length && /\s/.test(nextText[end])) {
            end += 1;
        } else if (start > 0 && /\s/.test(nextText[start - 1])) {
            start -= 1;
        }

        nextText = `${nextText.slice(0, start)}${nextText.slice(end)}`;
    }

    return nextText;
};

const getWordDeletionRange = (
    text: string,
    key: AttachmentCitationDeletionIntent['key'],
    cursor: number,
): CitationRange => {
    if (key === 'Backspace') {
        let start = cursor;
        while (start > 0 && /\s/.test(text[start - 1])) start -= 1;
        while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
        return { start, end: cursor };
    }

    let end = cursor;
    while (end < text.length && /\s/.test(text[end])) end += 1;
    while (end < text.length && !/\s/.test(text[end])) end += 1;
    return { start: cursor, end };
};

export const resolveAttachmentCitationDeletion = (
    text: string,
    filenames: string[],
    intent: AttachmentCitationDeletionIntent,
): AttachmentCitationDeletionResult | null => {
    const selectionStart = Math.max(0, Math.min(intent.selectionStart, text.length));
    const selectionEnd = Math.max(selectionStart, Math.min(intent.selectionEnd, text.length));
    let deletionRange: CitationRange;

    if (selectionStart !== selectionEnd) {
        deletionRange = { start: selectionStart, end: selectionEnd };
    } else if (intent.altKey) {
        deletionRange = getWordDeletionRange(text, intent.key, selectionStart);
    } else if (intent.key === 'Backspace') {
        deletionRange = { start: Math.max(0, selectionStart - 1), end: selectionStart };
    } else {
        deletionRange = { start: selectionStart, end: Math.min(text.length, selectionStart + 1) };
    }

    if (deletionRange.start === deletionRange.end) return null;

    const intersected = findAttachmentCitationRanges(text, filenames).filter((range) => (
        range.start < deletionRange.end && range.end > deletionRange.start
    ));
    if (intersected.length === 0) return null;

    let start = Math.min(deletionRange.start, ...intersected.map((range) => range.start));
    let end = Math.max(deletionRange.end, ...intersected.map((range) => range.end));

    if (end < text.length && /\s/.test(text[end]) && (start === 0 || /\s/.test(text[start - 1]))) {
        end += 1;
    } else if (end === text.length && start > 0 && /\s/.test(text[start - 1])) {
        start -= 1;
    }

    return {
        text: `${text.slice(0, start)}${text.slice(end)}`,
        caret: start,
        removedFilenames: intersected.map((range) => text.slice(range.start + 1, range.end - 1)),
    };
};
