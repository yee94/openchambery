import { hasConfirmedTerminalStop, isModelTextPart } from './assistantMessageLifecycle';
import type { ChatMessageEntry, TurnChangedFile, TurnDiffStats, TurnSummaryRecord } from './types';
import { resolveActivityPartId } from './resolveActivityPartId';

interface SummaryDiff {
    file?: string | null;
    additions?: number | null;
    deletions?: number | null;
}

interface UserSummaryPayload {
    body?: string | null;
    diffs?: SummaryDiff[] | null;
}

const getTextFromPart = (part: unknown): string | undefined => {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim().length > 0) {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim().length > 0) {
        return content;
    }
    return undefined;
};

export const projectTurnSummary = (assistantMessages: ChatMessageEntry[]): TurnSummaryRecord => {
    // Canonical stop summary: only a confirmed terminal stop (finish === 'stop'
    // with zero continuation tools, per the runLoop exit rule) may own the
    // canonical body, and only a real model text part — synthetic sidecar text
    // is skipped so the last model-produced text wins. A stop that still
    // carries continuation tools is a step boundary, not the final answer —
    // its text stays in Activity justification.
    for (let messageIndex = assistantMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const assistantMessage = assistantMessages[messageIndex];
        if (!assistantMessage) continue;

        const finish = (assistantMessage.info as { finish?: string | null }).finish;
        if (!hasConfirmedTerminalStop(finish, assistantMessage.parts)) continue;

        for (let partIndex = assistantMessage.parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = assistantMessage.parts[partIndex];
            if (!part || !isModelTextPart(part)) continue;

            const text = getTextFromPart(part);
            if (!text) continue;

            return {
                text,
                sourceMessageId: assistantMessage.info.id,
                sourcePartId: resolveActivityPartId(assistantMessage.info.id, part, partIndex),
            };
        }
    }

    for (let messageIndex = assistantMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
        const assistantMessage = assistantMessages[messageIndex];
        if (!assistantMessage) continue;

        for (let partIndex = assistantMessage.parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = assistantMessage.parts[partIndex];
            if (!part || part.type !== 'text') continue;

            const text = getTextFromPart(part);
            if (!text) continue;

            return {
                text,
                sourceMessageId: assistantMessage.info.id,
                sourcePartId: resolveActivityPartId(assistantMessage.info.id, part, partIndex),
            };
        }
    }

    return {};
};

export const projectTurnDiffStats = (userMessage: ChatMessageEntry): TurnDiffStats | undefined => {
    const summary = (userMessage.info as { summary?: UserSummaryPayload | null }).summary;
    const diffs = summary?.diffs;
    if (!Array.isArray(diffs) || diffs.length === 0) {
        return undefined;
    }

    let additions = 0;
    let deletions = 0;
    let files = 0;

    diffs.forEach((diff) => {
        if (!diff) return;

        const diffAdditions = typeof diff.additions === 'number' ? diff.additions : 0;
        const diffDeletions = typeof diff.deletions === 'number' ? diff.deletions : 0;

        if (diffAdditions !== 0 || diffDeletions !== 0) {
            files += 1;
        }

        additions += diffAdditions;
        deletions += diffDeletions;
    });

    if (files === 0) {
        return undefined;
    }

    return {
        additions,
        deletions,
        files,
    };
};

export const projectTurnChangedFiles = (userMessage: ChatMessageEntry): TurnChangedFile[] | undefined => {
    const summary = (userMessage.info as { summary?: UserSummaryPayload | null }).summary;
    const diffs = summary?.diffs;
    if (!Array.isArray(diffs) || diffs.length === 0) {
        return undefined;
    }

    const files = diffs
        .map((diff) => {
            if (!diff || typeof diff.file !== 'string' || diff.file.trim().length === 0) {
                return null;
            }
            const additions = typeof diff.additions === 'number' ? diff.additions : 0;
            const deletions = typeof diff.deletions === 'number' ? diff.deletions : 0;
            if (additions === 0 && deletions === 0) {
                return null;
            }
            return {
                file: diff.file,
                additions,
                deletions,
            };
        })
        .filter((file): file is TurnChangedFile => file !== null);

    return files.length > 0 ? files : undefined;
};
