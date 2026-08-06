import { countContinuationToolParts, hasConfirmedFinalBody } from './assistantMessageLifecycle';
import { projectTurnActivity } from './projectTurnActivity';
import { projectTurnIndexes } from './projectTurnIndexes';
import { projectTurnChangedFiles, projectTurnDiffStats, projectTurnSummary } from './projectTurnSummary';
import type {
    ChatMessageEntry,
    TurnActivityPresentationKind,
    TurnCompletionDisposition,
    TurnMessageRecord,
    TurnProjectionResult,
    TurnRecord,
    TurnStreamState,
} from './types';

const resolveMessageRole = (message: ChatMessageEntry): string => {
    const role = (message.info as { clientRole?: string | null; role?: string | null }).clientRole ?? message.info.role;
    return typeof role === 'string' ? role : '';
};

const getMessageParentId = (message: ChatMessageEntry): string | undefined => {
    const parentId = (message.info as { parentID?: unknown }).parentID;
    if (typeof parentId !== 'string' || parentId.trim().length === 0) {
        return undefined;
    }
    return parentId;
};

const getMessageCreatedAt = (message: ChatMessageEntry): number | undefined => {
    const created = (message.info as { time?: { created?: unknown } }).time?.created;
    return typeof created === 'number' ? created : undefined;
};

const getMessageCompletedAt = (message: ChatMessageEntry): number | undefined => {
    const completed = (message.info as { time?: { completed?: unknown } }).time?.completed;
    return typeof completed === 'number' ? completed : undefined;
};

const getPartEndTime = (part: unknown): number | undefined => {
    const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end;
    if (typeof stateEnd === 'number') {
        return stateEnd;
    }
    const timeEnd = (part as { time?: { end?: unknown } }).time?.end;
    return typeof timeEnd === 'number' ? timeEnd : undefined;
};

const getUserSummaryBody = (message: ChatMessageEntry): string | undefined => {
    const summaryBody = (message.info as { summary?: { body?: unknown } | null | undefined })?.summary?.body;
    if (typeof summaryBody !== 'string') {
        return undefined;
    }

    const trimmed = summaryBody.trim();
    return trimmed.length > 0 ? summaryBody : undefined;
};

const createTurnMessageRecord = (message: ChatMessageEntry, order: number): TurnMessageRecord => {
    const role = resolveMessageRole(message);
    return {
        messageId: message.info.id,
        role,
        parentMessageId: getMessageParentId(message),
        message,
        order,
    };
};

const buildTurnStreamState = (userMessage: ChatMessageEntry, assistantMessages: ChatMessageEntry[]): TurnStreamState => {
    const startedAt = getMessageCreatedAt(userMessage);
    let completedAt: number | undefined;
    let maxPartEndedAt: number | undefined;
    let isStreaming = false;

    assistantMessages.forEach((message) => {
        const completed = getMessageCompletedAt(message);
        if (typeof completed === 'number') {
            completedAt = Math.max(completedAt ?? 0, completed);
        } else {
            isStreaming = true;
        }
        message.parts.forEach((part) => {
            const endedAt = getPartEndTime(part);
            if (typeof endedAt === 'number') {
                maxPartEndedAt = Math.max(maxPartEndedAt ?? 0, endedAt);
            }
        });
    });

    // Prefer message completion; fall back to latest part end so abnormal-exit
    // turns still freeze a duration instead of live-ticking forever.
    const durationEnd = completedAt ?? maxPartEndedAt;
    const durationMs = typeof startedAt === 'number' && typeof durationEnd === 'number' && durationEnd >= startedAt
        ? durationEnd - startedAt
        : undefined;

    return {
        isStreaming,
        isRetrying: assistantMessages.length > 1,
        startedAt,
        completedAt,
        durationMs,
    };
};

/**
 * Disposition from the last assistant, with multi-step safety and the OpenCode
 * runLoop continuation semantics.
 *
 * - error → abnormal (authoritative even with a dangling tool)
 * - `finish === 'tool-calls'` → active
 * - any continuation tool part on the last assistant → active. Continuation
 *   means any ordinary (non-provider-executed) tool that is not an interrupted
 *   orphan — pending, running, *or completed*; the model may still owe a
 *   follow-up step for it. Provider-executed tools never block terminal stop.
 * - `finish === 'stop'` with zero continuation tools → normal
 * - other non-empty finish → abnormal
 * - Any assistant without `time.completed` → still active (next step not done)
 * - `time.completed` alone is **not** enough to settle: multi-step agents often
 *   stamp completed when a shell step ends, before the next assistant arrives.
 *   Treating that as abnormal collapses Activity and blanks nested tools for a
 *   frame (user-visible fold flash). Require a terminal finish/error, or
 *   settleHistoricalActiveTurns when a later user message proves the turn is over.
 */
const resolveTurnCompletionDisposition = (
    assistantMessages: ChatMessageEntry[],
): TurnCompletionDisposition => {
    if (assistantMessages.length === 0) {
        return 'active';
    }

    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    if (!lastAssistant) {
        return 'active';
    }

    const finish = (lastAssistant.info as { finish?: unknown }).finish;
    const error = (lastAssistant.info as { error?: unknown }).error;
    // Error is authoritative even alongside stop metadata: an aborted turn
    // settles even with a dangling tool.
    if (error) {
        return 'abnormal';
    }

    // Continuation semantics (OpenCode runLoop exit rule): `tool-calls`, or a
    // last assistant carrying any continuation tool part — provider-executed
    // tools and interrupted orphans excluded — means the loop is still owed a
    // step. A *completed* ordinary tool still counts.
    if (finish === 'tool-calls') {
        return 'active';
    }

    if (countContinuationToolParts(lastAssistant.parts) > 0) {
        return 'active';
    }

    if (finish === 'stop') {
        return 'normal';
    }

    if (typeof finish === 'string' && finish.length > 0) {
        // Non-stop terminal finish (length, canceled, ...).
        return 'abnormal';
    }

    // Any sibling still open → multi-step turn is live.
    for (const message of assistantMessages) {
        if (typeof getMessageCompletedAt(message) !== 'number') {
            return 'active';
        }
    }

    // `time.completed` alone is not a terminal settle. Multi-step agents stamp
    // it when a shell step ends, before the next assistant is appended; treating
    // that as abnormal collapses Activity and blanks nested tools. Real
    // abandons settle via error/finish, or settleHistoricalActiveTurns when a
    // later user message proves the turn is over.
    return 'active';
};

/**
 * Pure derivation from the current last assistant: confirmed terminal stop plus
 * a model-produced final text, vetoed by an error. Never latched — recomputed
 * per hydration, so a turn that grows a continuation step flips back to `false`.
 */
const resolveHasConfirmedFinalBody = (
    assistantMessages: ChatMessageEntry[],
): boolean => {
    const lastAssistant = assistantMessages[assistantMessages.length - 1];
    if (!lastAssistant) {
        return false;
    }
    const info = lastAssistant.info as { finish?: unknown; error?: unknown };
    return hasConfirmedFinalBody(info.finish, lastAssistant.parts, info.error);
};

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

/**
 * Compaction activity semantics from the user message only.
 * Matches display normalization: raw type=compaction, or normalized text exactly `/compact`.
 */
const resolveTurnActivityPresentationKind = (
    userMessage: ChatMessageEntry,
): TurnActivityPresentationKind => {
    const rawParts = userMessage.sourceParts ?? userMessage.parts;
    for (const part of rawParts) {
        if ((part as { type?: unknown }).type === 'compaction') {
            return 'compaction';
        }
    }

    for (const part of userMessage.parts) {
        if ((part as { type?: unknown }).type === 'compaction') {
            return 'compaction';
        }
        if ((part as { type?: unknown }).type === 'text' && getPartText(part).trim() === '/compact') {
            return 'compaction';
        }
    }

    return 'default';
};

interface ProjectTurnRecordsOptions {
    previousProjection?: TurnProjectionResult | null;
    showTextJustificationActivity: boolean;
    showTurnChangedFiles: boolean;
}

const DEFAULT_OPTIONS: ProjectTurnRecordsOptions = {
    previousProjection: null,
    showTextJustificationActivity: false,
    showTurnChangedFiles: false,
};

const areSameMessageRefs = (left: ChatMessageEntry[], right: ChatMessageEntry[]): boolean => {
    if (left === right) {
        return true;
    }
    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
};

const canReusePreviousTurn = (previous: TurnRecord, next: TurnRecord): boolean => {
    return previous.userMessage === next.userMessage
        && previous.headerMessageId === next.headerMessageId
        && areSameMessageRefs(previous.assistantMessages, next.assistantMessages);
};

const hydrateTurnRecord = (
    turn: TurnRecord,
    effectiveOptions: ProjectTurnRecordsOptions,
): TurnRecord => {
    turn.summary = projectTurnSummary(turn.assistantMessages);
    turn.summaryText = turn.summary.text ?? getUserSummaryBody(turn.userMessage);
    turn.diffStats = projectTurnDiffStats(turn.userMessage);
    turn.changedFiles = effectiveOptions.showTurnChangedFiles
        ? projectTurnChangedFiles(turn.userMessage)
        : undefined;

    turn.completionDisposition = resolveTurnCompletionDisposition(turn.assistantMessages);
    turn.hasConfirmedFinalBody = resolveHasConfirmedFinalBody(turn.assistantMessages);
    turn.activityPresentationKind = resolveTurnActivityPresentationKind(turn.userMessage);

    const activity = projectTurnActivity({
        turnId: turn.turnId,
        assistantMessages: turn.assistantMessages,
        summarySourceMessageId: turn.summary.sourceMessageId,
        summarySourcePartId: turn.summary.sourcePartId,
        showTextJustificationActivity: effectiveOptions.showTextJustificationActivity,
    });
    turn.activityParts = activity.activityParts;
    turn.activitySegments = activity.activitySegments;
    turn.hasTools = activity.hasTools;
    turn.hasReasoning = activity.hasReasoning;

    turn.stream = buildTurnStreamState(turn.userMessage, turn.assistantMessages);
    turn.startedAt = turn.stream.startedAt;
    turn.completedAt = turn.stream.completedAt;
    turn.durationMs = turn.stream.durationMs;
    return turn;
};

const hydrateStableTurnRecords = (
    turns: TurnRecord[],
    effectiveOptions: ProjectTurnRecordsOptions,
): TurnRecord[] => {
    const previousProjection = effectiveOptions.previousProjection;
    if (!previousProjection || previousProjection.turns.length === 0 || turns.length === 0) {
        return turns.map((turn) => hydrateTurnRecord(turn, effectiveOptions));
    }

    let canReuseTurnArray = previousProjection.turns.length === turns.length;
    let reusedAnyTurn = false;

    const nextTurns = turns.map((turn, index) => {
        const previousTurn = previousProjection.indexes.turnById.get(turn.turnId);
        if (previousTurn && canReusePreviousTurn(previousTurn, turn)) {
            reusedAnyTurn = true;
            if (previousProjection.turns[index] !== previousTurn) {
                canReuseTurnArray = false;
            }
            return previousTurn;
        }

        canReuseTurnArray = false;
        return hydrateTurnRecord(turn, effectiveOptions);
    });

    if (canReuseTurnArray && reusedAnyTurn) {
        return previousProjection.turns;
    }

    return nextTurns;
};

/**
 * A later user message proves the previous turn is no longer live. Incomplete
 * message metadata (abnormal exit without time.completed) must not keep older
 * turns as `active` with a live duration ticker.
 *
 * "Later user message" means one the server has begun answering. A queued or
 * optimistic user row merged into the viewport while the previous turn is still
 * streaming is not proof of anything: settling on it collapsed the running
 * turn's Activity the moment the user typed ahead. Wait for an assistant
 * response on the following turn. A turn abandoned mid-stream therefore keeps
 * ticking until the next turn is answered, which is the narrower failure.
 */
const settleHistoricalActiveTurns = (turns: TurnRecord[]): TurnRecord[] => {
    if (turns.length <= 1) {
        return turns;
    }

    let changed = false;
    const nextTurns = turns.map((turn, index) => {
        const isLastTurn = index === turns.length - 1;
        if (isLastTurn || turn.completionDisposition !== 'active') {
            return turn;
        }
        if ((turns[index + 1]?.assistantMessages.length ?? 0) === 0) {
            return turn;
        }

        changed = true;
        const nextStartedAt = turns[index + 1]?.startedAt;
        let durationMs = turn.durationMs;
        let completedAt = turn.completedAt;
        if (
            typeof durationMs !== 'number'
            && typeof turn.startedAt === 'number'
            && typeof nextStartedAt === 'number'
            && nextStartedAt >= turn.startedAt
        ) {
            completedAt = nextStartedAt;
            durationMs = nextStartedAt - turn.startedAt;
        }

        return {
            ...turn,
            completionDisposition: 'abnormal' as const,
            completedAt,
            durationMs,
            stream: {
                ...turn.stream,
                isStreaming: false,
                completedAt: completedAt ?? turn.stream.completedAt,
                durationMs,
            },
        };
    });

    return changed ? nextTurns : turns;
};

export const projectTurnRecords = (
    messages: ChatMessageEntry[],
    options?: Partial<ProjectTurnRecordsOptions>,
): TurnProjectionResult => {
    const effectiveOptions: ProjectTurnRecordsOptions = {
        ...DEFAULT_OPTIONS,
        ...options,
    };

    const turns: TurnRecord[] = [];
    const turnByUserId = new Map<string, TurnRecord>();
    const groupedMessageIds = new Set<string>();

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        if (role !== 'user') {
            return;
        }

        const turnId = message.info.id;
        const turn: TurnRecord = {
            turnId,
            userMessageId: message.info.id,
            userMessage: message,
            headerMessageId: undefined,
            messages: [createTurnMessageRecord(message, index)],
            assistantMessageIds: [],
            assistantMessages: [],
            activityParts: [],
            activitySegments: [],
            summary: {},
            summaryText: undefined,
            hasTools: false,
            hasReasoning: false,
            diffStats: undefined,
            changedFiles: undefined,
            stream: {
                isStreaming: false,
                isRetrying: false,
            },
            completionDisposition: 'active',
            activityPresentationKind: 'default',
            hasConfirmedFinalBody: false,
        };
        turns.push(turn);
        turnByUserId.set(turn.userMessageId, turn);
        groupedMessageIds.add(message.info.id);
    });

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        if (role !== 'assistant') {
            return;
        }

        const parentId = getMessageParentId(message);
        const targetTurn = parentId ? turnByUserId.get(parentId) : undefined;
        if (!targetTurn) {
            return;
        }

        targetTurn.assistantMessages.push(message);
        targetTurn.assistantMessageIds.push(message.info.id);
        targetTurn.messages.push(createTurnMessageRecord(message, index));
        if (!targetTurn.headerMessageId) {
            targetTurn.headerMessageId = message.info.id;
        }
        groupedMessageIds.add(message.info.id);
    });

    const stableTurns = settleHistoricalActiveTurns(
        hydrateStableTurnRecords(turns, effectiveOptions),
    );
    const projection = projectTurnIndexes(stableTurns);
    const ungroupedMessageIds = new Set<string>();
    messages.forEach((message) => {
        if (resolveMessageRole(message) === 'assistant') {
            return;
        }
        if (!groupedMessageIds.has(message.info.id)) {
            ungroupedMessageIds.add(message.info.id);
        }
    });

    return {
        ...projection,
        ungroupedMessageIds,
    };
};
