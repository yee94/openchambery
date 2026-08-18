import type { Part } from '@opencode-ai/sdk/v2';

import { filterSyntheticParts } from '@/lib/messages/synthetic';
import { normalizeParts } from '../message/partUtils';
import type { ChatMessageEntry } from './turns/types';

const getPartText = (part: unknown): string => {
    const record = part as { text?: unknown; content?: unknown };
    if (typeof record.text === 'string') {
        return record.text;
    }
    if (typeof record.content === 'string') {
        return record.content;
    }
    return '';
};

export const isCompactionCommandPart = (part: unknown): boolean => {
    const type = (part as { type?: unknown } | null | undefined)?.type;
    if (type === 'compaction') {
        return true;
    }
    return type === 'text' && getPartText(part).trim() === '/compact';
};

export const isCompactionCommandParts = (parts: readonly unknown[] | undefined): boolean => {
    if (!parts) {
        return false;
    }
    return parts.some((part) => isCompactionCommandPart(part));
};

export const hasCompactionPart = (message: ChatMessageEntry): boolean => {
    return isCompactionCommandParts(message.parts);
};

export const isCompactionCommandMessage = (message: ChatMessageEntry | undefined): boolean => {
    if (!message) {
        return false;
    }
    return isCompactionCommandParts(message.sourceParts) || isCompactionCommandParts(message.parts);
};

const normalizeCompactionCommandMessage = (message: ChatMessageEntry): ChatMessageEntry => {
    if (!hasCompactionPart(message)) {
        return message;
    }

    let changedParts = false;
    const nextParts = message.parts.map((part) => {
        const type = (part as { type?: unknown } | null | undefined)?.type;
        if (type !== 'compaction') {
            return part;
        }
        changedParts = true;
        return { type: 'text', text: '/compact' } as Part;
    });

    const info = message.info as unknown as { clientRole?: string | null | undefined };
    const needsClientRole = info.clientRole !== 'user';

    if (!changedParts && !needsClientRole) {
        return message;
    }

    return {
        ...message,
        info: needsClientRole
            ? ({
                ...(message.info as unknown as Record<string, unknown>),
                clientRole: 'user',
            } as unknown as typeof message.info)
            : message.info,
        parts: changedParts ? nextParts : message.parts,
    };
};

const normalizeMessageParts = (message: ChatMessageEntry): ChatMessageEntry => {
    const parts = normalizeParts(message.parts);
    if (parts.length === message.parts.length) {
        return message;
    }
    return {
        ...message,
        parts,
    };
};

const normalizedMessageBySource = new WeakMap<ChatMessageEntry, ChatMessageEntry>();

export const getNormalizedMessageForDisplay = (message: ChatMessageEntry): ChatMessageEntry => {
    const cached = normalizedMessageBySource.get(message);
    if (cached) {
        return cached;
    }

    const normalizedPartMessage = normalizeMessageParts(message);
    const normalizedCompactionMessage = normalizeCompactionCommandMessage(normalizedPartMessage);
    const sourceParts = normalizedCompactionMessage.parts;
    const filteredParts = filterSyntheticParts(sourceParts);
    // When synthetics are stripped for display, retain the pre-filter parts so
    // session-mention (and similar) decoration can still resolve titles/ids.
    const normalized = filteredParts === sourceParts
        ? normalizedCompactionMessage
        : {
            ...normalizedCompactionMessage,
            parts: filteredParts,
            sourceParts,
        };

    normalizedMessageBySource.set(message, normalized);
    return normalized;
};
