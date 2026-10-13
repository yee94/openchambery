import type { Part } from '@/lib/opencode/v2-types';

/**
 * Assistant-message lifecycle predicates, mirroring the OpenCode runLoop exit
 * semantics: the loop exits only when the last assistant carries a `finish`
 * other than `tool-calls` and no continuation tool part.
 */

/**
 * A tool part is provider-executed when the provider itself ran it (e.g. a
 * hosted web-search call). Those never keep the client loop alive.
 */
const isProviderExecutedToolPart = (part: Part): boolean => {
    if (part.type !== 'tool') {
        return false;
    }
    return (part as { metadata?: { providerExecuted?: unknown } }).metadata?.providerExecuted === true;
};

/**
 * A tool part orphaned by an interrupt: errored because the run was
 * interrupted, not because the model still owes a follow-up step. Orphans do
 * not count as continuation work.
 */
const isInterruptedOrphanToolPart = (part: Part): boolean => {
    if (part.type !== 'tool') {
        return false;
    }
    const state = (part as { state?: { status?: unknown; metadata?: { interrupted?: unknown } } }).state;
    return state?.status === 'error' && state.metadata?.interrupted === true;
};

/**
 * Continuation tool: any ordinary (non-provider-executed) tool part that is not
 * an interrupted orphan. A *completed* tool still counts — the model may owe a
 * follow-up step for it, so the turn is not confirmed terminal yet.
 */
export const isContinuationToolPart = (part: Part): boolean => {
    if (part.type !== 'tool') {
        return false;
    }
    if (isProviderExecutedToolPart(part)) {
        return false;
    }
    return !isInterruptedOrphanToolPart(part);
};

export const countContinuationToolParts = (parts: readonly Part[]): number => {
    let count = 0;
    for (const part of parts) {
        if (isContinuationToolPart(part)) {
            count += 1;
        }
    }
    return count;
};

/**
 * Confirmed terminal stop: the model explicitly stopped (`finish === 'stop'`)
 * and the message carries no continuation tool. Matches the runLoop exit rule
 * (`finish` present, not `tool-calls`, no continuation tool).
 */
export const hasConfirmedTerminalStop = (finish: unknown, parts: readonly Part[]): boolean => {
    if (finish !== 'stop') {
        return false;
    }
    return countContinuationToolParts(parts) === 0;
};

/**
 * A non-empty, model-produced text part. Synthetic text is client-injected
 * decoration, never the model's answer; empty/whitespace text carries no body.
 */
export const isModelTextPart = (part: Part): boolean => {
    if (part.type !== 'text') {
        return false;
    }
    if ((part as { synthetic?: unknown }).synthetic === true) {
        return false;
    }
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' && text.trim().length > 0;
};

/**
 * Confirmed final body: terminal stop plus at least one model text part. An
 * error vetoes confirmation — the loop cannot continue, but the text is
 * partial, so consumers that collapse on confirmation must stay open.
 */
export const hasConfirmedFinalBody = (finish: unknown, parts: readonly Part[], error?: unknown): boolean => {
    if (error) {
        return false;
    }
    if (!hasConfirmedTerminalStop(finish, parts)) {
        return false;
    }
    for (const part of parts) {
        if (isModelTextPart(part)) {
            return true;
        }
    }
    return false;
};

const isLiveStreamPhase = (streamPhase: unknown): boolean => (
    streamPhase === 'streaming' || streamPhase === 'cooldown'
);

/**
 * Effective stream phase for the sorted reveal path. This is the single
 * derivation of the phase handed to `canRevealSortedFinalBody` /
 * `shouldStreamSortedFinalBody`: a `stop` finish or message completion snaps
 * to `completed`, otherwise the live channel phase with a `streaming`
 * fallback. Consumers must not re-derive it inline — drift between copies
 * makes the body reveal and the Activity dedup disagree, so the same text
 * duplicates or vanishes.
 */
export const resolveSortedRevealStreamPhase = (input: {
    finish: unknown;
    isMessageCompleted: boolean;
    activeStreamingPhase: unknown;
}): unknown => {
    if (input.finish === 'stop') {
        return 'completed';
    }
    if (input.isMessageCompleted) {
        return 'completed';
    }
    return input.activeStreamingPhase ?? 'streaming';
};

export type SortedFinalBodyRevealInput = {
    finish: unknown;
    parts: readonly Part[];
    streamPhase?: unknown;
    error?: unknown;
    /** Turn position does not revoke already received message text. */
    isLastAssistantInTurn?: boolean;
};

/**
 * Received model text owns its message body in sorted mode too. Later steps,
 * tools, errors and completion cannot revoke content already shown to the user.
 */
export const canRevealSortedFinalBody = (input: SortedFinalBodyRevealInput): boolean => {
    return input.parts.some(isModelTextPart);
};

/**
 * Apply the streaming cadence only while the message's live channel is active.
 * Completion stops animation without withdrawing the body.
 */
export const shouldStreamSortedFinalBody = (input: SortedFinalBodyRevealInput): boolean => {
    if (!isLiveStreamPhase(input.streamPhase)) {
        return false;
    }
    return canRevealSortedFinalBody(input);
};
