import { getProviderModelDisplayName } from '@/lib/modelDisplay';

type UserMessageHeaderIdentity = {
    agentName?: string;
    providerId?: string;
    modelId?: string;
    variant?: string;
};

export type PendingAssistantHeaderPresentation = {
    providerID: string | null;
    modelID: string | null;
    agentName: string | undefined;
    modelName: string | undefined;
    variant: string | undefined;
};

const readTrimmedString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Header identity already present on the user row (optimistic send stamps
 * provider/model/agent before the assistant message exists).
 */
export const readUserMessageHeaderIdentity = (info: unknown): UserMessageHeaderIdentity | null => {
    if (typeof info !== 'object' || info === null) {
        return null;
    }

    const record = info as {
        mode?: unknown;
        agent?: unknown;
        providerID?: unknown;
        modelID?: unknown;
        variant?: unknown;
        model?: { variant?: unknown };
    };
    const agentName = readTrimmedString(record.mode) ?? readTrimmedString(record.agent);
    const providerId = readTrimmedString(record.providerID);
    const modelId = readTrimmedString(record.modelID);
    const variant = readTrimmedString(record.model?.variant) ?? readTrimmedString(record.variant);

    if (!agentName && !providerId && !modelId && !variant) {
        return null;
    }

    return { agentName, providerId, modelId, variant };
};

export const resolvePendingAssistantHeader = (
    identity: UserMessageHeaderIdentity | null,
): PendingAssistantHeaderPresentation => {
    const modelID = identity?.modelId ?? null;
    return {
        providerID: identity?.providerId ?? null,
        modelID,
        agentName: identity?.agentName,
        modelName: getProviderModelDisplayName(undefined, modelID) || undefined,
        variant: identity?.variant,
    };
};

/**
 * Paint the assistant MessageHeader as soon as the user bubble exists, in the
 * window before SSE materializes the first assistant row. Compaction already
 * owns that gap. A live streaming id means another assistant still owns the
 * header (typically the previous turn), so this placeholder stays off.
 */
export const shouldShowPendingAssistantHeader = (input: {
    isLastTurn: boolean;
    sessionIsWorking: boolean;
    hasAssistantMessages: boolean;
    activityPresentationKind: string;
    hasActiveStreamingMessage: boolean;
}): boolean => {
    if (!input.isLastTurn || !input.sessionIsWorking) {
        return false;
    }
    if (input.hasAssistantMessages) {
        return false;
    }
    if (input.activityPresentationKind === 'compaction') {
        return false;
    }
    if (input.hasActiveStreamingMessage) {
        return false;
    }
    return true;
};
