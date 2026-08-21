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

export type SubagentReadOnlyBannerExecution = {
    agentName?: string;
    providerId?: string;
    modelId?: string;
};

export type SubagentReadOnlyBannerParentTarget = {
    id: string;
    directory: string | null;
};

export type SubagentReadOnlyBannerLatch<TParent extends SubagentReadOnlyBannerParentTarget = SubagentReadOnlyBannerParentTarget> = {
    viewKey: string;
    parentTarget: TParent;
    execution: SubagentReadOnlyBannerExecution;
};

const mergeSubagentReadOnlyBannerExecution = (
    previous: SubagentReadOnlyBannerExecution | undefined,
    next: SubagentReadOnlyBannerExecution,
): SubagentReadOnlyBannerExecution => ({
    agentName: next.agentName ?? previous?.agentName,
    providerId: next.providerId ?? previous?.providerId,
    modelId: next.modelId ?? previous?.modelId,
});

const sameSubagentReadOnlyBannerParent = (
    left: SubagentReadOnlyBannerParentTarget,
    right: SubagentReadOnlyBannerParentTarget,
): boolean => left.id === right.id && left.directory === right.directory;

const sameSubagentReadOnlyBannerExecution = (
    left: SubagentReadOnlyBannerExecution,
    right: SubagentReadOnlyBannerExecution,
): boolean => (
    left.agentName === right.agentName
    && left.providerId === right.providerId
    && left.modelId === right.modelId
);

/**
 * Once a viewed session is confirmed as a child, keep its read-only footer
 * parent target and last-known execution identity through temporary list-row
 * gaps. `session.updated` hides subagents from the live directory list; recovery
 * may reinsert the row, and streaming must not flash the footer to the
 * metadata-less banner between those writes. Reset when the view identity
 * changes so a different session cannot inherit the previous child's footer.
 *
 * Returns `previous` when the latched identity is unchanged so a render-phase
 * caller can keep a stable reference across parent-object churn.
 */
export const resolveSubagentReadOnlyBannerLatch = <TParent extends SubagentReadOnlyBannerParentTarget>(
    previous: SubagentReadOnlyBannerLatch<TParent> | null,
    currentViewKey: string,
    parentTarget: TParent | null,
    execution: SubagentReadOnlyBannerExecution,
): SubagentReadOnlyBannerLatch<TParent> | null => {
    if (!currentViewKey) return null;
    const nextParent = parentTarget ?? (previous?.viewKey === currentViewKey ? previous.parentTarget : null);
    if (!nextParent) return null;
    const nextExecution = mergeSubagentReadOnlyBannerExecution(
        previous?.viewKey === currentViewKey ? previous.execution : undefined,
        execution,
    );
    if (
        previous
        && previous.viewKey === currentViewKey
        && sameSubagentReadOnlyBannerParent(previous.parentTarget, nextParent)
        && sameSubagentReadOnlyBannerExecution(previous.execution, nextExecution)
    ) {
        return previous;
    }
    return {
        viewKey: currentViewKey,
        parentTarget: nextParent,
        execution: nextExecution,
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
