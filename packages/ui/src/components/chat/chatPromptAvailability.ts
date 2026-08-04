import type { ComposerSendPhase } from '@/sync/composer-send-manager';

type ChatPromptAvailability = {
    showReadOnlyBanner: boolean;
    blockSubmission: boolean;
};

/**
 * Primary chat waits for session identity before send. Hosted secondary
 * surfaces (Assistant) already own an authoritative binding on the host — a
 * missing list row must not block the composer.
 *
 * A directory list row is the preferred proof, but a renderable message
 * snapshot is enough once materialization succeeded: list/index lag must not
 * permanently disable Send after messages for that session already paint.
 */
export const resolveSessionIdentityPending = (input: {
    sessionId: string | null | undefined;
    hasSessionEntity: boolean;
    /** True when sync already holds a renderable message/part snapshot for this session. */
    hasRenderableSessionSnapshot?: boolean;
    composerSurfaceKind?: 'primary' | 'secondary' | null;
}): boolean => {
    if (!input.sessionId) {
        return false;
    }
    if (input.composerSurfaceKind === 'secondary') {
        return false;
    }
    if (input.hasSessionEntity) {
        return false;
    }
    if (input.hasRenderableSessionSnapshot) {
        return false;
    }
    return true;
};

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
