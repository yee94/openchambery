import type { AttachedFile } from '@/stores/types/sessionTypes';
import { createUuid } from '@/lib/uuid';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { compileAuthoredDeliveryPlan, dedupeDeliveryAttachments } from '@/composer/delivery';
import type { ComposerReferenceSemantic } from '@/composer/extensions';
import type { ComposerSendPlan } from '@/composer/send-plan';
import { getSyncSessions } from '@/sync/sync-refs';
import { basename, isAbsolute, join, normalize } from 'pathe';
import {
    DIRECTORY_ATTACHMENT_MIME,
    expandCodeSelectionCitations,
    stripAttachmentCitationSlotsForDelivery,
} from './attachmentCitations';
import { collectSessionMentionIds, replaceSessionMentionTokens } from './fileMentionAutocompleteState';

// Optional reserved icon em-space between `/` and the skill name.
const INLINE_SKILL_TOKEN_PATTERN = /(^|\s)\/\u2003?([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/g;

/** Normalize filesystem paths with pathe (POSIX + Windows drive + UNC → `/` separators). */
const normalizeFsPath = (path: string): string => normalize(path.trim());

/** Encode a normalized filesystem path as a file:// URL (drive letters → file:///C:/...). */
const toServerFileUrl = (filepath: string): string => {
    const trimmed = filepath.trim();
    if (trimmed.toLowerCase().startsWith('file://')) return trimmed;
    const normalized = normalizeFsPath(trimmed);
    const encoded = normalized
        .split('/')
        .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
        .join('/');
    // Drive-letter paths need an extra slash so URL pathname is `/C:/...`.
    if (/^[A-Za-z]:/.test(encoded)) return `file:///${encoded}`;
    return `file://${encoded}`;
};

export const legacyTextToAuthoredPlan = (text: string): ComposerSendPlan => ({
    chunks: [{ provenance: 'authored', text, start: 0, end: text.length }],
    semantics: [],
});

export const extractInlineFileMentions = ({ text, root, confirmedFilePaths, confirmedDirectoryPaths = [], agentNames }: {
    text: string;
    root?: string | null;
    confirmedFilePaths: readonly string[];
    /** Paths known to be directories (from @ autocomplete directory hits). */
    confirmedDirectoryPaths?: readonly string[];
    agentNames: ReadonlySet<string>;
}): AttachedFile[] => {
    const attachments: AttachedFile[] = [];
    const seenPaths = new Set<string>();
    // Trailing slashes stripped for stable join; pathe keeps drive/UNC roots intact.
    const normalizedRoot = root ? normalizeFsPath(root).replace(/\/+$/, '') : '';
    const normalizeMentionPath = (path: string): string => normalizeFsPath(path).replace(/^\.\//, '');
    const confirmed = new Set(confirmedFilePaths.map((path) => normalizeMentionPath(path)));
    const confirmedDirectories = new Set(confirmedDirectoryPaths.map((path) => normalizeMentionPath(path)));
    const mentions = /@([^\s]+)/g;
    let match: RegExpExecArray | null;
    while ((match = mentions.exec(text)) !== null) {
        const before = match.index > 0 ? text[match.index - 1] : null;
        if (before && !/(\s|\(|\)|\[|\]|\{|\}|"|'|`|,|\.|;|:)/.test(before)) continue;
        const mention = match[1].trim().replace(/^[`"'<(]+/, '').replace(/[),.;:!?`"'>]+$/g, '');
        if (!mention || agentNames.has(mention.toLowerCase())) continue;
        const normalizedMentionPath = normalizeMentionPath(mention);
        // Relative form for confirmed-set matching (strip leading `/` only; never strip drive/UNC).
        const relativeMentionKey = isAbsolute(mention) || isAbsolute(normalizedMentionPath)
            ? normalizedMentionPath
            : normalizedMentionPath.replace(/^\/+/, '');
        const looksLikePath = confirmed.has(normalizedMentionPath)
            || confirmed.has(relativeMentionKey)
            || mention.includes('/')
            || mention.includes('\\')
            || mention.includes('.');
        if (!looksLikePath) continue;
        // Absolute Windows drive / UNC / POSIX paths keep their own root — never join project root.
        const normalizedServerPath = (isAbsolute(mention) || isAbsolute(normalizedMentionPath))
            ? normalizedMentionPath
            : normalizedRoot
                ? join(normalizedRoot, relativeMentionKey)
                : null;
        if (!relativeMentionKey || !normalizedServerPath || seenPaths.has(normalizedServerPath)) continue;
        seenPaths.add(normalizedServerPath);
        const filename = basename(normalizedServerPath) || relativeMentionKey;
        // Prefer OpenCode's directory mime so message chips render a folder icon.
        const isDirectory = confirmedDirectories.has(normalizedMentionPath)
            || confirmedDirectories.has(relativeMentionKey)
            || /[/\\]$/.test(mention);
        const mimeType = isDirectory ? DIRECTORY_ATTACHMENT_MIME : 'text/plain';
        attachments.push({ id: createUuid(), file: new File([], filename, { type: mimeType }), filename, mimeType, size: 0, dataUrl: toServerFileUrl(normalizedServerPath), source: 'server', serverPath: normalizedServerPath });
    }
    return attachments;
};

const collectSkillSemantics = (text: string, installedSkillNames: ReadonlySet<string>): ComposerReferenceSemantic[] => {
    const semantics: ComposerReferenceSemantic[] = [];
    const seen = new Set<string>();
    INLINE_SKILL_TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_SKILL_TOKEN_PATTERN.exec(text)) !== null) {
        const name = match[2] || '';
        if (installedSkillNames.has(name) && !seen.has(name)) {
            seen.add(name);
            semantics.push({ type: 'skill', skillName: name });
        }
    }
    return semantics;
};

export const compileChatComposerDelivery = ({ plan, agents, installedSkillNames, directory, root, confirmedFilePaths = [], confirmedDirectoryPaths = [], citationAttachments = [] }: {
    plan: ComposerSendPlan;
    agents: Parameters<typeof parseAgentMentions>[1];
    installedSkillNames: ReadonlySet<string>;
    directory: string;
    root?: string | null;
    confirmedFilePaths?: readonly string[];
    confirmedDirectoryPaths?: readonly string[];
    citationAttachments?: AttachedFile[];
}) => {
    const agentNames = new Set(agents.map((agent) => agent.name.toLowerCase()));
    const labels = new Map(getSyncSessions(directory).map((session) => [session.id, session.title || session.id]));
    return compileAuthoredDeliveryPlan(plan, (authored) => {
        const agent = parseAgentMentions(authored, agents);
        const semantics = [...collectSkillSemantics(authored, installedSkillNames), ...collectSessionMentionIds(authored).map((sessionId) => ({ type: 'session' as const, sessionId }))];
        const attachments = extractInlineFileMentions({ text: agent.sanitizedText, root, confirmedFilePaths, confirmedDirectoryPaths, agentNames });
        return {
            text: replaceSessionMentionTokens(
                stripAttachmentCitationSlotsForDelivery(
                    expandCodeSelectionCitations(agent.sanitizedText, citationAttachments),
                ),
                labels,
            ),
            agent: agent.mention?.name,
            attachments,
            semantics,
        };
    });
};

type AssistantQueueDeliveryPart = { type: 'text'; text: string; synthetic?: true } | { type: 'file'; mime: string; attachmentID: string };
type AssistantQueueSyntheticPart = { partID: string; text: string; synthetic?: boolean; attachments?: readonly AttachedFile[] };

/** Maps ephemeral synthetic context into direct-send parts without consuming their draft resources. */
export const buildSyntheticDeliveryParts = (
    syntheticParts: readonly { text: string; attachments?: readonly AttachedFile[] }[],
): Array<{ text: string; attachments?: AttachedFile[]; synthetic: true }> => syntheticParts.map((part) => ({
    text: part.text,
    ...(part.attachments?.length ? { attachments: dedupeDeliveryAttachments(part.attachments) } : {}),
    synthetic: true,
}));

/** Builds the durable Assistant queue payload from already-resolved delivery values. */
export const buildAssistantQueueDeliveryParts = ({
    text,
    attachments,
    semanticParts,
    syntheticParts = [],
}: {
    text: string;
    attachments: readonly AttachedFile[];
    semanticParts: readonly { text: string; synthetic: true }[];
    syntheticParts?: readonly { text: string; attachments?: readonly AttachedFile[] }[] | null;
}): AssistantQueueDeliveryPart[] => [
    { type: 'text', text },
    ...dedupeDeliveryAttachments(attachments).map((attachment) => ({ type: 'file' as const, mime: attachment.mimeType, attachmentID: attachment.id })),
    ...semanticParts.map((part) => ({ type: 'text' as const, text: part.text, synthetic: true as const })),
    ...(syntheticParts ?? []).flatMap((part) => [
        { type: 'text' as const, text: part.text, synthetic: true as const },
        ...dedupeDeliveryAttachments(part.attachments ?? []).map((attachment) => ({ type: 'file' as const, mime: attachment.mimeType, attachmentID: attachment.id })),
    ]),
];

export const buildAssistantQueueSyntheticSidecar = (
    deliveryParts: readonly AssistantQueueDeliveryPart[],
    syntheticParts: readonly AssistantQueueSyntheticPart[],
) => {
    const deduped = syntheticParts.map((part) => ({ ...part, attachments: dedupeDeliveryAttachments(part.attachments ?? []) }));
    let index = deliveryParts.length - deduped.reduce((total, part) => total + 1 + part.attachments.length, 0);
    if (index < 0) throw new Error('assistant-queue-synthetic-parts-mismatch');
    return deduped.map((part) => {
        const deliveryPartIndexes = [index++];
        for (const attachment of part.attachments) {
            void attachment;
            deliveryPartIndexes.push(index++);
        }
        return { partID: part.partID, text: part.text, ...(part.synthetic === true ? { synthetic: true } : {}), attachmentIDs: part.attachments.map((attachment) => attachment.id), deliveryPartIndexes };
    });
};
