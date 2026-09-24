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
        model?: { variant?: unknown; providerID?: unknown; modelID?: unknown; id?: unknown };
        metadata?: { agent?: unknown; variant?: unknown; model?: { variant?: unknown; providerID?: unknown; modelID?: unknown; id?: unknown } };
    };
    const model = typeof record.model === 'object' && record.model !== null ? record.model : undefined;
    const metadata = typeof record.metadata === 'object' && record.metadata !== null ? record.metadata : undefined;
    const metadataModel = typeof metadata?.model === 'object' && metadata.model !== null ? metadata.model : undefined;
    // Official ModelRef uses `id`. Prompt metadata keeps `{ providerID, modelID }`.
    const agentName = readTrimmedString(record.mode)
        ?? readTrimmedString(record.agent)
        ?? readTrimmedString(metadata?.agent);
    const providerId = readTrimmedString(record.providerID)
        ?? readTrimmedString(model?.providerID)
        ?? readTrimmedString(metadataModel?.providerID);
    const modelId = readTrimmedString(record.modelID)
        ?? readTrimmedString(model?.modelID)
        ?? readTrimmedString(model?.id)
        ?? readTrimmedString(metadataModel?.modelID)
        ?? readTrimmedString(metadataModel?.id);
    const variant = readTrimmedString(model?.variant)
        ?? readTrimmedString(metadataModel?.variant)
        ?? readTrimmedString(record.variant)
        ?? readTrimmedString(metadata?.variant);

    if (!agentName && !providerId && !modelId && !variant) {
        return null;
    }

    return { agentName, providerId, modelId, variant };
};

type CompleteModelSelection = {
    providerId?: string;
    modelId?: string;
};

const completeModelSelection = (
    selection: CompleteModelSelection | null | undefined,
): { providerId: string; modelId: string } | null => {
    const providerId = selection?.providerId?.trim();
    const modelId = selection?.modelId?.trim();
    if (!providerId || !modelId) return null;
    return { providerId, modelId };
};

/**
 * Model shown on the turn assistant header before (and while) execution
 * identity arrives. Assistant wire identity wins, then the user row the
 * client just stamped. A still-open turn uses the live composer pick before
 * session memory, because that pick is what the send already used. Settled
 * history does not borrow the composer. OpenCode 2 user rows often omit model.
 */
export const resolveAssistantHeaderModel = (input: {
    assistantIdentity: UserMessageHeaderIdentity | null;
    userIdentity: UserMessageHeaderIdentity | null;
    sessionSelection: CompleteModelSelection | null;
    composerSelection: CompleteModelSelection | null;
    allowComposerFallback: boolean;
}): { providerId: string; modelId: string } | null => (
    completeModelSelection(input.assistantIdentity)
    ?? completeModelSelection(input.userIdentity)
    ?? (input.allowComposerFallback ? completeModelSelection(input.composerSelection) : null)
    ?? completeModelSelection(input.sessionSelection)
);

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
