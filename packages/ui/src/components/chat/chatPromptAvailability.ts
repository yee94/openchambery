import type { ComposerSendPhase } from '@/sync/composer-send-manager';

type ChatPromptAvailability = {
    showReadOnlyBanner: boolean;
    blockSubmission: boolean;
};

/**
 * Primary chat waits for the directory session list entity. Hosted secondary
 * surfaces (Assistant) already own an authoritative binding on the host — a
 * missing list row must not block the composer.
 */
export const resolveSessionIdentityPending = (input: {
    sessionId: string | null | undefined;
    hasSessionEntity: boolean;
    composerSurfaceKind?: 'primary' | 'secondary' | null;
}): boolean => Boolean(input.sessionId && !input.hasSessionEntity && input.composerSurfaceKind !== 'secondary');

export const resolveChatPromptAvailability = (input: {
    readOnly: boolean;
    sessionIdentityPending: boolean;
    isSubagentSession: boolean;
    allowPromptingSubagentSessions: boolean;
}): ChatPromptAvailability => {
    const subagentReadOnly = input.isSubagentSession && !input.allowPromptingSubagentSessions;
    return {
        showReadOnlyBanner: input.isSubagentSession && (input.readOnly || subagentReadOnly),
        blockSubmission: input.sessionIdentityPending,
    };
};

/**
 * Send/queue availability derives from one composer send phase instead of
 * separate flight booleans. An establishing new-session send keeps both actions
 * available because later submits stage client pending-admission chips.
 */
export const resolveComposerActionAvailability = (input: {
    canSend: boolean;
    hasSessionTarget: boolean;
    draftSubmitting: boolean;
    submissionBlocked: boolean;
    sendPhase: ComposerSendPhase;
    queueFrozen: boolean;
    queueFallbackAvailable: boolean;
}) => {
    const { inFlight, establishing } = input.sendPhase;
    const busyBlocks = !establishing && (input.draftSubmitting || inFlight);
    const sendDisabled = !input.canSend
        || !input.hasSessionTarget
        || input.submissionBlocked
        || busyBlocks;
    const queueDisabled = !input.hasSessionTarget
        || input.submissionBlocked
        || (!establishing && inFlight)
        || (input.queueFrozen && !input.queueFallbackAvailable);
    return {
        sendDisabled,
        queueDisabled,
        disabledClass: 'opacity-30 pointer-events-none',
    };
};
