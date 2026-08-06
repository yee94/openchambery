import type { Part } from '@opencode-ai/sdk/v2';

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
