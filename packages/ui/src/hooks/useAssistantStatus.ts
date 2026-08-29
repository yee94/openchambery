import React from 'react';
import type { Part, ReasoningPart, TextPart, ToolPart } from '@opencode-ai/sdk/v2';

import type { MessageStreamPhase } from '@/stores/types/sessionTypes';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
    useSessionMessages,
    useSessionParts,
    useSessionPermissions,
    useSessionQuestions,
    useSessionStatus,
} from '@/sync/sync-context';
import { isCompactionCommandParts } from '@/components/chat/lib/messageDisplayNormalization';
import { hasConfirmedFinalBody } from '@/components/chat/lib/turns/assistantMessageLifecycle';
import { isFullySyntheticMessage } from '@/lib/messages/synthetic';
import { useI18n, type I18nKey, type I18nParams } from '@/lib/i18n';
import { useSessionActivity } from './useSessionActivity';

type AssistantActivity = 'idle' | 'streaming' | 'tooling' | 'cooldown' | 'permission';

interface WorkingSummary {
    activity: AssistantActivity;
    hasWorkingContext: boolean;
    hasActiveTools: boolean;
    isWorking: boolean;
    isStreaming: boolean;
    isCooldown: boolean;
    lifecyclePhase: MessageStreamPhase | null;
    statusText: string | null;
    isGenericStatus: boolean;
    isWaitingForPermission: boolean;
    canAbort: boolean;
    compactionDeadline: number | null;
    activePartType?: 'text' | 'tool' | 'reasoning' | 'editing';
    activeToolName?: string;
    wasAborted: boolean;
    abortActive: boolean;
    lastCompletionId: string | null;
    isComplete: boolean;
    /**
     * Last assistant has a confirmed final body (same authority as Changes
     * chrome). When true the working hint must hide immediately — no step-gap
     * linger after the turn has settled.
     */
    isTurnSettled: boolean;
    retryInfo: { attempt?: number; next?: number } | null;
    turnStartedAt?: number;
}

interface FormingSummary {
    isActive: boolean;
    characterCount: number;
}

export interface AssistantStatusSnapshot {
    forming: FormingSummary;
    working: WorkingSummary;
}

const DEFAULT_WORKING: WorkingSummary = {
    activity: 'idle',
    hasWorkingContext: false,
    hasActiveTools: false,
    isWorking: false,
    isStreaming: false,
    isCooldown: false,
    lifecyclePhase: null,
    statusText: null,
    isGenericStatus: true,
    isWaitingForPermission: false,
    canAbort: false,
    compactionDeadline: null,
    activePartType: undefined,
    activeToolName: undefined,
    wasAborted: false,
    abortActive: false,
    lastCompletionId: null,
    isComplete: false,
    isTurnSettled: false,
    retryInfo: null,
    turnStartedAt: undefined,
};

const EMPTY_PARTS: Part[] = [];
const STATUS_SIGNATURE_SEPARATOR = '\u0000';
const EDITING_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch']);
const TOOL_STATUS_KEYS: Record<string, I18nKey> = {
    read: 'chat.assistantStatus.readingFile',
    write: 'chat.assistantStatus.writingFile',
    edit: 'chat.assistantStatus.editingFile',
    multiedit: 'chat.assistantStatus.editingFiles',
    apply_patch: 'chat.assistantStatus.applyingPatch',
    bash: 'chat.assistantStatus.runningCommand',
    grep: 'chat.assistantStatus.searchingContent',
    glob: 'chat.assistantStatus.findingFiles',
    list: 'chat.assistantStatus.listingDirectory',
    task: 'chat.assistantStatus.delegatingTask',
    webfetch: 'chat.assistantStatus.fetchingUrl',
    websearch: 'chat.assistantStatus.searchingWeb',
    codesearch: 'chat.assistantStatus.webCodeSearch',
    todowrite: 'chat.assistantStatus.updatingTodos',
    todoread: 'chat.assistantStatus.readingTodos',
    skill: 'chat.assistantStatus.learningSkill',
    question: 'chat.assistantStatus.askingQuestion',
    plan_enter: 'chat.assistantStatus.switchingToPlanning',
    plan_exit: 'chat.assistantStatus.switchingToBuilding',
};
const WORKING_PHRASE_KEYS: I18nKey[] = [
    'chat.assistantStatus.working',
    'chat.assistantStatus.processing',
    'chat.assistantStatus.preparing',
    'chat.assistantStatus.warmingUp',
    'chat.assistantStatus.gearsTurning',
    'chat.assistantStatus.computing',
    'chat.assistantStatus.calculating',
    'chat.assistantStatus.analyzing',
    'chat.assistantStatus.wheelsSpinning',
    'chat.assistantStatus.calibrating',
    'chat.assistantStatus.synthesizing',
    'chat.assistantStatus.connectingDots',
    'chat.assistantStatus.inspectingLogic',
    'chat.assistantStatus.weighingOptions',
];

type ParsedStatusResult = {
    activePartType: 'text' | 'tool' | 'reasoning' | 'editing' | undefined;
    activeToolName: string | undefined;
    statusText: string;
    isGenericStatus: boolean;
};

const getToolStatusPhrase = (toolName: string, t: (key: I18nKey, params?: I18nParams) => string): string => {
    const key = TOOL_STATUS_KEYS[toolName];
    return key ? t(key) : t('chat.assistantStatus.usingTool', { tool: toolName });
};

const hashString = (value: string): number => {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash);
};

const getStableWorkingPhrase = (key: string, t: (key: I18nKey, params?: I18nParams) => string): string => {
    const phraseKey = WORKING_PHRASE_KEYS[hashString(key) % WORKING_PHRASE_KEYS.length] ?? 'chat.assistantStatus.working';
    return t(phraseKey);
};

const createParsedStatus = (
    parts: Part[],
    genericKey: string,
    t: (key: I18nKey, params?: I18nParams) => string,
): ParsedStatusResult => {
    let activePartType: ParsedStatusResult['activePartType'] = undefined;
    let activeToolName: string | undefined = undefined;

    if (!isFullySyntheticMessage(parts)) {
        for (let index = parts.length - 1; index >= 0; index -= 1) {
            const part = parts[index];
            if (!part) continue;

            switch (part.type) {
                case 'reasoning': {
                    const time = part.time ?? getPartTimeInfo(part);
                    const stillRunning = !time || typeof time.end === 'undefined';
                    if (stillRunning && !activePartType) {
                        activePartType = 'reasoning';
                    }
                    break;
                }
                case 'tool': {
                    const toolStatus = part.state?.status;
                    if ((toolStatus === 'running' || toolStatus === 'pending') && !activePartType) {
                        const toolName = getToolDisplayName(part);
                        if (EDITING_TOOLS.has(toolName)) {
                            activePartType = 'editing';
                            activeToolName = toolName;
                        } else {
                            activePartType = 'tool';
                            activeToolName = toolName;
                        }
                    }
                    break;
                }
                case 'text': {
                    const rawContent = getLegacyTextContent(part) ?? '';
                    if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
                        const time = getPartTimeInfo(part);
                        const streamingPart = !time || typeof time.end === 'undefined';
                        if (streamingPart && !activePartType) {
                            activePartType = 'text';
                        }
                    }
                    break;
                }
                default:
                    break;
            }
        }
    }

    const isGenericStatus = activePartType === undefined;
    const statusText = (() => {
        if (activePartType === 'editing') return activeToolName === 'multiedit' ? getToolStatusPhrase(activeToolName, t) : t('chat.assistantStatus.editingFile');
        if (activePartType === 'tool' && activeToolName) return getToolStatusPhrase(activeToolName, t);
        if (activePartType === 'reasoning') return t('chat.assistantStatus.thinking');
        if (activePartType === 'text') return t('chat.assistantStatus.composing');
        return getStableWorkingPhrase(genericKey, t);
    })();

    return { activePartType, activeToolName, statusText, isGenericStatus };
};

const encodeParsedStatus = (status: ParsedStatusResult): string => {
    return [
        status.activePartType ?? '',
        status.activeToolName ?? '',
        status.statusText,
        status.isGenericStatus ? '1' : '0',
    ].join(STATUS_SIGNATURE_SEPARATOR);
};

const decodeParsedStatus = (signature: string): ParsedStatusResult => {
    const [activePartType, activeToolName, statusText = 'working', isGenericStatus] = signature.split(STATUS_SIGNATURE_SEPARATOR);
    return {
        activePartType: activePartType === 'text' || activePartType === 'tool' || activePartType === 'reasoning' || activePartType === 'editing'
            ? activePartType
            : undefined,
        activeToolName: activeToolName || undefined,
        statusText,
        isGenericStatus: isGenericStatus === '1',
    };
};

const isReasoningPart = (part: Part): part is ReasoningPart => part.type === 'reasoning';

const isTextPart = (part: Part): part is TextPart => part.type === 'text';

const getLegacyTextContent = (part: Part): string | undefined => {
    if (isTextPart(part)) {
        return part.text;
    }
    const candidate = part as Partial<{ text?: unknown; content?: unknown; value?: unknown }>;
    if (typeof candidate.text === 'string') {
        return candidate.text;
    }
    if (typeof candidate.content === 'string') {
        return candidate.content;
    }
    if (typeof candidate.value === 'string') {
        return candidate.value;
    }
    return undefined;
};

const getPartTimeInfo = (part: Part): { end?: number } | undefined => {
    if (isTextPart(part) || isReasoningPart(part)) {
        return part.time;
    }
    const candidate = part as Partial<{ time?: { end?: number } }>;
    return candidate.time;
};

const getToolDisplayName = (part: ToolPart): string => {
    if (part.tool) {
        return part.tool;
    }
    const candidate = part as ToolPart & Partial<{ name?: unknown }>;
    return typeof candidate.name === 'string' ? candidate.name : 'tool';
};

export function useAssistantStatus(
    sessionId?: string | null,
    directory?: string | null,
): AssistantStatusSnapshot {
    const { t } = useI18n();
    const primarySessionId = useSessionUIStore((state) => state.currentSessionId);
    const primarySessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
    const currentSessionId = sessionId ?? primarySessionId;
    const currentSessionDirectory = directory ?? primarySessionDirectory;
    const pendingSendMessageIDSelector = React.useMemo(() => (
        state: ReturnType<typeof useSessionUIStore.getState>
    ) => (
        currentSessionId ? state.pendingSendMessageIDs.get(currentSessionId) ?? null : null
    ), [currentSessionId]);
    const pendingSendMessageID = useSessionUIStore(
        pendingSendMessageIDSelector,
    );

    // Ticket 02: messages via repository observer (useSessionMessages).
    const rawSessionMessages = useSessionMessages(
        currentSessionId ?? '',
        currentSessionDirectory ?? undefined,
    );

    // Only subscribe to parts for the last assistant message — avoids re-render
    // on every part delta for earlier messages.
    const lastAssistant = React.useMemo(() => {
        for (let i = rawSessionMessages.length - 1; i >= 0; i--) {
            const message = rawSessionMessages[i];
            if (message.role === 'assistant') {
                return {
                    id: message.id,
                    finish: (message as { finish?: unknown }).finish,
                    error: (message as { error?: unknown }).error,
                };
            }
        }
        return { id: null as string | null, finish: undefined as unknown, error: undefined as unknown };
    }, [rawSessionMessages]);
    const lastAssistantId = lastAssistant.id;

    const lastUser = React.useMemo(() => {
        for (let i = rawSessionMessages.length - 1; i >= 0; i--) {
            const message = rawSessionMessages[i];
            if (message.role === 'user') {
                return {
                    id: message.id,
                    turnStartedAt: Number.isFinite(message.time.created) ? message.time.created : undefined,
                };
            }
        }
        return { id: null, turnStartedAt: undefined };
    }, [rawSessionMessages]);
    const lastUserId = lastUser.id;

    // Ticket 02: parts via repository; session-scoped subscription when known.
    const lastAssistantParts = useSessionParts(
        lastAssistantId ?? '',
        currentSessionDirectory ?? undefined,
        currentSessionId ?? undefined,
    );
    const lastUserParts = useSessionParts(
        lastUserId ?? '',
        currentSessionDirectory ?? undefined,
        currentSessionId ?? undefined,
    );
    const lastUserIsCompaction = Boolean(lastUserId) && isCompactionCommandParts(lastUserParts);
    const isTurnSettled = Boolean(
        lastAssistantId
        && hasConfirmedFinalBody(lastAssistant.finish, lastAssistantParts, lastAssistant.error),
    );
    const lastAssistantStatusSignature = React.useMemo(() => {
        const genericKey = `${currentSessionId ?? ''}:${lastAssistantId ?? ''}`;
        const parts = lastAssistantId ? lastAssistantParts : EMPTY_PARTS;
        return encodeParsedStatus(createParsedStatus(parts, genericKey, t));
    }, [currentSessionId, lastAssistantId, lastAssistantParts, t]);

    const sessionPermissionRequests = useSessionPermissions(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    const sessionQuestionRequests = useSessionQuestions(currentSessionId ?? '', currentSessionDirectory ?? undefined);

    const sessionAbortRecordSelector = React.useMemo(() => (
        state: ReturnType<typeof useSessionUIStore.getState>
    ) => {
            if (!currentSessionId) {
                return null;
            }
            return state.sessionAbortFlags?.get(currentSessionId) ?? null;
    }, [currentSessionId]);
    const sessionAbortRecord = useSessionUIStore(sessionAbortRecordSelector);

    const { phase: activityPhase, isWorking: isPhaseWorking } = useSessionActivity(
        currentSessionId,
        currentSessionDirectory ?? undefined,
    );

    const currentSessionStatus = useSessionStatus(currentSessionId ?? '', currentSessionDirectory ?? undefined);

    const sessionRetryAttempt = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; attempt?: number }).attempt
        : undefined;

    const sessionRetryNext = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; next?: number }).next
        : undefined;

    const parsedStatus = React.useMemo<ParsedStatusResult>(() => {
        return decodeParsedStatus(lastAssistantStatusSignature);
    }, [lastAssistantStatusSignature]);

    const abortState = React.useMemo(() => {
        const hasActiveAbort = Boolean(sessionAbortRecord && !sessionAbortRecord.acknowledged);
        return { wasAborted: hasActiveAbort, abortActive: hasActiveAbort };
    }, [sessionAbortRecord]);

    const baseWorking = React.useMemo<WorkingSummary>(() => {

        if (abortState.wasAborted) {
            return {
                ...DEFAULT_WORKING,
                wasAborted: true,
                abortActive: abortState.abortActive,
                activity: 'idle',
                hasWorkingContext: false,
                isWorking: false,
                isStreaming: false,
                isCooldown: false,
                statusText: null,
                canAbort: false,
                retryInfo: null,
            };
        }

        // Same authority as Changes chrome: once the last assistant has a
        // confirmed final body, the working hint must not stay painted or
        // linger — session.status can still be busy for a frame (or flap)
        // after the turn has already settled.
        if (isTurnSettled) {
            return {
                ...DEFAULT_WORKING,
                isComplete: true,
                isTurnSettled: true,
                turnStartedAt: lastUser.turnStartedAt,
            };
        }

        const isWorking = isPhaseWorking;
        const isStreaming = activityPhase === 'busy';
        const isCooldown = false;
        const isRetry = activityPhase === 'retry';
        const preferCompactionStatus = isWorking && lastUserIsCompaction;

        let activity: AssistantActivity = 'idle';
        if (isWorking) {
            if (!preferCompactionStatus && (parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing')) {
                activity = 'tooling';
            } else {
                activity = isCooldown ? 'cooldown' : 'streaming';
            }
        }

        const retryInfo = isRetry
            ? { attempt: sessionRetryAttempt, next: sessionRetryNext }
            : null;

        return {
            activity,
            hasWorkingContext: isWorking,
            hasActiveTools: !preferCompactionStatus && (parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing'),
            isWorking,
            isStreaming,
            isCooldown,
            lifecyclePhase: isStreaming ? 'streaming' : isCooldown ? 'cooldown' : null,
            statusText: isWorking
                ? (preferCompactionStatus ? t('chat.assistantStatus.compacting') : parsedStatus.statusText)
                : null,
            isGenericStatus: isWorking ? (preferCompactionStatus ? false : parsedStatus.isGenericStatus) : true,
            isWaitingForPermission: false,
            canAbort: isWorking,
            compactionDeadline: null,
            activePartType: isWorking && !preferCompactionStatus ? parsedStatus.activePartType : undefined,
            activeToolName: isWorking && !preferCompactionStatus ? parsedStatus.activeToolName : undefined,
            wasAborted: false,
            abortActive: false,
            lastCompletionId: null,
            isComplete: false,
            isTurnSettled: false,
            retryInfo,
            turnStartedAt: lastUser.turnStartedAt,
        };
    }, [activityPhase, isPhaseWorking, isTurnSettled, lastUserIsCompaction, lastUser.turnStartedAt, parsedStatus, abortState, sessionRetryAttempt, sessionRetryNext, t]);

    const forming = React.useMemo<FormingSummary>(() => {
        const isActive = isPhaseWorking && parsedStatus.activePartType === 'text';
        return { isActive, characterCount: 0 };
    }, [isPhaseWorking, parsedStatus.activePartType]);

    const working = React.useMemo<WorkingSummary>(() => {
        if (baseWorking.wasAborted || baseWorking.abortActive) {
            return baseWorking;
        }

        if (pendingSendMessageID) {
            return {
                ...baseWorking,
                activity: 'streaming',
                hasWorkingContext: true,
                isWorking: true,
                isStreaming: true,
                isCooldown: false,
                lifecyclePhase: 'streaming',
                statusText: t('chat.assistantStatus.sendingMessage'),
                isGenericStatus: false,
                isWaitingForPermission: false,
                canAbort: false,
                activePartType: undefined,
                activeToolName: undefined,
                isComplete: false,
                isTurnSettled: false,
                retryInfo: null,
            };
        }

        const hasPendingPermission = sessionPermissionRequests.length > 0;
        const hasPendingQuestion = sessionQuestionRequests.length > 0;

        if (!hasPendingPermission && !hasPendingQuestion) {
            return baseWorking;
        }

        if (hasPendingQuestion) {
            return {
                ...baseWorking,
                statusText: null,
                isWorking: false,
                hasWorkingContext: false,
                hasActiveTools: false,
                canAbort: false,
                activePartType: undefined,
                activeToolName: undefined,
                retryInfo: null,
            };
        }

        return {
            ...baseWorking,
            statusText: t('chat.assistantStatus.waitingForPermission'),
            isWaitingForPermission: true,
            canAbort: false,
            retryInfo: null,
        };
    }, [baseWorking, pendingSendMessageID, sessionPermissionRequests, sessionQuestionRequests, t]);

    return {
        forming,
        working,
    };
}
