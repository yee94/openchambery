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

export const resolveComposerActionAvailability = (input: {
    canSend: boolean;
    hasSessionTarget: boolean;
    draftSubmitting: boolean;
    submissionBlocked: boolean;
    queueFrozen: boolean;
    hasBlockingAdmission: boolean;
}) => {
    const sendDisabled = !input.canSend
        || !input.hasSessionTarget
        || input.draftSubmitting
        || input.submissionBlocked
        || input.hasBlockingAdmission;
    const queueDisabled = !input.hasSessionTarget
        || input.submissionBlocked
        || input.queueFrozen
        || input.hasBlockingAdmission;
    return {
        sendDisabled,
        queueDisabled,
        disabledClass: 'opacity-30 pointer-events-none',
    };
};
