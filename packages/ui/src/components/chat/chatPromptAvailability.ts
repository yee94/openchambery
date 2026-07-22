type ChatPromptAvailability = {
    showReadOnlyBanner: boolean;
    blockSubmission: boolean;
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
