import { DRAFT_COMPOSER_TRIGGER_ICON_SLOT } from '@/sync/input-draft-types';
import { buildAgentHref, buildSkillHref } from '@/lib/messages/inlineMessageLinks';
import type {
    MessageReferenceDecoration,
    MessageReferenceSpan,
    MessageReferenceStrategy,
} from './types';

export const MESSAGE_REFERENCE_CLASS = 'text-[var(--primary)]';

const IMAGE_FILENAME_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|heic|heif|tiff?)$/i;
const SLASH_TOKEN_PATTERN = /(^|\s)\/([A-Za-z0-9][A-Za-z0-9_-]*)/g;
const CANONICAL_SKILL_PATTERN = /\[skill:([A-Za-z0-9][A-Za-z0-9_-]*)\]/g;
const CANONICAL_COMMAND_PATTERN = /\[command:([^\]\r\n]+)\]/g;
const SESSION_TOKEN_PATTERN = /(^|[\s([{])(@session:([A-Za-z0-9_-]+))(?=$|[\s)\]},.!?;:])/g;
const MENTION_PATTERN = /@([^\s]+)/g;
/** Composer may persist the reserved icon slot between `@` and the session label. */
const SESSION_VISIBLE_SLOT = DRAFT_COMPOSER_TRIGGER_ICON_SLOT;

const commandNameFromReference = (reference: string): string => (
    reference.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.md$/, '') ?? ''
);

const normalizeFilenameKey = (filename: string): string => filename.trim().toLowerCase();

const isBoundaryBefore = (text: string, index: number): boolean => {
    const charBefore = index > 0 ? text[index - 1] : null;
    return !charBefore || /(\s|\(|\)|\[|\]|\{|\}|"|'|`|,|\.|;|:)/.test(charBefore);
};

const looksLikeFilePath = (mention: string): boolean => (
    mention.includes('/') || mention.includes('\\') || mention.includes('.')
);

const pushSpan = (
    spans: MessageReferenceSpan[],
    span: MessageReferenceSpan,
): void => {
    spans.push(span);
};

export const skillReferenceStrategy: MessageReferenceStrategy = {
    kind: 'skill',
    priority: 120,
    shouldScan: (text) => text.includes('/') || text.includes('[skill:'),
    detect: (text, context) => {
        const spans: MessageReferenceSpan[] = [];
        const known = context.skillNames;

        // Canonical tags are durable wire form — always decorate them even if the
        // skill was uninstalled later. Slash tokens still require a known name.
        CANONICAL_SKILL_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = CANONICAL_SKILL_PATTERN.exec(text)) !== null) {
            const skillName = match[1];
            pushSpan(spans, {
                start: match.index,
                end: match.index + match[0].length,
                kind: 'skill',
                raw: match[0],
                label: `/${skillName}`,
                payload: { kind: 'skill', skillName },
            });
        }

        if (!known || known.size === 0) return spans;

        const knownLower = new Map(Array.from(known, (name) => [name.toLowerCase(), name]));
        SLASH_TOKEN_PATTERN.lastIndex = 0;
        while ((match = SLASH_TOKEN_PATTERN.exec(text)) !== null) {
            const token = match[2];
            const skillName = knownLower.get(token.toLowerCase());
            if (!skillName) continue;
            const start = match.index + match[1].length;
            const end = start + token.length + 1;
            // Prefer canonical `[skill:…]` when both forms somehow overlap.
            if (spans.some((span) => span.start < end && span.end > start)) continue;
            pushSpan(spans, {
                start,
                end,
                kind: 'skill',
                raw: text.slice(start, end),
                label: `/${skillName}`,
                payload: { kind: 'skill', skillName },
            });
        }

        return spans;
    },
    decorate: (span) => {
        const skillName = span.payload.kind === 'skill' ? span.payload.skillName : span.label.slice(1);
        return {
            kind: 'skill',
            label: span.label,
            icon: 'book-open',
            className: MESSAGE_REFERENCE_CLASS,
            href: buildSkillHref(skillName),
            skillName,
        };
    },
};

export const commandReferenceStrategy: MessageReferenceStrategy = {
    kind: 'command',
    priority: 115,
    shouldScan: (text, context) => text.includes('[command:') || (Boolean(context.commandNames?.size) && text.includes('/')),
    detect: (text, context) => {
        const spans: MessageReferenceSpan[] = [];

        CANONICAL_COMMAND_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = CANONICAL_COMMAND_PATTERN.exec(text)) !== null) {
            const reference = match[1];
            const commandName = commandNameFromReference(reference);
            if (!commandName) continue;
            pushSpan(spans, {
                start: match.index,
                end: match.index + match[0].length,
                kind: 'command',
                raw: match[0],
                label: `/${commandName}`,
                payload: { kind: 'command', commandName, reference },
            });
        }

        const known = context.commandNames;
        if (!known || known.size === 0) return spans;
        const knownLower = new Map(Array.from(known, (name) => [name.toLowerCase(), name]));
        SLASH_TOKEN_PATTERN.lastIndex = 0;
        while ((match = SLASH_TOKEN_PATTERN.exec(text)) !== null) {
            const token = match[2];
            const commandName = knownLower.get(token.toLowerCase());
            if (!commandName) continue;
            const start = match.index + match[1].length;
            const end = start + token.length + 1;
            if (spans.some((span) => span.start < end && span.end > start)) continue;
            pushSpan(spans, {
                start,
                end,
                kind: 'command',
                raw: text.slice(start, end),
                label: `/${commandName}`,
                payload: { kind: 'command', commandName },
            });
        }

        return spans;
    },
    decorate: (span) => ({
        kind: 'command',
        label: span.label,
        icon: 'command',
        className: MESSAGE_REFERENCE_CLASS,
    }),
};

export const citationReferenceStrategy: MessageReferenceStrategy = {
    kind: 'image',
    priority: 110,
    shouldScan: (text) => text.includes('['),
    detect: (text, context) => {
        const spans: MessageReferenceSpan[] = [];
        let cursor = 0;
        while (cursor < text.length) {
            const start = text.indexOf('[', cursor);
            if (start === -1) break;
            const end = text.indexOf(']', start + 1);
            if (end === -1) break;
            // Skip markdown links: [label](url)
            if (text[end + 1] === '(') {
                cursor = end + 1;
                continue;
            }

            const filename = text.slice(start + 1, end).trim();
            const key = normalizeFilenameKey(filename);
            const configured = context.citationIcons?.get(key);
            const inferredImage = !configured && IMAGE_FILENAME_PATTERN.test(filename);
            const iconKind = configured ?? (inferredImage ? 'image' : null);
            if (!iconKind) {
                cursor = end + 1;
                continue;
            }

            pushSpan(spans, {
                start,
                end: end + 1,
                kind: iconKind,
                raw: text.slice(start, end + 1),
                label: filename,
                payload: iconKind === 'image'
                    ? { kind: 'image', filename }
                    : { kind: 'attachment', filename },
            });
            cursor = end + 1;
        }
        return spans;
    },
    decorate: (span) => {
        const filename = span.payload.kind === 'image' || span.payload.kind === 'attachment'
            ? span.payload.filename
            : span.label;
        return {
            kind: span.kind === 'attachment' ? 'attachment' : 'image',
            label: filename,
            icon: span.kind === 'attachment' ? 'attachment-2' : 'file-image',
            className: MESSAGE_REFERENCE_CLASS,
            filename,
        };
    },
};

export const sessionReferenceStrategy: MessageReferenceStrategy = {
    kind: 'session',
    priority: 105,
    shouldScan: (text) => text.includes('@'),
    detect: (text, context) => {
        const spans: MessageReferenceSpan[] = [];
        SESSION_TOKEN_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = SESSION_TOKEN_PATTERN.exec(text)) !== null) {
            const sessionId = match[3];
            const start = match.index + match[1].length;
            const end = start + match[2].length;
            const sessionLabel = context.sessionTitles?.get(sessionId) ?? sessionId;
            pushSpan(spans, {
                start,
                end,
                kind: 'session',
                raw: text.slice(start, end),
                label: sessionLabel,
                payload: { kind: 'session', sessionId, sessionLabel },
            });
        }

        const visibleMentions = [...(context.sessionMentions ?? [])]
            .filter((mention) => mention.sessionLabel.length > 0)
            .sort((left, right) => right.sessionLabel.length - left.sessionLabel.length);
        for (const mention of visibleMentions) {
            // Prefer the reserved-slot form first so `@␠Label` wins over a bare `@Label` prefix.
            const tokens = [
                `@${SESSION_VISIBLE_SLOT}${mention.sessionLabel}`,
                `@${mention.sessionLabel}`,
            ];
            for (const token of tokens) {
                let start = text.indexOf(token);
                while (start !== -1) {
                    const end = start + token.length;
                    const boundaryBefore = start === 0 || /[\s([{]/.test(text[start - 1]);
                    const boundaryAfter = end === text.length || /[\s)\]},.!?;:]/.test(text[end]);
                    const overlaps = spans.some((span) => span.start < end && span.end > start);
                    if (boundaryBefore && boundaryAfter && !overlaps) {
                        pushSpan(spans, {
                            start,
                            end,
                            kind: 'session',
                            raw: text.slice(start, end),
                            label: mention.sessionLabel,
                            payload: { kind: 'session', sessionId: mention.sessionId, sessionLabel: mention.sessionLabel },
                        });
                    }
                    start = text.indexOf(token, end);
                }
            }
        }
        return spans;
    },
    decorate: (span) => {
        const sessionId = span.payload.kind === 'session' ? span.payload.sessionId : undefined;
        const sessionLabel = span.payload.kind === 'session' ? span.payload.sessionLabel : span.label;
        return {
            kind: 'session',
            label: sessionLabel,
            icon: 'chat-thread',
            className: MESSAGE_REFERENCE_CLASS,
            sessionId,
        };
    },
};

export const mentionReferenceStrategy: MessageReferenceStrategy = {
    kind: 'file',
    priority: 100,
    shouldScan: (text) => text.includes('@'),
    detect: (text, context) => {
        const spans: MessageReferenceSpan[] = [];
        const agentNames = context.agentNames;
        const filePaths = context.filePaths;
        const allowPathHeuristics = context.allowPathHeuristics === true;

        MENTION_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = MENTION_PATTERN.exec(text)) !== null) {
            const start = match.index;
            if (!isBoundaryBefore(text, start)) continue;
            if (match[1].startsWith('session:')) continue;

            const mention = match[1].trim().replace(/[),.;:!?`"'>]+$/g, '');
            if (!mention) continue;
            const end = start + 1 + mention.length;
            const raw = text.slice(start, end);

            if (agentNames?.has(mention.toLowerCase())) {
                pushSpan(spans, {
                    start,
                    end,
                    kind: 'agent',
                    raw,
                    label: raw,
                    payload: { kind: 'agent', agentName: mention },
                });
                continue;
            }

            const normalized = mention.replace(/\\/g, '/').replace(/^\.\//, '');
            const confirmed = filePaths?.has(mention)
                || filePaths?.has(normalized)
                || filePaths?.has(normalized.replace(/^\/+/, ''));
            if (confirmed || (allowPathHeuristics && looksLikeFilePath(mention))) {
                pushSpan(spans, {
                    start,
                    end,
                    kind: 'file',
                    raw,
                    label: raw,
                    payload: { kind: 'file', path: mention },
                });
            }
        }
        return spans;
    },
    decorate: (span) => {
        if (span.kind === 'agent' && span.payload.kind === 'agent') {
            return {
                kind: 'agent',
                label: span.label,
                icon: null,
                className: MESSAGE_REFERENCE_CLASS,
                href: buildAgentHref(span.payload.agentName),
                agentName: span.payload.agentName,
            };
        }
        const path = span.payload.kind === 'file' ? span.payload.path : span.label;
        return {
            kind: 'file',
            label: span.label,
            icon: null,
            className: MESSAGE_REFERENCE_CLASS,
            path,
        };
    },
};

/** Ordered strategy list — priority still decides overlap winners. */
export const DEFAULT_MESSAGE_REFERENCE_STRATEGIES: readonly MessageReferenceStrategy[] = [
    skillReferenceStrategy,
    commandReferenceStrategy,
    citationReferenceStrategy,
    sessionReferenceStrategy,
    mentionReferenceStrategy,
];

export const decorateMessageReference = (
    span: MessageReferenceSpan,
    strategies: readonly MessageReferenceStrategy[] = DEFAULT_MESSAGE_REFERENCE_STRATEGIES,
): MessageReferenceDecoration => {
    const strategy = strategies.find((item) => item.kind === span.kind)
        ?? strategies.find((item) => item.decorate(span).kind === span.kind);
    if (strategy) return strategy.decorate(span);
    // Citation strategy owns both image and attachment kinds.
    if (span.kind === 'image' || span.kind === 'attachment') {
        return citationReferenceStrategy.decorate(span);
    }
    if (span.kind === 'agent') {
        return mentionReferenceStrategy.decorate(span);
    }
    return {
        kind: span.kind,
        label: span.label,
        icon: null,
        className: MESSAGE_REFERENCE_CLASS,
    };
};
