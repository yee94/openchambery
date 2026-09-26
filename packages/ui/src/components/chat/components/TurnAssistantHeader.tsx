import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { useSelectionStore } from '@/sync/selection-store';
import type { ChatMessageEntry } from '../lib/turns/types';
import type { PendingAssistantHeaderPresentation } from '../lib/pendingAssistantHeader';
import { readUserMessageHeaderIdentity, resolveAssistantHeaderModel } from '../lib/pendingAssistantHeader';
import MessageHeader from '../message/MessageHeader';

const readInfoString = (info: unknown, key: string): string | undefined => {
    if (typeof info !== 'object' || info === null) return undefined;
    const value = (info as Record<string, unknown>)[key];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const useStickyValue = <T,>(value: T | null | undefined): T | null | undefined => {
    const [stickyValue, setStickyValue] = React.useState<T | null | undefined>(value);
    React.useEffect(() => {
        if (value !== undefined && value !== null) setStickyValue(value);
    }, [value]);
    return value ?? stickyValue;
};

interface TurnAssistantHeaderProps {
    assistantMessage?: ChatMessageEntry;
    userMessage: ChatMessageEntry;
    pendingPresentation?: PendingAssistantHeaderPresentation | null;
    assistantIsInActiveTurn: boolean;
    isMobile: boolean;
}

const TurnAssistantHeader: React.FC<TurnAssistantHeaderProps> = ({
    assistantMessage,
    userMessage,
    pendingPresentation,
    assistantIsInActiveTurn,
    isMobile,
}) => {
    const providers = useConfigStore((state) => state.providers);
    const composerSelection = useConfigStore(useShallow((state) => ({
        providerId: state.currentProviderId,
        modelId: state.currentModelId,
    })));
    const sessionId = assistantMessage?.info.sessionID ?? userMessage.info.sessionID;
    const { currentContextAgent, savedSessionAgentSelection } = useContextStore(
        useShallow((state) => ({
            currentContextAgent: assistantIsInActiveTurn && sessionId
                ? state.currentAgentContext.get(sessionId)
                : undefined,
            savedSessionAgentSelection: assistantIsInActiveTurn && sessionId
                ? state.sessionAgentSelections.get(sessionId)
                : undefined,
        })),
    );
    const userIdentity = React.useMemo(
        () => readUserMessageHeaderIdentity(userMessage.info),
        [userMessage.info],
    );
    const assistantIdentity = React.useMemo(
        () => (assistantMessage ? readUserMessageHeaderIdentity(assistantMessage.info) : null),
        [assistantMessage],
    );

    const agentName = React.useMemo(() => {
        if (!assistantMessage) return pendingPresentation?.agentName ?? userIdentity?.agentName;
        return readInfoString(assistantMessage.info, 'mode')
            ?? readInfoString(assistantMessage.info, 'agent')
            ?? userIdentity?.agentName
            ?? currentContextAgent
            ?? savedSessionAgentSelection;
    }, [assistantMessage, currentContextAgent, pendingPresentation?.agentName, savedSessionAgentSelection, userIdentity?.agentName]);

    const sessionModelSelection = useSelectionStore((state) => {
        if (sessionId && agentName) {
            const agentSelection = state.getAgentModelForSession(sessionId, agentName);
            if (agentSelection?.providerId && agentSelection.modelId) return agentSelection;
        }
        if (!sessionId) return null;
        const sessionSelection = state.getSessionModelSelection(sessionId);
        return sessionSelection?.providerId && sessionSelection.modelId ? sessionSelection : null;
    });

    const resolvedModel = resolveAssistantHeaderModel({
        assistantIdentity,
        userIdentity,
        sessionSelection: sessionModelSelection,
        composerSelection,
        // Pending shell and the live streaming row still belong to the model
        // the composer just sent. Settled history must not borrow that pick.
        allowComposerFallback: !assistantMessage || assistantIsInActiveTurn,
    });
    const providerID = resolvedModel?.providerId;
    const modelID = resolvedModel?.modelId;
    const stableAgentName = useStickyValue(agentName);
    const stableProviderID = useStickyValue(providerID);
    const stableModelID = useStickyValue(modelID);

    const provider = stableProviderID
        ? providers.find((candidate) => candidate.id === stableProviderID)
        : undefined;
    const modelName = getProviderModelDisplayName(provider, stableModelID ?? null)
        || pendingPresentation?.modelName
        || undefined;
    const model = provider?.models?.find((candidate) => candidate.id === stableModelID);
    const modelHasVariants = Boolean(model?.variants && Object.keys(model.variants).length > 0);
    const variant = modelHasVariants
        ? userIdentity?.variant ?? pendingPresentation?.variant
        : undefined;

    return (
        <MessageHeader
            isUser={false}
            isMobile={isMobile}
            providerID={stableProviderID ?? null}
            modelID={stableModelID ?? null}
            agentName={stableAgentName ?? undefined}
            modelName={modelName}
            variant={variant}
        />
    );
};

export default React.memo(TurnAssistantHeader);
