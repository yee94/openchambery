const FILE_DROP_DATA_TYPES = [
    'CodeFiles',
    'codefiles',
    'application/vnd.code.tree',
    'application/vnd.code.tree.explorer',
    'text/uri-list',
    'text/plain',
];

const isLikelyAbsolutePath = (value: string): boolean => (
    value.startsWith('/')
    || value.startsWith('//')
    || value.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(value)
);

/**
 * Plain-text paste is shared by real filesystem paths and Composer slash chips
 * (`/release`, `/\u2003release args`). A naive "starts with /" check turns those
 * chips into `@/release` file mentions. Require multi-segment path shape and
 * reject unescaped whitespace for text/plain only; drag/drop MIME types keep the
 * broader absolute-path check.
 */
const isLikelyPlainTextFilesystemPath = (value: string): boolean => {
    if (!isLikelyAbsolutePath(value)) return false;
    // Slash-command invocations commonly carry arguments after the head token.
    if (/\s/.test(value)) return false;

    if (value.startsWith('//') || value.startsWith('\\\\')) {
        // UNC: //server/share or \\server\share — need a share segment.
        const body = value.replace(/^[\\/]+/, '');
        return /[\\/]/.test(body);
    }

    if (/^[A-Za-z]:[\\/]/.test(value)) {
        // Windows: require another separator or a filename with extension so
        // bare `C:\release`-shaped tokens are not hijacked from slash paste.
        const rest = value.slice(3);
        return rest.includes('\\') || rest.includes('/') || rest.includes('.');
    }

    // POSIX absolute: reject single-segment `/release` (slash commands) while
    // keeping multi-segment paths such as `/tmp/one.txt`.
    const withoutRoot = value.replace(/^\/+/, '');
    return withoutRoot.includes('/');
};

const toLikelyFileDropReference = (
    value: string,
    { fromPlainText = false }: { fromPlainText?: boolean } = {},
): string | null => {
    const trimmed = value.trim().replace(/^['"]+|['"]+$/g, '');
    if (!trimmed || trimmed === '/>' || /[\r\n]/.test(trimmed)) {
        return null;
    }

    if (trimmed.toLowerCase().startsWith('file://')) {
        return trimmed;
    }

    if (fromPlainText ? isLikelyPlainTextFilesystemPath(trimmed) : isLikelyAbsolutePath(trimmed)) {
        return trimmed;
    }

    return null;
};

const collectStringLeaves = (input: unknown, output: Set<string>, depth = 0): void => {
    if (depth > 6 || input == null) {
        return;
    }

    if (typeof input === 'string') {
        output.add(input);
        return;
    }

    if (Array.isArray(input)) {
        for (const item of input) {
            collectStringLeaves(item, output, depth + 1);
        }
        return;
    }

    if (typeof input !== 'object') {
        return;
    }

    for (const value of Object.values(input)) {
        collectStringLeaves(value, output, depth + 1);
    }
};

type FileDropReferenceParseOptions = {
    allowMultipleLines?: boolean;
    allowStructuredPayload?: boolean;
    /** text/plain paste — stricter so slash chips are not treated as absolute paths. */
    fromPlainText?: boolean;
};

export const parseFileDropReferences = (
    rawPayload: string,
    {
        allowMultipleLines = true,
        allowStructuredPayload = true,
        fromPlainText = false,
    }: FileDropReferenceParseOptions = {},
): string[] => {
    const extracted = new Set<string>();

    const addCandidatesFromText = (value: string): void => {
        const direct = toLikelyFileDropReference(value, { fromPlainText });
        if (direct) {
            extracted.add(direct);
            return;
        }

        if (allowMultipleLines) {
            for (const line of value.split(/\r?\n/)) {
                const candidate = toLikelyFileDropReference(line, { fromPlainText });
                if (candidate) {
                    extracted.add(candidate);
                }
            }
        }
    };

    addCandidatesFromText(rawPayload);

    if (allowStructuredPayload) {
        try {
            const parsed = JSON.parse(rawPayload) as unknown;
            const leaves = new Set<string>();
            collectStringLeaves(parsed, leaves);
            for (const leaf of leaves) {
                addCandidatesFromText(leaf);
            }
        } catch {
            // Ignore non-JSON payloads.
        }
    }

    return Array.from(extracted);
};

export const collectFileDropReferences = (dataTransfer: Pick<DataTransfer, 'getData'> | null | undefined): string[] => {
    if (!dataTransfer || typeof dataTransfer.getData !== 'function') {
        return [];
    }

    const extracted = new Set<string>();
    for (const dataType of FILE_DROP_DATA_TYPES) {
        let rawPayload = '';
        try {
            rawPayload = dataTransfer.getData(dataType);
        } catch {
            continue;
        }

        const parseOptions = dataType === 'text/plain'
            ? { allowMultipleLines: false, allowStructuredPayload: false, fromPlainText: true }
            : dataType === 'text/uri-list'
                ? { allowStructuredPayload: false }
                : undefined;
        for (const candidate of parseFileDropReferences(rawPayload, parseOptions)) {
            extracted.add(candidate);
        }
    }

    return Array.from(extracted);
};

export const normalizeFileDropPath = (rawPath: string): string => {
    const input = rawPath.trim();
    if (!input.toLowerCase().startsWith('file://')) {
        return input;
    }

    try {
        const url = new URL(input);
        let pathname = decodeURIComponent(url.pathname || '');
        if (url.hostname && url.hostname !== 'localhost') {
            pathname = `//${url.hostname}${pathname}`;
        }
        if (/^\/[A-Za-z]:\//.test(pathname)) {
            pathname = pathname.slice(1);
        }
        return pathname || input;
    } catch {
        const stripped = input.replace(/^file:\/\//i, '');
        try {
            return decodeURIComponent(stripped);
        } catch {
            return stripped;
        }
    }
};

export const isAbsoluteFileDropPath = (path: string): boolean => isLikelyAbsolutePath(path);
